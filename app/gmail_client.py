from __future__ import annotations

import base64
import json
import re
import threading
import time
from datetime import datetime
from html.parser import HTMLParser
import mimetypes
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, getaddresses, parseaddr
from pathlib import Path
from typing import Any

from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from . import attachments
from .classifier import classify, parse_email
from .config import (
    ACCOUNT,
    CLIENT_SECRETS_PATH,
    REDIRECT_URI,
    SCOPES,
    TOKEN_PATH,
    TZ,
    client_id,
    client_secret,
    oauth_credentials_file,
)
from . import store

_REFRESH_LOCK = threading.Lock()
_CRED_LOCK = threading.Lock()


class QuotaPartial(Exception):
    def __init__(self, ingested: int, merged: int):
        self.ingested = ingested
        self.merged = merged
        super().__init__(
            "Cota do Gmail (unidades/minuto). A lista que já entrou permanece; "
            "espere ~1 min e clique em Atualizar de novo."
        )


def _execute(request, attempts: int = 6):
    delay = 2.0
    last: HttpError | None = None
    for _ in range(attempts):
        try:
            return request.execute()
        except HttpError as exc:
            last = exc
            body = (exc.content or b"").decode("utf-8", errors="replace")
            if exc.resp.status in {403, 429} and "rateLimitExceeded" in body:
                time.sleep(delay)
                delay = min(delay * 2, 32)
                continue
            raise
    raise last or RuntimeError("Gmail falhou sem resposta")


def _client_config() -> dict[str, Any]:
    path = oauth_credentials_file()
    if path:
        return json.loads(path.read_text(encoding="utf-8"))
    cid, secret = client_id(), client_secret()
    if not cid or not secret:
        raise RuntimeError(
            "Faltam GOOGLE_GMAIL_CLIENT_ID e GOOGLE_GMAIL_CLIENT_SECRET no .env "
            "(cliente OAuth Desktop do Google Cloud, Gmail API ligada)."
        )
    config = {
        "installed": {
            "client_id": cid,
            "client_secret": secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [REDIRECT_URI, "http://localhost"],
        }
    }
    CLIENT_SECRETS_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return config


def has_client() -> bool:
    try:
        _client_config()
        return True
    except RuntimeError:
        return False


def load_credentials() -> Credentials | None:
    with _CRED_LOCK:
        if not TOKEN_PATH.is_file():
            return None
        # Sem passar SCOPES aqui: isso faz o objeto refletir o escopo pedido
        # pelo app, nao o que o Google de fato concedeu no token salvo.
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH))
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except RefreshError:
                TOKEN_PATH.unlink(missing_ok=True)
                return None
            save_credentials(creds)
        if creds and creds.valid:
            return creds
        return None


def save_credentials(creds: Credentials) -> None:
    TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")


def has_modify_scope(creds: Credentials | None) -> bool:
    if not creds:
        return False
    scopes = set(creds.scopes or [])
    return bool(
        scopes
        & {
            "https://www.googleapis.com/auth/gmail.modify",
            "https://mail.google.com/",
        }
    )


def has_send_scope(creds: Credentials | None) -> bool:
    if not creds:
        return False
    scopes = set(creds.scopes or [])
    return bool(
        scopes
        & {
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.compose",
            "https://mail.google.com/",
        }
    )


def auth_url() -> str:
    flow = Flow.from_client_config(_client_config(), scopes=SCOPES)
    flow.redirect_uri = REDIRECT_URI
    url, _state = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        login_hint=ACCOUNT,
    )
    Path(TOKEN_PATH.parent / "oauth-state.txt").write_text(_state, encoding="utf-8")
    return url


def finish_auth(code: str) -> None:
    flow = Flow.from_client_config(_client_config(), scopes=SCOPES)
    flow.redirect_uri = REDIRECT_URI
    flow.fetch_token(code=code)
    save_credentials(flow.credentials)


def _service(creds: Credentials):
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _list_ids(service, query: str, max_results: int) -> list[str]:
    ids: list[str] = []
    token = None
    while len(ids) < max_results:
        remaining = max_results - len(ids)
        response = _execute(
            service.users()
            .threads()
            .list(
                userId="me",
                q=query,
                maxResults=min(50, remaining),
                pageToken=token,
            )
        )
        for item in response.get("threads", []):
            ids.append(item["id"])
        token = response.get("nextPageToken")
        if not token:
            break
    return ids


def _header_map(payload: dict[str, Any]) -> dict[str, str]:
    return {
        item.get("name", "").lower(): item.get("value", "")
        for item in payload.get("headers", [])
    }


def refresh_thread(thread_id: str) -> None:
    """Re-busca uma unica thread no Gmail e atualiza a classificacao local."""
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    _ingest_thread(_service(creds), thread_id)


def _ingest_thread(service, thread_id: str) -> None:
    raw = _execute(
        service.users().threads().get(userId="me", id=thread_id, format="metadata")
    )
    messages = raw.get("messages") or []
    if not messages:
        return
    last = messages[-1]
    first = messages[0]
    last_headers = _header_map(last.get("payload") or {})
    first_headers = _header_map(first.get("payload") or {})
    subject = last_headers.get("subject") or first_headers.get("subject") or "(sem assunto)"
    from_header = last_headers.get("from") or first_headers.get("from") or ""
    name, email = parseaddr(from_header)
    labels = last.get("labelIds") or raw.get("labelIds") or []
    # UNREAD pode estar so na mensagem nova, nao no thread wrapper.
    all_labels: list[str] = []
    for msg in messages:
        all_labels.extend(msg.get("labelIds") or [])
    snippet = last.get("snippet") or raw.get("snippet") or ""
    internal = int(last.get("internalDate") or first.get("internalDate") or 0)
    result = classify(
        label_ids=all_labels,
        last_from_header=from_header,
        subject=subject,
        snippet=snippet,
        me=ACCOUNT,
    )
    sender_email = parse_email(from_header) or email.lower()
    forced_marketing = result.is_marketing or store.is_blocked_sender(sender_email)
    store.upsert_thread(
        {
            "id": thread_id,
            "subject": subject,
            "from_email": sender_email,
            "from_name": name or email,
            "snippet": snippet,
            "internal_date": internal,
            "is_unread": int(result.is_unread),
            "last_from_me": int(result.last_from_me),
            "is_automatic": int(result.is_automatic),
            "is_marketing": int(forced_marketing),
            "needs_action_hint": int(result.needs_action_hint),
            "awaiting_reply": int(result.awaiting_reply),
            "conferido": 1,
            "hide_as_replied": int(result.hide_as_replied),
            "last_from_header": from_header,
            "labels_json": sorted(set(all_labels)),
        }
    )


def refresh(recent: int = 25, unread: int = 20) -> dict[str, int]:
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    if not _REFRESH_LOCK.acquire(blocking=False):
        return {"skipped": 1, "reason": "refresh_em_andamento"}
    try:
        service = _service(creds)
        recent_ids = _list_ids(service, "in:inbox category:primary", recent)
        unread_ids = _list_ids(service, "in:inbox category:primary is:unread", unread)
        unread_set = set(unread_ids)
        known = store.conferido_ids()
        ordered: list[str] = []
        seen: set[str] = set()
        for thread_id in unread_ids + recent_ids:
            if thread_id in seen:
                continue
            seen.add(thread_id)
            if thread_id in known and thread_id not in unread_set:
                continue
            ordered.append(thread_id)
        ingested = 0
        for thread_id in ordered:
            try:
                _ingest_thread(service, thread_id)
                ingested += 1
                time.sleep(0.15)
            except HttpError as exc:
                body = (exc.content or b"").decode("utf-8", errors="replace")
                if exc.resp.status in {403, 429} and "rateLimitExceeded" in body:
                    store.set_meta(
                        "last_refresh", datetime.now(TZ).strftime("%H:%M")
                    )
                    raise QuotaPartial(ingested, len(ordered)) from exc
                raise
        store.set_meta("last_refresh", datetime.now(TZ).strftime("%H:%M"))
        store.set_meta(
            "last_scope",
            json.dumps(
                {
                    "recent": recent,
                    "unread": unread,
                    "fetched": ingested,
                    "skipped_cache": len(seen) - len(ordered),
                }
            ),
        )
        return {
            "recent": len(recent_ids),
            "unread_query": len(unread_ids),
            "fetched": ingested,
        }
    finally:
        _REFRESH_LOCK.release()


def _b64(data: str) -> str:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad).decode("utf-8", errors="replace")


_BLOCK_TAGS = {"br", "p", "div", "tr", "li", "blockquote", "table", "h1", "h2", "h3", "h4", "h5", "h6"}


class _HtmlTextExtractor(HTMLParser):
    """Extrai texto legivel de um e-mail que so tem parte text/html (sem
    text/plain) -- sem isso o corpo aparecia com as tags cruas na tela."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style"):
            self._skip = max(0, self._skip - 1)
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def _html_to_text(raw: str) -> str:
    extractor = _HtmlTextExtractor()
    try:
        extractor.feed(raw)
    except Exception:
        return re.sub(r"<[^>]+>", " ", raw).strip()
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in "".join(extractor.parts).split("\n")]
    out: list[str] = []
    blank = False
    for ln in lines:
        if not ln:
            if not blank:
                out.append("")
            blank = True
        else:
            out.append(ln)
            blank = False
    return "\n".join(out).strip()


def _collect_text(payload: dict[str, Any], plain: list[str], html: list[str]) -> None:
    mime = payload.get("mimeType") or ""
    body = payload.get("body") or {}
    data = body.get("data")
    if data:
        text = _b64(data)
        if mime.startswith("text/plain"):
            plain.append(text)
        elif mime.startswith("text/html"):
            html.append(text)
    for part in payload.get("parts") or []:
        _collect_text(part, plain, html)


def _collect_ics(payload: dict[str, Any], out: list[dict[str, str | None]]) -> None:
    mime = (payload.get("mimeType") or "").lower()
    if mime in ("text/calendar", "application/ics"):
        body = payload.get("body") or {}
        out.append({"data": body.get("data"), "attachment_id": body.get("attachmentId")})
    for part in payload.get("parts") or []:
        _collect_ics(part, out)


def get_invite_ics(thread_id: str) -> str | None:
    """Retorna o conteudo .ics (texto bruto) do convite de calendario
    anexado a ultima mensagem da thread, se houver."""
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    service = _service(creds)
    raw = _execute(
        service.users().threads().get(userId="me", id=thread_id, format="full")
    )
    messages = raw.get("messages") or []
    if not messages:
        return None
    last_message = messages[-1]
    candidates: list[dict[str, str | None]] = []
    _collect_ics(last_message.get("payload") or {}, candidates)
    # Prefere text/calendar; qualquer um serve, pega o primeiro com conteudo.
    for cand in candidates:
        if cand.get("data"):
            return _b64(cand["data"])
    for cand in candidates:
        if cand.get("attachment_id"):
            attachment = _execute(
                service.users()
                .messages()
                .attachments()
                .get(userId="me", messageId=last_message["id"], id=cand["attachment_id"])
            )
            data = attachment.get("data")
            if data:
                return _b64(data)
    return None


def _collect_attachments(message_id: str, payload: dict[str, Any], out: list[dict[str, Any]]) -> None:
    filename = payload.get("filename") or ""
    body = payload.get("body") or {}
    if filename and body.get("attachmentId"):
        out.append(
            {
                "message_id": message_id,
                "attachment_id": body["attachmentId"],
                "filename": filename,
                "mime_type": payload.get("mimeType") or "application/octet-stream",
                "size": body.get("size") or 0,
            }
        )
    for part in payload.get("parts") or []:
        _collect_attachments(message_id, part, out)


def list_thread_attachments(thread_id: str) -> dict[str, Any]:
    """Lista os anexos reais recebidos na thread (nao os que o Leo anexa pra
    responder -- esses ficam em `attachments.py`, sao locais), junto com a
    ordem das mensagens (mesma ordem/contagem de `get_thread_text`, pra dar
    pra casar cada anexo com o bloco de texto certo no front)."""
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    service = _service(creds)
    raw = _execute(
        service.users().threads().get(userId="me", id=thread_id, format="full")
    )
    files: list[dict[str, Any]] = []
    message_ids: list[str] = []
    for message in raw.get("messages") or []:
        msg_id = message.get("id") or ""
        message_ids.append(msg_id)
        _collect_attachments(msg_id, message.get("payload") or {}, files)
    return {"files": files, "message_ids": message_ids}


def get_attachment_bytes(thread_id: str, message_id: str, attachment_id: str) -> bytes:
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    service = _service(creds)
    attachment = _execute(
        service.users()
        .messages()
        .attachments()
        .get(userId="me", messageId=message_id, id=attachment_id)
    )
    data = attachment.get("data") or ""
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def mark_threads_read(thread_ids: list[str]) -> list[str]:
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    if not has_modify_scope(creds):
        raise RuntimeError(
            "Reautorize o Gmail (Entrar no Gmail): o app precisa de gmail.modify "
            "para marcar como lido."
        )
    service = _service(creds)
    done: list[str] = []
    for thread_id in thread_ids:
        _execute(
            service.users()
            .threads()
            .modify(
                userId="me",
                id=thread_id,
                body={"removeLabelIds": ["UNREAD"]},
            )
        )
        done.append(thread_id)
        time.sleep(0.08)
    store.mark_local_read(done)
    return done


def get_thread_text(thread_id: str) -> str:
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    raw = _execute(
        _service(creds).users().threads().get(userId="me", id=thread_id, format="full")
    )
    blocks: list[str] = []
    for message in raw.get("messages") or []:
        headers = _header_map(message.get("payload") or {})
        who = headers.get("from") or ""
        when = headers.get("date") or ""
        plain: list[str] = []
        html: list[str] = []
        _collect_text(message.get("payload") or {}, plain, html)
        body = "\n".join(plain).strip() or _html_to_text("\n".join(html))
        if len(body) > 8000:
            body = body[:8000] + "\n[cortado]"
        blocks.append(f"De: {who}\nData: {when}\n\n{body}")
    return "\n\n----\n\n".join(blocks)


def _split_addresses(header_value: str) -> list[dict[str, str]]:
    out = []
    for name, addr in getaddresses([header_value or ""]):
        if addr:
            out.append({"name": name, "email": addr})
    return out


def get_recipients(thread_id: str) -> dict[str, list[dict[str, str]]]:
    """Para/Cc da ultima mensagem da thread -- pra mostrar quem mais foi
    colocado no e-mail, alem do Leo."""
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    raw = _execute(
        _service(creds)
        .users()
        .threads()
        .get(
            userId="me",
            id=thread_id,
            format="metadata",
            metadataHeaders=["To", "Cc"],
        )
    )
    messages = raw.get("messages") or []
    if not messages:
        return {"to": [], "cc": []}
    headers = _header_map(messages[-1].get("payload") or {})
    return {
        "to": _split_addresses(headers.get("to") or ""),
        "cc": _split_addresses(headers.get("cc") or ""),
    }


def send_reply(thread_id: str, body_text: str) -> dict:
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    if not has_send_scope(creds):
        raise RuntimeError(
            "Reautorize o Gmail (Entrar no Gmail): o app precisa de gmail.send para enviar."
        )
    service = _service(creds)
    raw = _execute(
        service.users()
        .threads()
        .get(userId="me", id=thread_id, format="metadata", metadataHeaders=["From", "To", "Subject", "Message-ID"])
    )
    messages = raw.get("messages") or []
    if not messages:
        raise RuntimeError("Thread vazia.")
    last = messages[-1]
    headers = _header_map(last.get("payload") or {})
    _, from_addr = parseaddr(headers.get("from") or "")
    to_addr = from_addr if from_addr.lower() != ACCOUNT else (parseaddr(headers.get("to") or "")[1] or ACCOUNT)
    subject = headers.get("subject") or "(sem assunto)"
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    message_id = headers.get("message-id") or ""

    files = attachments.list_files(thread_id)
    if files:
        msg = MIMEMultipart()
        msg.attach(MIMEText(body_text))
        for item in files:
            path = attachments.folder(thread_id) / item["name"]
            ctype, _ = mimetypes.guess_type(item["name"])
            maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
            part = MIMEBase(maintype, subtype)
            part.set_payload(path.read_bytes())
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=item["name"])
            msg.attach(part)
    else:
        msg = MIMEText(body_text)
    msg["To"] = to_addr
    msg["From"] = formataddr(("Lettiery D'Lamare", ACCOUNT))
    msg["Subject"] = subject
    if message_id:
        msg["In-Reply-To"] = message_id
        msg["References"] = message_id

    raw_bytes = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    sent = _execute(
        service.users()
        .messages()
        .send(userId="me", body={"raw": raw_bytes, "threadId": thread_id})
    )
    return {"id": sent.get("id"), "to": to_addr, "subject": subject}
