from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime, timedelta

from . import attachments, context_base, copilot, fixpt, gmail_client, learned, llm, rag, secrets_guard, store, summary_templates
from .config import (
    ACCOUNT,
    CONTEXT_GLOBAL_MAX_CHARS,
    CONTEXT_MD,
    EMAIL_EXPORT_RETENTION_DAYS,
    LB_COMPANY_DIR,
    LB_PERSONAL_DIR,
    LEARNING_BASE_GLOBAL_DEFAULT,
)
from .preload import pick_preload

# Pasta-mãe de todas as categorias de captura (cada uma com README.md
# descrevendo o assunto + context.md pra acumular fatos, mesmo padrão que
# CONTEXT_MD já usava só pra "emails"). Derivado de CONTEXT_MD pra não
# duplicar o caminho em dois lugares.
CAPTURE_CATEGORIES_DIR = CONTEXT_MD.parent.parent
CAPTURE_FALLBACK_CATEGORY = CONTEXT_MD.parent.name

STYLE_PRESETS = {
    "formal": "Tom formal: frases completas, sem gírias, tratamento respeitoso, evite contrações informais.",
    "neutro": "Tom neutro e direto (padrão já usado hoje).",
    "direto": "Tom direto e mais informal: frases curtas, vai direto ao ponto.",
}

_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(thread_id: str) -> threading.Lock:
    """Lock por thread, não um lock global -- gerar resumo/rascunho de um
    e-mail (chamada de LLM, pode levar vários segundos) não pode travar a
    leitura de outro e-mail já em cache só porque os dois passam por
    analyze()/draft(). O global aqui era o motivo do app parecer travado
    durante o preload de fundo."""
    with _LOCKS_GUARD:
        lock = _LOCKS.get(thread_id)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[thread_id] = lock
        return lock


def _looks_verbatim(summary: str, body: str, snippet: str, strict_format: bool = True) -> bool:
    text = (summary or "").strip()
    if not text:
        return True
    if "google.com/url" in text.lower():
        return True
    seed = (snippet or body or "").strip()[:80]
    if strict_format:
        if not text.startswith(("Pedido:", "pedido:")) and "\n-" not in text and "Fatos:" not in text:
            if seed and seed[:40] in text:
                return True
            if text.count("\n") < 2 and len(text) > 280:
                return True
    elif seed and len(seed) >= 40 and seed[:40] in text:
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


def _recent_body(body: str, max_chars: int = 20000) -> str:
    """Corta pelo INÍCIO (mensagens mais antigas), não pelo fim. O pedido
    de verdade quase sempre está na mensagem mais recente, no fim da
    thread (é como o Gmail ordena) -- cortar pelo fim jogava fora
    justamente a parte que pede algo do Leo em threads longas, fazendo o
    resumo dizer "nenhuma ação" quando na real tinha um pedido direto lá
    embaixo que nunca chegou a ser lido pela IA."""
    if len(body) <= max_chars:
        return body
    tail = body[-max_chars:]
    sep = "\n\n----\n\n"
    sep_idx = tail.find(sep)
    if sep_idx != -1:
        tail = tail[sep_idx + len(sep):]
    return "[...thread truncada, mensagens mais antigas omitidas...]\n\n" + tail


_MSG_HEAD_RE = re.compile(r"^De:\s*(.+?)\s*$\n^Data:\s*(.+?)\s*$", re.M)
_LEO_ADDR_RE = re.compile(r"leo@confrapag\.com\.br", re.I)


def _thread_outline(body: str) -> str:
    """Mapa da thread (quem escreveu cada mensagem, em ordem) com a ÚLTIMA
    destacada. Sem isso o modelo respondia à primeira mensagem (ou a quem
    aparece primeiro) e repetia o que o Leo já tinha respondido antes."""
    heads = _MSG_HEAD_RE.findall(body or "")
    if len(heads) < 2:
        return ""
    lines = []
    last_other = None
    for i, (who, when) in enumerate(heads, 1):
        mine = bool(_LEO_ADDR_RE.search(who))
        lines.append(f"{i}. {'Leo (já enviada)' if mine else who} — {when}")
        if not mine:
            last_other = (i, who)
    out = "Mensagens da thread, da mais antiga para a mais recente:\n" + "\n".join(lines) + "\n"
    if last_other:
        out += (
            f"O rascunho responde à mensagem mais recente de outra pessoa (nº {last_other[0]}, de "
            f"{last_other[1]}): cumprimente e responda a ESSA pessoa e ao que ELA perguntou. As "
            "anteriores são só histórico: o que o Leo já respondeu nelas não se repete, e perguntas "
            "antigas já respondidas por ele não entram de novo.\n"
        )
    return out + "\n"


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
    with _lock_for(thread_id):
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
                summary_templates.is_default(store.get_settings()),
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
        settings = store.get_settings()
        raw = llm.complete(
            f"{summary_templates.example(settings)}\n\n"
            "Agora resuma ESTA thread. JSON apenas:\n"
            f"{summary_templates.json_spec()}\n"
            "sugestao só se der para responder sem inventar; senão string vazia.\n"
            "acao_leo=true só se pede decisão/validação direta do Leo.\n"
            "so_copia=true se Leo só está em cópia/FYI, sem nada pra fazer (ver regra no system).\n"
            "nota_captura só se houver fato durável pra guardar (ver regra no system).\n"
            "eh_propaganda só pra e-mail comercial de terceiros (ver regra no system).\n\n"
            f"Assunto: {subject}\n\n{_recent_body(body)}",
            system=llm.SYSTEM + "\n" + summary_templates.build_system(settings),
        )
        parsed = _parse_json(raw)
        if secrets_guard.looks_like_secret(parsed["nota_captura"]):
            parsed["nota_captura"] = ""  # nunca sugerir guardar senha/credencial no cérebro
        summary = parsed["resumo"] or raw
        if _looks_verbatim(summary, body, row.get("snippet") or "", summary_templates.is_default(settings)):
            summary = (
                "Pedido: Não identificado com segurança (o modelo devolveu o texto do e-mail).\n"
                "Fatos:\n- Abra Texto completo e gere o resumo de novo.\n"
                "Decisão/ação de Leo:\n- Não identificado\n"
                "Ruído: não avaliado"
            )
        chat = _load_chat(row)
        if parsed["sugestao"] and not chat:
            chat = [{"role": "ai", "text": parsed["sugestao"]}]
        # Não apaga rascunho já salvo/editado ao (re)gerar só o resumo.
        existing_draft = (row.get("draft") or "").strip()
        save_kwargs = dict(
            summary=summary,
            chat_json=json.dumps(chat),
            needs_action_hint=1 if parsed["acao_leo"] else 0,
            fyi_only=1 if parsed["so_copia"] else 0,
            chat_anchor_date=row.get("internal_date") or 0,
        )
        if existing_draft:
            out_draft = existing_draft
        else:
            out_draft = parsed["sugestao"] or ""
            save_kwargs["draft"] = out_draft
        if parsed["eh_propaganda"]:
            save_kwargs["is_marketing"] = 1
        if parsed["nota_captura"]:
            save_kwargs["capture_note"] = parsed["nota_captura"]
            save_kwargs["capture_status"] = "pending"
        store.save_ai(thread_id, **save_kwargs)
        store.log_event("summary", thread_id)
        return {
            "id": thread_id,
            "subject": row.get("subject") or "",
            "from_email": row.get("from_email") or "",
            "summary": summary,
            "draft": out_draft,
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
    """Uma linha por PESSOA (vários apelidos para o mesmo e-mail ficam juntos),
    em vez de uma linha por apelido: menos texto no prompt e deixa claro que
    "rodrigo" e "rodrigo henrrique" são a mesma pessoa."""
    groups: dict[str, dict] = {}
    for a in store.list_aliases():
        if not (a.get("name") or a.get("email")):
            continue
        key = (a.get("email") or "").lower() or a["alias"]
        g = groups.setdefault(key, {"name": a.get("name") or a["alias"], "email": a.get("email") or "", "aliases": []})
        g["aliases"].append(a["alias"])
    lines = []
    for g in groups.values():
        names = " ou ".join(f'"{x}"' for x in g["aliases"])
        target = f'{g["name"]} <{g["email"]}>' if g["email"] else g["name"]
        lines.append(f"- {names} = {target}")
    if not lines:
        return ""
    return "Apelidos que o Leo usa pra se referir a pessoas (resolva assim quando aparecer na instrução):\n" + "\n".join(lines)


def _rag_context(query_text: str, exclude_ref: str | None = None) -> str:
    settings = store.get_settings()
    hits = rag.search(query_text, k=int(settings.get("rag_top_k") or 6), exclude_ref=exclude_ref)
    return rag.format_context(hits)


def _draft_extra_context(instruction: str, query_text: str = "", exclude_ref: str | None = None) -> str:
    settings = store.get_settings()
    blocks = [f"Estilo de escrita pedido:\n{_style_instructions(settings)}"]
    glossary = _alias_glossary()
    if glossary:
        blocks.append(glossary)
    if settings.get("rag_enabled", True):
        # Busca só o que é relevante pra ESTE e-mail (cérebro + histórico),
        # em vez de despejar os arquivos mais recentes que couberem.
        snippet = _rag_context(f"{instruction}\n{query_text}", exclude_ref)
        if snippet:
            blocks.append(
                "Trechos mais relevantes do cérebro do Leo e do histórico de e-mails dele (decisões "
                "anteriores, respostas parecidas, regras) -- use só o que for realmente pertinente à "
                "instrução e cite fatos daqui com cuidado:\n" + snippet
            )
        return "\n\n".join(blocks) + "\n\n"
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


def _parse_draft_response(raw: str) -> tuple[str, str, list[str]]:
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(0))
            kind = data.get("kind")
            text = str(data.get("text") or "").strip()
            cc_names = [str(n).strip() for n in (data.get("cc_names") or []) if str(n).strip()]
            if kind in ("draft", "answer") and text:
                return kind, text, cc_names
        except json.JSONDecodeError:
            pass
    return "draft", raw.strip(), []


_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")


def _pending_cc_query(chat: list[dict]) -> str | None:
    """Olha a última mensagem da IA que pediu resolução de Cc: se sobrou
    exatamente um nome sem achar e-mail (not_found/ambiguous), devolve esse
    nome -- é o que a próxima mensagem do Leo provavelmente está resolvendo.
    Mais de um pendente ao mesmo tempo é ambíguo demais pra adivinhar."""
    for msg in reversed(chat):
        if msg.get("role") == "ai" and msg.get("cc_resolution"):
            pending = [r for r in msg["cc_resolution"] if r.get("status") in ("not_found", "ambiguous")]
            return pending[0]["query"] if len(pending) == 1 else None
    return None


def _resolve_cc_names(names: list[str]) -> list[dict]:
    """Pra cada nome/apelido que a instrução pediu pra copiar no e-mail,
    tenta achar um e-mail real: primeiro nos apelidos cadastrados, depois
    no histórico de remetentes. Se achar mais de um, devolve as opções
    pra pessoa escolher em vez de adivinhar errado."""
    if not names:
        return []
    aliases = {a["alias"].lower(): a for a in store.list_aliases()}
    results = []
    for raw_name in names:
        name = (raw_name or "").strip()
        if not name:
            continue
        alias_hit = aliases.get(name.lower())
        if alias_hit and alias_hit.get("email"):
            results.append(
                {
                    "query": name,
                    "status": "resolved",
                    "candidates": [{"name": alias_hit.get("name") or name, "email": alias_hit["email"]}],
                }
            )
            continue
        candidates = store.search_senders(name, limit=5)
        if len(candidates) == 1:
            results.append({"query": name, "status": "resolved", "candidates": candidates})
        elif len(candidates) > 1:
            results.append({"query": name, "status": "ambiguous", "candidates": candidates})
        else:
            results.append({"query": name, "status": "not_found", "candidates": []})
    return results


def _chat_context(chat: list[dict], max_chars: int = 6000) -> str:
    """A conversa já ocorrida sobre ESTE e-mail (instruções do Leo e o que a
    IA respondeu/rascunhou), mais recente por último. Sem isso, cada pedido
    chegava na IA isolado: o Leo explicava um fato numa mensagem e na
    seguinte ("crie o e-mail com essas informações") a IA não sabia de nada
    -- ele acabava tendo que colar as próprias mensagens de volta na caixa."""
    lines = []
    for msg in chat:
        if msg.get("placeholder") or not (msg.get("text") or "").strip():
            continue
        if msg.get("role") == "user":
            who = "Leo"
        elif msg.get("kind") == "answer":
            who = "IA (resposta)"
        else:
            who = "IA (rascunho)"
        lines.append(f"{who}: {msg['text'].strip()}")
    out, used = [], 0
    for line in reversed(lines):
        if used + len(line) > max_chars and out:
            break
        out.append(line)
        used += len(line)
    return "\n".join(reversed(out))


def _same_text(a: str, b: str) -> bool:
    return " ".join((a or "").split()) == " ".join((b or "").split())


def _alvo_block(alvo: dict | None) -> str:
    """Bloco do prompt quando o Leo responde a UMA mensagem da thread (não à última)."""
    if not alvo:
        return ""
    total = alvo.get("total") or 0
    pos = f"mensagem {alvo.get('idx', 0) + 1} de {total}" if total else "uma mensagem da thread"
    return (
        f"Você está respondendo a ESTA mensagem ({pos}), não necessariamente à última:\n"
        f"De: {alvo.get('de') or '?'}\nData: {alvo.get('data') or '?'}\n"
        f"<<<\n{(alvo.get('texto') or '').strip()[:6000]}\n>>>\n"
        "Responda a quem escreveu ESTA mensagem e sobre o que ela diz (saudação para essa pessoa). "
        "O resto da thread (abaixo) é só contexto: não responda às outras mensagens.\n\n"
    )


def _alvo_ref(alvo: dict | None) -> dict | None:
    """O que fica guardado no chat sobre o alvo (sem o texto inteiro)."""
    if not alvo:
        return None
    return {k: alvo.get(k) for k in ("idx", "de", "data", "message_id") if alvo.get(k) not in (None, "")}


def draft(thread_id: str, instruction: str, comment: str = "", current_draft: str = "", alvo: dict | None = None,
          keep_text: bool = False) -> dict:
    """current_draft: o texto que o Leo tem na caixa agora (o copiloto manda o
    rascunho editado à mão). Vazio = usa o último rascunho salvo na thread.
    alvo: mensagem específica sendo respondida ({idx, total, de, data, texto,
    message_id}); o prompt foca nela e o chat guarda a referência.
    keep_text: "Usar meu texto (só corrigir)" -- a instrução inteira É o e-mail.
    Sem a flag, "escreva da mesma forma: …" também cai nesse modo."""
    with _lock_for(thread_id):
        row = store.get_thread(thread_id) or {}
        chat = _load_chat(row)

        own = fixpt.keep_text_request(instruction) or ((instruction or "").strip() if keep_text else None)
        if own:
            return _draft_keep_text(thread_id, row, chat, instruction, own, current_draft, alvo)

        # Atalho: Leo respondeu com o e-mail de alguém que ficou sem resolver
        # ("o email é fulano@x.com") -- resolve na hora, sem chamar a IA de
        # novo, e já salva como apelido pra não perguntar de novo da próxima
        # vez. Isso é o "aprendizado" que faltava: sem isso, cada instrução
        # ia pra IA sem contexto de que estava respondendo uma pendência de Cc.
        email_match = _EMAIL_RE.search(instruction or "")
        pending_query = _pending_cc_query(chat) if email_match else None
        if email_match and pending_query:
            email = email_match.group(0).lower()
            store.save_alias(alias=pending_query, name=pending_query, email=email)
            if instruction:
                chat.append({"role": "user", "text": instruction})
            ai_msg = {
                "role": "ai",
                "text": f'Beleza, salvei "{pending_query}" = {email} como apelido -- da próxima vez '
                f"resolvo direto. Vou copiar esse e-mail nessa resposta.",
                "kind": "answer",
                "cc_resolution": [
                    {
                        "query": pending_query,
                        "status": "resolved",
                        "candidates": [{"name": pending_query, "email": email}],
                    }
                ],
            }
            chat.append(ai_msg)
            store.save_ai(
                thread_id,
                chat_json=json.dumps(chat),
                chat_anchor_date=row.get("internal_date") or 0,
            )
            return {
                "id": thread_id,
                "draft": row.get("draft") or "",
                "chat": chat,
                "summary": row.get("summary") or "",
            }

        body = _ensure_body(thread_id)
        previous = (current_draft or "").strip() or row.get("draft") or ""
        if not llm.has_key():
            raise RuntimeError("Falta chave de LLM (Claude/Gemini/OpenRouter) para gerar rascunho.")
        chat_context = _chat_context(chat)
        extra_context = _draft_extra_context(
            instruction,
            f"{row.get('subject') or ''}\n{_recent_body(body, 3000)}",
            exclude_ref=f"mail:{thread_id}",
        )
        learned_block = learned.notes_block(thread_id, row.get("subject") or "", learned.thread_emails(row))
        attach_block = attachments.extract_context(thread_id)
        # Pedido de ajuste sobre um rascunho que já existe ("pergunta se faz sentido",
        # "mais curto"...): sem isso, com o histórico e a fidelidade puxando pro texto
        # anterior, a IA devolvia o MESMO rascunho e parecia que o pedido foi ignorado.
        revision = (
            "REVISÃO: o Leo já tem o Rascunho anterior (abaixo) e a instrução mais recente pede para "
            "MUDÁ-LO. Parta dele, aplique exatamente o que foi pedido (acrescentar uma pergunta, "
            "encurtar, citar algo, mudar o tom...) e devolva o e-mail inteiro já revisado. Devolver o "
            "mesmo texto sem a mudança pedida é erro.\n"
            if instruction and previous.strip()
            else ""
        )
        prompt = (
            'Responda em JSON: {"kind": "draft" ou "answer", "text": "...", "cc_names": [...]}.\n'
            'kind="draft" é o PADRÃO. Use "draft" sempre que o Leo explicar, decidir, corrigir, '
            "comentar um trecho (instruções com [1], [2]... citando partes do e-mail), dar um "
            "posicionamento ou pedir pra redigir/ajustar a resposta: ele quer que VOCÊ escreva o "
            "e-mail que ELE vai mandar ao remetente, em primeira pessoa (como se fosse o Leo falando "
            "com a pessoa), incorporando o que ele disse. Nunca narre o que o Leo disse em terceira "
            'pessoa ("Leo esclareceu que...") -- isso não é e-mail. text deve ser só o corpo do '
            "e-mail (sem assunto, sem markdown).\n"
            'Use kind="answer" SÓ quando a instrução é claramente uma pergunta ou pedido de explicação '
            "pro próprio Leo sobre a thread (ex.: \"quanto foi cobrado?\", \"isso já foi resolvido?\", "
            '"resume pra mim") -- text é uma resposta direta em português, curta, sem virar e-mail. '
            "Na dúvida, escolha draft.\n"
            "Fidelidade: o rascunho só pode afirmar o que o Leo disse na instrução/conversa ou o que "
            "está na thread. Não invente decisões, prazos ou compromissos novos e nunca contradiga o "
            "Leo (se ele diz que algo já está definido, o e-mail diz que está definido, não propõe "
            'fechar de novo). Trechos entre aspas com [n] são citações do e-mail RECEBIDO que o Leo '
            "está comentando; o texto depois dos dois pontos é o posicionamento dele sobre aquele "
            "trecho. Responda a quem escreveu o trecho citado. Reaproveite os argumentos do próprio Leo "
            "(inclusive \"já fechamos isso\" ou \"já rediscutimos\"), de forma cordial, e NÃO acrescente "
            "parágrafos que ele não pediu (próximos passos, \"precisamos alinhar\", etc.).\n"
            'Já "[n] Sobre o trecho do rascunho \\"...\\": ..." cita o Rascunho anterior (abaixo), não o '
            "e-mail recebido: o Leo pede para mudar AQUELE trecho conforme o comentário. Parta do "
            "Rascunho anterior, aplique a mudança nesse trecho e mantenha o resto como está.\n"
            "cc_names: se a instrução pedir pra adicionar, copiar, incluir ou envolver alguém no "
            "e-mail (Cc), liste cada nome/apelido mencionado como uma string nesse array (pode ser "
            "mais de um nome). NÃO invente e-mail, NÃO escreva e-mail nesse campo, só o nome como o "
            "Leo escreveu. Não inclua o próprio Leo. Array vazio se ninguém foi pedido pra ser "
            "adicionado.\n\n"
            f"{extra_context}"
            f"{learned_block}"
            f"{attach_block}"
            + (
                "Conversa até agora entre você (IA) e o Leo sobre ESTE e-mail -- o que ele já explicou ou "
                "decidiu aqui vale para o pedido atual, e a instrução mais recente tem prioridade se "
                "houver conflito. Se o Leo corrigiu ou contrariou algo que você (IA) respondeu antes, "
                "vale o que o Leo disse: NÃO repita nem ofereça como alternativa a sua resposta antiga:\n"
                + chat_context + "\n\n"
                if chat_context
                else ""
            )
            + revision
            + _alvo_block(alvo)
            + f"Instrução do Leo: {instruction or '(gerar a partir do contexto)'}\n"
            f"Ajuste pedido: {comment or '(nenhum)'}\n"
            f"Rascunho anterior:\n{previous or '(nenhum)'}\n\n"
            f"Assunto: {row.get('subject')}\n\n{_thread_outline(body)}Thread:\n{_recent_body(body)}"
        )
        kind, text, cc_names = _parse_draft_response(llm.complete(prompt))
        # Voltou idêntico ao rascunho anterior: tenta uma vez mais, insistindo no pedido.
        unchanged = bool(revision) and kind == "draft" and _same_text(text, previous)
        if unchanged:
            kind, text, cc_names = _parse_draft_response(
                llm.complete(
                    prompt + "\n\nATENÇÃO: sua resposta anterior devolveu o Rascunho anterior sem "
                    f"nenhuma mudança. Aplique agora o pedido do Leo: {instruction}"
                )
            )
            unchanged = kind == "draft" and _same_text(text, previous)
        cc_resolution = _resolve_cc_names(cc_names)
        store.log_event("draft" if kind == "draft" else "answer", thread_id)

        alvo_ref = _alvo_ref(alvo)
        if instruction:
            chat.append({"role": "user", "text": instruction, **({"alvo": alvo_ref} if alvo_ref else {})})
        ai_msg: dict = {"role": "ai", "text": text, "kind": kind}
        if cc_resolution:
            ai_msg["cc_resolution"] = cc_resolution
        if alvo_ref:
            ai_msg["alvo"] = alvo_ref
        chat.append(ai_msg)

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
            "unchanged": unchanged,
            "alvo": alvo_ref,
        }


def _draft_keep_text(thread_id: str, row: dict, chat: list[dict], instruction: str, own: str,
                     current_draft: str, alvo: dict | None) -> dict:
    """"Escreva da mesma forma: …": o rascunho é o texto do Leo, só com o
    português corrigido (sem gerar outro e-mail). Se a correção divergir demais
    ou não houver LLM, vai o texto dele como está, com um aviso. A assinatura do
    rascunho atual é mantida no fim quando o texto dele não traz uma."""
    previous = (current_draft or "").strip() or row.get("draft") or ""
    fixed, aviso = own, ""
    try:
        fixed = fixpt.fix(own)["text"].strip()
    except fixpt.FixRejected as exc:
        aviso = str(exc)
    except RuntimeError as exc:
        aviso = f"{exc} Usei seu texto sem correção."
    text = fixpt.with_signature(fixed, previous)
    original = fixpt.with_signature(own, previous)
    alvo_ref = _alvo_ref(alvo)
    if instruction:
        chat.append({"role": "user", "text": instruction, **({"alvo": alvo_ref} if alvo_ref else {})})
    ai_msg: dict = {"role": "ai", "text": text, "kind": "draft", "keep_text": True}
    if alvo_ref:
        ai_msg["alvo"] = alvo_ref
    chat.append(ai_msg)
    store.save_ai(thread_id, chat_json=json.dumps(chat), chat_anchor_date=row.get("internal_date") or 0, draft=text)
    store.log_event("draft_keep_text", thread_id)
    return {
        "id": thread_id,
        "draft": text,
        "chat": chat,
        "summary": row.get("summary") or "",
        "unchanged": False,
        "alvo": alvo_ref,
        "keep_text": True,
        "original": original,  # o texto do Leo sem correção (o front destaca as mudanças / Desfazer)
        "corrigido": fixed != own.strip(),
        "aviso": aviso,
    }


REWRITE_DEFAULT_INSTRUCTION = "melhore este trecho"


class PassageMismatch(ValueError):
    """O trecho enviado não bate com draft[start:end] (o rascunho mudou no meio)."""


def _clean_replacement(raw: str, passage: str) -> str:
    """Tira o embrulho que a IA às vezes põe (```, aspas, "Trecho reescrito:")
    e devolve o texto com o mesmo espaço em branco nas pontas do trecho original."""
    text = (raw or "").strip()
    fence = re.match(r"^```[a-zA-Z]*\n(.*)\n```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    text = re.sub(r"^(trecho reescrito|novo trecho|reescrita|texto)\s*:\s*", "", text, flags=re.IGNORECASE).strip()
    pairs = {'"': '"', "“": "”", "'": "'", "«": "»"}
    if len(text) >= 2 and text[0] in pairs and text[-1] == pairs[text[0]] and not (passage[:1] == text[0] and passage[-1:] == text[-1]):
        text = text[1:-1].strip()
    lead = passage[: len(passage) - len(passage.lstrip())]
    trail = passage[len(passage.rstrip()):]
    return f"{lead}{text}{trail}" if text else ""


def rewrite_passage(thread_id: str, draft_text: str, start: int, end: int, passage: str, instruction: str = "") -> dict:
    """Reescreve SÓ draft[start:end] (botão "Reescrever" da seleção no rascunho).
    Não salva nada nem mexe no chat: devolve {replacement} e o front troca o
    trecho na caixa (o resto do texto fica byte-idêntico) e salva pelo autosave."""
    draft_text = draft_text or ""
    if not (0 <= start < end <= len(draft_text)) or draft_text[start:end] != passage or not passage.strip():
        raise PassageMismatch("O trecho não confere com o rascunho atual. Selecione de novo.")
    instruction = (instruction or "").strip() or REWRITE_DEFAULT_INSTRUCTION
    row = store.get_thread(thread_id) or {}
    if not row:
        raise RuntimeError("Thread não está no radar. Atualize a lista.")
    if not llm.has_key():
        raise RuntimeError("Falta chave de LLM (Claude/Gemini/OpenRouter) para reescrever.")
    body = _ensure_body(thread_id)
    extra_context = _draft_extra_context(
        f"{instruction}\n{passage}",
        f"{row.get('subject') or ''}\n{_recent_body(body, 3000)}",
        exclude_ref=f"mail:{thread_id}",
    )
    learned_block = learned.notes_block(thread_id, row.get("subject") or "", learned.thread_emails(row))
    marked = f"{draft_text[:start]}⟦{passage}⟧{draft_text[end:]}"
    prompt = (
        "Você está ajudando o Leo a editar UM TRECHO do rascunho de resposta que ele vai mandar. "
        "Reescreva SOMENTE o trecho marcado, seguindo a instrução dele, para que se encaixe no "
        "lugar exato do original (mesma pessoa, mesmo tom, concordância com o texto antes e depois).\n"
        "Responda APENAS com o texto novo do trecho: sem aspas, sem markdown, sem explicação, sem "
        "saudação nem assinatura (a não ser que o trecho original já seja a saudação/assinatura), "
        "sem repetir o texto de fora do trecho. Não invente fatos, prazos ou compromissos que não "
        "estejam na thread, na instrução ou no rascunho.\n\n"
        f"{extra_context}"
        f"{learned_block}"
        f"Instrução do Leo para o trecho: {instruction}\n\n"
        f"Trecho a reescrever:\n{passage}\n\n"
        f"Rascunho inteiro (o trecho está entre ⟦ e ⟧):\n{marked}\n\n"
        f"Assunto: {row.get('subject')}\n\nThread:\n{_recent_body(body, 8000)}"
    )
    replacement = _clean_replacement(llm.complete(prompt), passage)
    if not replacement.strip():
        raise RuntimeError("A IA não devolveu o trecho reescrito. Tente de novo.")
    if secrets_guard.looks_like_secret(replacement) and not secrets_guard.looks_like_secret(draft_text):
        raise PassageMismatch("A IA devolveu algo com cara de senha/token; o trecho não foi trocado.")
    store.log_event("rewrite_passage", thread_id)
    return {"replacement": replacement}


def _chat_transcript(chat: list[dict]) -> str:
    lines = []
    for msg in chat:
        if msg.get("placeholder"):
            continue
        who = "Leo" if msg.get("role") == "user" else "Você (IA)"
        lines.append(f"{who}: {msg.get('text', '')}")
    return "\n".join(lines)


def compose_draft(to: str, subject: str, instruction: str, comment: str, chat: list[dict]) -> dict:
    """Mesmo motor do draft() de resposta, mas pra um e-mail do zero --
    sem thread_id nem corpo de e-mail anterior pra ler. Sem lock nem
    persistência própria: quem chama (o compositor no front) segura o
    histórico da conversa em memória e manda de volta a cada mensagem,
    já que não existe uma thread no banco pra pendurar isso até o envio."""
    if not llm.has_key():
        raise RuntimeError("Falta chave de LLM (Claude/Gemini/OpenRouter) para gerar rascunho.")
    email_match = _EMAIL_RE.search(instruction or "")
    pending_query = _pending_cc_query(chat) if email_match else None
    if email_match and pending_query:
        email = email_match.group(0).lower()
        store.save_alias(alias=pending_query, name=pending_query, email=email)
        return {
            "kind": "answer",
            "text": f'Beleza, salvei "{pending_query}" = {email} como apelido -- da próxima vez '
            f"resolvo direto. Vou copiar esse e-mail nessa resposta.",
            "cc_resolution": [
                {
                    "query": pending_query,
                    "status": "resolved",
                    "candidates": [{"name": pending_query, "email": email}],
                }
            ],
        }

    compose_context = _draft_extra_context(instruction, subject + "\n" + to)
    # e-mail novo: aprendizados gerais + os das pessoas no "Para"
    compose_context += learned.notes_block("", "", [m.group(0).lower() for m in _EMAIL_RE.finditer(to or "")])
    raw = llm.complete(
        'Responda em JSON: {"kind": "draft" ou "answer", "text": "...", "cc_names": [...]}.\n'
        'Use kind="draft" quando a instrução pede pra escrever/ajustar o e-mail -- text deve ser '
        "só o corpo do e-mail (sem assunto, sem markdown).\n"
        'Use kind="answer" quando a instrução é uma pergunta sobre o que está sendo escrito, não um '
        "pedido de texto -- text é uma resposta direta em português, curta, sem virar e-mail.\n"
        "cc_names: se a instrução pedir pra adicionar, copiar, incluir ou envolver alguém no e-mail "
        "(Cc), liste cada nome/apelido mencionado como uma string nesse array. NÃO invente e-mail, "
        "NÃO escreva e-mail nesse campo, só o nome como o Leo escreveu. Não inclua o próprio Leo. "
        "Array vazio se ninguém foi pedido pra ser adicionado.\n\n"
        f"{compose_context}"
        "Este é um e-mail NOVO que o Leo está escrevendo do zero (não é resposta a nenhuma thread "
        "existente).\n"
        f"Para: {to or '(não preenchido ainda)'}\n"
        f"Assunto: {subject or '(sem assunto)'}\n"
        f"Instrução do Leo: {instruction or '(gerar a partir do que já foi conversado)'}\n"
        f"Ajuste pedido: {comment or '(nenhum)'}\n"
        f"Conversa até agora:\n{_chat_transcript(chat) or '(nenhuma)'}"
    )
    kind, text, cc_names = _parse_draft_response(raw)
    cc_resolution = _resolve_cc_names(cc_names)
    result: dict = {"kind": kind, "text": text}
    if cc_resolution:
        result["cc_resolution"] = cc_resolution
    return result


def _slug(text: str, max_len: int = 60) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug[:max_len] or "sem-assunto"


def _first_readme_line(readme: "Path") -> str:
    if not readme.exists():
        return ""
    for line in readme.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line
    return ""


def _learning_base_menu() -> dict[str, dict]:
    """Cardápio de TODOS os destinos possíveis na Learning Base -- não só
    principal_agents/emails/ como antes. Segue a tabela "Onde salvar por
    tipo de assunto" do START-HERE.md: agentes recorrentes (acrescenta no
    context.md canônico), produtos da Confrapag, áreas gerais da empresa
    (tech/cto/business) e vida pessoal/profissional do Leo (cria uma nota
    nova seguindo o modelo do START-HERE.md). Usado tanto por "Guardar no
    cérebro" quanto por "Exportar contexto pra outra IA" -- antes cada um
    só enxergava um pedaço fixo da base (principal_agents/*)."""
    menu: dict[str, dict] = {}

    if CAPTURE_CATEGORIES_DIR.is_dir():
        for child in sorted(CAPTURE_CATEGORIES_DIR.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            # Só entram pastas que já seguem o padrão (têm context.md de
            # verdade) -- skins/, viagens/, projetos-pequenos/ usam outra
            # estrutura (subpasta por item) e não devem ganhar um
            # context.md novo só porque a IA achou que o assunto combinava.
            if not (child / "context.md").exists():
                continue
            desc = _first_readme_line(child / "README.md")
            menu[f"agente:{child.name}"] = {
                "desc": desc or f"agente recorrente do Radar ({child.name})",
                "mode": "append",
                "path": child / "context.md",
            }

    products_dir = LB_COMPANY_DIR / "products"
    if products_dir.is_dir():
        for child in sorted(products_dir.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            menu[f"produto:{child.name}"] = {
                "desc": f"produto/plataforma da Confrapag: {child.name}",
                "mode": "new",
                "path": child / "docs",
            }

    for key, sub, desc in (
        ("tech", "tech", "tecnologia geral, arquitetura, infraestrutura, segurança, stack, padrões"),
        ("cto", "cto", "pessoas, estratégia, planejamento, decisões executivas"),
        ("business", "business", "comercial, financeiro, legal, operações, clientes, parceiros"),
    ):
        menu[f"empresa:{key}"] = {"desc": desc, "mode": "new", "path": LB_COMPANY_DIR / sub}

    menu["pessoal:personal"] = {
        "desc": "vida pessoal do Leo: finanças, saúde, metas, ideias, rotina",
        "mode": "new",
        "path": LB_PERSONAL_DIR / "personal",
    }
    menu["pessoal:professional"] = {
        "desc": "carreira/profissional individual do Leo: estudos, metas, portfólio, rede",
        "mode": "new",
        "path": LB_PERSONAL_DIR / "professional",
    }

    return menu


def _pick_destination(content: str, subject: str) -> tuple[str, dict]:
    """Pergunta pra IA em qual destino da Learning Base INTEIRA esse
    conteúdo de e-mail encaixa melhor (agente recorrente, produto, área da
    empresa ou pessoal/profissional) -- generaliza o que antes só olhava
    principal_agents/* e sempre caía em "emails" pra tudo que não fosse
    óbvio. Cai no fallback (agente "emails") se não tiver LLM, o cardápio
    vier vazio ou a resposta não bater com nenhuma opção real."""
    menu = _learning_base_menu()
    fallback_key = f"agente:{CAPTURE_FALLBACK_CATEGORY}"
    fallback = menu.get(fallback_key) or {
        "desc": "e-mails do Radar (padrão)",
        "mode": "append",
        "path": CONTEXT_MD,
    }
    if not menu or not llm.has_key():
        return fallback_key, fallback
    options = "\n".join(f"- {key}: {info['desc']}" for key, info in menu.items())
    try:
        raw = llm.complete(
            "Escolha em qual dos destinos abaixo esse conteúdo de e-mail deve ser guardado na "
            "Learning Base do Leo. Responda APENAS a chave exata de uma opção da lista, nada mais.\n\n"
            f"Destinos:\n{options}\n\n"
            f"Assunto do e-mail: {subject}\n"
            f"Conteúdo: {content}",
            system=llm.SYSTEM,
        )
    except Exception:
        return fallback_key, fallback
    choice = raw.strip().strip('"').strip("'").splitlines()[0].strip() if raw.strip() else ""
    if choice in menu:
        return choice, menu[choice]
    return fallback_key, fallback


def _note_template(subject: str, fact: str) -> str:
    return (
        f"# {subject}\n\n"
        f"Ultima atualizacao: {datetime.now().strftime('%Y-%m-%d')}\n\n"
        "## Contexto\n\n"
        f'Capturado do Radar (IA.Email) a partir do e-mail "{subject}".\n\n'
        "## Fatos confirmados\n\n"
        f"- {fact}\n\n"
        "## Decisoes\n\n"
        "## Pendencias / pontos em aberto\n\n"
        "## Links e arquivos relacionados\n"
    )


def _cleanup_old_exports(export_dir) -> None:
    if not export_dir.is_dir():
        return
    cutoff = time.time() - EMAIL_EXPORT_RETENTION_DAYS * 86400
    for path in export_dir.glob("*.md"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


def export_context(thread_id: str) -> dict:
    with _lock_for(thread_id):
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

        # Onde este e-mail encaixa na Learning Base inteira (não mais
        # sempre em principal_agents/emails/) -- o dump vai pra uma
        # subpasta radar-contextos/ dentro desse destino, não direto no
        # context.md/pasta do produto, pra não misturar exportação bruta
        # (staging, com retenção/limpeza) com conhecimento já digerido.
        content_hint = row.get("summary") or body[:800]
        key, dest = _pick_destination(content_hint, subject)
        base_dir = dest["path"].parent if dest["mode"] == "append" else dest["path"]
        export_dir = base_dir / "radar-contextos"

        export_dir.mkdir(parents=True, exist_ok=True)
        _cleanup_old_exports(export_dir)
        filename = f"{datetime.now().strftime('%Y-%m-%d')}_{_slug(subject)}_{thread_id[:8]}.md"
        export_path = export_dir / filename
        export_path.write_text(markdown, encoding="utf-8")

        prompt = (
            f'Pegue o contexto do e-mail "{subject}" no arquivo '
            f"{export_path} antes de responder."
        )
        return {"path": str(export_path), "prompt": prompt, "category": key}


def list_generated_exports() -> list[dict]:
    """Escaneia a Learning Base inteira por pastas radar-contextos/ (onde
    export_context() vai jogando os arquivos, agora espalhados pela base
    conforme o assunto, em vez de só em principal_agents/emails/) -- usado
    pela tela de Configurações pra listar/apagar exportações antigas."""
    root = LEARNING_BASE_GLOBAL_DEFAULT
    if not root.is_dir():
        return []
    out = []
    for path in root.glob("**/radar-contextos/*.md"):
        try:
            stat = path.stat()
        except OSError:
            continue
        out.append(
            {
                "name": path.name,
                "path": str(path.relative_to(root)),
                "size": stat.st_size,
                "modified_at": stat.st_mtime,
            }
        )
    return sorted(out, key=lambda f: f["modified_at"], reverse=True)


def delete_generated_export(rel_path: str) -> None:
    root = LEARNING_BASE_GLOBAL_DEFAULT
    target = (root / rel_path).resolve()
    if (
        root.resolve() not in target.parents
        or target.parent.name != "radar-contextos"
        or not target.is_file()
    ):
        raise RuntimeError("Arquivo não encontrado.")
    target.unlink()


def delete_all_generated_exports() -> int:
    root = LEARNING_BASE_GLOBAL_DEFAULT
    if not root.is_dir():
        return 0
    removed = 0
    for path in root.glob("**/radar-contextos/*.md"):
        try:
            path.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def approve_capture(thread_id: str) -> dict:
    with _lock_for(thread_id):
        row = store.get_thread(thread_id) or {}
        note = (row.get("capture_note") or "").strip()
        if not note:
            raise RuntimeError("Essa thread não tem nota de captura pendente.")
        if secrets_guard.looks_like_secret(note):
            store.save_ai(thread_id, capture_status="dismissed")
            raise RuntimeError(
                "Essa nota parece conter senha ou credencial, então não vou gravar no cérebro. "
                "A sugestão foi descartada."
            )
        subject = row.get("subject") or "(sem assunto)"
        key, dest = _pick_destination(note, subject)
        if dest["mode"] == "append":
            target = dest["path"]
            entry = (
                f"\n\n## Captura do Radar — {datetime.now().strftime('%d/%m/%Y')} — {subject}\n"
                f"{note}\n"
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("a", encoding="utf-8") as fh:
                fh.write(entry)
        else:
            target = dest["path"] / f"{datetime.now().strftime('%Y-%m-%d')}_{_slug(subject)}.md"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(_note_template(subject, note), encoding="utf-8")
        store.save_ai(thread_id, capture_status="approved")
        return {"ok": True, "path": str(target), "category": key}


def dismiss_capture(thread_id: str) -> dict:
    with _lock_for(thread_id):
        store.save_ai(thread_id, capture_status="dismissed")
        return {"ok": True}


# ── Piloto automático: aprendizado de padrões de resposta ──

_PATTERNS_DIGEST_KEY = "reply_patterns_digest"
_PATTERNS_UPDATED_KEY = "reply_patterns_updated_at"
_PATTERNS_MAX_CHARS = 24000


def _gather_reply_examples(limit: int = 40) -> str:
    """Junta exemplos de como o Leo responde de verdade: primeiro os que já
    passaram pelo próprio IA.Email (mais confiáveis -- já têm instrução e
    rascunho registrados em chat_json), depois uma amostra do Enviados real
    do Gmail (mais rico, mas sem a instrução por trás, só o texto final).
    Amostragem tipo pick_preload (mais novos + mais antigos) pra não
    estourar o prompt e pegar alguma diversidade temporal."""
    blocks: list[str] = []

    app_sent = store.list_recent_sent(limit=limit // 2)
    for row in app_sent:
        chat = _load_chat(row)
        last_user = next((m["text"] for m in reversed(chat) if m.get("role") == "user"), "")
        last_ai = next(
            (m["text"] for m in reversed(chat) if m.get("role") == "ai" and m.get("kind") != "answer"),
            row.get("draft") or "",
        )
        if not last_ai:
            continue
        blocks.append(
            f"### E-mail: {row.get('subject') or '(sem assunto)'}\n"
            f"Instrução de Leo: {last_user or '(gerado sem instrução explícita)'}\n"
            f"Resposta enviada:\n{last_ai}"
        )

    try:
        sent_ids = gmail_client.list_sent_thread_ids(limit=limit)
    except RuntimeError:
        sent_ids = []
    sample_ids = pick_preload(sent_ids, count=max(3, (limit - len(blocks)) // 2))
    for thread_id in sample_ids:
        try:
            text = gmail_client.get_thread_text(thread_id)
        except Exception:
            continue
        # get_thread_text separa mensagens por "----"; cada bloco começa com
        # "De: ...\nData: ...\n\n{corpo}" -- filtra só os blocos onde o "De"
        # é a conta do Leo, que é a resposta dele de verdade.
        for part in text.split("\n\n----\n\n"):
            head = part.split("\n\n", 1)[0]
            if ACCOUNT in head.lower():
                blocks.append(f"### Enviado (Gmail)\n{part.strip()[:1500]}")
                break

    joined = "\n\n".join(blocks)
    return joined[:_PATTERNS_MAX_CHARS]


def build_reply_patterns_digest() -> str:
    """Resume por IA os exemplos reais de resposta do Leo num digest de
    padrões (tom, tipo de pedido resolvido rápido x com cautela, decisões
    padrão). Fica em cache no banco (meta) -- é inferência derivada, por
    isso não é gravada na Learning Base como fato confirmado."""
    examples = _gather_reply_examples()
    if not examples.strip() or not llm.has_key():
        digest = "(sem exemplos suficientes de e-mails enviados ainda, ou sem chave de LLM configurada.)"
    else:
        digest = llm.complete(
            "Analise os exemplos de e-mails que o Leo já respondeu de verdade (abaixo) e produza um "
            "resumo objetivo em português, em texto puro (sem JSON), cobrindo:\n"
            "1. Tom e estilo recorrente (formalidade, tamanho das respostas, como ele assina).\n"
            "2. Tipos de pedido que ele resolve rápido e direto (indique 2-4 exemplos de assunto).\n"
            "3. Tipos de pedido que ele trata com mais cautela/detalhe antes de decidir.\n"
            "4. Decisões-padrão já tomadas que se repetem (ex.: CC de rotina, respostas-modelo).\n"
            "Seja específico e curto -- isso vai ser usado como contexto pra outra IA decidir se "
            "responde um e-mail novo no lugar dele.\n\n"
            f"Exemplos:\n{examples}",
            system=llm.SYSTEM,
        )
    store.set_meta(_PATTERNS_DIGEST_KEY, digest)
    store.set_meta(_PATTERNS_UPDATED_KEY, datetime.now().isoformat())
    return digest


def get_reply_patterns() -> dict:
    return {
        "digest": store.get_meta(_PATTERNS_DIGEST_KEY) or "",
        "updated_at": store.get_meta(_PATTERNS_UPDATED_KEY),
    }


# ── Piloto automático: motor de decisão ──

# None = auto_send nunca permitido nesse nível, qualquer que seja a
# confiança -- "conservador" só gera rascunho ou alerta.
_SENSITIVITY_THRESHOLDS = {"conservador": None, "moderado": 0.85, "autonomo": 0.6}

_SENSITIVITY_PROMPT_DESC = {
    "conservador": "Conservador: a IA só pode sugerir rascunho ou alertar, nunca enviar sozinha.",
    "moderado": "Moderado: a IA pode sugerir enviar sozinha, mas só quando o caso é claramente de rotina "
    "e bate com um padrão de resposta já confirmado -- na dúvida, prefira rascunho ou alerta.",
    "autonomo": "Autônomo: a IA pode sugerir enviar sozinha pra maioria dos casos que não são excepcionais, "
    "mas ainda assim prefira alertar quando o assunto for sensível, ambíguo ou fora do padrão conhecido.",
}

_MONEY_RE = re.compile(
    r"r\$\s?\d|\bboleto\b|\bpagamento\b|\bfatura\b|\breembolso\b|\bcontrato\b|"
    r"\bag[eê]ncia\b|\bconta (corrente|banc[aá]ria|poupan[cç]a)\b|\bchave pix\b|\biban\b",
    re.IGNORECASE,
)
_LEGAL_HR_RE = re.compile(
    r"\bjur[ií]dico\b|\badvogad[oa]\b|\bprocesso (judicial|trabalhista)\b|\ba[çc][ãa]o judicial\b|"
    r"\brescis[ãa]o\b|\bdemiss[ãa]o\b|\badmiss[ãa]o\b|"
    r"\bf[ée]rias\b|\bsal[áa]rio\b|\bhoras extras\b|\bbonifica[çc][ãa]o\b",
    re.IGNORECASE,
)
_ATTACH_MENTION_RE = re.compile(r"anex", re.IGNORECASE)


def _hard_exclusions(row: dict, body: str, draft_text: str) -> str | None:
    """Exclusões fixas no código, iguais em todos os níveis de
    sensibilidade -- nunca auto-envia nesses casos, só alerta. Ver a seção
    "Piloto Automático de Respostas" no context.md pra que isso fica
    documentado como regra, não só implementação."""
    from_email = row.get("from_email") or ""
    if not store.sender_seen_before(from_email, row.get("id") or ""):
        return "remetente nunca apareceu antes no histórico"
    subject_body = f"{row.get('subject') or ''}\n{body or ''}"
    if secrets_guard.looks_like_secret(subject_body):
        return "o e-mail contém senha, token ou credencial"
    if _MONEY_RE.search(subject_body):
        return "assunto envolve valores financeiros/pagamento"
    if _LEGAL_HR_RE.search(subject_body):
        return "assunto jurídico ou de RH"
    if _ATTACH_MENTION_RE.search(draft_text or "") and not attachments.list_files(row.get("id") or ""):
        return "rascunho menciona anexo sem anexo real confirmado"
    return copilot.pilot_block_reason(row.get("id") or "")


def decide_autopilot_action(thread_id: str) -> dict:
    """Decide o que fazer com UMA thread: auto_send (entra na fila com
    buffer), draft_only (fica como rascunho normal pra revisão manual) ou
    alert (precisa da atenção do Leo). O LLM só SUGERE; o limiar de
    confiança por nível e as exclusões rígidas são aplicados em código,
    não deixados pro LLM decidir por conta própria."""
    row = store.get_thread(thread_id) or {}
    if not row:
        raise RuntimeError("Thread não está no radar.")
    body = _ensure_body(thread_id)
    settings = store.get_settings()
    level = settings.get("autopilot_level") or "conservador"

    excluded_reason = _hard_exclusions(row, body, row.get("draft") or "")
    if excluded_reason:
        decision = {
            "thread_id": thread_id,
            "action": "alert",
            "confidence": 0.0,
            "reasoning": f"Exclusão de segurança: {excluded_reason}.",
            "draft_text": "",
            "cc": "",
            "sensitivity_level": level,
            "status": "resolved",
        }
        decision["id"] = store.create_autopilot_decision(**decision)
        return decision

    patterns = get_reply_patterns().get("digest") or ""
    if settings.get("rag_enabled", True):
        context_snippet = _rag_context(
            f"{row.get('subject') or ''}\n{_recent_body(body, 3000)}", exclude_ref=f"mail:{thread_id}"
        )
    else:
        context_snippet = ""
        if settings.get("context_global_enabled"):
            context_snippet, _ = context_base.build_context_snippet(
                settings.get("context_global_paths") or [], max_chars=CONTEXT_GLOBAL_MAX_CHARS
            )

    raw = llm.complete(
        'Responda em JSON: {"action_suggested": "auto_send"|"draft_only"|"alert", "confidence": 0.0-1.0, '
        '"draft_text": "...", "reasoning": "..."}.\n'
        "Você está decidindo se esse e-mail pode ser respondido sozinho, no lugar do Leo.\n"
        f"Nível de sensibilidade ativo: {_SENSITIVITY_PROMPT_DESC.get(level, level)}\n"
        "Use action_suggested=\"alert\" se o e-mail parecer novo/fora do padrão, ambíguo, ou exigir uma "
        "decisão que só o Leo pode tomar. Use \"draft_only\" se dá pra responder mas não tem certeza "
        "suficiente pra enviar sozinho. Use \"auto_send\" só se tiver confiança real de que é exatamente "
        "o tipo de resposta de rotina que o Leo já daria.\n"
        "draft_text é o corpo da resposta (sem assunto, sem markdown), mesmo quando action_suggested não "
        "for auto_send -- sempre preencha com o melhor rascunho possível.\n\n"
        f"Padrões de resposta conhecidos do Leo:\n{patterns or '(nenhum ainda)'}\n\n"
        + (f"Trechos relevantes do cérebro e do histórico de e-mails do Leo:\n{context_snippet}\n\n" if context_snippet else "")
        + f"Assunto: {row.get('subject')}\n\nThread:\n{_recent_body(body)}",
        system=llm.SYSTEM,
    )
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    try:
        parsed = json.loads(match.group(0)) if match else {}
    except json.JSONDecodeError:
        parsed = {}
    action_suggested = parsed.get("action_suggested") or "alert"
    confidence = float(parsed.get("confidence") or 0.0)
    draft_text = str(parsed.get("draft_text") or "").strip()
    reasoning = str(parsed.get("reasoning") or "").strip()

    threshold = _SENSITIVITY_THRESHOLDS.get(level)
    if action_suggested == "auto_send" and threshold is not None and confidence >= threshold:
        final_action = "auto_send"
    elif action_suggested == "alert":
        final_action = "alert"
    else:
        final_action = "draft_only"

    decision = {
        "thread_id": thread_id,
        "action": final_action,
        "confidence": confidence,
        "reasoning": reasoning,
        "draft_text": draft_text,
        "cc": "",
        "sensitivity_level": level,
        "status": "pending" if final_action == "auto_send" else "resolved",
        "internal_date_snapshot": row.get("internal_date"),
    }
    if final_action == "auto_send":
        buffer_minutes = int(settings.get("autopilot_buffer_minutes") or 10)
        decision["scheduled_send_at"] = (
            datetime.now() + timedelta(minutes=buffer_minutes)
        ).isoformat()
        # Fica também como o draft "oficial" da thread, igual um rascunho
        # manual -- se for cancelado antes de enviar, a thread não fica sem
        # nada, continua com esse texto pronto pra revisão.
        store.save_ai(thread_id, draft=draft_text)
    decision["id"] = store.create_autopilot_decision(**decision)
    return decision


def process_due_autopilot_sends() -> list[dict]:
    """Despacha de verdade as decisões cujo horário do buffer já passou.
    Antes de enviar, reconfirma que a thread não recebeu mensagem nova
    desde a decisão (se recebeu, cancela e marca alerta em vez de enviar
    algo que já pode estar desatualizado)."""
    now_iso = datetime.now().isoformat()
    results = []
    for decision in store.due_autopilot_sends(now_iso):
        thread_id = decision["thread_id"]
        row = store.get_thread(thread_id) or {}
        if not row:
            store.update_autopilot_decision(decision["id"], status="cancelled", error="thread não encontrada")
            results.append({"id": decision["id"], "status": "cancelled"})
            continue
        snapshot = decision.get("internal_date_snapshot")
        current = row.get("internal_date")
        if snapshot and current and int(current) > int(snapshot):
            # Chegou mensagem nova na thread depois da decisão -- o
            # rascunho pode já estar desatualizado ou fora de contexto.
            # Mais seguro cancelar e alertar do que enviar algo obsoleto.
            store.update_autopilot_decision(
                decision["id"], status="cancelled", error="thread recebeu mensagem nova após a decisão"
            )
            results.append({"id": decision["id"], "status": "cancelled", "reason": "thread_moved"})
            continue
        try:
            send_result = gmail_client.send_reply(thread_id, decision["draft_text"], cc=decision.get("cc") or "")
            gmail_client.mark_threads_read([thread_id])
            store.save_ai(
                thread_id,
                draft="",
                sent_via_app_at=int(datetime.now().timestamp() * 1000),
            )
            store.update_autopilot_decision(
                decision["id"], status="sent", sent_at=datetime.now().isoformat()
            )
            store.log_event("auto_sent", thread_id)
            try:
                from . import copilot
                copilot.resolve_after_send(thread_id)
            except Exception:
                pass
            results.append({"id": decision["id"], "status": "sent", **send_result})
        except Exception as exc:
            store.update_autopilot_decision(decision["id"], status="failed", error=str(exc))
            results.append({"id": decision["id"], "status": "failed", "error": str(exc)})
    return results


def dismiss_autopilot_decision(decision_id: str) -> dict:
    """Tira da vista um alerta ou rascunho do piloto que o Leo já viu. Não apaga: a
    decisão continua no banco (e nas métricas), só deixa de aparecer no painel."""
    decision = store.get_autopilot_decision(decision_id)
    if not decision:
        raise RuntimeError("Decisão não encontrada.")
    if decision["status"] != "resolved" or decision["action"] not in ("alert", "draft_only"):
        raise RuntimeError("Só dá pra dispensar um alerta ou rascunho do piloto.")
    store.update_autopilot_decision(decision_id, status="dismissed")
    return {"ok": True}


def cancel_autopilot_decision(decision_id: str) -> dict:
    decision = store.get_autopilot_decision(decision_id)
    if not decision:
        raise RuntimeError("Decisão não encontrada.")
    if decision["status"] != "pending":
        raise RuntimeError("Essa decisão não está mais pendente.")
    store.update_autopilot_decision(decision_id, status="cancelled")
    return {"ok": True}


def run_autopilot_scan_tick(*, max_candidates: int = 10) -> dict:
    """Um ciclo do piloto automático: decide sobre um lote limitado de
    threads candidatas (sem decisão ainda) e despacha o que já passou do
    buffer. Não faz nada se a feature estiver desligada."""
    settings = store.get_settings()
    if not settings.get("autopilot_enabled"):
        return {"enabled": False}
    if settings.get("autopilot_mode") == "auxiliar":
        # Modo Auxiliar nunca envia: o piloto não decide nem despacha nada.
        return {"enabled": True, "mode": "auxiliar", "decided": 0, "dispatched": []}
    candidates = [
        row["id"]
        for row in store.list_visible()
        if (row.get("is_unread") or row.get("awaiting_reply"))
        and not row.get("is_marketing")
        and not row.get("is_automatic")
        and not store.recent_decision_for_thread(row["id"])
    ][:max_candidates]
    decided = []
    for thread_id in candidates:
        try:
            decided.append(decide_autopilot_action(thread_id))
        except Exception as exc:
            decided.append({"thread_id": thread_id, "error": str(exc)})
    dispatched = process_due_autopilot_sends()
    return {"enabled": True, "decided": len(decided), "dispatched": dispatched}
