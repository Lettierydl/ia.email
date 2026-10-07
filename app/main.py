from __future__ import annotations

from datetime import datetime
from typing import List, Optional
import mimetypes
import os
import re
import threading
import time
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from googleapiclient.errors import HttpError

from pydantic import BaseModel

from . import assist, assistant, attachments, board, calendar_client, copilot, context_base, fs_browser, gmail_client, learned, llm, metrics, netstatus, outbox, people_client, rag, store, summary_templates
from .gmail_client import QuotaPartial
from .preload import pick_preload
from .config import ACCOUNT, CONTEXT_MD, ROOT, TZ

STATIC = ROOT / "static"

app = FastAPI(title="IA.Email")
store.init()
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def _autopilot_loop() -> None:
    # Loop em processo único (sem fila/scheduler externo) -- só funciona
    # corretamente com um único worker/processo, que é o setup atual (um
    # container, uvicorn sem --workers). Uma falha num ciclo não mata o
    # loop; só loga e tenta de novo no próximo intervalo.
    while True:
        try:
            settings = store.get_settings()
            scan_minutes = max(1, int(settings.get("autopilot_scan_minutes") or 5))
        except Exception:
            scan_minutes = 5
        time.sleep(scan_minutes * 60)
        try:
            current = store.get_settings()
            if current.get("autopilot_enabled") and current.get("autopilot_mode") == "auxiliar":
                assist.background_tick()
            else:
                assistant.run_autopilot_scan_tick()
        except Exception as exc:
            print(f"[autopilot] ciclo falhou: {exc}")


def _warm_llm_catalog() -> None:
    try:
        llm.openrouter_catalog()
    except Exception:
        pass


def _rag_initial_sync() -> None:
    try:
        rag.sync()
    except Exception as exc:
        print(f"[rag] indexação inicial falhou: {exc}")


@app.on_event("startup")
def _start_autopilot_loop() -> None:
    threading.Thread(target=_autopilot_loop, daemon=True).start()
    threading.Thread(target=_rag_initial_sync, daemon=True).start()
    threading.Thread(target=_warm_llm_catalog, daemon=True).start()
    # Sync automático do Gmail (só leitura) e fila de envio. Antes não havia
    # sync nenhum: a caixa só mudava no botão Atualizar do /mail.
    threading.Thread(target=netstatus.sync_loop, daemon=True).start()
    threading.Thread(target=outbox.worker_loop, daemon=True).start()


class SetupBody(BaseModel):
    client_id: str
    client_secret: str


class DraftBody(BaseModel):
    instruction: str = ""
    comment: str = ""
    # texto editado na caixa (copiloto): vira o "Rascunho anterior" do prompt
    current_draft: str = ""


class LearnedBody(BaseModel):
    scope: str
    text: str
    thread_id: str = ""
    person_email: str = ""


class SaveDraftBody(BaseModel):
    """Persistência do rascunho editado (autosave). Sem LLM, sem envio."""
    text: str = ""


class SendBody(BaseModel):
    text: str
    cc: str = ""
    # de onde saiu o envio (/mail ou /copilot) -- só para o registro reply_edits
    source: str = "mail"


class ComposeBody(BaseModel):
    to: str
    cc: str = ""
    subject: str = ""
    text: str


class ComposeDraftBody(BaseModel):
    to: str = ""
    subject: str = ""
    instruction: str = ""
    comment: str = ""
    chat: List[dict] = []


class RsvpBody(BaseModel):
    response: str


class PreloadBody(BaseModel):
    ids: List[str]


class SettingsBody(BaseModel):
    context_enabled: Optional[bool] = None
    context_paths: Optional[List[str]] = None
    context_global_enabled: Optional[bool] = None
    context_global_paths: Optional[List[str]] = None
    style_preset: Optional[str] = None
    style_custom: Optional[str] = None
    preload_enabled: Optional[bool] = None
    preload_count: Optional[int] = None
    llm_models: Optional[List[str]] = None
    llm_reasoning: Optional[bool] = None
    summary_template: Optional[str] = None
    summary_custom: Optional[str] = None
    metric_minutes_summary: Optional[float] = None
    metric_minutes_reply: Optional[float] = None
    rag_enabled: Optional[bool] = None
    rag_top_k: Optional[int] = None
    rag_include_personal: Optional[bool] = None
    autopilot_enabled: Optional[bool] = None
    autopilot_mode: Optional[str] = None
    autopilot_level: Optional[str] = None
    autopilot_buffer_minutes: Optional[int] = None
    autopilot_scan_minutes: Optional[int] = None


class CopilotActionBody(BaseModel):
    action: str
    opcao: Optional[int] = None
    para: str = ""
    nome: str = ""
    modo: str = ""
    nota: str = ""
    index: Optional[int] = None
    feita: bool = True


class CopilotResolveColumnBody(BaseModel):
    tab: str
    thread_ids: Optional[list[str]] = None


class CopilotPrefsBody(BaseModel):
    skin: Optional[str] = None
    digest_daily: Optional[str] = None
    digest_weekly_day: Optional[int] = None
    digest_weekly_time: Optional[str] = None
    digest_enabled: Optional[bool] = None
    show_all: Optional[bool] = None
    show_tasks_card: Optional[bool] = None
    show_facts_card: Optional[bool] = None


class PathsBody(BaseModel):
    paths: List[str] = []


class AliasBody(BaseModel):
    alias: str
    name: str = ""
    email: str = ""


def _index():
    return FileResponse(
        STATIC / "index.html",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/")
def index():
    return _index()


@app.get("/favicon.ico")
def favicon():
    return RedirectResponse("/static/favicon.svg?v=2")


@app.get("/mail/{thread_id}")
def mail_page(thread_id: str):
    return _index()


@app.get("/compose")
def compose_page():
    return _index()


@app.get("/autopilot")
def autopilot_page():
    return _index()


@app.get("/settings")
def settings_page():
    return _index()


@app.get("/board")
def board_page():
    return FileResponse(STATIC / "board.html", headers={"Cache-Control": "no-store"})


@app.get("/copilot")
def copilot_page():
    return FileResponse(STATIC / "copilot.html", headers={"Cache-Control": "no-store"})


# Detalhe do copiloto em página inteira (desktop) com deep link; o JS lê o id do path.
@app.get("/copilot/{thread_id}")
def copilot_thread_page(thread_id: str):
    return copilot_page()


@app.get("/settings")
def settings_page():
    return _index()


def _last_refresh_label() -> str | None:
    """"18:19" sozinho escondia que o último sync era de outro dia."""
    return netstatus.sync_label(store.get_meta("last_sync_at")) or store.get_meta("last_refresh")


def _active_model_name() -> str:
    if not llm.has_key():
        return ""
    last = llm.last_used()
    if last and last.get("name"):
        return last["name"]
    usable = llm.usable_chain()
    return llm.display_name(usable[0]) if usable else ""


@app.get("/api/status")
def status():
    creds = gmail_client.load_credentials()
    return {
        "account": ACCOUNT,
        "has_client": gmail_client.has_client(),
        "authenticated": bool(creds),
        "last_refresh": _last_refresh_label(),
        "sync_status": netstatus.status(),
        "hidden": store.hidden_count(),
        "cached": store.thread_count(),
        "can_mark_read": gmail_client.has_modify_scope(creds),
        "can_send": gmail_client.has_send_scope(creds),
        "can_calendar": calendar_client.has_calendar_scope(creds),
        "can_people": people_client.has_people_scope(creds),
        "now": datetime.now(TZ).strftime("%H:%M"),
        "llm_provider": llm.provider_label(),
        "llm_tokens_today": store.llm_usage_today(),
        "preload_enabled": store.get_settings().get("preload_enabled", True),
        "preload_count": store.get_settings().get("preload_count", 2),
        "llm_model": _active_model_name(),
    }


@app.get("/api/auth/login")
def login():
    if not gmail_client.has_client():
        raise HTTPException(
            400,
            "Falta client OAuth. Cole o Client ID e o Secret no quadro abaixo, ou preencha ia_email/.env.",
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
        counts = netstatus.run_sync("manual")
    except QuotaPartial as exc:
        raise HTTPException(
            429,
            {
                "message": str(exc),
                "fetched": exc.ingested,
                "queued": exc.merged,
            },
        ) from exc
    except Exception as exc:
        kind = netstatus.kind_of(exc)
        if kind == netstatus.AUTH_ERROR:
            raise HTTPException(401, "O acesso ao Gmail expirou: entre no Gmail de novo.") from exc
        if kind == netstatus.OFFLINE:
            raise HTTPException(503, "Sem conexão com o Gmail: não consegui baixar e-mails novos.") from exc
        if isinstance(exc, RuntimeError):
            raise HTTPException(401, str(exc)) from exc
        raise
    return {"ok": True, **counts, "last_refresh": _last_refresh_label()}


def _sync_status() -> dict:
    return {**netstatus.snapshot(), "outbox": outbox.counts()}


@app.get("/api/sync/status")
def sync_status():
    return _sync_status()


@app.post("/api/sync/now")
def sync_now():
    """Botão "Tentar agora"/⟳: um sync na hora. Nunca levanta erro -- o
    estado (online/offline/auth_error) volta no corpo."""
    counts: dict = {}
    try:
        counts = netstatus.run_sync("manual")
    except QuotaPartial as exc:
        counts = {"fetched": exc.ingested, "quota": True}
    except Exception:
        pass
    if netstatus.is_online():
        try:
            outbox.flush()
        except Exception:
            pass
    return {**_sync_status(), "result": counts}


@app.get("/api/outbox")
def outbox_list(all: bool = Query(False)):
    return {"items": outbox.list_items(include_done=all), "counts": outbox.counts()}


@app.post("/api/outbox/{item_id}/cancel")
def outbox_cancel(item_id: str):
    try:
        return outbox.cancel(item_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/outbox/{item_id}/retry")
def outbox_retry(item_id: str):
    try:
        return outbox.retry(item_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


_QUEUED_MSG = "Sem conexão com o Gmail: ficou na fila de envio e sai sozinho quando a conexão voltar."
_AUTH_QUEUED_MSG = "O acesso ao Gmail expirou: ficou na fila de envio e sai depois que você entrar no Gmail de novo."


def _queued_response(item: dict, kind: str) -> JSONResponse:
    return JSONResponse(
        status_code=202,
        content={
            "ok": True,
            "queued": True,
            "outbox_id": item["id"],
            "status": item["status"],
            "message": _AUTH_QUEUED_MSG if kind == netstatus.AUTH_ERROR else _QUEUED_MSG,
        },
    )


@app.get("/api/radar")
def radar(
    q: str = "",
    acao_sua: bool = False,
    restore_hidden: bool = False,
):
    rows = store.list_visible(include_hidden=restore_hidden)
    needle = q.strip().lower()
    unread, waiting, automatic, promotions = [], [], [], []
    for row in rows:
        if acao_sua and not row["needs_action_hint"]:
            continue
        hay = f"{row['from_email']} {row['from_name']} {row['subject']}".lower()
        if needle and needle not in hay:
            continue
        item = _public(row)
        if row["is_marketing"]:
            promotions.append(item)
            continue
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

    sent = []
    for row in store.list_recent_sent(limit=20):
        hay = f"{row['from_email']} {row['from_name']} {row['subject']}".lower()
        if needle and needle not in hay:
            continue
        sent.append(_public(row, use_sent_time=True))

    return {
        "account": ACCOUNT,
        "last_refresh": _last_refresh_label(),
        "unanswered": unanswered,
        "needs_action": action,
        "hidden": store.hidden_count(),
        "unread": unread,
        "waiting": waiting,
        "promotions": promotions,
        "automatic": automatic,
        "sent": sent,
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


@app.get("/api/threads/{thread_id}/original-preview")
def thread_original_preview(thread_id: str):
    # So o corpo cru (do cache local ou do Gmail), sem passar pelo resumo da
    # IA -- usado no ícone de olho da lista pra pré-visualizar em hover sem
    # gastar chamada de LLM.
    row = store.get_thread(thread_id)
    if not row:
        raise HTTPException(404, "Thread não encontrada.")
    try:
        body = assistant._ensure_body(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    draft = row.get("draft") or ""
    return {
        "subject": row.get("subject") or "",
        "from_email": row.get("from_email") or "",
        "from_name": row.get("from_name") or "",
        "body": body,
        "draft": draft,
        "has_draft": bool(str(draft).strip()),
    }


@app.get("/api/threads/{thread_id}/draft")
def thread_get_draft(thread_id: str):
    """Rascunho salvo (sqlite), sem LLM — para pintar o composer na hora."""
    row = store.get_thread(thread_id)
    if not row:
        raise HTTPException(404, "Thread não encontrada.")
    text = row.get("draft") or ""
    return {"draft": text, "has_draft": bool(str(text).strip())}


@app.post("/api/threads/{thread_id}/save-draft")
def thread_save_draft(thread_id: str, body: SaveDraftBody):
    """Autosave do textarea: grava em sqlite sem chamar a IA e sem enviar."""
    row = store.get_thread(thread_id)
    if not row:
        raise HTTPException(404, "Thread não encontrada.")
    text = body.text if body.text is not None else ""
    store.save_ai(thread_id, draft=text)
    store.log_event("draft_save", thread_id)
    return {"ok": True, "len": len(text)}


@app.post("/api/threads/{thread_id}/draft")
def thread_draft(thread_id: str, body: DraftBody):
    try:
        # current_draft só vai quando veio (o /mail não manda): chamada idêntica à de antes
        extra = {"current_draft": body.current_draft} if body.current_draft.strip() else {}
        return assistant.draft(thread_id, body.instruction, body.comment, **extra)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


# ── Aprendizados (botão Aprender do copiloto): contexto p/ os próximos e-mails ──
@app.get("/api/learned")
def learned_list(thread_id: str = Query("")):
    notes = learned.for_thread(thread_id) if thread_id else store.list_learned_notes()
    return {"notes": notes}


@app.post("/api/learned")
def learned_add(body: LearnedBody):
    try:
        note = learned.add(body.scope, body.text, body.thread_id, body.person_email)
    except learned.LearnedError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"note": note}


@app.delete("/api/learned/{note_id}")
def learned_delete(note_id: int):
    if not learned.delete(note_id):
        raise HTTPException(404, "Aprendizado não encontrado.")
    return {"ok": True}


@app.post("/api/threads/{thread_id}/chat/reset")
def thread_chat_reset(thread_id: str):
    row = store.get_thread(thread_id)
    if not row:
        raise HTTPException(404, "Thread não encontrada.")
    store.save_ai(
        thread_id,
        chat_json="[]",
        draft="",
        chat_anchor_date=row.get("internal_date") or 0,
    )
    return {"ok": True}


@app.post("/api/threads/{thread_id}/export-context")
def thread_export_context(thread_id: str):
    try:
        return assistant.export_context(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/threads/{thread_id}/capture/approve")
def thread_capture_approve(thread_id: str):
    try:
        return assistant.approve_capture(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/threads/{thread_id}/capture/dismiss")
def thread_capture_dismiss(thread_id: str):
    return assistant.dismiss_capture(thread_id)


@app.post("/api/threads/{thread_id}/not-interested")
def thread_not_interested(thread_id: str):
    row = store.get_thread(thread_id)
    if not row:
        raise HTTPException(404, "Thread não encontrada.")
    email = row.get("from_email") or ""
    store.block_sender(email)
    store.save_ai(thread_id, is_marketing=1)
    return {"ok": True, "blocked": email}


@app.get("/api/threads/{thread_id}/invite")
def thread_invite(thread_id: str):
    creds = gmail_client.load_credentials()
    if not creds:
        raise HTTPException(401, "Gmail não autenticado.")
    try:
        ics = gmail_client.get_invite_ics(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not ics:
        return {"is_invite": False}
    info = calendar_client.parse_ics(ics)
    start = calendar_client.parse_ics_datetime(info.get("dtstart"))
    end = calendar_client.parse_ics_datetime(info.get("dtend")) or start
    base = {
        "is_invite": True,
        "uid": info.get("uid"),
        "summary": info.get("summary") or "",
        "start": start.strftime("%H:%M") if start else "",
        "end": end.strftime("%H:%M") if end else "",
        "start_iso": start.isoformat() if start else None,
        "day_label": calendar_client.day_label(start) if start else "",
    }
    if not start:
        return base
    if not calendar_client.has_calendar_scope(creds):
        return {**base, "needs_calendar_scope": True}
    try:
        ctx = calendar_client.day_context(creds, start, end, info.get("uid"))
    except Exception as exc:
        return {**base, "calendar_error": str(exc)}
    ctx["events"].append(
        {
            "summary": base["summary"] or "(sem título)",
            "start": base["start"],
            "end": base["end"],
            "start_iso": start.isoformat(),
            "end_iso": end.isoformat() if end else None,
            "all_day": False,
            "is_conflict": False,
            "is_target": True,
        }
    )
    return {**base, **ctx}


@app.post("/api/threads/{thread_id}/invite/rsvp")
def thread_invite_rsvp(thread_id: str, body: RsvpBody):
    if body.response not in ("accepted", "declined", "tentative"):
        raise HTTPException(400, "Resposta inválida.")
    creds = gmail_client.load_credentials()
    if not creds:
        raise HTTPException(401, "Gmail não autenticado.")
    if not calendar_client.has_calendar_scope(creds):
        raise HTTPException(
            400, "Reautorize o Gmail (Entrar no Gmail) para responder convites."
        )
    try:
        ics = gmail_client.get_invite_ics(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not ics:
        raise HTTPException(400, "Não é um convite de calendário.")
    info = calendar_client.parse_ics(ics)
    uid = info.get("uid")
    if not uid:
        raise HTTPException(400, "Convite sem identificador (UID).")
    try:
        result = calendar_client.respond_to_invite(creds, uid, body.response, ACCOUNT, ics_info=info)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, **result}


@app.post("/api/threads/{thread_id}/send")
def thread_send(thread_id: str, body: SendBody):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Texto vazio.")
    # rascunho da IA antes de enviar (o envio limpa o campo draft)
    ai_draft = ((store.get_thread(thread_id) or {}).get("draft") or "").strip()
    row = store.get_thread(thread_id) or {}

    def enqueue(error: str = "") -> dict:
        return outbox.enqueue(
            kind="reply", thread_id=thread_id, body=text, cc=body.cc, subject=row.get("subject") or "",
            to=row.get("from_email") or "", source=body.source, ai_draft=ai_draft, error=error,
        )

    # Sem conexão (ou sem acesso): o envio que o Leo confirmou vai para a
    # fila em vez de falhar; o worker manda quando o Gmail voltar.
    state = netstatus.status()
    if state != netstatus.ONLINE:
        return _queued_response(enqueue(), state)
    try:
        result = gmail_client.send_reply(thread_id, text, cc=body.cc)
    except Exception as exc:
        kind = netstatus.kind_of(exc)
        if kind != "error" and not netstatus.is_ambiguous_send_error(exc):
            netstatus.mark_error(exc, "send")
            return _queued_response(enqueue(netstatus.short_error(exc)), kind)
        if netstatus.is_ambiguous_send_error(exc):
            raise HTTPException(502, "A conexão caiu durante o envio: pode ter saído. Confira no Gmail antes de enviar de novo.") from exc
        if isinstance(exc, RuntimeError):
            raise HTTPException(400, str(exc)) from exc
        raise HTTPException(502, str(exc)) from exc
    # Saiu. Daqui pra baixo é melhor esforço: antes, falha ao marcar como
    # lido/re-buscar virava 502 com o e-mail já enviado (e o Leo reenviava).
    outbox.finalize_reply(thread_id, text, ai_draft, body.source)
    return {"ok": True, **result}


@app.get("/api/fs/browse")
def fs_browse(path: str = Query("")):
    try:
        return fs_browser.browse(path or None)
    except fs_browser.FsError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/fs/search")
def fs_search(q: str = Query("")):
    return {"items": fs_browser.search(q)}


@app.post("/api/fs/describe")
def fs_describe(body: PathsBody):
    return {"items": fs_browser.describe(body.paths)}


@app.get("/api/metrics")
def usage_metrics():
    return {"week": metrics.compute(7), "month": metrics.compute(30)}


@app.get("/api/summary/templates")
def summary_template_catalog():
    settings = store.get_settings()
    return {
        "items": [
            {"key": k, "name": t["name"], "description": t["description"], "sample": t["sample"], "headers": t["headers"]}
            for k, t in summary_templates.TEMPLATES.items()
        ],
        "headers": summary_templates.all_headers(),
        "selected": settings.get("summary_template") or summary_templates.DEFAULT_KEY,
        "custom": settings.get("summary_custom") or "",
    }


@app.get("/api/rag/status")
def rag_status():
    return rag.status()


@app.post("/api/rag/reindex")
def rag_reindex(force: bool = Query(False)):
    try:
        stats = rag.sync(force=force)
    except Exception as exc:
        raise HTTPException(502, f"Falha ao indexar: {exc}") from exc
    return {"ok": True, "stats": stats, **rag.status()}


@app.get("/api/rag/search")
def rag_search(q: str = Query(""), k: int = Query(6, ge=1, le=20)):
    hits = rag.search(q, k=k)
    return {
        "items": [
            {"source": h["source"], "title": h["title"], "snippet": h["body"][:320]} for h in hits
        ]
    }


@app.get("/api/llm/models")
def llm_models_catalog():
    try:
        return {"items": llm.catalog()}
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc


@app.get("/api/llm/config")
def llm_config():
    keys = llm._keys()
    configured = store.get_settings().get("llm_models") or []
    return {
        "models": [
            {
                "entry": e,
                "name": llm.display_name(e),
                "provider": llm.parse_entry(e)[0],
                "available": bool(keys.get(llm.parse_entry(e)[0])),
            }
            for e in llm.chain()
        ],
        "is_default": not configured,
        "last_used": llm.last_used(),
    }


@app.post("/api/llm/test")
def llm_test():
    try:
        llm.complete("Responda apenas: ok", timeout=40)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"ok": True, "last_used": llm.last_used()}


@app.post("/api/autopilot/patterns/refresh")
def autopilot_patterns_refresh():
    try:
        digest = assistant.build_reply_patterns_digest()
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"ok": True, "digest": digest}


@app.get("/api/autopilot/patterns")
def autopilot_patterns():
    return assistant.get_reply_patterns()


@app.post("/api/autopilot/decide/{thread_id}")
def autopilot_decide(thread_id: str):
    # Roda o motor de decisão pra UMA thread, sob demanda -- usado pra
    # testar/depurar e, pela própria página do piloto automático.
    try:
        return assistant.decide_autopilot_action(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


def _with_thread_info(items: list[dict]) -> list[dict]:
    out = []
    for item in items:
        row = store.get_thread(item.get("thread_id")) or {}
        out.append({**item, "subject": row.get("subject") or "", "from_email": row.get("from_email") or ""})
    return out


@app.post("/api/assistant/run")
def assistant_run(limit: int = Query(12, ge=1, le=40), force: bool = Query(False)):
    if not llm.has_key():
        raise HTTPException(400, "Falta chave de LLM (Gemini, OpenRouter ou Claude) no .env.")
    return assist.start(limit, force)


@app.get("/api/assistant/status")
def assistant_status():
    return assist.status()


@app.post("/api/assistant/cancel")
def assistant_cancel():
    return assist.cancel()


@app.get("/api/assistant/report")
def assistant_report():
    return assist.report()


@app.post("/api/assistant/{decision_id}/use")
def assistant_use(decision_id: str):
    try:
        return assist.use(decision_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/assistant/{decision_id}/dismiss")
def assistant_dismiss(decision_id: str):
    try:
        return assist.dismiss(decision_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/board")
def board_data():
    return board.build()


# ── Copiloto ── (rotas fixas antes de /api/copilot/{thread_id})
@app.get("/api/copilot")
def copilot_list(all: Optional[bool] = Query(None), user: Optional[str] = Query(None), q: str = Query("", max_length=200)):
    # abrir o painel já põe a IA para ler o que falta, em segundo plano
    if not q.strip():
        copilot.ensure_batch()
    # q = busca: olha lidos/resolvidos também (não só o quadro de não lidos)
    data = copilot.list_items(show_all=all, user=user, q=q)
    data["sync"] = _sync_status()
    return data


@app.get("/api/copilot/status")
def copilot_status():
    return copilot.job_status()


@app.post("/api/copilot/run")
def copilot_run(limit: int = Query(12, ge=1, le=40), force: bool = Query(False)):
    return copilot.start(limit, force)


@app.get("/api/copilot/digest")
def copilot_digest(period: str = Query("daily"), user: Optional[str] = Query(None)):
    try:
        return copilot.digest(period, user)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/copilot/settings")
def copilot_settings(user: Optional[str] = Query(None)):
    return copilot.get_prefs(user)


@app.post("/api/copilot/settings")
def copilot_settings_save(body: CopilotPrefsBody, user: Optional[str] = Query(None)):
    try:
        return copilot.save_prefs(user, **body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/copilot/resolve-column")
def copilot_resolve_column(body: CopilotResolveColumnBody, user: Optional[str] = Query(None)):
    # "Resolver todos" da coluna: marca resolvido + lido no Gmail; não envia nada
    try:
        return copilot.resolve_column(body.tab, body.thread_ids, user)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/copilot/{thread_id}")
def copilot_detail(thread_id: str, refresh: bool = Query(False), force: bool = Query(False)):
    try:
        return copilot.analyze(thread_id, force=True) if (refresh or force) else copilot.detail(thread_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/copilot/{thread_id}/action")
def copilot_action(thread_id: str, body: CopilotActionBody):
    try:
        return copilot.act(thread_id, body.action, body.model_dump())
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/autopilot/decisions/{decision_id}/dismiss")
def autopilot_dismiss(decision_id: str):
    try:
        return assistant.dismiss_autopilot_decision(decision_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/autopilot/queue")
def autopilot_queue():
    return {"items": _with_thread_info(store.list_autopilot_decisions(status="pending"))}


@app.get("/api/autopilot/log")
def autopilot_log():
    sent = store.list_autopilot_decisions(status="sent", limit=50)
    cancelled = store.list_autopilot_decisions(status="cancelled", limit=20)
    failed = store.list_autopilot_decisions(status="failed", limit=20)
    items = sorted(sent + cancelled + failed, key=lambda d: d.get("decided_at") or "", reverse=True)
    return {"items": _with_thread_info(items[:50])}


@app.get("/api/autopilot/alerts")
def autopilot_alerts():
    items = [d for d in store.list_autopilot_decisions(status="resolved", limit=100) if d["action"] == "alert"]
    return {"items": _with_thread_info(items)}


@app.get("/api/autopilot/drafts")
def autopilot_drafts():
    items = [d for d in store.list_autopilot_decisions(status="resolved", limit=100) if d["action"] == "draft_only"]
    return {"items": _with_thread_info(items)}


@app.post("/api/autopilot/queue/{decision_id}/cancel")
def autopilot_cancel(decision_id: str):
    try:
        return assistant.cancel_autopilot_decision(decision_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/autopilot/tick")
def autopilot_tick():
    # Dispara manualmente um ciclo do piloto automático -- útil pra testar
    # sem esperar o intervalo do loop em background, e é o mesmo código que
    # o loop chama sozinho.
    return assistant.run_autopilot_scan_tick()


@app.post("/api/compose/draft")
def compose_draft(body: ComposeDraftBody):
    try:
        return assistant.compose_draft(body.to, body.subject, body.instruction, body.comment, body.chat)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/compose/send")
def compose_send(body: ComposeBody):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Texto vazio.")
    if not body.to.strip():
        raise HTTPException(400, "Informe pelo menos um destinatário.")
    def enqueue(error: str = "") -> dict:
        return outbox.enqueue(kind="new", to=body.to, cc=body.cc, subject=body.subject, body=text,
                              source="compose", error=error)

    state = netstatus.status()
    if state != netstatus.ONLINE:
        return _queued_response(enqueue(), state)
    try:
        result = gmail_client.send_new(body.to, body.cc, body.subject, text)
    except Exception as exc:
        kind = netstatus.kind_of(exc)
        if kind != "error" and not netstatus.is_ambiguous_send_error(exc):
            netstatus.mark_error(exc, "send")
            return _queued_response(enqueue(netstatus.short_error(exc)), kind)
        if netstatus.is_ambiguous_send_error(exc):
            raise HTTPException(502, "A conexão caiu durante o envio: pode ter saído. Confira no Gmail antes de enviar de novo.") from exc
        if isinstance(exc, RuntimeError):
            raise HTTPException(400, str(exc)) from exc
        raise HTTPException(502, str(exc)) from exc
    outbox.finalize_new(result)
    return {"ok": True, **result}


@app.get("/api/avatar")
def avatar_lookup(email: str = Query(...)):
    creds = gmail_client.load_credentials()
    if not creds or not people_client.has_people_scope(creds):
        return {"photo_url": None}
    resolved, cached_url = store.get_avatar(email)
    if resolved:
        return {"photo_url": cached_url}
    try:
        url = people_client.resolve_avatar(creds, email)
    except Exception:
        url = None
    store.save_avatar(email, url)
    return {"photo_url": url}


@app.get("/api/threads/{thread_id}/recipients")
def thread_recipients(thread_id: str):
    try:
        return gmail_client.get_recipients(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/threads/{thread_id}/gmail-attachments")
def list_gmail_attachments(thread_id: str):
    try:
        return gmail_client.list_thread_attachments(thread_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


def _gmail_attachment_response(thread_id: str, message_id: str, attachment_id: str, filename: str, as_download: bool):
    try:
        data = gmail_client.get_attachment_bytes(thread_id, message_id, attachment_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except HttpError as exc:
        raise HTTPException(404, "Anexo não encontrado.") from exc
    ctype, _ = mimetypes.guess_type(filename)
    safe_name = re.sub(r'[\r\n"]', "_", filename)
    kind = "attachment" if as_download else "inline"
    disposition = f"{kind}; filename=\"{safe_name}\"; filename*=UTF-8''{quote(filename)}"
    return Response(
        content=data,
        media_type=ctype or "application/octet-stream",
        headers={"Content-Disposition": disposition},
    )


@app.get("/api/threads/{thread_id}/gmail-attachments/{message_id}/file")
def download_gmail_attachment_file(
    thread_id: str,
    message_id: str,
    attachment_id: str = Query(...),
    filename: str = Query("anexo"),
    download: bool = Query(False),
):
    """attachment_id na query: IDs longos/com caracteres especiais não quebram a rota."""
    return _gmail_attachment_response(thread_id, message_id, attachment_id, filename, download)


@app.get("/api/threads/{thread_id}/gmail-attachments/{message_id}/{attachment_id}")
def download_gmail_attachment(
    thread_id: str,
    message_id: str,
    attachment_id: str,
    filename: str = Query("anexo"),
    download: bool = Query(False),
):
    return _gmail_attachment_response(thread_id, message_id, attachment_id, filename, download)


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
    settings = store.get_settings()
    if not settings.get("preload_enabled", True):
        return {"ids": [], "results": []}
    ids = pick_preload(body.ids, settings.get("preload_count") or 2)
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


# ── Configurações: base de contexto, estilo, apelidos, arquivos ──
@app.get("/api/settings")
def get_settings():
    return {"settings": store.get_settings(), "aliases": store.list_aliases()}


@app.post("/api/settings")
def update_settings(body: SettingsBody):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if "autopilot_mode" in fields and fields["autopilot_mode"] not in ("piloto", "auxiliar"):
        raise HTTPException(400, "Modo desconhecido.")
    if "summary_template" in fields and fields["summary_template"] not in summary_templates.TEMPLATES:
        raise HTTPException(400, "Modelo de resumo desconhecido.")
    if "llm_models" in fields:
        seen: list[str] = []
        for entry in fields["llm_models"]:
            norm = llm.normalize_entry(entry)
            if norm not in seen:
                seen.append(norm)
        fields["llm_models"] = seen
    return {"settings": store.save_settings(**fields)}


@app.get("/api/settings/aliases")
def list_aliases():
    return {"aliases": store.list_aliases()}


@app.post("/api/settings/aliases")
def upsert_alias(body: AliasBody):
    if not body.alias.strip():
        raise HTTPException(400, "Apelido não pode ser vazio.")
    store.save_alias(body.alias, body.name, body.email)
    return {"aliases": store.list_aliases()}


@app.delete("/api/settings/aliases/{alias}")
def remove_alias(alias: str):
    store.delete_alias(alias)
    return {"aliases": store.list_aliases()}


@app.get("/api/settings/alias-suggest")
def alias_suggest(q: str = Query("")):
    if len(q.strip()) < 2:
        return {"suggestions": []}
    return {"suggestions": store.search_senders(q)}


@app.get("/api/settings/context-files")
def settings_context_files(base: str = Query("email")):
    settings = store.get_settings()
    key = "context_global_paths" if base == "global" else "context_paths"
    files = context_base.list_context_files(settings.get(key) or [])
    return {"files": files}


@app.get("/api/settings/generated-files")
def settings_generated_files():
    # As exportações agora podem estar em qualquer pasta radar-contextos/
    # da Learning Base (não só em principal_agents/emails/) -- ver
    # assistant.export_context() e assistant._learning_base_menu().
    exports = assistant.list_generated_exports()
    context_md = None
    if CONTEXT_MD.is_file():
        stat = CONTEXT_MD.stat()
        context_md = {"path": str(CONTEXT_MD), "size": stat.st_size, "modified_at": stat.st_mtime}
    return {"exports": exports, "context_md": context_md}


@app.delete("/api/settings/generated-files/{path:path}")
def delete_generated_file(path: str):
    try:
        assistant.delete_generated_export(path)
    except RuntimeError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"ok": True}


@app.delete("/api/settings/generated-files")
def delete_all_generated_files():
    return {"ok": True, "removed": assistant.delete_all_generated_exports()}


def _public(row: dict, *, use_sent_time: bool = False) -> dict:
    ts_field = "sent_via_app_at" if use_sent_time else "internal_date"
    ts = int(row.get(ts_field) or 0) / 1000
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
