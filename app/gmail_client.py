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


def _list_threads(service, query: str, max_results: int) -> list[dict[str, str]]:
    """[{id, historyId}] -- o historyId muda a cada mensagem nova ou troca de
    rótulo (lido/não lido) na thread: é o que diz se precisa re-buscar."""
    out: list[dict[str, str]] = []
    token = None
    while len(out) < max_results:
        remaining = max_results - len(out)
        response = _execute(
            service.users()
            .threads()
            .list(
                userId="me",
                q=query,
                maxResults=min(100, remaining),
                pageToken=token,
            )
        )
        for item in response.get("threads", []):
            out.append({"id": item["id"], "historyId": str(item.get("historyId") or "")})
        token = response.get("nextPageToken")
        if not token:
            break
    return out


def _list_ids(service, query: str, max_results: int) -> list[str]:
    return [item["id"] for item in _list_threads(service, query, max_results)]


def _header_map(payload: dict[str, Any]) -> dict[str, str]:
    return {
        item.get("name", "").lower(): item.get("value", "")
        for item in payload.get("headers", [])
    }


def list_sent_thread_ids(limit: int = 150) -> list[str]:
    """IDs de threads do Enviados -- usado pelo piloto automatico pra
    aprender os padroes de resposta reais do Leo, nao so o que passou pelo
    IA.Email. Reaproveita `_list_ids`, que ja e generico sobre a query."""
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    return _list_ids(_service(creds), "in:sent", limit)


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
            # Para/Cc da última mensagem: o copiloto usa pra saber se o Leo
            # foi só copiado ou se o pedido é pra ele.
            "to_header": last_headers.get("to") or "",
            "cc_header": last_headers.get("cc") or "",
            # versão da thread no Gmail: o refresh compara com a lista e só
            # re-busca o que mudou (mensagem nova, lida/não lida em outro lugar)
            "history_id": str(raw.get("historyId") or ""),
        }
    )


# Gmail conta "não lidos" da aba Principal por mensagem (INBOX + UNREAD +
# CATEGORY_PERSONAL). A busca "is:unread" por thread devolve falsos positivos
# (threads sem nenhuma mensagem não lida): por isso o limite folgado e a
# classificação final sempre pelos rótulos das mensagens (_ingest_thread).
REFRESH_RECENT = 50
REFRESH_UNREAD = 300


def gmail_counts(service) -> dict[str, int | None]:
    """Contadores do próprio Gmail (o número que aparece na aba Principal).
    Uma chamada barata por rótulo; falha aqui não derruba o refresh."""
    out: dict[str, int | None] = {"primary_unread": None, "inbox_unread": None}
    for key, label in (("primary_unread", "CATEGORY_PERSONAL"), ("inbox_unread", "INBOX")):
        try:
            data = _execute(service.users().labels().get(userId="me", id=label))
            out[key] = int(data.get("threadsUnread") or 0)
        except HttpError:
            continue
    return out


def refresh(recent: int = REFRESH_RECENT, unread: int = REFRESH_UNREAD) -> dict[str, int]:
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    if not _REFRESH_LOCK.acquire(blocking=False):
        return {"skipped": 1, "reason": "refresh_em_andamento"}
    try:
        service = _service(creds)
        recent_list = _list_threads(service, "in:inbox category:primary", recent)
        unread_list = _list_threads(service, "in:inbox category:primary is:unread", unread)
        unread_set = {t["id"] for t in unread_list}
        index = store.thread_sync_index()  # {id: {history_id, is_unread, visible}}
        ordered: list[str] = []
        seen: set[str] = set()
        for item in unread_list + recent_list:
            thread_id = item["id"]
            if thread_id in seen:
                continue
            seen.add(thread_id)
            known = index.get(thread_id)
            # Antes: thread conhecida e fora da lista de não lidos nunca era
            # re-buscada -- mensagem nova lida no celular, resposta do Leo
            # pelo Gmail etc. ficavam congeladas. Agora: re-busca quando o
            # historyId do Gmail mudou (ou quando ainda não temos o historyId).
            if known and known.get("history_id") and known["history_id"] == item["historyId"]:
                continue
            ordered.append(thread_id)
        # Não lido no banco que o Gmail não lista mais como não lido (lido no
        # celular/Gmail web, arquivado, movido de aba): re-busca para limpar a
        # flag velha em vez de mostrá-lo como pendente para sempre.
        for thread_id, known in index.items():
            if known.get("is_unread") and known.get("visible") and thread_id not in unread_set and thread_id not in seen:
                seen.add(thread_id)
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
                if exc.resp.status == 404:
                    # thread apagada/sumiu entre a lista e o get: segue o resto
                    continue
                raise
        counts = gmail_counts(service)
        now = datetime.now(TZ)
        store.set_meta("last_refresh", now.strftime("%H:%M"))
        store.set_meta("last_sync_at", now.isoformat(timespec="seconds"))
        store.set_meta(
            "gmail_counts",
            json.dumps({**counts, "at": now.isoformat(timespec="seconds")}),
        )
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
            "recent": len(recent_list),
            "unread_query": len(unread_list),
            "fetched": ingested,
            "primary_unread_gmail": counts.get("primary_unread"),
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


def _reply_to_addr(headers: dict) -> str:
    """Para padrão da resposta (o mesmo de sempre): o último remetente; se
    foi o Leo, o Para da mensagem dele."""
    _, from_addr = parseaddr(headers.get("from") or "")
    if from_addr.lower() != ACCOUNT:
        return from_addr
    return parseaddr(headers.get("to") or "")[1] or ACCOUNT


def get_recipients(thread_id: str) -> dict:
    """Para/Cc da ultima mensagem da thread -- pra mostrar quem mais foi
    colocado no e-mail, alem do Leo. Também devolve o Para/Cc que o envio
    usa por padrão (reply_to/reply_cc, "responder a todos") e todo mundo que
    apareceu na thread (participants), para o composer editar os chips."""
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
            metadataHeaders=["From", "To", "Cc"],
        )
    )
    messages = raw.get("messages") or []
    if not messages:
        return {"to": [], "cc": [], "reply_to": [], "reply_cc": [], "participants": []}
    headers = _header_map(messages[-1].get("payload") or {})
    return {
        "to": _split_addresses(headers.get("to") or ""),
        "cc": _split_addresses(headers.get("cc") or ""),
        **reply_defaults([_header_map(m.get("payload") or {}) for m in messages]),
    }


# Cabeçalhos por mensagem (De/Para/Cc/Cco/Data/Message-ID), na mesma ordem
# de get_thread_text -> o índice casa com os cards da "Conversa completa".
# Cache em memória por thread + internal_date (mensagem nova invalida).
_META_CACHE: dict[str, tuple[float, Any, list[dict]]] = {}
_META_TTL = 600.0


def _meta_view(message: dict) -> dict:
    headers = _header_map(message.get("payload") or {})
    sender = _split_addresses(headers.get("from") or "")
    return {
        "id": message.get("id") or "",
        "message_id": headers.get("message-id") or "",
        "from": sender[0] if sender else {"name": headers.get("from") or "", "email": ""},
        "to": _split_addresses(headers.get("to") or ""),
        "cc": _split_addresses(headers.get("cc") or ""),
        # Cco só aparece nas mensagens que o próprio Leo mandou
        "bcc": _split_addresses(headers.get("bcc") or ""),
        "date": headers.get("date") or "",
        "subject": headers.get("subject") or "",
    }


def get_messages_meta(thread_id: str, *, force: bool = False) -> list[dict]:
    """Uma entrada por mensagem da thread (format=metadata, só leitura)."""
    anchor = (store.get_thread(thread_id) or {}).get("internal_date")
    hit = _META_CACHE.get(thread_id)
    if hit and not force and hit[1] == anchor and time.time() - hit[0] < _META_TTL:
        return hit[2]
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
            metadataHeaders=["From", "To", "Cc", "Bcc", "Date", "Subject", "Message-ID"],
        )
    )
    out = [_meta_view(m) for m in raw.get("messages") or []]
    _META_CACHE[thread_id] = (time.time(), anchor, out)
    return out


def search_messages(query: str, max_results: int = 5) -> list[dict]:
    """Busca na caixa do Leo (Verificador). SÓ LEITURA: messages.list com q +
    messages.get format=metadata. Nunca modify/send/labels/trash. A query já
    vem saneada (verify.sanitize_query)."""
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    messages = _service(creds).users().messages()
    listed = _execute(messages.list(userId="me", q=query, maxResults=max(1, min(int(max_results), 10))))
    out: list[dict] = []
    for item in (listed.get("messages") or [])[:max_results]:
        raw = _execute(
            messages.get(
                userId="me",
                id=item["id"],
                format="metadata",
                metadataHeaders=["From", "To", "Cc", "Subject", "Date"],
            )
        )
        headers = _header_map(raw.get("payload") or {})
        out.append({
            "message_id": raw.get("id") or item["id"],
            "thread_id": raw.get("threadId") or item.get("threadId") or "",
            "assunto": headers.get("subject") or "",
            "de": headers.get("from") or "",
            "para": headers.get("to") or "",
            "cc": headers.get("cc") or "",
            "data": headers.get("date") or "",
            "internal_date": int(raw.get("internalDate") or 0),
            "snippet": raw.get("snippet") or "",
            "labels": list(raw.get("labelIds") or []),
        })
    return out


def _find_target(messages: list[dict], reply_to_message_id: str) -> dict | None:
    """Acha a mensagem pelo id do Gmail ou pelo Message-ID do cabeçalho."""
    wanted = (reply_to_message_id or "").strip()
    bare = wanted.strip("<>")
    for m in messages:
        if m.get("id") == wanted:
            return m
        mid = (_header_map(m.get("payload") or {}).get("message-id") or "").strip()
        if mid and mid.strip("<>") == bare:
            return m
    return None


def reply_defaults(all_headers: list) -> dict:
    """Cabeçalhos de cada mensagem (a última por último) -> Para padrão,
    Cc de "responder a todos" e participantes (nome + e-mail, sem o Leo)."""
    last = all_headers[-1] if all_headers else {}
    to_addr = _reply_to_addr(last).lower()
    seen = {ACCOUNT, to_addr}
    reply_cc = []
    for a in _split_addresses(last.get("to") or "") + _split_addresses(last.get("cc") or ""):
        email = a["email"].lower()
        if email not in seen:
            seen.add(email)
            reply_cc.append(email)
    people = {}
    for h in all_headers:
        for key in ("from", "to", "cc"):
            for a in _split_addresses(h.get(key) or ""):
                email = a["email"].lower()
                if email == ACCOUNT:
                    continue
                if email not in people or (a["name"] and not people[email]["name"]):
                    people[email] = {"email": email, "name": a["name"]}
    return {"reply_to": [to_addr] if to_addr else [], "reply_cc": reply_cc, "participants": list(people.values())}


def send_reply(thread_id: str, body_text: str, cc: str = "", only_files: list[str] | None = None,
               to: str | list[str] | None = None, reply_to_message_id: str | None = None) -> dict:
    """only_files: nomes dos anexos (da pasta da thread) a mandar. None = todos
    os que estão na pasta agora (comportamento de sempre); a fila de envio
    passa a lista fotografada no momento em que o Leo confirmou o envio.
    to: Para escolhido no composer (lista ou "a@x, b@y"). Vazio/None = o de
    sempre (último remetente; se foi o Leo, o Para dele). A resposta continua
    na mesma conversa (In-Reply-To/References) em qualquer caso.
    reply_to_message_id: responder a UMA mensagem da thread (id do Gmail ou
    Message-ID), não à última: In-Reply-To = Message-ID dela, References =
    References dela + Message-ID dela, e o Para padrão sai dela."""
    from .recipients import clean_addresses

    to_list = clean_addresses(to)  # inválido -> ValueError antes de falar com o Gmail
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
        .get(userId="me", id=thread_id, format="metadata",
             metadataHeaders=["From", "To", "Subject", "Message-ID", "References"])
    )
    messages = raw.get("messages") or []
    if not messages:
        raise RuntimeError("Thread vazia.")
    target = messages[-1]
    if reply_to_message_id:
        target = _find_target(messages, reply_to_message_id)
        if target is None:
            raise RuntimeError("A mensagem que você quis responder não está mais nesta conversa. Recarregue e escolha de novo.")
    headers = _header_map(target.get("payload") or {})
    to_addr = ", ".join(to_list) if to_list else _reply_to_addr(headers)
    subject = headers.get("subject") or "(sem assunto)"
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    message_id = headers.get("message-id") or ""

    files = attachments.list_files(thread_id)
    if only_files is not None:
        wanted = set(only_files)
        files = [item for item in files if item["name"] in wanted]
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
    to_set = {a.strip().lower() for a in to_addr.split(",")}
    cc_clean = ", ".join(addr for addr in clean_addresses(cc) if addr not in to_set)
    if cc_clean:
        msg["Cc"] = cc_clean
    msg["From"] = formataddr(("Lettiery D'Lamare", ACCOUNT))
    msg["Subject"] = subject
    if message_id:
        msg["In-Reply-To"] = message_id
        # resposta a uma mensagem do meio: a cadeia dela + ela (RFC 5322)
        refs = (headers.get("references") or "").split() if reply_to_message_id else []
        msg["References"] = " ".join([r for r in refs if r != message_id] + [message_id])

    raw_bytes = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    sent = _execute(
        service.users()
        .messages()
        .send(userId="me", body={"raw": raw_bytes, "threadId": thread_id})
    )
    _META_CACHE.pop(thread_id, None)  # a resposta vira mensagem nova da thread
    out = {"id": sent.get("id"), "to": to_addr, "cc": cc_clean, "subject": subject}
    if reply_to_message_id:
        out["reply_to_message_id"] = target.get("id") or reply_to_message_id
    return out


def send_new(to: str, cc: str, subject: str, body_text: str) -> dict:
    """E-mail do zero, sem responder nenhuma thread existente -- ao
    contrário de send_reply, não tem In-Reply-To/References nem
    threadId: o Gmail abre uma conversa nova."""
    creds = load_credentials()
    if not creds:
        raise RuntimeError("Gmail nao autenticado.")
    if not has_send_scope(creds):
        raise RuntimeError(
            "Reautorize o Gmail (Entrar no Gmail): o app precisa de gmail.send para enviar."
        )
    to_clean = ", ".join(addr for addr in (a.strip() for a in (to or "").split(",")) if addr)
    if not to_clean:
        raise RuntimeError("Informe pelo menos um destinatário.")
    service = _service(creds)
    msg = MIMEText(body_text)
    msg["To"] = to_clean
    cc_clean = ", ".join(addr for addr in (a.strip() for a in (cc or "").split(",")) if addr)
    if cc_clean:
        msg["Cc"] = cc_clean
    msg["From"] = formataddr(("Lettiery D'Lamare", ACCOUNT))
    msg["Subject"] = subject.strip() or "(sem assunto)"

    raw_bytes = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    sent = _execute(service.users().messages().send(userId="me", body={"raw": raw_bytes}))
    return {
        "id": sent.get("id"),
        "thread_id": sent.get("threadId"),
        "to": to_clean,
        "cc": cc_clean,
        "subject": msg["Subject"],
    }
