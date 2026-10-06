"""Fila de envio (outbox): respostas/e-mails que o Leo JÁ CONFIRMOU mas que
não saíram porque não havia conexão com o Gmail.

Regras:
- Só entra aqui o que veio de um clique de Enviar confirmado (/send,
  /compose/send). Nada é gerado ou enfileirado sozinho; o piloto não usa.
- O worker tenta de novo com espera crescente; o Leo pode cancelar.
- reply_edits/métricas só são gravados depois do envio real.
- Erro "ambíguo" (timeout depois de mandar) NÃO é reenviado sozinho: vira
  "falhou" com aviso para conferir no Gmail -- melhor que e-mail duplicado.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from . import attachments, netstatus, store

QUEUED, SENDING, SENT, FAILED, CANCELLED = "queued", "sending", "sent", "failed", "cancelled"
OPEN_STATUSES = (QUEUED, SENDING, FAILED)
BACKOFF_BASE = 30  # s
BACKOFF_MAX = 15 * 60
WORKER_SECONDS = 20
_FLUSH_LOCK = threading.Lock()
_READY: set[str] = set()


def _ensure(conn) -> None:
    key = str(getattr(store, "DB_PATH", ""))
    if key in _READY:
        return
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,              -- reply | new
            thread_id TEXT,
            to_addr TEXT,
            cc TEXT,
            subject TEXT,
            body TEXT NOT NULL,
            attachments_json TEXT,           -- nomes dos anexos na hora da confirmação
            source TEXT,                     -- mail | copilot | compose
            ai_draft TEXT,                   -- rascunho da IA (p/ reply_edits após envio real)
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            next_attempt_at REAL,
            result_json TEXT,
            created_at TEXT,
            updated_at TEXT,
            sent_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status)")
    _READY.add(key)


def _conn():
    conn = store._connect()
    _ensure(conn)
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(r) -> dict[str, Any]:
    d = dict(r)
    try:
        d["attachments"] = json.loads(d.pop("attachments_json") or "[]")
    except (TypeError, ValueError):
        d["attachments"] = []
    return d


def enqueue(*, kind: str, body: str, thread_id: str = "", to: str = "", cc: str = "", subject: str = "",
            source: str = "mail", ai_draft: str = "", files: list[str] | None = None, error: str = "") -> dict[str, Any]:
    """Grava um envio confirmado. Mesmo texto já na fila para a mesma
    thread/destinatário não duplica (duplo clique, retry da UI)."""
    if kind not in ("reply", "new"):
        raise ValueError("kind inválido")
    body = (body or "").strip()
    if not body:
        raise ValueError("Texto vazio.")
    if files is None:
        files = [f["name"] for f in attachments.list_files(thread_id)] if (kind == "reply" and thread_id) else []
    with _conn() as conn:
        dup = conn.execute(
            "SELECT * FROM outbox WHERE status IN (?, ?) AND kind=? AND COALESCE(thread_id,'')=? "
            "AND COALESCE(to_addr,'')=? AND body=?",
            (QUEUED, SENDING, kind, thread_id or "", to or "", body),
        ).fetchone()
        if dup:
            return _row(dup)
        item_id = uuid.uuid4().hex[:16]
        now = _now()
        conn.execute(
            "INSERT INTO outbox(id, kind, thread_id, to_addr, cc, subject, body, attachments_json, source, ai_draft, "
            "status, attempts, last_error, next_attempt_at, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
            (item_id, kind, thread_id or "", to or "", cc or "", subject or "", body, json.dumps(files),
             source or "mail", ai_draft or "", QUEUED, error[:300], time.time() + BACKOFF_BASE, now, now),
        )
        r = conn.execute("SELECT * FROM outbox WHERE id=?", (item_id,)).fetchone()
    store.log_event("outbox_queued", thread_id or "")
    return _row(r)


def get(item_id: str) -> dict[str, Any] | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM outbox WHERE id=?", (item_id,)).fetchone()
    return _row(r) if r else None


def list_items(include_done: bool = False, limit: int = 50) -> list[dict[str, Any]]:
    sql = "SELECT * FROM outbox"
    args: tuple = ()
    if not include_done:
        sql += f" WHERE status IN ({', '.join('?' for _ in OPEN_STATUSES)})"
        args = OPEN_STATUSES
    sql += " ORDER BY created_at DESC LIMIT ?"
    with _conn() as conn:
        rows = conn.execute(sql, (*args, limit)).fetchall()
    return [_row(r) for r in rows]


def counts() -> dict[str, int]:
    with _conn() as conn:
        rows = conn.execute("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status").fetchall()
    out = {s: 0 for s in (QUEUED, SENDING, FAILED)}
    for r in rows:
        if r["status"] in out:
            out[r["status"]] = int(r["n"])
    out["pending"] = out[QUEUED] + out[SENDING]
    return out


def queued_for_thread(thread_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM outbox WHERE thread_id=? AND status IN ({', '.join('?' for _ in OPEN_STATUSES)}) ORDER BY created_at",
            (thread_id, *OPEN_STATUSES),
        ).fetchall()
    return [_row(r) for r in rows]


def _set(item_id: str, **fields: Any) -> None:
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k}=?" for k in fields)
    with _conn() as conn:
        conn.execute(f"UPDATE outbox SET {cols} WHERE id=?", (*fields.values(), item_id))


def cancel(item_id: str) -> dict[str, Any]:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM outbox WHERE id=?", (item_id,)).fetchone()
        if not r:
            raise LookupError("Item não está na fila.")
        if r["status"] not in (QUEUED, FAILED):
            raise ValueError("Esse envio já está saindo (ou já saiu) e não pode mais ser cancelado.")
        conn.execute("UPDATE outbox SET status=?, updated_at=? WHERE id=?", (CANCELLED, _now(), item_id))
    return get(item_id) or {}


def retry(item_id: str) -> dict[str, Any]:
    """Pedido explícito do Leo para tentar de novo um item (falhou ou na fila)."""
    item = get(item_id)
    if not item:
        raise LookupError("Item não está na fila.")
    if item["status"] not in (QUEUED, FAILED):
        raise ValueError("Esse envio não está aguardando.")
    _set(item_id, status=QUEUED, next_attempt_at=time.time())
    flush(only_id=item_id)
    return get(item_id) or {}


def recover_interrupted() -> int:
    """No boot: "sending" = o processo morreu no meio do envio. Pode ter
    saído -- não reenvia sozinho, deixa para o Leo conferir."""
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE outbox SET status=?, last_error=?, updated_at=? WHERE status=?",
            (FAILED, "Envio interrompido (o app reiniciou no meio). Confira no Gmail se saiu antes de tentar de novo.",
             _now(), SENDING),
        )
        return cur.rowcount or 0


# ── envio real ──
def finalize_reply(thread_id: str, text: str, ai_draft: str, source: str) -> None:
    """Pós-envio de uma resposta (mesmo do /send direto). Tudo aqui é
    "melhor esforço": o e-mail já saiu, nada disso pode virar erro."""
    from . import gmail_client

    for step in (lambda: gmail_client.mark_threads_read([thread_id]), lambda: gmail_client.refresh_thread(thread_id)):
        try:
            step()
        except Exception as exc:
            print(f"[envio] pós-envio falhou ({thread_id}): {netstatus.short_error(exc)}")
    if ai_draft:
        store.log_reply_edit(thread_id, ai_draft, text, "copilot" if source == "copilot" else "mail")
    row = store.get_thread(thread_id) or {}
    store.save_ai(
        thread_id,
        draft="",
        chat_anchor_date=row.get("internal_date") or 0,
        sent_via_app_at=int(datetime.now().timestamp() * 1000),
    )
    store.log_event("sent", thread_id)
    for item in attachments.list_files(thread_id):
        attachments.delete_file(thread_id, item["name"])


def finalize_new(result: dict[str, Any]) -> None:
    from . import gmail_client

    thread_id = result.get("thread_id")
    if thread_id:
        try:
            gmail_client.refresh_thread(thread_id)
            store.save_ai(thread_id, sent_via_app_at=int(datetime.now().timestamp() * 1000))
        except Exception:
            pass
    store.log_event("compose_sent", thread_id or "")


def _deliver(item: dict[str, Any]) -> dict[str, Any]:
    from . import gmail_client

    if item["kind"] == "reply":
        result = gmail_client.send_reply(item["thread_id"], item["body"], cc=item.get("cc") or "",
                                         only_files=item.get("attachments") or [])
        finalize_reply(item["thread_id"], item["body"], item.get("ai_draft") or "", item.get("source") or "mail")
    else:
        result = gmail_client.send_new(item.get("to_addr") or "", item.get("cc") or "", item.get("subject") or "", item["body"])
        finalize_new(result)
    return result


def _backoff(attempts: int) -> float:
    return min(BACKOFF_BASE * (2 ** max(0, attempts - 1)), BACKOFF_MAX)


def flush(only_id: str | None = None, now: float | None = None) -> int:
    """Tenta mandar o que está na fila e já passou da espera. Devolve
    quantos saíram. Para no primeiro erro de rede (sem conexão não adianta
    insistir nos outros)."""
    if not _FLUSH_LOCK.acquire(blocking=False):
        return 0
    sent = 0
    try:
        now = time.time() if now is None else now
        with _conn() as conn:
            if only_id:
                rows = conn.execute("SELECT * FROM outbox WHERE id=? AND status=?", (only_id, QUEUED)).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM outbox WHERE status=? AND COALESCE(next_attempt_at, 0) <= ? ORDER BY created_at",
                    (QUEUED, now),
                ).fetchall()
        for r in rows:
            item = _row(r)
            # trava otimista: só um worker pega o item
            with _conn() as conn:
                cur = conn.execute(
                    "UPDATE outbox SET status=?, attempts=attempts+1, updated_at=? WHERE id=? AND status=?",
                    (SENDING, _now(), item["id"], QUEUED),
                )
                if not cur.rowcount:
                    continue
            attempts = int(item.get("attempts") or 0) + 1
            try:
                result = _deliver(item)
            except Exception as exc:
                kind = netstatus.kind_of(exc)
                msg = netstatus.short_error(exc)
                if kind == netstatus.OFFLINE and netstatus.is_ambiguous_send_error(exc):
                    netstatus.mark_error(exc, "outbox")
                    _set(item["id"], status=FAILED, last_error="A conexão caiu durante o envio: pode ter saído. "
                         "Confira no Gmail antes de tentar de novo. (" + msg + ")")
                    break
                if kind in (netstatus.OFFLINE, netstatus.AUTH_ERROR):
                    netstatus.mark_error(exc, "outbox")
                    _set(item["id"], status=QUEUED, last_error=msg, next_attempt_at=now + _backoff(attempts))
                    break
                _set(item["id"], status=FAILED, last_error=msg)
                continue
            _set(item["id"], status=SENT, sent_at=_now(), last_error="", result_json=json.dumps(result, default=str))
            netstatus.mark_ok()
            sent += 1
    finally:
        _FLUSH_LOCK.release()
    return sent


def worker_loop() -> None:
    """Fica de olho na fila; sem nada na fila não faz nada (não chama o Gmail)."""
    try:
        recover_interrupted()
    except Exception as exc:
        print(f"[outbox] recuperação falhou: {exc}")
    while True:
        time.sleep(WORKER_SECONDS)
        try:
            if counts()[QUEUED]:
                flush()
        except Exception as exc:
            print(f"[outbox] ciclo falhou: {netstatus.short_error(exc)}")
