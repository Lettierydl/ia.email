"""Histórico de ações do Leo + Desfazer/Refazer (Cmd/Ctrl+Z no /copilot e /mail).

Cada ação do usuário (marcar como lido, resolver, mover, delegar, enviar...)
vira uma linha em historico_acoes com o retrato *só dos campos que mudaram*,
por thread: estado anterior e estado novo. Efeitos automáticos (análise da IA,
sync do Gmail) nunca entram aqui.

Desfazer = voltar cada campo ao anterior, mas só onde o valor atual ainda é o
que a ação deixou ("compare-and-set"). Se algo mudou depois (chegou mensagem
nova e o sync deixou a thread não lida de novo, a IA releu e reabriu, o Leo
editou o rascunho...), aquele campo fica como está: desfazer nunca atropela o
que aconteceu depois. Se nada puder voltar, responde 409 e a ação não é marcada
como desfeita. Refazer é o mesmo no sentido contrário.

Gmail: só a label UNREAD é revertida, e só nas threads em que a própria ação
tirou o UNREAD no Gmail (gmail_json). O Gmail vai primeiro; se falhar, nada
muda localmente (e o que já tinha ido ao Gmail volta) -- ver _run_gmail.
"""
from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

from . import store

ITEM_FIELDS = ("status", "papel", "depende_de_outros", "bola_json", "delegado_json", "tarefas_json")
THREAD_FIELDS = ("is_unread", "hidden", "is_marketing", "draft", "chat_json")
_INT_FIELDS = {"thread.is_unread", "thread.hidden", "thread.is_marketing"}

LABELS = {
    "marcar_lido": "Marcado como lido",
    "resolvido": "Resolvido",
    "resolver_coluna": "Resolvidos em lote",
    "reabrir": "Reaberto",
    "acompanhar": "Você acompanha",
    "mover": "Movido",
    "delegar": "Delegado",
    "cobrar": "Cobrança preparada",
    "aplicar": "Sugestão aplicada",
    "tarefa": "Tarefa",
    "enviar": "E-mail enviado",
    "salvar_rascunho": "Rascunho salvo",
    "ocultar": "Ocultado",
    "mostrar": "Voltou a aparecer",
    "nao_interessado": "Não tenho interesse",
}
# Cmd/Ctrl+Z global não pega rascunho: o próprio campo de texto tem o desfazer
# dele, e o autosave do composer tomaria o atalho de toda ação "de verdade".
# Rascunho salvo continua desfazível pelo botão da página Histórico.
SKIP_ULTIMO = ("salvar_rascunho",)
# Autosave do composer grava a cada pausa: edições seguidas da mesma thread
# viram uma linha só ("Rascunho salvo"), com o anterior de antes da 1ª edição.
DRAFT_COALESCE = timedelta(minutes=15)
NAO_ENVIO = "E-mail já enviado: não dá para desfazer."


class HistoryError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm(key: str, value: Any) -> Any:
    if key in _INT_FIELDS:
        return int(value or 0)
    if key == "remetente_bloqueado":
        return bool(value)
    return value if value is not None else ("" if key.startswith("thread.") else None)


def snapshot(thread_id: str) -> dict[str, Any] | None:
    row = store.get_thread(thread_id)
    if not row:
        return None
    item = store.get_copilot_item(thread_id) or {}
    snap: dict[str, Any] = {f"thread.{k}": _norm(f"thread.{k}", row.get(k)) for k in THREAD_FIELDS}
    snap.update({f"item.{k}": item.get(k) for k in ITEM_FIELDS})
    snap["remetente_bloqueado"] = store.is_blocked_sender(row.get("from_email") or "")
    return snap


def _diff(before: dict, after: dict) -> tuple[dict, dict]:
    keys = [k for k in after if before.get(k) != after.get(k)]
    return {k: before.get(k) for k in keys}, {k: after.get(k) for k in keys}


def _subject(thread_ids: list[str]) -> str:
    row = store.get_thread(thread_ids[0]) if thread_ids else None
    subject = (row or {}).get("subject") or "(sem assunto)"
    if len(thread_ids) > 1:
        return f"{len(thread_ids)} e-mails · {subject} e outros"
    return subject


def public(entry: dict | None) -> dict | None:
    if not entry:
        return None
    acao, detalhe = entry["acao"], entry.get("detalhe") or ""
    rotulo = LABELS.get(acao, acao)
    if acao == "mover" and detalhe:
        rotulo = f"Movido para {detalhe}"
    elif acao == "tarefa" and detalhe:
        rotulo = detalhe
    elif acao == "resolvido" and detalhe:
        rotulo = f"Resolvido {detalhe}"
    elif acao == "delegar" and detalhe:
        rotulo = f"Delegado para {detalhe}"
    elif acao == "resolver_coluna" and detalhe:
        rotulo = f"Resolvidos em lote · {detalhe}"
    ids = entry.get("thread_ids") or ([entry["thread_id"]] if entry.get("thread_id") else [])
    desfeito = bool(entry.get("desfeito_em"))
    return {
        "id": entry["id"], "at": entry["at"], "thread_id": entry.get("thread_id") or "", "thread_ids": ids,
        "n": len(ids), "assunto": entry.get("assunto") or "", "acao": acao, "rotulo": rotulo, "detalhe": detalhe,
        "origem": entry.get("origem") or "", "desfazivel": entry["desfazivel"], "motivo": entry.get("motivo") or "",
        "desfeito": desfeito, "desfeito_em": entry.get("desfeito_em"), "refeito_em": entry.get("refeito_em"),
        "grupo_id": entry.get("grupo_id"),
        "estado": "nao_reversivel" if not entry["desfazivel"] else "desfeito" if desfeito else "ativo",
    }


def record(
    acao: str, before: dict[str, dict | None], *, origem: str = "", detalhe: str = "", gmail: list[str] | None = None,
    desfazivel: bool = True, motivo: str = "", assunto: str = "",
) -> dict | None:
    """Grava a ação com o retrato depois dela. Melhor esforço: o histórico
    nunca pode derrubar a ação, que já aconteceu."""
    try:
        ids = list(before)
        anterior, novo = {}, {}
        for tid in ids:
            prev, after = before[tid], snapshot(tid)
            if prev is None or after is None:
                continue
            a, n = _diff(prev, after)
            if n:
                anterior[tid], novo[tid] = a, n
        if desfazivel and not novo:
            desfazivel, motivo = False, motivo or "Nada mudou: não há o que desfazer."
        lidos = [t for t in (gmail or []) if novo.get(t, {}).get("thread.is_unread") == 0]
        entry = store.add_historico(
            acao=acao, thread_ids=ids, assunto=assunto or _subject(ids), detalhe=detalhe, origem=origem,
            anterior=anterior, novo=novo, gmail=lidos, desfazivel=desfazivel, motivo=motivo,
            grupo_id=uuid.uuid4().hex if len(ids) > 1 else None,
        )
        return public(entry)
    except Exception as exc:  # noqa: BLE001
        print(f"[historico] não registrou {acao}: {exc}")
        return None


def take(thread_ids: list[str]) -> dict[str, dict | None]:
    out = {}
    for tid in thread_ids:
        try:
            out[tid] = snapshot(tid)
        except Exception:  # noqa: BLE001
            out[tid] = None
    return out


@contextmanager
def tracking(acao: str, thread_ids: list[str], **kw: Any) -> Iterator[dict]:
    """with tracking("marcar_lido", ids, origem="mail") as rec: ... ;
    rec["gmail"] = ids que saíram do UNREAD no Gmail; rec["detalhe"] opcional.
    Ação que levanta erro não é registrada. Depois: rec["entry"]."""
    before = take(thread_ids)
    rec: dict[str, Any] = {}
    yield rec
    opts = {**kw, **{k: v for k, v in rec.items() if k in ("detalhe", "gmail", "desfazivel", "motivo")}}
    rec["entry"] = record(acao, before, **opts)


def record_send(thread_id: str, origem: str = "", assunto: str = "") -> dict | None:
    """Envio: entra no histórico, mas não desfaz (o e-mail já saiu)."""
    try:
        entry = store.add_historico(
            acao="enviar", thread_ids=[thread_id] if thread_id else [],
            assunto=assunto or (_subject([thread_id]) if thread_id else "(sem assunto)"), origem=origem,
            desfazivel=False, motivo="E-mail já enviado",
        )
        return public(entry)
    except Exception as exc:  # noqa: BLE001
        print(f"[historico] não registrou envio: {exc}")
        return None


def record_draft(thread_id: str, before_text: str, text: str, origem: str = "") -> dict | None:
    if (before_text or "") == (text or ""):
        return None
    try:
        last = store.list_historico(thread_id=thread_id, limit=1)
        if last:
            e = last[0]
            at = datetime.fromisoformat(e["at"])
            if (e["acao"] == "salvar_rascunho" and not e.get("desfeito_em") and e["thread_ids"] == [thread_id]
                    and datetime.now(timezone.utc) - at < DRAFT_COALESCE):
                novo = {thread_id: {"thread.draft": text}}
                store.update_historico(e["id"], at=_now(), estado_novo_json=json.dumps(novo, ensure_ascii=False))
                return public(store.get_historico(e["id"]))
        entry = store.add_historico(
            acao="salvar_rascunho", thread_ids=[thread_id], assunto=_subject([thread_id]), origem=origem,
            anterior={thread_id: {"thread.draft": before_text or ""}}, novo={thread_id: {"thread.draft": text}},
        )
        return public(entry)
    except Exception as exc:  # noqa: BLE001
        print(f"[historico] não registrou rascunho: {exc}")
        return None


# ── desfazer / refazer ──

def _plan(entry: dict, origem_estado: dict, destino_estado: dict) -> tuple[dict[str, dict], list[str]]:
    """Campos a gravar por thread (só onde o atual ainda é o de origem) e a
    lista de campos que mudaram depois da ação (ficam como estão)."""
    plan: dict[str, dict] = {}
    conflitos: list[str] = []
    for tid in entry["thread_ids"]:
        dst = destino_estado.get(tid) or {}
        src = origem_estado.get(tid) or {}
        if not dst:
            continue
        cur = snapshot(tid)
        if cur is None:
            conflitos.append(f"{tid}:thread")
            continue
        for key, value in dst.items():
            if cur.get(key) == value:
                continue
            if cur.get(key) == src.get(key):
                plan.setdefault(tid, {})[key] = value
            else:
                conflitos.append(f"{tid}:{key}")
    return plan, conflitos


def _run_gmail(ids: list[str], unread: bool) -> None:
    """Gmail antes do local, thread a thread. Falhou no meio: volta as que já
    foram (melhor esforço) e levanta -- o estado local não muda. Assim o app
    nunca fica "não lido" com o Gmail lido (o próximo sync desfaria sozinho,
    em silêncio) nem o contrário."""
    if not ids:
        return
    from . import gmail_client

    do = gmail_client.mark_threads_unread if unread else gmail_client.mark_threads_read
    back = gmail_client.mark_threads_read if unread else gmail_client.mark_threads_unread
    done: list[str] = []
    try:
        for tid in ids:
            do([tid])
            done.append(tid)
    except Exception as exc:
        if done:
            try:
                back(done)
            except Exception:  # noqa: BLE001
                pass
        verbo = "não lido" if unread else "lido"
        raise HistoryError(
            502,
            f"Não consegui marcar como {verbo} no Gmail ({_short(exc)}). Nada foi alterado; tente de novo daqui a pouco.",
        ) from exc


def _short(exc: Exception) -> str:
    text = str(exc).strip() or exc.__class__.__name__
    return text if len(text) <= 120 else text[:117] + "…"


def _apply_local(tid: str, fields: dict) -> None:
    thread = {k.split(".", 1)[1]: v for k, v in fields.items() if k.startswith("thread.")}
    item = {k.split(".", 1)[1]: v for k, v in fields.items() if k.startswith("item.")}
    if thread:
        store.set_thread_fields(tid, **thread)
    if item:
        store.save_copilot_item(tid, **item)
    if "remetente_bloqueado" in fields:
        email = (store.get_thread(tid) or {}).get("from_email") or ""
        (store.block_sender if fields["remetente_bloqueado"] else store.unblock_sender)(email)


def _apply(entry: dict, undo: bool) -> dict:
    src, dst = (entry["estado_novo"], entry["estado_anterior"]) if undo else (entry["estado_anterior"], entry["estado_novo"])
    plan, conflitos = _plan(entry, src, dst)
    if not plan and conflitos:
        raise HistoryError(
            409,
            "Esse e-mail mudou depois dessa ação (chegou mensagem nova ou houve outra ação); "
            + ("não há o que desfazer." if undo else "não há o que refazer."),
        )
    gmail_ids = [t for t in entry.get("gmail") or [] if "thread.is_unread" in plan.get(t, {})]
    _run_gmail(gmail_ids, unread=undo)
    for tid, fields in plan.items():
        _apply_local(tid, fields)
    return {"aplicados": sum(len(f) for f in plan.values()), "conflitos": len(conflitos), "gmail": gmail_ids}


def _get(entry_id: int) -> dict:
    entry = store.get_historico(entry_id)
    if not entry:
        raise HistoryError(404, "Ação não encontrada no histórico.")
    return entry


def undo(entry_id: int) -> dict:
    entry = _get(entry_id)
    if not entry["desfazivel"]:
        raise HistoryError(409, NAO_ENVIO if entry["acao"] == "enviar" else (entry.get("motivo") or "Essa ação não pode ser desfeita."))
    if entry.get("desfeito_em"):
        raise HistoryError(409, "Essa ação já foi desfeita.")
    res = _apply(entry, undo=True)
    store.update_historico(entry_id, desfeito_em=_now())
    return {"ok": True, **res, "entry": public(store.get_historico(entry_id))}


def redo(entry_id: int) -> dict:
    entry = _get(entry_id)
    if not entry.get("desfeito_em"):
        raise HistoryError(409, "Essa ação não está desfeita.")
    res = _apply(entry, undo=False)
    store.update_historico(entry_id, desfeito_em=None, refeito_em=_now())
    return {"ok": True, **res, "entry": public(store.get_historico(entry_id))}


def undo_last() -> dict:
    entry = store.last_historico_undoable(SKIP_ULTIMO)
    if not entry:
        raise HistoryError(404, "Nada para desfazer.")
    return undo(entry["id"])


def redo_last() -> dict:
    entry = store.last_historico_redoable(SKIP_ULTIMO)
    if not entry:
        raise HistoryError(404, "Nada para refazer.")
    return redo(entry["id"])


def listing(*, limit: int = 50, before: int | None = None, tipo: str = "", q: str = "") -> dict:
    limit = max(1, min(int(limit or 50), 200))
    acoes = [t for t in (tipo or "").split(",") if t.strip()]
    rows = store.list_historico(limit=limit + 1, before=before, acoes=acoes or None, q=(q or "").strip())
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [public(r) for r in rows],
        "proximo": rows[-1]["id"] if more and rows else None,
        "tipos": [{"key": k, "label": v} for k, v in LABELS.items()],
    }
