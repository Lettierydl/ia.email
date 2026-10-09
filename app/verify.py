"""Verificador: checa na caixa do Leo o que o e-mail afirma.

1. A IA lê a thread (foco na última mensagem de outra pessoa) e tira as
   AFIRMAÇÕES verificáveis sobre a caixa do Leo ("você recebeu o link de
   acesso", "mandamos o anexo X dia Y", "você respondeu em …"), cada uma com
   consultas de busca do Gmail sugeridas.
2. As consultas são saneadas (só operadores conhecidos) e rodam SÓ LEITURA
   (gmail_client.search_messages: messages.list + get format=metadata).
3. A IA avalia cada afirmação com as evidências: Confirmado / Não encontrado /
   Inconclusivo + explicação curta citando os e-mails.

Cache por thread (copilot_verificacoes), com o retrato da thread: mensagem
nova invalida; "Regerar" refaz. Nunca envia, marca, arquiva nem rotula nada.
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime
from urllib.parse import quote

from . import config, copilot, gmail_client, llm, secrets_guard, store

MAX_AFIRMACOES = 6
MAX_CONSULTAS = 3
MAX_RESULTADOS = 5
MAX_QUERY_LEN = 220

VEREDITOS = ("confirmado", "nao_encontrado", "inconclusivo")
VEREDITO_LABEL = {"confirmado": "Confirmado", "nao_encontrado": "Não encontrado", "inconclusivo": "Inconclusivo"}

_SECRET_SNIPPET = "[trecho omitido: parece ter senha ou credencial]"


# ── consulta saneada: só operadores conhecidos, valores no formato esperado ──
_ADDR_VALUE = re.compile(r"^[\w.+@-]{2,80}$", re.UNICODE)
_DATE_VALUE = re.compile(r"^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$")
_OPS = {
    "from": _ADDR_VALUE,
    "to": _ADDR_VALUE,
    "cc": _ADDR_VALUE,
    "bcc": _ADDR_VALUE,
    "subject": None,  # texto (palavra ou "frase")
    "after": _DATE_VALUE,
    "before": _DATE_VALUE,
    "newer_than": re.compile(r"^\d{1,4}[dmy]$"),
    "older_than": re.compile(r"^\d{1,4}[dmy]$"),
    "has": re.compile(r"^(attachment|drive|document|spreadsheet|presentation|pdf)$"),
    "in": re.compile(r"^(anywhere|sent|inbox|spam|trash)$"),
    "filename": re.compile(r"^[\w.-]{1,80}$", re.UNICODE),
    "is": re.compile(r"^(read|unread|starred|important)$"),
}
_TOKEN_RE = re.compile(r'-?[\w]+:"[^"]*"|-?"[^"]*"|\S+', re.UNICODE)
_WORD_KEEP = re.compile(r"[^\w@.+-]", re.UNICODE)


def _clean_phrase(text: str) -> str:
    return " ".join(_WORD_KEEP.sub(" ", text or "").split())[:80]


def sanitize_query(q: str) -> str:
    """Query do Gmail só com o que a gente conhece. Operador desconhecido
    (label:, deliveredto:, {}, ( ), etc.) é descartado; valor fora do formato
    também. Palavras soltas perdem pontuação estranha. "" se não sobrou nada."""
    out: list[str] = []
    for raw in _TOKEN_RE.findall((q or "").replace("\n", " ")):
        neg = raw.startswith("-") and len(raw) > 1
        tok = raw[1:] if neg else raw
        if tok == "OR":
            if out and out[-1] != "OR":
                out.append("OR")
            continue
        op, sep, value = tok.partition(":")
        if sep and re.fullmatch(r"[A-Za-z_]+", op):
            op = op.lower()
            if op not in _OPS:
                continue
            value = value.strip()
            quoted = len(value) >= 2 and value[0] == '"' and value[-1] == '"'
            if quoted:
                value = value[1:-1]
            if op == "subject" or (quoted and op in ("from", "to", "cc", "bcc")):  # from:"Ana Souza"
                value = _clean_phrase(value)
                if not value:
                    continue
                value = f'"{value}"' if " " in value else value
            else:
                value = value.lower() if op not in ("filename",) else value
                m = _OPS[op].match(value)
                if not m:
                    continue
                if op in ("after", "before"):
                    y, mo, d = (int(x) for x in m.groups())
                    if not (1990 <= y <= 2100 and 1 <= mo <= 12 and 1 <= d <= 31):
                        continue
                    value = f"{y:04d}/{mo:02d}/{d:02d}"
            out.append(f"{'-' if neg else ''}{op}:{value}")
            continue
        if tok.startswith('"'):
            phrase = _clean_phrase(tok.strip('"'))
            if phrase:
                out.append(f'{"-" if neg else ""}"{phrase}"' if " " in phrase else f"{'-' if neg else ''}{phrase}")
            continue
        word = _clean_phrase(tok)
        for w in word.split():
            if len(w) >= 2:
                out.append(f"{'-' if neg else ''}{w}")
    while out and out[0] == "OR":
        out.pop(0)
    while out and out[-1] == "OR":
        out.pop()
    query = " ".join(out)
    if len(query) > MAX_QUERY_LEN:
        query = query[:MAX_QUERY_LEN].rsplit(" ", 1)[0]
    return query.strip()


# ── links ──
def gmail_url(thread_id: str) -> str:
    me = config.ACCOUNT
    authuser = f"?authuser={quote(me)}" if me else ""
    return f"https://mail.google.com/mail/{authuser}#all/{quote(thread_id or '')}"


def app_url(thread_id: str) -> str:
    """/copilot/{id} só se a thread está no radar (store local)."""
    return f"/copilot/{thread_id}" if thread_id and store.get_thread(thread_id) else ""


# ── prompts ──
def _extract_prompt(row: dict, body: str, hoje: str) -> str:
    return (
        "Você vai ajudar o Leo (leo@confrapag.com.br) a CONFERIR na caixa de e-mail dele o que este e-mail afirma.\n"
        f"Hoje é {hoje}. Leia a thread inteira, com foco na ÚLTIMA mensagem escrita por outra pessoa (não o Leo).\n"
        "Liste as AFIRMAÇÕES verificáveis sobre a caixa do Leo ou sobre eventos de e-mail: que o Leo recebeu algo "
        "(link de acesso, convite, anexo, boleto, relatório) de alguém por volta de uma data, que algo foi enviado a ele, "
        "que ele já respondeu/enviou algo, que um e-mail foi encaminhado, etc. Ignore opiniões, pedidos e fatos que não "
        "deixam rastro na caixa de e-mail.\n"
        f"No máximo {MAX_AFIRMACOES} afirmações, cada uma com até {MAX_CONSULTAS} consultas de busca do Gmail, da mais "
        "específica para a mais ampla. Operadores permitidos: from:, to:, cc:, subject:, palavras ou \"frase\", "
        "after:AAAA/MM/DD, before:AAAA/MM/DD, newer_than:Nd, has:attachment, filename:, in:anywhere (inclui arquivados, "
        "spam e lixeira), in:sent (o que o Leo enviou), OR. Use janelas de data folgadas (alguns dias antes e depois). "
        "Prefira e-mails e domínios que aparecem na thread.\n"
        "Responda SÓ com JSON, em português do Brasil, tratando o Leo por \"você\":\n"
        '{"afirmacoes": [{"texto": "Você recebeu de X um e-mail com o link de acesso por volta de 05/10", '
        '"consultas": ["from:x@empresa.com after:2026/10/03 before:2026/10/08 in:anywhere", "acesso link in:anywhere newer_than:14d"]}]}\n'
        'Sem afirmações verificáveis: {"afirmacoes": []}. NUNCA invente nome, e-mail ou data que não estão na thread.\n\n'
        f"Assunto: {row.get('subject') or ''}\n"
        f"Para: {row.get('to_header') or '?'} · Cc: {row.get('cc_header') or '-'}\n\n"
        f"Thread (mensagens separadas por ----, a última por último):\n{body[-14000:]}"
    )


def _evidence_line(key: str, ev: dict) -> str:
    where = "mesma conversa deste e-mail" if ev.get("mesma_thread") else "outra conversa"
    pasta = ", ".join(l for l in ev.get("labels") or [] if l in ("SENT", "INBOX", "SPAM", "TRASH", "DRAFT")) or "arquivado"
    return (
        f"[{key}] De: {ev.get('de') or '?'} | Para: {ev.get('para') or '?'} | Data: {ev.get('data') or '?'} | "
        f"Assunto: {ev.get('assunto') or ''} | Pasta: {pasta} | {where}\n    Trecho: {ev.get('snippet') or ''}"
    )


def _judge_prompt(row: dict, afirmacoes: list[dict], evidencias: dict, hoje: str) -> str:
    blocks = []
    for i, af in enumerate(afirmacoes):
        lines = [f"Afirmação {i + 1}: {af['texto']}"]
        for c in af["consultas"]:
            lines.append(f"  Consulta: {c['q']} -> {len(c['resultados'])} resultado(s){' (erro: ' + c['erro'] + ')' if c.get('erro') else ''}")
            for key in c["resultados"]:
                lines.append("  " + _evidence_line(key, evidencias[key]))
        blocks.append("\n".join(lines))
    return (
        "Você está conferindo, com buscas na caixa de e-mail do Leo (leo@confrapag.com.br), o que um e-mail afirma.\n"
        f"Hoje é {hoje}. Assunto do e-mail conferido: {row.get('subject') or ''}\n"
        "Para cada afirmação, decida com base SÓ nas evidências listadas (resultados das buscas):\n"
        '- "confirmado": há e-mail que sustenta a afirmação (remetente/assunto/data/trecho batem).\n'
        '- "nao_encontrado": as buscas não acharam nada que sustente.\n'
        '- "inconclusivo": achou algo parecido, mas não dá para afirmar (data, remetente ou conteúdo não batem bem).\n'
        "Mensagens da \"mesma conversa deste e-mail\" escritas por quem fez a afirmação NÃO a confirmam sozinhas "
        "(é o próprio e-mail se citando); respostas do Leo nessa conversa contam.\n"
        "Explicação curta (1-2 frases), em português do Brasil, tratando o Leo por \"você\", citando datas e remetentes. "
        "Em \"evidencias\" liste as chaves ([E1], [E2]…) dos e-mails que sustentam ou mais se aproximam.\n"
        "Responda SÓ com JSON: "
        '{"avaliacoes": [{"n": 1, "veredito": "confirmado", "explicacao": "...", "evidencias": ["E1"]}]}\n\n'
        + "\n\n".join(blocks)
    )


# ── etapas ──
def _hoje() -> str:
    return datetime.now(config.TZ).strftime("%d/%m/%Y (%A)")


def _extract(row: dict, body: str) -> list[dict]:
    try:
        data = copilot._parse(llm.complete(_extract_prompt(row, body, _hoje()), system=llm.SYSTEM, timeout=90.0))
    except Exception as exc:
        raise RuntimeError(f"A IA não respondeu agora ({copilot._clip(str(exc), 120)}). Tente de novo em instantes.") from exc
    if not isinstance(data.get("afirmacoes"), list):
        raise RuntimeError("A IA respondeu fora do formato. Tente Regerar.")
    out: list[dict] = []
    for af in data["afirmacoes"]:
        if not isinstance(af, dict):
            continue
        texto = " ".join(str(af.get("texto") or "").split())
        if not texto:
            continue
        consultas: list[str] = []
        for q in af.get("consultas") if isinstance(af.get("consultas"), list) else []:
            clean = sanitize_query(str(q))
            if clean and clean not in consultas:
                consultas.append(clean)
            if len(consultas) >= MAX_CONSULTAS:
                break
        out.append({"texto": copilot._clip(texto, 300), "consultas": consultas})
        if len(out) >= MAX_AFIRMACOES:
            break
    return out


def _evidence_from(hit: dict, thread_id: str) -> dict:
    snippet = html.unescape(" ".join(str(hit.get("snippet") or "").split()))
    assunto = str(hit.get("assunto") or "")
    if secrets_guard.looks_like_secret(snippet):
        snippet = _SECRET_SNIPPET
    if secrets_guard.looks_like_secret(assunto):
        assunto = "[assunto omitido]"
    tid = str(hit.get("thread_id") or "")
    return {
        "message_id": str(hit.get("message_id") or ""),
        "thread_id": tid,
        "assunto": assunto,
        "de": str(hit.get("de") or ""),
        "para": str(hit.get("para") or ""),
        "data": str(hit.get("data") or ""),
        "snippet": copilot._clip(snippet, 300),
        "labels": list(hit.get("labels") or []),
        "mesma_thread": tid == thread_id,
        "gmail_url": gmail_url(tid) if tid else "",
        "app_url": app_url(tid),
    }


def _search(thread_id: str, afirmacoes: list[dict]) -> tuple[list[dict], dict]:
    """Roda as consultas (uma vez cada) -> afirmações com {q, resultados:[E1..], erro}
    + mapa E# -> evidência. Mesma mensagem achada por duas consultas = mesma chave."""
    evidencias: dict = {}
    by_msg: dict = {}
    ran: dict = {}
    errors = 0
    total = 0
    out = []
    for af in afirmacoes:
        consultas = []
        for q in af["consultas"]:
            total += 1
            if q not in ran:
                try:
                    hits = gmail_client.search_messages(q, MAX_RESULTADOS)
                    keys = []
                    for hit in hits:
                        mid = str(hit.get("message_id") or "")
                        if mid not in by_msg:
                            key = f"E{len(evidencias) + 1}"
                            by_msg[mid] = key
                            evidencias[key] = _evidence_from(hit, thread_id)
                        keys.append(by_msg[mid])
                    ran[q] = (keys, "")
                except Exception as exc:
                    errors += 1
                    ran[q] = ([], copilot._clip(str(exc), 120))
            keys, err = ran[q]
            item = {"q": q, "resultados": keys}
            if err:
                item["erro"] = err
            consultas.append(item)
        out.append({"texto": af["texto"], "consultas": consultas})
    if total and errors == len(ran):
        raise RuntimeError("Não consegui buscar na sua caixa agora (o Gmail não respondeu). Tente de novo em instantes.")
    return out, evidencias


def _judge(row: dict, afirmacoes: list[dict], evidencias: dict) -> list[dict]:
    avaliacoes: dict = {}
    if any(c["resultados"] for af in afirmacoes for c in af["consultas"]):
        try:
            data = copilot._parse(llm.complete(_judge_prompt(row, afirmacoes, evidencias, _hoje()), system=llm.SYSTEM, timeout=90.0))
        except Exception as exc:
            raise RuntimeError(f"A IA não respondeu agora ({copilot._clip(str(exc), 120)}). Tente de novo em instantes.") from exc
        for i, av in enumerate(data.get("avaliacoes") if isinstance(data.get("avaliacoes"), list) else []):
            if not isinstance(av, dict):
                continue
            try:
                n = int(av.get("n") or (i + 1)) - 1
            except (TypeError, ValueError):
                n = i
            avaliacoes.setdefault(n, av)
    out = []
    for i, af in enumerate(afirmacoes):
        found = []
        for c in af["consultas"]:
            for key in c["resultados"]:
                if key not in found:
                    found.append(key)
        av = avaliacoes.get(i) or {}
        veredito = str(av.get("veredito") or "").strip().lower().replace("ã", "a").replace(" ", "_")
        if veredito not in VEREDITOS:
            veredito = "inconclusivo" if found else "nao_encontrado"
        explicacao = " ".join(str(av.get("explicacao") or "").split())
        if not explicacao:
            if not af["consultas"]:
                explicacao = "Não deu para montar uma busca para esta afirmação."
            elif not found:
                explicacao = "As buscas na sua caixa não acharam nenhum e-mail sobre isso."
            else:
                explicacao = "Achei e-mails parecidos, mas a IA não conseguiu concluir."
        citadas = [str(k).strip("[] ") for k in (av.get("evidencias") if isinstance(av.get("evidencias"), list) else [])]
        # só vale chave que a busca desta afirmação achou de verdade
        keys = [k for k in citadas if k in found]
        if not keys and veredito != "nao_encontrado":
            keys = found[:3]
        out.append({
            "texto": af["texto"],
            "veredito": veredito,
            "veredito_label": VEREDITO_LABEL[veredito],
            "explicacao": copilot._clip(explicacao, 400),
            "consultas": [{"q": c["q"], "resultados": len(c["resultados"]), **({"erro": c["erro"]} if c.get("erro") else {})}
                          for c in af["consultas"]],
            "evidencias": [{k: v for k, v in evidencias[k].items() if k != "labels"} | {"pasta": _pasta(evidencias[k])} for k in keys],
            "encontrados": len(found),
        })
    return out


def _pasta(ev: dict) -> str:
    labels = set(ev.get("labels") or [])
    for label, name in (("TRASH", "Lixeira"), ("SPAM", "Spam"), ("SENT", "Enviados"), ("INBOX", "Caixa de entrada"), ("DRAFT", "Rascunhos")):
        if label in labels:
            return name
    return "Arquivado"


# ── cache ──
def _out(cached: dict, *, from_cache: bool, stale: bool = False) -> dict:
    data = copilot._loads(cached.get("resultado_json"), {})
    return {
        "afirmacoes": data.get("afirmacoes") or [],
        "aviso": data.get("aviso") or "",
        "gerado_em": cached.get("gerado_em") or "",
        "cached": from_cache,
        "desatualizado": stale,
    }


def cached(thread_id: str) -> dict:
    """Só o cache (nunca chama IA nem Gmail). afirmacoes=None quando não há."""
    row = store.get_thread(thread_id)
    if not row:
        raise LookupError("Thread não encontrada.")
    hit = store.get_copilot_verificacao(thread_id)
    if not hit:
        return {"afirmacoes": None, "gerado_em": "", "cached": False, "desatualizado": False}
    return _out(hit, from_cache=True, stale=_is_stale(row, hit, None))


def _is_stale(row: dict, hit: dict, count) -> bool:
    if int(row.get("internal_date") or 0) > int(hit.get("internal_date_snapshot") or 0):
        return True
    return count is not None and bool(hit.get("msg_count_snapshot")) and count != int(hit["msg_count_snapshot"])


def verificar(thread_id: str, *, force: bool = False) -> dict:
    """Extrai -> busca (só leitura) -> avalia. Usa o cache se a thread não
    mudou e não é Regerar. Erros amigáveis em RuntimeError."""
    row = store.get_thread(thread_id)
    if not row:
        raise LookupError("Thread não encontrada.")
    body = copilot._thread_body(row)
    count = copilot._msg_count(body)
    hit = store.get_copilot_verificacao(thread_id)
    if hit and not force and not _is_stale(row, hit, count):
        return _out(hit, from_cache=True)

    if not llm.has_key():
        raise RuntimeError("Sem chave de IA configurada: o verificador precisa da IA para ler o e-mail. Configure em Configurações.")
    if not gmail_client.load_credentials():
        raise RuntimeError("O Gmail não está conectado: o verificador precisa ler a sua caixa (só leitura). Conecte em Configurações.")
    if secrets_guard.looks_like_secret(f"{row.get('subject') or ''}\n{body}"):
        raise RuntimeError("A conversa traz senha ou credencial: não mandei para a IA. Confira a caixa manualmente.")
    if len(re.sub(r"\s+", "", re.sub(r"^(De|Data):.*$", "", body, flags=re.M))) < 25:
        raise RuntimeError("Não consegui ler o texto da conversa (vazio, só imagem ou anexo).")

    afirmacoes = _extract(row, body)
    aviso = ""
    if afirmacoes:
        buscadas, evidencias = _search(thread_id, afirmacoes)
        resultado = _judge(row, buscadas, evidencias)
    else:
        resultado = []
        aviso = "Não achei neste e-mail nenhuma afirmação que dê para conferir na sua caixa."
    store.save_copilot_verificacao(
        thread_id, json.dumps({"afirmacoes": resultado, "aviso": aviso}, ensure_ascii=False),
        int(row.get("internal_date") or 0), count,
    )
    return _out(store.get_copilot_verificacao(thread_id) or {}, from_cache=False)
