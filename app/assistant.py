from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime

from . import context_base, gmail_client, llm, store
from .config import CONTEXT_GLOBAL_MAX_CHARS, CONTEXT_MD, EMAIL_EXPORT_DIR, EMAIL_EXPORT_RETENTION_DAYS

STYLE_PRESETS = {
    "formal": "Tom formal: frases completas, sem gírias, tratamento respeitoso, evite contrações informais.",
    "neutro": "Tom neutro e direto (padrão já usado hoje).",
    "direto": "Tom direto e mais informal: frases curtas, vai direto ao ponto.",
}

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

Marque so_copia=true quando Leo está apenas em cópia/FYI e o e-mail não pede
nada dele: atas de reunião distribuídas em massa, avisos de status entre
outras pessoas, threads onde a decisão já foi resolvida por terceiros, etc.
so_copia=true mesmo que o assunto pareça importante, desde que não haja
pedido/decisão direta a Leo. Nesse caso acao_leo deve ser false também.

Preencha nota_captura APENAS quando o e-mail tiver um fato durável que valha
guardar num arquivo de referência pessoal do Leo (uma decisão tomada, uma
regra/política definida, um número ou acordo que vai ser consultado depois).
Não preencha para chamados pontuais, cobranças rotineiras ou "ainda em
aberto". Se preencher, escreva 1-2 linhas objetivas, estilo nota de
referência (fato + data + quem decidiu), sem floreio. Deixe "" se não houver
nada que valha a pena.

Marque eh_propaganda=true para e-mail comercial/institucional de terceiros
sem relação de trabalho direta com Leo: convite de webinar, newsletter,
divulgação de produto/parceria, prospecção comercial (ex.: fornecedor
oferecendo serviço). NÃO marque para comunicação interna da Confrapag/Pulse/
Stalopay nem para threads de trabalho com clientes, parceiros ou fornecedores
já em relação ativa (mesmo que peça pra "conhecer uma solução").
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


_EMPTY_PARSED = {
    "resumo": "",
    "acao_leo": False,
    "sugestao": "",
    "so_copia": False,
    "nota_captura": "",
    "eh_propaganda": False,
}


def _parse_json(raw: str) -> dict:
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return {**_EMPTY_PARSED, "resumo": raw.strip()}
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {**_EMPTY_PARSED, "resumo": raw.strip()}
    return {
        "resumo": str(data.get("resumo") or "").strip(),
        "acao_leo": bool(data.get("acao_leo")),
        "sugestao": str(data.get("sugestao") or "").strip(),
        "nota_captura": str(data.get("nota_captura") or "").strip(),
        "so_copia": bool(data.get("so_copia")),
        "eh_propaganda": bool(data.get("eh_propaganda")),
    }


def _thread_moved_since_chat(row: dict) -> bool:
    """True se chegou mensagem nova na thread depois da ultima vez que
    resumo/chat foram gerados -- nesse caso o resumo/rascunho/conversa
    antigos nao fazem mais sentido e precisam recomecar do zero."""
    if not row:
        return False
    had_activity = bool(row.get("summary")) or bool(
        row.get("chat_json") and row.get("chat_json") not in ("[]", "")
    )
    anchor = row.get("chat_anchor_date")
    current = row.get("internal_date")
    if not had_activity or anchor is None or not current:
        return False
    return int(current) > int(anchor)


def analyze(thread_id: str, *, force: bool = False) -> dict:
    with _LOCK:
        row = store.get_thread(thread_id) or {}
        if _thread_moved_since_chat(row):
            store.save_ai(
                thread_id,
                summary="",
                draft="",
                chat_json="[]",
                body_text="",
                capture_note="",
                capture_status="",
            )
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
                    "fyi_only": bool(row.get("fyi_only")),
                    "capture_note": row.get("capture_note") or "",
                    "capture_status": row.get("capture_status"),
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
                "fyi_only": bool(row.get("fyi_only")),
                "capture_note": row.get("capture_note") or "",
                "capture_status": row.get("capture_status"),
                "cached": False,
                "warning": "Sem chave de LLM (Claude/Gemini/OpenRouter): não dá para resumir no estilo do painel. Cole uma chave no .env do cérebro.",
            }
        subject = row.get("subject") or ""
        raw = llm.complete(
            f"{SUMARIO_EXEMPLO}\n\n"
            "Agora resuma ESTA thread. JSON apenas:\n"
            '{"resumo":"Pedido: ...\\nFatos:\\n- ...\\nDecisão/ação de Leo:\\n- ...\\nRuído: ...",'
            '"acao_leo":true,'
            '"sugestao":"",'
            '"so_copia":false,'
            '"nota_captura":"",'
            '"eh_propaganda":false}\n'
            "sugestao só se der para responder sem inventar; senão string vazia.\n"
            "acao_leo=true só se pede decisão/validação direta do Leo.\n"
            "so_copia=true se Leo só está em cópia/FYI, sem nada pra fazer (ver regra no system).\n"
            "nota_captura só se houver fato durável pra guardar (ver regra no system).\n"
            "eh_propaganda só pra e-mail comercial de terceiros (ver regra no system).\n\n"
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
        save_kwargs = dict(
            summary=summary,
            draft=parsed["sugestao"],
            chat_json=json.dumps(chat),
            needs_action_hint=1 if parsed["acao_leo"] else 0,
            fyi_only=1 if parsed["so_copia"] else 0,
            chat_anchor_date=row.get("internal_date") or 0,
        )
        if parsed["eh_propaganda"]:
            save_kwargs["is_marketing"] = 1
        if parsed["nota_captura"]:
            save_kwargs["capture_note"] = parsed["nota_captura"]
            save_kwargs["capture_status"] = "pending"
        store.save_ai(thread_id, **save_kwargs)
        return {
            "id": thread_id,
            "subject": row.get("subject") or "",
            "from_email": row.get("from_email") or "",
            "summary": summary,
            "draft": parsed["sugestao"],
            "chat": chat,
            "fyi_only": parsed["so_copia"],
            "capture_note": parsed["nota_captura"],
            "capture_status": "pending" if parsed["nota_captura"] else None,
            "body": body,
            "needs_action_hint": parsed["acao_leo"],
            "cached": False,
        }


def _style_instructions(settings: dict) -> str:
    preset = STYLE_PRESETS.get(settings.get("style_preset") or "neutro", STYLE_PRESETS["neutro"])
    custom = (settings.get("style_custom") or "").strip()
    return f"{preset}\nInstrução extra de estilo do Leo: {custom}" if custom else preset


def _alias_glossary() -> str:
    aliases = store.list_aliases()
    lines = [
        f'- "{a["alias"]}" = {a["name"]} <{a["email"]}>'
        for a in aliases
        if a.get("name") or a.get("email")
    ]
    if not lines:
        return ""
    return "Apelidos que o Leo usa pra se referir a pessoas (resolva assim quando aparecer na instrução):\n" + "\n".join(lines)


def _draft_extra_context(instruction: str) -> str:
    settings = store.get_settings()
    blocks = [f"Estilo de escrita pedido:\n{_style_instructions(settings)}"]
    glossary = _alias_glossary()
    if glossary:
        blocks.append(glossary)
    if settings.get("context_enabled"):
        snippet, _used = context_base.build_context_snippet(settings.get("context_paths") or [])
        if snippet:
            blocks.append(
                "Base de conhecimento sobre e-mails/trabalho do Leo -- "
                "cite fatos daqui só se forem realmente relevantes pra instrução:\n" + snippet
            )
    if settings.get("context_global_enabled"):
        snippet, _used = context_base.build_context_snippet(
            settings.get("context_global_paths") or [], max_chars=CONTEXT_GLOBAL_MAX_CHARS
        )
        if snippet:
            blocks.append(
                "Base de conhecimento geral do Leo (sistemas, produto, processos -- Learning Base "
                "completa) -- use pra ter mais propriedade técnica e contexto de negócio, cite só o "
                "que for realmente relevante:\n" + snippet
            )
    return "\n\n".join(blocks) + "\n\n" if blocks else ""


def _parse_draft_response(raw: str) -> tuple[str, str]:
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(0))
            kind = data.get("kind")
            text = str(data.get("text") or "").strip()
            if kind in ("draft", "answer") and text:
                return kind, text
        except json.JSONDecodeError:
            pass
    return "draft", raw.strip()


def draft(thread_id: str, instruction: str, comment: str = "") -> dict:
    with _LOCK:
        body = _ensure_body(thread_id)
        row = store.get_thread(thread_id) or {}
        previous = row.get("draft") or ""
        if not llm.has_key():
            raise RuntimeError("Falta chave de LLM (Claude/Gemini/OpenRouter) para gerar rascunho.")
        raw = llm.complete(
            'Responda em JSON: {"kind": "draft" ou "answer", "text": "..."}.\n'
            'Use kind="draft" quando a instrução pede pra redigir/ajustar a resposta ao remetente -- '
            "text deve ser só o corpo do e-mail (sem assunto, sem markdown).\n"
            'Use kind="answer" quando a instrução é uma pergunta ou pedido de explicação sobre a '
            "thread (ex.: \"quanto foi cobrado?\", \"isso já foi resolvido?\") -- text é uma resposta "
            "direta em português, curta, sem virar e-mail.\n\n"
            f"{_draft_extra_context(instruction)}"
            f"Instrução do Leo: {instruction or '(gerar a partir do contexto)'}\n"
            f"Ajuste pedido: {comment or '(nenhum)'}\n"
            f"Rascunho anterior:\n{previous or '(nenhum)'}\n\n"
            f"Assunto: {row.get('subject')}\n\nThread:\n{body[:12000]}"
        )
        kind, text = _parse_draft_response(raw)

        chat = _load_chat(row)
        if instruction:
            chat.append({"role": "user", "text": instruction})
        chat.append({"role": "ai", "text": text, "kind": kind})

        save_fields: dict = {
            "chat_json": json.dumps(chat),
            "chat_anchor_date": row.get("internal_date") or 0,
        }
        if kind == "draft":
            save_fields["draft"] = text
        store.save_ai(thread_id, **save_fields)
        return {
            "id": thread_id,
            "draft": text if kind == "draft" else (row.get("draft") or ""),
            "chat": chat,
            "summary": row.get("summary") or "",
        }


def _slug(text: str, max_len: int = 60) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug[:max_len] or "sem-assunto"


def _cleanup_old_exports() -> None:
    if not EMAIL_EXPORT_DIR.is_dir():
        return
    cutoff = time.time() - EMAIL_EXPORT_RETENTION_DAYS * 86400
    for path in EMAIL_EXPORT_DIR.glob("*.md"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


def export_context(thread_id: str) -> dict:
    with _LOCK:
        row = store.get_thread(thread_id) or {}
        if not row:
            raise RuntimeError("Thread não está no radar. Atualize a lista.")
        body = _ensure_body(thread_id)
        subject = row.get("subject") or "(sem assunto)"
        chat = _load_chat(row)

        parts = [f"# {subject}", ""]
        parts.append(f"- **De:** {row.get('from_name') or ''} <{row.get('from_email') or ''}>")
        parts.append(f"- **Exportado em:** {datetime.now().strftime('%d/%m/%Y %H:%M')}")
        parts.append("")
        if row.get("summary"):
            parts += ["## Resumo (IA)", "", row["summary"], ""]
        if chat:
            parts += ["## Conversa (instruções e rascunhos)", ""]
            for msg in chat:
                who = "Você" if msg.get("role") == "user" else "IA"
                parts.append(f"**{who}:** {msg.get('text', '')}")
                parts.append("")
        parts += ["## Texto completo da thread", "", body, ""]
        markdown = "\n".join(parts)

        EMAIL_EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        _cleanup_old_exports()
        filename = f"{datetime.now().strftime('%Y-%m-%d')}_{_slug(subject)}_{thread_id[:8]}.md"
        export_path = EMAIL_EXPORT_DIR / filename
        export_path.write_text(markdown, encoding="utf-8")

        prompt = (
            f'Pegue o contexto do e-mail "{subject}" no arquivo '
            f"{export_path} antes de responder."
        )
        return {"path": str(export_path), "prompt": prompt}


def approve_capture(thread_id: str) -> dict:
    with _LOCK:
        row = store.get_thread(thread_id) or {}
        note = (row.get("capture_note") or "").strip()
        if not note:
            raise RuntimeError("Essa thread não tem nota de captura pendente.")
        subject = row.get("subject") or "(sem assunto)"
        entry = (
            f"\n\n## Captura do Radar — {datetime.now().strftime('%d/%m/%Y')} — {subject}\n"
            f"{note}\n"
        )
        CONTEXT_MD.parent.mkdir(parents=True, exist_ok=True)
        with CONTEXT_MD.open("a", encoding="utf-8") as fh:
            fh.write(entry)
        store.save_ai(thread_id, capture_status="approved")
        return {"ok": True, "path": str(CONTEXT_MD)}


def dismiss_capture(thread_id: str) -> dict:
    with _LOCK:
        store.save_ai(thread_id, capture_status="dismissed")
        return {"ok": True}
