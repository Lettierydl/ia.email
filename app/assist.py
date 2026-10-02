from __future__ import annotations

import json
import re
import threading
from datetime import datetime

from . import assistant, llm, rag, secrets_guard, store

# Modo "Auxiliar" do piloto: NUNCA envia nada. Analisa vários e-mails de uma
# vez e mostra, para cada um, ou "como eu responderia" (com o que embasou a
# resposta) ou "sem contexto suficiente" (com o que falta). A regra central é
# que só vira sugestão o que citar pelo menos um trecho real do cérebro ou do
# histórico -- se o modelo disser que sabe responder mas não apontar base,
# vai pra "sem contexto" (é o jeito de segurar resposta inventada com cara de
# confiante).

MIN_CONFIDENCE = 0.5
DEFAULT_LIMIT = 12
_EVIDENCE_SNIPPET = 220
_SOURCE_LABEL = {"kb": "cérebro", "mail": "e-mail recebido", "mail_sent": "resposta sua"}

_JOB_LOCK = threading.Lock()
_JOB: dict = {}


def _new_job(total: int) -> dict:
    return {
        "running": True,
        "cancel": False,
        "done": 0,
        "total": total,
        "current": "",
        "suggested": 0,
        "gaps": 0,
        "no_reply": 0,
        "errors": 0,
        "started_at": datetime.now().isoformat(),
        "finished_at": None,
    }


_JOB.update({**_new_job(0), "running": False})


# ── candidatos ──
def candidates(limit: int = DEFAULT_LIMIT, force: bool = False) -> list[str]:
    """E-mails que ainda esperam uma resposta e que o Auxiliar ainda não
    analisou (ou que ganharam mensagem nova desde a última análise)."""
    out: list[str] = []
    for row in store.list_visible():
        if not (row.get("is_unread") or row.get("awaiting_reply")):
            continue
        if row.get("is_marketing") or row.get("is_automatic"):
            continue
        prev = store.last_assist_decision(row["id"])
        if prev and not force:
            snapshot = prev.get("internal_date_snapshot") or 0
            if prev["status"] in ("open", "used") and int(row.get("internal_date") or 0) <= int(snapshot):
                continue
        out.append(row["id"])
        if len(out) >= limit:
            break
    return out


# ── decisão por e-mail ──
def _numbered(hits: list[dict]) -> str:
    return "\n\n".join(
        f"[{i}] ({_SOURCE_LABEL.get(h['source'], h['source'])}) {h['title']}\n{h['body'][:900]}"
        for i, h in enumerate(hits, 1)
    )


_CITATION_RE = re.compile(r"\s*[\(\[]\s*(?:trechos?|fonte|base)\s*\[?\d+(?:\s*[,e]\s*\d+)*\]?\s*[\)\]]", re.IGNORECASE)
_BRACKET_NUM_RE = re.compile(r"\s?\[\d+(?:\s*,\s*\d+)*\]")


def clean_draft(text: str) -> str:
    """Os números dos trechos ([1], "trecho [6]") são do prompt, não do e-mail:
    se o modelo deixar escapar um deles pro texto, sai antes de chegar no Leo."""
    text = _CITATION_RE.sub("", text or "")
    text = _BRACKET_NUM_RE.sub("", text)
    return re.sub(r"[ \t]+\n", "\n", re.sub(r"[ \t]{2,}", " ", text)).strip()


def _parse(raw: str) -> dict:
    match = re.search(r"\{.*\}", raw or "", re.DOTALL)
    try:
        data = json.loads(match.group(0)) if match else {}
    except json.JSONDecodeError:
        data = {}
    return data if isinstance(data, dict) else {}


def _save(thread_id: str, row: dict, action: str, *, confidence: float, reasoning: str, draft: str, extra: dict) -> dict:
    decision = {
        "thread_id": thread_id,
        "action": action,
        "confidence": confidence,
        "reasoning": reasoning,
        "draft_text": draft,
        "cc": "",
        "sensitivity_level": "auxiliar",
        "status": "open",
        "internal_date_snapshot": row.get("internal_date"),
        "evidence_json": json.dumps(extra, ensure_ascii=False),
    }
    decision["id"] = store.create_autopilot_decision(**decision)
    return decision


def decide(thread_id: str) -> dict:
    row = store.get_thread(thread_id) or {}
    if not row:
        raise RuntimeError("Thread não está no radar.")
    body = assistant._ensure_body(thread_id)
    subject = row.get("subject") or ""

    if secrets_guard.looks_like_secret(f"{subject}\n{body}"):
        return _save(
            thread_id, row, "needs_context", confidence=0.0, draft="",
            reasoning="O e-mail traz senha ou credencial, então não preparei resposta. Veja com calma.",
            extra={"evidence": [], "question": "", "sensitive": False},
        )

    readable = re.sub(r"^(De|Data):.*$", "", body, flags=re.MULTILINE)
    if len(re.sub(r"\s+", "", readable)) < 25:
        return _save(
            thread_id, row, "needs_context", confidence=0.0, draft="",
            reasoning="Não consegui ler o texto desse e-mail (veio vazio, só imagem ou anexo). Abra para ver.",
            extra={"evidence": [], "question": "", "sensitive": False},
        )

    sensitive = bool(assistant._MONEY_RE.search(f"{subject}\n{body}") or assistant._LEGAL_HR_RE.search(f"{subject}\n{body}"))
    hits = rag.search(f"{subject}\n{assistant._recent_body(body, 3000)}", k=8, exclude_ref=f"mail:{thread_id}")
    settings = store.get_settings()
    patterns = assistant.get_reply_patterns().get("digest") or ""
    glossary = assistant._alias_glossary()

    prompt = (
        "Você é o AUXILIAR do Leo: prepara resposta SÓ quando existe base concreta. Abaixo há trechos "
        "numerados do cérebro e do histórico de e-mails dele (decisões já tomadas, respostas parecidas "
        "que ele já deu, regras registradas).\n"
        "Regras:\n"
        "- can_answer=true SÓ se algum trecho sustenta o que você vai dizer. Cite os números em based_on "
        "e diga em uma linha por que cada um serve.\n"
        "- Se o e-mail pede uma decisão nova, um dado que você não tem, ou o contexto não cobre o assunto: "
        'can_answer=false; em "missing" diga o que falta; em "question" uma pergunta curta pro Leo, se couber.\n'
        "- needs_reply=false quando o e-mail é só informativo (ata, aviso, status, convite já respondido) e "
        "não pede nada ao Leo; nesse caso explique em uma frase em \"missing\" e deixe can_answer=false.\n"
        '- "question" é uma pergunta curta e direta ao Leo, tratando-o por "você" (nunca "o senhor").\n'
        "- NUNCA invente fato, valor, data ou nome que não esteja no e-mail ou nos trechos.\n"
        "- Escreva no estilo do Leo. Corpo do e-mail apenas (sem assunto, sem markdown).\n"
        "- NUNCA escreva no draft_text a palavra \"trecho\", números entre colchetes como [1] ou qualquer "
        "referência aos trechos numerados: eles são só para você citar em based_on. O e-mail deve ler como "
        "se o próprio Leo tivesse escrito, citando a decisão pelo conteúdo (ex.: \"conforme combinado em set/2026\").\n"
        'Responda em JSON: {"needs_reply": true|false, "can_answer": true|false, "confidence": 0.0-1.0, '
        '"draft_text": "...", "based_on": [{"n": 1, "why": "..."}], "missing": "...", "question": "..."}\n\n'
        f"Estilo pedido:\n{assistant._style_instructions(settings)}\n\n"
        + (f"{glossary}\n\n" if glossary else "")
        + f"Padrões de resposta conhecidos do Leo:\n{patterns or '(nenhum ainda)'}\n\n"
        + f"Trechos disponíveis:\n{_numbered(hits) if hits else '(nenhum trecho encontrado)'}\n\n"
        + f"Assunto: {subject}\n\nThread:\n{assistant._recent_body(body)}"
    )
    parsed = _parse(llm.complete(prompt, system=llm.SYSTEM))

    try:
        confidence = float(parsed.get("confidence") or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0
    draft = clean_draft(str(parsed.get("draft_text") or ""))
    evidence: list[dict] = []
    seen: set[int] = set()
    for item in parsed.get("based_on") or []:
        try:
            n = int(item.get("n") if isinstance(item, dict) else item)
        except (TypeError, ValueError):
            continue
        if 1 <= n <= len(hits) and n not in seen:
            seen.add(n)
            hit = hits[n - 1]
            evidence.append(
                {
                    "source": hit["source"],
                    "title": hit["title"],
                    "snippet": hit["body"][:_EVIDENCE_SNIPPET],
                    "why": str(item.get("why") or "").strip() if isinstance(item, dict) else "",
                }
            )

    question = str(parsed.get("question") or "").strip()
    if parsed.get("needs_reply") is False and parsed.get("can_answer") is not True:
        return _save(
            thread_id, row, "no_reply", confidence=confidence, draft="",
            reasoning=str(parsed.get("missing") or "").strip() or "E-mail informativo: não pede nada de você.",
            extra={"evidence": [], "question": "", "sensitive": sensitive},
        )
    if parsed.get("can_answer") is True and draft and evidence and confidence >= MIN_CONFIDENCE:
        return _save(
            thread_id, row, "suggest", confidence=confidence, draft=draft,
            reasoning="Baseado em " + "; ".join(e["title"] for e in evidence[:3]),
            extra={"evidence": evidence, "question": "", "sensitive": sensitive},
        )

    if parsed.get("can_answer") is True and draft and not evidence:
        why = "A IA disse que sabia responder, mas não apontou nenhuma base no cérebro ou no histórico. Por segurança, não sugeri."
    elif parsed.get("can_answer") is True and draft:
        why = "Há alguma base, mas a confiança ficou baixa para sugerir uma resposta."
    else:
        why = str(parsed.get("missing") or "").strip() or "Não encontrei no cérebro ou no histórico nada que sustente uma resposta."
    return _save(
        thread_id, row, "needs_context", confidence=confidence, draft="", reasoning=why,
        extra={"evidence": evidence, "question": question, "sensitive": sensitive},
    )


# ── lote em segundo plano ──
def status() -> dict:
    with _JOB_LOCK:
        return {k: v for k, v in _JOB.items() if k != "cancel"}


def start(limit: int = DEFAULT_LIMIT, force: bool = False) -> dict:
    limit = max(1, min(int(limit), 40))
    with _JOB_LOCK:
        if _JOB.get("running"):
            return {k: v for k, v in _JOB.items() if k != "cancel"}
        ids = candidates(limit, force)
        _JOB.clear()
        _JOB.update(_new_job(len(ids)))
        if not ids:
            _JOB.update(running=False, finished_at=datetime.now().isoformat())
            return {k: v for k, v in _JOB.items() if k != "cancel"}
    threading.Thread(target=_run, args=(ids,), daemon=True).start()
    return status()


def cancel() -> dict:
    with _JOB_LOCK:
        if _JOB.get("running"):
            _JOB["cancel"] = True
    return status()


def _run(ids: list[str]) -> None:
    for thread_id in ids:
        with _JOB_LOCK:
            if _JOB.get("cancel"):
                break
            row = store.get_thread(thread_id) or {}
            _JOB["current"] = row.get("subject") or ""
        try:
            result = decide(thread_id)
            key = {"suggest": "suggested", "no_reply": "no_reply"}.get(result["action"], "gaps")
        except Exception:
            key = "errors"
        with _JOB_LOCK:
            _JOB[key] += 1
            _JOB["done"] += 1
    with _JOB_LOCK:
        _JOB.update(running=False, current="", finished_at=datetime.now().isoformat())


def background_tick(max_candidates: int = 5) -> int:
    """Usado pelo loop em segundo plano quando o modo Auxiliar está ligado:
    analisa os e-mails novos aos poucos, sem enviar nada."""
    done = 0
    for thread_id in candidates(max_candidates):
        try:
            decide(thread_id)
            done += 1
        except Exception:
            continue
    return done


# ── relatório e ações ──
def _present(d: dict) -> dict:
    row = store.get_thread(d["thread_id"]) or {}
    extra = {}
    try:
        extra = json.loads(d.get("evidence_json") or "{}")
    except json.JSONDecodeError:
        pass
    return {
        "id": d["id"],
        "thread_id": d["thread_id"],
        "subject": row.get("subject") or "",
        "from_email": row.get("from_email") or "",
        "from_name": row.get("from_name") or "",
        "action": d["action"],
        "confidence": d.get("confidence") or 0.0,
        "reasoning": d.get("reasoning") or "",
        "draft_text": d.get("draft_text") or "",
        "evidence": extra.get("evidence") or [],
        "question": extra.get("question") or "",
        "sensitive": bool(extra.get("sensitive")),
        "decided_at": d.get("decided_at"),
    }


def report() -> dict:
    items = [_present(d) for d in store.list_assist_open()]
    return {
        "suggestions": [i for i in items if i["action"] == "suggest"],
        "gaps": [i for i in items if i["action"] == "needs_context"],
        "no_reply": [i for i in items if i["action"] == "no_reply"],
    }


def _open_decision(decision_id: str) -> dict:
    d = store.get_autopilot_decision(decision_id)
    if not d or d["action"] not in ("suggest", "needs_context", "no_reply"):
        raise RuntimeError("Sugestão não encontrada.")
    if d["status"] != "open":
        raise RuntimeError("Essa sugestão já foi tratada.")
    return d


def use(decision_id: str) -> dict:
    """Coloca a resposta sugerida como rascunho do e-mail (com o porquê dela)
    pra o Leo revisar e, se quiser, enviar pelo fluxo normal. Não envia nada."""
    d = _open_decision(decision_id)
    if d["action"] != "suggest" or not d.get("draft_text"):
        raise RuntimeError("Só dá pra usar uma resposta sugerida.")
    thread_id = d["thread_id"]
    row = store.get_thread(thread_id) or {}
    chat = assistant._load_chat(row)
    item = _present(d)
    if item["evidence"]:
        basis = "Como cheguei nessa resposta:\n" + "\n".join(
            f"- {_SOURCE_LABEL.get(e['source'], e['source'])}: {e['title']}" + (f" — {e['why']}" if e["why"] else "")
            for e in item["evidence"]
        )
        chat.append({"role": "ai", "text": basis, "kind": "answer"})
    chat.append({"role": "ai", "text": d["draft_text"], "kind": "draft"})
    store.save_ai(
        thread_id,
        draft=d["draft_text"],
        chat_json=json.dumps(chat),
        chat_anchor_date=row.get("internal_date") or 0,
    )
    store.update_autopilot_decision(decision_id, status="used")
    store.log_event("draft", thread_id)
    return {"thread_id": thread_id}


def dismiss(decision_id: str) -> dict:
    _open_decision(decision_id)
    store.update_autopilot_decision(decision_id, status="dismissed")
    return {"ok": True}
