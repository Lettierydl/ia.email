"""Estado da conexão com o Gmail (online | offline | auth_error) e o loop
de sincronização em segundo plano.

Antes não existia sync automático: a caixa local só mudava quando alguém
clicava "Atualizar" no /mail. O /copilot (e o ⟳ dele) só relia o que já
estava no banco -- dias sem sync pareciam "nada novo". Aqui o servidor puxa
o Gmail sozinho a cada SYNC_MINUTES (só leitura: threads.list/get) e guarda
se deu certo, para a UI mostrar "Sem conexão" em vez de dados velhos calados.
"""
from __future__ import annotations

import errno
import json
import socket
import ssl
import threading
import time
from datetime import datetime
from typing import Any

from . import config, store

ONLINE, OFFLINE, AUTH_ERROR = "online", "offline", "auth_error"
_META_KEY = "sync_status"
_LOCK = threading.Lock()
_NET_ERRNOS = {
    errno.ECONNREFUSED, errno.ECONNRESET, errno.ECONNABORTED, errno.ENETUNREACH,
    errno.EHOSTUNREACH, errno.ENETDOWN, errno.ETIMEDOUT, errno.EPIPE,
}


# ── classificação de erros ──
def _chain(exc: BaseException):
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        yield exc
        exc = exc.__cause__ or exc.__context__


def is_auth_error(exc: BaseException) -> bool:
    try:
        from google.auth.exceptions import RefreshError
    except Exception:  # pragma: no cover
        RefreshError = ()  # type: ignore
    for e in _chain(exc):
        if RefreshError and isinstance(e, RefreshError):
            return True
        status = getattr(getattr(e, "resp", None), "status", None)
        if status == 401:
            return True
        text = str(e).lower()
        if isinstance(e, RuntimeError) and ("nao autenticado" in text or "não autenticado" in text or "reautorize" in text):
            return True
        if "invalid_grant" in text or "token has been expired or revoked" in text:
            return True
    return False


def is_network_error(exc: BaseException) -> bool:
    """DNS, conexão recusada/caída, timeout, TLS, Gmail 5xx: não dá para
    falar com o Gmail agora -- tentar de novo mais tarde resolve."""
    names = {"ServerNotFoundError", "TransportError", "ConnectionError", "ConnectTimeout",
             "ReadTimeout", "Timeout", "NewConnectionError", "MaxRetryError", "ProtocolError",
             "RemoteDisconnected", "IncompleteRead"}
    for e in _chain(exc):
        if isinstance(e, (socket.gaierror, socket.timeout, TimeoutError, ConnectionError, ssl.SSLError)):
            return True
        if isinstance(e, OSError) and getattr(e, "errno", None) in _NET_ERRNOS:
            return True
        if type(e).__name__ in names:
            return True
        status = getattr(getattr(e, "resp", None), "status", None)
        if isinstance(status, int) and status >= 500:
            return True
    return False


def is_ambiguous_send_error(exc: BaseException) -> bool:
    """Timeout/conexão caída DEPOIS de mandar o pedido: o Gmail pode ter
    enviado. Não reenviamos sozinhos (evita e-mail duplicado)."""
    for e in _chain(exc):
        if isinstance(e, (socket.timeout, TimeoutError)) or type(e).__name__ in {"ReadTimeout", "RemoteDisconnected", "IncompleteRead"}:
            return True
        if isinstance(e, OSError) and getattr(e, "errno", None) in {errno.ECONNRESET, errno.EPIPE, errno.ETIMEDOUT}:
            return True
    return False


def kind_of(exc: BaseException) -> str:
    if is_auth_error(exc):
        return AUTH_ERROR
    if is_network_error(exc):
        return OFFLINE
    return "error"


def short_error(exc: BaseException) -> str:
    text = f"{type(exc).__name__}: {exc}".strip()
    return text[:300]


# ── estado ──
def _now_iso() -> str:
    return datetime.now(config.TZ).isoformat(timespec="seconds")


def _load() -> dict[str, Any]:
    try:
        data = json.loads(store.get_meta(_META_KEY) or "{}")
    except (ValueError, TypeError):
        data = {}
    return data if isinstance(data, dict) else {}


def _save(data: dict[str, Any]) -> None:
    store.set_meta(_META_KEY, json.dumps(data, ensure_ascii=False))


def mark_ok() -> dict[str, Any]:
    with _LOCK:
        data = _load()
        data.update(status=ONLINE, last_ok_at=_now_iso(), offline_since=None, failures=0)
        _save(data)
        return data


def mark_error(exc: BaseException, where: str = "sync") -> str:
    """Registra a falha; devolve o tipo (online não muda para erros comuns:
    um 400 de uma thread não significa que caiu a conexão)."""
    kind = kind_of(exc)
    with _LOCK:
        data = _load()
        data.update(last_error=short_error(exc), last_error_at=_now_iso(), last_error_where=where, last_error_kind=kind)
        if kind in (OFFLINE, AUTH_ERROR):
            if data.get("status") != kind:
                data["offline_since"] = _now_iso()
            data["status"] = kind
            data["failures"] = int(data.get("failures") or 0) + 1
        _save(data)
    return kind


def status() -> str:
    return _load().get("status") or ONLINE


def is_online() -> bool:
    return status() == ONLINE


def snapshot() -> dict[str, Any]:
    data = _load()
    counts = {}
    try:
        counts = json.loads(store.get_meta("gmail_counts") or "{}")
    except (ValueError, TypeError):
        counts = {}
    last_sync_at = store.get_meta("last_sync_at")
    stale_minutes = None
    if last_sync_at:
        try:
            stale_minutes = int((datetime.now(config.TZ) - datetime.fromisoformat(last_sync_at)).total_seconds() // 60)
        except ValueError:
            stale_minutes = None
    return {
        "status": data.get("status") or ONLINE,
        "last_sync_at": last_sync_at,
        "last_sync_label": sync_label(last_sync_at),
        "minutes_since_sync": stale_minutes,
        "last_ok_at": data.get("last_ok_at"),
        "last_error": data.get("last_error") or "",
        "last_error_at": data.get("last_error_at"),
        "last_error_kind": data.get("last_error_kind") or "",
        "offline_since": data.get("offline_since"),
        "gmail_primary_unread": counts.get("primary_unread"),
        "gmail_counts_at": counts.get("at"),
        "sync_minutes": sync_minutes(),
        "syncing": _SYNCING.is_set(),
    }


def sync_label(iso: str | None, now: datetime | None = None) -> str:
    """"hoje 18:19" vira só "18:19"; outro dia mostra a data -- o antigo
    last_refresh "18:19" escondia que o último sync era de 4 dias antes."""
    if not iso:
        return ""
    try:
        when = datetime.fromisoformat(iso)
    except ValueError:
        return iso
    now = now or datetime.now(config.TZ)
    if when.tzinfo is None:
        when = when.replace(tzinfo=config.TZ)
    when = when.astimezone(config.TZ)
    if when.date() == now.date():
        return when.strftime("%H:%M")
    return when.strftime("%d/%m %H:%M")


# ── sync ──
_SYNCING = threading.Event()


def sync_minutes() -> float:
    try:
        return float(getattr(config, "SYNC_MINUTES", 3))
    except (TypeError, ValueError):
        return 3.0


def run_sync(where: str = "sync") -> dict[str, Any]:
    """Um ciclo: puxa o Gmail e atualiza o estado. Exceções sobem (o
    endpoint /api/refresh traduz); o estado já fica gravado."""
    from . import gmail_client

    _SYNCING.set()
    try:
        counts = gmail_client.refresh()
    except gmail_client.QuotaPartial:
        mark_ok()  # falou com o Gmail; só a cota acabou
        raise
    except Exception as exc:
        mark_error(exc, where)
        raise
    finally:
        _SYNCING.clear()
    mark_ok()
    return counts


def _after_ok() -> None:
    # voltou a conexão: a fila de envio sai (só o que o Leo já confirmou)
    try:
        from . import outbox

        outbox.flush()
    except Exception as exc:
        print(f"[outbox] flush falhou: {exc}")


def sync_loop() -> None:
    """Loop em processo único (mesmo esquema do piloto: um container, um
    worker). Online: sync a cada SYNC_MINUTES. Offline/sem auth: tenta de
    novo com espera crescente (30s → 60s → ... até SYNC_MINUTES), sem
    encher o log -- só loga quando o estado muda."""
    backoff = 30.0
    last_logged = None
    time.sleep(5)
    while True:
        minutes = sync_minutes()
        if minutes <= 0:
            time.sleep(60)
            continue
        wait = minutes * 60
        try:
            run_sync("loop")
            backoff = 30.0
            if last_logged not in (None, ONLINE):
                print("[sync] conexão com o Gmail voltou")
            last_logged = ONLINE
            _after_ok()
        except Exception as exc:
            kind = kind_of(exc)
            if kind in (OFFLINE, AUTH_ERROR):
                if last_logged != kind:
                    print(f"[sync] {kind}: {short_error(exc)}")
                last_logged = kind
                wait = min(backoff, minutes * 60) if kind == OFFLINE else minutes * 60
                backoff = min(backoff * 2, minutes * 60)
            else:
                print(f"[sync] ciclo falhou: {short_error(exc)}")
        time.sleep(wait)
