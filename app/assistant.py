from __future__ import annotations

import json
import re
import threading

from . import gmail_client, llm, store

_LOCK = threading.Lock()

SUMARIO_SYSTEM = """Você resume e-mails para Leo (TI/Confrapag). Português do Brasil.
Nunca copie o e-mail. Nunca cole URL do Gmail (google.com/url).
Formato obrigatório do campo resumo, em texto puro:

Pedido: uma linha com o que o remetente quer de Leo.
Fatos:
- 3 a 6 bullets com números, prazos, sistemas e nomes citados
Decisão/ação de Leo:
- o que ele precisa validar, responder ou fazer
Ruído: uma linha se houver (cópia, marketing, aceite de agenda) ou "nenhum".

Se faltar evidência, escreva "Não identificado". Sem tom alarmista.
"""

SUMARIO_EXEMPLO = """Exemplo de resumo bom:
Pedido: Paulo pede validação técnica se Confrapag pode ser EC de operação.
Fatos:
- Confrapag está como EC/LA no tenant Pague Assim e gerou R$ 9.813,07 de comissão em 2026
- Pede 4 checagens: path_percent zerado, papéis OP/WL/EC, marcação de conta interna, esforço/prazo
- Limpeza de 3 sellers no CNPJ e correção de débito F6 de R$ 2.451,60
Decisão/ação de Leo:
- Confirmar se a comissão foi combinada e como travar comissão zero
Ruído: nenhum."""


def _looks_verbatim(summary: str, body: str, snippet: str) -> bool:
    text = (summary or "").strip()
    if not text:
        return True
    if "google.com/url" in text.lower():
        return True
    if not text.startswith(("Pedido:", "pedido:")) and "\n-" not in text and "Fatos:" not in text:
        seed = (snippet or body or "").strip()[:80]
        if seed and seed[:40] in text:
            return True
        if text.count("\n") < 2 and len(text) > 280:
            return True
    return False


def _load_chat(row: dict) -> list[dict]:
    raw = row.get("chat_json") if row else None
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def _ensure_body(thread_id: str) -> str:
    row = store.get_thread(thread_id)
    if not row:
        raise RuntimeError("Thread não está no radar. Atualize a lista.")
    if row.get("body_text"):
        return row["body_text"]
    text = gmail_client.get_thread_text(thread_id)
    store.save_ai(thread_id, body_text=text)
    return text


def _parse_json(raw: str) -> dict:
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return {"resumo": raw.strip(), "acao_leo": False, "sugestao": ""}
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"resumo": raw.strip(), "acao_leo": False, "sugestao": ""}
    return {
        "resumo": str(data.get("resumo") or "").strip(),
        "acao_leo": bool(data.get("acao_leo")),
        "sugestao": str(data.get("sugestao") or "").strip(),
    }


def analyze(thread_id: str, *, force: bool = False) -> dict:
    with _LOCK:
        row = store.get_thread(thread_id) or {}
        body = _ensure_body(thread_id)
        if row.get("summary") and not force:
            if not _looks_verbatim(
                row.get("summary") or "",
                row.get("body_text") or body,
                row.get("snippet") or "",
            ):
                return {
                    "id": thread_id,
                    "subject": row.get("subject") or "",
                    "from_email": row.get("from_email") or "",
                    "summary": row.get("summary") or "",
                    "draft": row.get("draft") or "",
                    "chat": _load_chat(row),
                    "body": body,
                    "needs_action_hint": bool(row.get("needs_action_hint")),
                    "cached": True,
                }
        if not llm.has_key():
            return {
                "id": thread_id,
                "subject": row.get("subject") or "",
                "from_email": row.get("from_email") or "",
                "summary": "",
                "draft": "",
                "chat": _load_chat(row),
                "body": body,
                "needs_action_hint": bool(row.get("needs_action_hint")),
                "cached": False,
                "warning": "Sem chave de LLM (Claude/Gemini/OpenRouter): não dá para resumir no estilo do painel. Cole uma chave no .env do cérebro.",
            }
        subject = row.get("subject") or ""
        raw = llm.complete(
            f"{SUMARIO_EXEMPLO}\n\n"
            "Agora resuma ESTA thread. JSON apenas:\n"
            '{"resumo":"Pedido: ...\\nFatos:\\n- ...\\nDecisão/ação de Leo:\\n- ...\\nRuído: ...",'
            '"acao_leo":true,'
            '"sugestao":""}\n'
            "sugestao só se der para responder sem inventar; senão string vazia.\n"
            "acao_leo=true só se pede decisão/validação direta do Leo.\n\n"
            f"Assunto: {subject}\n\n{body[:12000]}",
            system=llm.SYSTEM + "\n" + SUMARIO_SYSTEM,
        )
        parsed = _parse_json(raw)
        summary = parsed["resumo"] or raw
        if _looks_verbatim(summary, body, row.get("snippet") or ""):
            summary = (
                "Pedido: Não identificado com segurança (o modelo devolveu o texto do e-mail).\n"
                "Fatos:\n- Abra Texto completo e gere o resumo de novo.\n"
                "Decisão/ação de Leo:\n- Não identificado\n"
                "Ruído: não avaliado"
            )
        chat = _load_chat(row)
        if parsed["sugestao"] and not chat:
            chat = [{"role": "ai", "text": parsed["sugestao"]}]
        store.save_ai(
            thread_id,
            summary=summary,
            draft=parsed["sugestao"],
            chat_json=json.dumps(chat),
            needs_action_hint=1 if parsed["acao_leo"] else 0,
        )
        return {
            "id": thread_id,
            "subject": row.get("subject") or "",
            "from_email": row.get("from_email") or "",
            "summary": summary,
            "draft": parsed["sugestao"],
            "chat": chat,
            "body": body,
            "needs_action_hint": parsed["acao_leo"],
            "cached": False,
        }


def draft(thread_id: str, instruction: str, comment: str = "") -> dict:
    with _LOCK:
        body = _ensure_body(thread_id)
        row = store.get_thread(thread_id) or {}
        previous = row.get("draft") or ""
        if not llm.has_key():
            raise RuntimeError("Falta chave de LLM (Claude/Gemini/OpenRouter) para gerar rascunho.")
        text = llm.complete(
            "Escreva só o corpo do e-mail de resposta (sem assunto, sem markdown).\n"
            f"Instrução do Leo: {instruction or '(gerar a partir do contexto)'}\n"
            f"Ajuste pedido: {comment or '(nenhum)'}\n"
            f"Rascunho anterior:\n{previous or '(nenhum)'}\n\n"
            f"Assunto: {row.get('subject')}\n\nThread:\n{body[:12000]}"
        )
        chat = _load_chat(row)
        if instruction:
            chat.append({"role": "user", "text": instruction})
        chat.append({"role": "ai", "text": text})
        store.save_ai(thread_id, draft=text, chat_json=json.dumps(chat))
        return {
            "id": thread_id,
            "draft": text,
            "chat": chat,
            "summary": row.get("summary") or "",
        }
