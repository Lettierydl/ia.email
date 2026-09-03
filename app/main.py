from __future__ import annotations

from datetime import datetime
from typing import List, Optional
import os
from zoneinfo import ZoneInfo

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from pydantic import BaseModel

from . import assistant, attachments, gmail_client, llm, store
from .gmail_client import QuotaPartial
from .preload import pick_preload
from .config import ACCOUNT, ROOT

TZ = ZoneInfo("America/Fortaleza")
STATIC = ROOT / "static"

app = FastAPI(title="IA.Email")
store.init()
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class SetupBody(BaseModel):
    client_id: str
    client_secret: str


class DraftBody(BaseModel):
    instruction: str = ""
    comment: str = ""


class SendBody(BaseModel):
    text: str


class PreloadBody(BaseModel):
    ids: List[str]


def _index():
    return FileResponse(
        STATIC / "index.html",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/")
def index():
    return _index()


@app.get("/mail/{thread_id}")
def mail_page(thread_id: str):
    return _index()


@app.get("/api/status")
def status():
    creds = gmail_client.load_credentials()
    return {
        "account": ACCOUNT,
        "has_client": gmail_client.has_client(),
        "authenticated": bool(creds),
        "last_refresh": store.get_meta("last_refresh"),
        "hidden": store.hidden_count(),
        "cached": store.thread_count(),
        "can_mark_read": gmail_client.has_modify_scope(creds),
        "can_send": gmail_client.has_send_scope(creds),
        "now": datetime.now(TZ).strftime("%H:%M"),
        "llm_provider": llm.provider_label(),
        "llm_tokens_today": store.llm_usage_today(),
    }


@app.get("/api/auth/login")
def login():
    if not gmail_client.has_client():
        raise HTTPException(
            400,
            "Falta client OAuth. Cole o Client ID e o Secret no quadro abaixo, ou preencha radar-confrapag/.env.",
        )
    try:
        return {"url": gmail_client.auth_url()}
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/auth/setup")
def setup(body: SetupBody):
    cid = body.client_id.strip()
    secret = body.client_secret.strip()
    if not cid or not secret:
        raise HTTPException(400, "Client ID e Secret são obrigatórios.")
    env_path = ROOT / ".env"
    env_path.write_text(
        "\n".join(
            [
                "RADAR_ACCOUNT=leo@confrapag.com.br",
                "RADAR_HOST=127.0.0.1",
                "RADAR_PORT=8765",
                f"GOOGLE_GMAIL_CLIENT_ID={cid}",
                f"GOOGLE_GMAIL_CLIENT_SECRET={secret}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    env_path.chmod(0o600)
    os.environ["GOOGLE_GMAIL_CLIENT_ID"] = cid
    os.environ["GOOGLE_GMAIL_CLIENT_SECRET"] = secret
    return {"ok": True, "has_client": gmail_client.has_client()}


@app.get("/api/auth/callback")
def callback(code: Optional[str] = None, error: Optional[str] = None):
    if error:
        raise HTTPException(400, error)
    if not code:
        raise HTTPException(400, "code ausente")
    gmail_client.finish_auth(code)
    return RedirectResponse("/", status_code=302)


@app.post("/api/refresh")
def refresh():
    try:
        counts = gmail_client.refresh()
    except QuotaPartial as exc:
        raise HTTPException(
            429,
            {
                "message": str(exc),
                "fetched": exc.ingested,
                "queued": exc.merged,
            },
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(401, str(exc)) from exc
    return {"ok": True, **counts, "last_refresh": store.get_meta("last_refresh")}


@app.get("/api/radar")
def radar(
    q: str = "",
    acao_sua: bool = False,
    marketing: bool = False,
    restore_hidden: bool = False,
):
    rows = store.list_visible(include_hidden=restore_hidden)
    needle = q.strip().lower()
    unread, waiting, automatic = [], [], []
    for row in rows:
        if not marketing and row["is_marketing"] and not row["is_unread"]:
            continue
        if acao_sua and not row["needs_action_hint"]:
            continue
        hay = f"{row['from_email']} {row['from_name']} {row['subject']}".lower()
        if needle and needle not in hay:
            continue
        item = _public(row)
        if row["is_automatic"]:
            if row["is_unread"]:
                automatic.append(item)
            continue
        elif row["is_unread"]:
            unread.append(item)
        elif row["awaiting_reply"] or (
            restore_hidden and row.get("hide_as_replied")
        ):
            waiting.append(item)

    unanswered = len(unread) + len(waiting)
    action = sum(1 for item in unread + waiting if item["needs_action_hint"])
    return {
        "account": ACCOUNT,
        "last_refresh": store.get_meta("last_refresh"),
        "unanswered": unanswered,
        "needs_action": action,
        "hidden": store.hidden_count(),
        "unread": unread,
        "waiting": waiting,
        "automatic": automatic,
    }


@app.post("/api/threads/{thread_id}/hide")
def hide(thread_id: str, hidden: bool = Query(True)):
    store.set_hidden(thread_id, hidden)
    return {"ok": True}


class MarkReadBody(BaseModel):
    ids: List[str]


@app.post("/api/threads/{thread_id}/mark-read")
def mark_read_single(thread_id: str):
    try:
        done = gmail_client.mark_threads_read([thread_id])
        return {"ok": True, "marked": done}
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/mark-read")
def mark_read_batch(body: MarkReadBody):
    try:
        done = gmail_client.mark_threads_read(body.ids)
        return {"ok": True, "marked": done}
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/threads/{thread_id}")
def thread_detail(thread_id: str, force: bool = Query(False)):
    try:
        return assistant.analyze(thread_id, force=force)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/threads/{thread_id}/draft")
def thread_draft(thread_id: str, body: DraftBody):
    try:
        return assistant.draft(thread_id, body.instruction, body.comment)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/threads/{thread_id}/export-context")
def thread_export_context(thread_id: str):
    try:
        return assistant.export_context(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/threads/{thread_id}/send")
def thread_send(thread_id: str, body: SendBody):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Texto vazio.")
    try:
        result = gmail_client.send_reply(thread_id, text)
        gmail_client.mark_threads_read([thread_id])
        gmail_client.refresh_thread(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc
    store.save_ai(thread_id, draft="")
    for item in attachments.list_files(thread_id):
        attachments.delete_file(thread_id, item["name"])
    return {"ok": True, **result}


@app.get("/api/threads/{thread_id}/attachments")
def list_attachments(thread_id: str):
    return {"files": attachments.list_files(thread_id)}


@app.post("/api/threads/{thread_id}/attachments")
async def upload_attachment(thread_id: str, file: UploadFile = File(...)):
    data = await file.read()
    try:
        saved = attachments.save_file(thread_id, file.filename or "anexo", data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, **saved}


@app.delete("/api/threads/{thread_id}/attachments/{filename}")
def delete_attachment(thread_id: str, filename: str):
    attachments.delete_file(thread_id, filename)
    return {"ok": True}


@app.post("/api/preload")
def preload(body: PreloadBody):
    ids = pick_preload(body.ids)
    results = []
    for thread_id in ids:
        try:
            item = assistant.analyze(thread_id)
            results.append(
                {
                    "id": thread_id,
                    "ok": True,
                    "has_summary": bool(item.get("summary")),
                    "has_draft": bool(item.get("draft")),
                }
            )
        except Exception as exc:
            results.append({"id": thread_id, "ok": False, "error": str(exc)})
            break
    return {"ids": ids, "results": results}


def _public(row: dict) -> dict:
    ts = int(row["internal_date"] or 0) / 1000
    dt = datetime.fromtimestamp(ts, TZ) if ts else None
    when = dt.strftime("%d/%m %H:%M") if dt else ""
    return {
        "id": row["id"],
        "subject": row["subject"],
        "from_email": row["from_email"],
        "from_name": row["from_name"],
        "snippet": row["snippet"],
        "time": when,
        "is_unread": bool(row["is_unread"]),
        "awaiting_reply": bool(row["awaiting_reply"]),
        "is_automatic": bool(row["is_automatic"]),
        "is_marketing": bool(row["is_marketing"]),
        "needs_action_hint": bool(row["needs_action_hint"]),
        "conferido": bool(row["conferido"]),
        "has_summary": bool(row.get("summary")),
        "has_draft": bool(row.get("draft")),
        "fyi_only": bool(row.get("fyi_only")),
    }
