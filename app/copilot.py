from __future__ import annotations

import json
import re
import threading
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from email.utils import getaddresses, parsedate_to_datetime
from urllib.parse import urlencode

from . import config, learned, llm, netstatus, rag, secrets_guard, store

# Copiloto: lê a caixa e, para cada thread, diz em 3 camadas
#   1. papel do Leo (só cópia, mencionado, demanda, FYI, pode ignorar);
#   2. o que aconteceu (uma linha);
#   3. o que ele faria (1-3 opções, cada uma com confiança e evidência citada).
# A regra central é a mesma do Auxiliar: opção sem evidência verificável é
# descartada -- citação de mensagem precisa existir de verdade no e-mail, e
# fonte numerada precisa ser um trecho que foi mesmo entregue ao modelo.
# "Responder" ainda exige precedente (cérebro ou decisão anterior); sem isso
# vira "preciso de contexto". Nada aqui envia e-mail: as ações só preparam
# rascunho e mudam o estado do item.

PAPEIS = ("so_copia", "mencionado_opiniao", "demanda", "fyi", "pode_ignorar")
OPCOES = ("direcionar", "estudar_depois_responder", "pedir_contexto", "responder", "aguardar")
URGENCIAS = ("alta", "media", "baixa", "neutra")
STATUS = ("aberto", "assumido", "delegado", "cobrado", "aguardando", "resolvido")
# Quadro: só o que ainda pede atenção. Resolver marca lido no Gmail, então
# uma coluna "Resolvido" num quadro de não lidos ficaria sempre vazia --
# resolvidos e lidos viram histórico à parte (HISTORY, sempre com ?all=1).
TABS = (
    {"key": "precisa_de_voce", "title": "Precisa de você"},
    {"key": "bola_com_outros", "title": "Aguardando outras pessoas"},
    {"key": "so_conhecimento", "title": "Só conhecimento"},
)
HISTORY = (
    {"key": "resolvido", "title": "Resolvidos"},
    {"key": "lidos", "title": "Marcados como lido"},
)
_KNOWLEDGE = {"so_copia", "fyi", "pode_ignorar"}
_PRECEDENT = {"learning_base", "decisao"}
_SOURCE_KIND = {"kb": "learning_base", "mail_sent": "decisao", "mail": "mensagem"}
_URG_ORDER = {"alta": 0, "media": 1, "baixa": 2, "neutra": 3}
_MIN_QUOTE = 8
_MAX_OPTIONS = 3
DEFAULT_LIMIT = 12
LIST_LIMIT = 200

_LOCK = threading.Lock()
_JOB: dict = {"running": False, "done": 0, "total": 0, "current": "", "current_id": "", "pending": [], "errors": 0, "finished_at": None, "cancel": False}
# Leitura automática: abrir o painel já dispara o lote em segundo plano.
# Thread que falhou não volta para o lote automático antes de _RETRY_AFTER
# (senão o painel, que recarrega ao fim do lote, ficaria em laço).
AUTO_BATCH = True
_RETRY_AFTER = 600
_TRIED: dict = {}
# Leitura da IA que deu erro (exceção ou resposta fora do formato): o item
# fica na fila "Analisando" marcado como falha até o Leo pedir de novo.
_FAILED: dict = {}
# Lida "por regra" de propósito (propaganda, aviso automático, credencial,
# corpo ilegível): é final até chegar mensagem nova -- não fica pedindo IA.
_FINAL = {"llm", "regra"}


# ── utilidades ──
def _me() -> str:
    return config.ACCOUNT


def _addresses(header: str | None) -> list[dict]:
    return [{"name": n, "email": a.strip().lower()} for n, a in getaddresses([header or ""]) if a]


def _norm(text: str) -> str:
    return " ".join((text or "").casefold().split())


def _clip(text: str, n: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _loads(raw: str | None, default):
    try:
        value = json.loads(raw) if raw else default
    except (TypeError, json.JSONDecodeError):
        return default
    return value if isinstance(value, type(default)) else default


def _now() -> datetime:
    return datetime.now(config.TZ)


def _last_message(body: str) -> str:
    blocks = [b for b in (body or "").split("\n\n----\n\n") if b.strip()]
    # sem as linhas De:/Data: -- o e-mail do próprio Leo ali contaria como "citaram o Leo"
    return re.sub(r"^(De|Data):.*$", "", blocks[-1], flags=re.M).strip() if blocks else ""


_PRAZO_RE = re.compile(r"\b(?:at[eé]|prazo[:\s]+|para)\s*(?:o dia\s*)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?", re.IGNORECASE)
_URGENTE_RE = re.compile(r"\burgente\b|\bhoje\b|\bainda hoje\b|\basap\b", re.IGNORECASE)
_PEDIDO_RE = re.compile(r"\?|\bpode(ria)?s?\b|\bconsegue\b|\bpor favor\b|\bpreciso\b|\bfavor\b|\bvalidar\b|\baprovar\b", re.IGNORECASE)
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _prazo_from_text(text: str, today: date) -> str:
    m = _PRAZO_RE.search(text or "")
    if not m:
        return ""
    day, month, year = int(m.group(1)), int(m.group(2)), m.group(3)
    y = int(year) + (2000 if year and len(year) == 2 else 0) if year else today.year
    try:
        found = date(y, month, day)
    except ValueError:
        return ""
    if not year and found < today - timedelta(days=60):
        found = date(y + 1, month, day)
    return found.isoformat()


def _mentions_me(text: str) -> bool:
    return bool(re.search(r"\b(leo|lettiery)\b", text or "", re.IGNORECASE))


def _short_name(name: str, email: str) -> str:
    name = (name or "").strip().strip('"')
    if name and "@" not in name:
        return " ".join(name.split()[:2])
    return (email or "").split("@")[0] or "Alguém"


def _rule_summary(row: dict, papel: str, prazo: str, bola: dict) -> str:
    """Uma linha dita com as palavras do painel, não o texto cru do e-mail
    -- quem resume o conteúdo é a IA; isto só segura o lugar até ela ler."""
    who = _short_name(row.get("from_name") or "", row.get("from_email") or "")
    if row.get("last_from_me"):
        other = _short_name(bola.get("nome") or "", bola.get("email") or "") if bola.get("email") else "retorno"
        line = f"Você foi o último a escrever; aguardando {other}."
    elif row.get("is_marketing"):
        line = f"Divulgação de {who}."
    elif row.get("is_automatic"):
        line = f"Aviso automático de {who}."
    elif papel == "demanda":
        line = f"{who} pede algo a você."
    elif papel == "mencionado_opiniao":
        line = f"{who} citou você na conversa."
    elif papel == "so_copia":
        line = f"{who} escreveu; você está só em cópia."
    else:
        line = f"{who} mandou um informativo."
    if prazo:
        line = line.rstrip(".") + f" (prazo {prazo[8:10]}/{prazo[5:7]})."
    return line


# ── leitura sem IA (sempre disponível) ──
def heuristic(row: dict, body: str = "") -> dict:
    """Primeira leitura só com regra: serve pra thread que a IA ainda não
    leu (o painel nunca fica vazio esperando LLM) e de base pra corrigir o
    que o modelo devolver fora do formato."""
    me = _me()
    to = [a["email"] for a in _addresses(row.get("to_header"))]
    cc = [a["email"] for a in _addresses(row.get("cc_header"))]
    last = _last_message(body) or row.get("snippet") or ""
    blob = f"{row.get('subject') or ''}\n{last}"
    today = _now().date()

    if row.get("is_marketing") or row.get("is_automatic"):
        papel = "pode_ignorar"
    elif row.get("last_from_me"):
        papel = "demanda"
    elif me in cc and me not in to:
        papel = "mencionado_opiniao" if _mentions_me(last) else "so_copia"
    elif row.get("needs_action_hint") or (me in to and _PEDIDO_RE.search(blob)):
        papel = "demanda"
    elif _mentions_me(last) and len(to) > 1:
        papel = "mencionado_opiniao"
    elif row.get("fyi_only"):
        papel = "fyi"
    elif not to and _PEDIDO_RE.search(blob):
        papel = "demanda"
    else:
        papel = "fyi"

    prazo = _prazo_from_text(blob, today)
    if papel in _KNOWLEDGE:
        urgencia = "neutra"
    elif _URGENTE_RE.search(blob) or (prazo and prazo <= (today + timedelta(days=1)).isoformat()):
        urgencia = "alta"
    elif papel == "demanda":
        urgencia = "media"
    else:
        urgencia = "baixa"

    if row.get("last_from_me"):
        others = [a for a in _addresses(row.get("to_header")) if a["email"] != me]
        who = others[0] if others else {"name": "", "email": ""}
        bola = {"com": "outros", "email": who["email"], "nome": who["name"]}
    elif papel in ("demanda", "mencionado_opiniao"):
        bola = {"com": "leo", "email": me, "nome": "Você"}
    else:
        bola = {"com": "ninguem", "email": "", "nome": ""}

    sender = (row.get("from_email") or "").lower()
    quem = {"nome": row.get("from_name") or "", "email": sender} if sender and sender != me else {"nome": "", "email": ""}
    return {
        "papel": papel,
        "o_que_aconteceu": _rule_summary(row, papel, prazo, bola),
        "opcoes": [],
        "urgencia": urgencia,
        "bola": bola,
        "depende_de_outros": bola["com"] == "outros",
        "sem_resposta_desde": int(row.get("internal_date") or 0) if bola["com"] != "ninguem" else None,
        "prazo": prazo,
        "quem_pediu": quem,
        "tarefas": [],
        "needs_context": False,
        "o_que_falta": "",
        "pergunta": "",
        "status": "aberto",
        "source": "heuristica",
    }


# ── leitura com IA ──
def _sources(row: dict, body: str) -> list[dict]:
    """Trechos numerados que o modelo pode citar: cérebro + histórico (RAG)
    e o que o Leo já fez antes com e-mails dessa pessoa."""
    hits = rag.search(f"{row.get('subject') or ''}\n{body[-3000:]}", k=6, exclude_ref=f"mail:{row['id']}")
    out = [
        {"tipo": _SOURCE_KIND.get(h["source"], "mensagem"), "titulo": h["title"], "texto": h["body"]}
        for h in hits
    ]
    for a in store.copilot_actions_for_sender(row.get("from_email") or "", row["id"]):
        payload = _loads(a.get("payload_json"), {})
        detail = payload.get("para") or payload.get("acao") or ""
        out.append(
            {
                "tipo": "decisao",
                "titulo": f"Você já fez \"{a['action']}\" em: {a.get('subject') or '(sem assunto)'}",
                "texto": f"Em {(a.get('at') or '')[:10]} você escolheu {a['action']}" + (f" ({detail})" if detail else "") + ".",
            }
        )
    return out


def _prompt(row: dict, body: str, sources: list[dict], base: dict) -> str:
    numbered = "\n\n".join(
        f"[{i}] ({s['tipo']}) {s['titulo']}\n{s['texto'][:800]}" for i, s in enumerate(sources, 1)
    ) or "(nenhum trecho encontrado)"
    return (
        "Você é o COPILOTO de e-mails do Leo (leo@confrapag.com.br). Leia a thread e responda SÓ com JSON.\n"
        "Campos:\n"
        f'- "papel_leo": um de {list(PAPEIS)}. so_copia = Leo só copiado sem pedido a ele; '
        "mencionado_opiniao = citam o Leo ou pedem a opinião dele; demanda = pedem algo que o Leo precisa fazer/decidir; "
        "fyi = informativo; pode_ignorar = ruído.\n"
        '- "o_que_aconteceu": UMA linha humana (máx. 140 caracteres) sobre o estado atual da conversa, '
        "com suas palavras (resuma; não copie o texto do e-mail).\n"
        f'- "urgencia": um de {list(URGENCIAS)} (alta só com prazo real ou impacto claro).\n'
        '- "bola": "leo" | "outros" | "ninguem" -- com quem está o próximo passo; "bola_email": e-mail de quem está com a bola.\n'
        '- "depende_de_outros": true|false. "prazo": "AAAA-MM-DD" só se estiver escrito no e-mail, senão "".\n'
        '- "quem_pediu": {"nome": "...", "email": "..."}. "tarefas": lista curta de passos concretos (pode ser vazia).\n'
        f'- "o_que_eu_faria": 1 a 3 opções, cada uma {{"acao": um de {list(OPCOES)}, "texto": "frase curta", '
        '"para": "e-mail (só em direcionar)", "confianca": 0.0-1.0, "evidencias": [...]}.\n'
        '  Cada evidência é {"tipo": "mensagem", "citacao": "trecho COPIADO LITERALMENTE da thread"} ou '
        '{"tipo": "fonte", "n": número do trecho, "porque": "por que serve"}.\n'
        "  Opção sem evidência será descartada. \"responder\" exige pelo menos uma fonte do cérebro ou decisão anterior "
        "(precedente); sem precedente, prefira pedir_contexto, estudar_depois_responder ou direcionar.\n"
        "  Se o papel for demanda ou mencionado_opiniao, traga ao menos uma opção concreta -- uma citação literal "
        "do pedido na thread já serve de evidência.\n"
        '- "o_que_falta" e "pergunta": se faltar contexto, o que falta e uma pergunta curta ao Leo (trate por "você").\n'
        "NUNCA invente fato, nome, valor ou data.\n\n"
        f"{learned.notes_block(row.get('id') or '', row.get('subject') or '', learned.thread_emails(row))}"
        f"Leitura por regra (pode corrigir): papel={base['papel']}, bola={base['bola']['com']}.\n"
        f"Para: {row.get('to_header') or '?'}\nCc: {row.get('cc_header') or '-'}\n\n"
        f"Trechos disponíveis:\n{numbered}\n\n"
        f"Assunto: {row.get('subject') or ''}\n\nThread:\n{body[-12000:]}"
    )


def _parse(raw: str) -> dict:
    match = re.search(r"\{.*\}", raw or "", re.DOTALL)
    try:
        data = json.loads(match.group(0)) if match else {}
    except json.JSONDecodeError:
        data = {}
    return data if isinstance(data, dict) else {}


def _evidence(items, body: str, sources: list[dict]) -> list[dict]:
    """Só passa evidência verificável: citação que existe na thread ou
    número de trecho que foi mesmo entregue ao modelo."""
    out: list[dict] = []
    norm_body = _norm(body)
    seen: set = set()
    for ev in items if isinstance(items, list) else []:
        if not isinstance(ev, dict):
            continue
        tipo = str(ev.get("tipo") or "").strip().lower()
        if tipo == "mensagem":
            quote = " ".join(str(ev.get("citacao") or "").split()).strip(" \"'“”")
            if len(quote) < _MIN_QUOTE or _norm(quote) not in norm_body or ("m", _norm(quote)) in seen:
                continue
            seen.add(("m", _norm(quote)))
            out.append({"tipo": "mensagem", "titulo": "Na própria thread", "trecho": _clip(quote, 240), "porque": str(ev.get("porque") or "").strip()})
        elif tipo in ("fonte", "learning_base", "decisao"):
            try:
                n = int(ev.get("n"))
            except (TypeError, ValueError):
                continue
            if not 1 <= n <= len(sources) or ("f", n) in seen:
                continue
            seen.add(("f", n))
            src = sources[n - 1]
            out.append({"tipo": src["tipo"], "titulo": src["titulo"], "trecho": _clip(src["texto"], 240), "porque": str(ev.get("porque") or "").strip()})
    return out


def _options(raw_opts, body: str, sources: list[dict]) -> list[dict]:
    out = []
    for opt in raw_opts if isinstance(raw_opts, list) else []:
        if not isinstance(opt, dict):
            continue
        acao = str(opt.get("acao") or "").strip().lower()
        if acao not in OPCOES:
            continue
        evid = _evidence(opt.get("evidencias"), body, sources)
        if not evid:
            continue
        if acao == "responder" and not any(e["tipo"] in _PRECEDENT for e in evid):
            continue
        try:
            conf = max(0.0, min(1.0, float(opt.get("confianca") or 0.0)))
        except (TypeError, ValueError):
            conf = 0.0
        para = str(opt.get("para") or "").strip().lower()
        out.append(
            {
                "acao": acao,
                "texto": _clip(str(opt.get("texto") or ""), 220),
                "para": para if "@" in para else "",
                "confianca": round(conf, 2),
                "evidencias": evid,
            }
        )
    out.sort(key=lambda o: -o["confianca"])
    return out[:_MAX_OPTIONS]


def interpret(row: dict, body: str, parsed: dict, sources: list[dict]) -> dict:
    """Transforma a resposta do modelo em item validado, completando com a
    leitura por regra onde o modelo falhar."""
    base = heuristic(row, body)
    item = dict(base)
    papel = str(parsed.get("papel_leo") or "").strip().lower()
    item["papel"] = papel if papel in PAPEIS else base["papel"]
    line = _clip(str(parsed.get("o_que_aconteceu") or "").splitlines()[0] if parsed.get("o_que_aconteceu") else "", 160)
    item["o_que_aconteceu"] = line or base["o_que_aconteceu"]
    urg = str(parsed.get("urgencia") or "").strip().lower()
    item["urgencia"] = urg if urg in URGENCIAS else base["urgencia"]
    if item["papel"] in _KNOWLEDGE and item["urgencia"] == "alta":
        item["urgencia"] = "baixa"

    bola = str(parsed.get("bola") or "").strip().lower()
    if row.get("last_from_me"):
        item["bola"] = base["bola"]
    elif bola == "leo":
        item["bola"] = {"com": "leo", "email": _me(), "nome": "Você"}
    elif bola == "outros":
        email = str(parsed.get("bola_email") or "").strip().lower()
        known = {a["email"]: a["name"] for a in _addresses(f"{row.get('to_header') or ''},{row.get('cc_header') or ''},{row.get('last_from_header') or ''}")}
        item["bola"] = {"com": "outros", "email": email if email in known else "", "nome": known.get(email, "")}
    elif bola == "ninguem":
        item["bola"] = {"com": "ninguem", "email": "", "nome": ""}
    item["depende_de_outros"] = bool(parsed.get("depende_de_outros")) or item["bola"]["com"] == "outros"
    item["sem_resposta_desde"] = int(row.get("internal_date") or 0) if item["bola"]["com"] != "ninguem" else None

    prazo = str(parsed.get("prazo") or "").strip()
    item["prazo"] = prazo if _ISO_RE.match(prazo) else base["prazo"]
    quem = parsed.get("quem_pediu") if isinstance(parsed.get("quem_pediu"), dict) else {}
    if quem.get("email") and "@" in str(quem["email"]):
        item["quem_pediu"] = {"nome": str(quem.get("nome") or ""), "email": str(quem["email"]).strip().lower()}
    tarefas = parsed.get("tarefas") if isinstance(parsed.get("tarefas"), list) else []
    item["tarefas"] = [{"texto": _clip(str(t), 140), "feita": False} for t in tarefas if str(t).strip()][:5]

    item["opcoes"] = _options(parsed.get("o_que_eu_faria"), body, sources)
    item["needs_context"] = not item["opcoes"] and item["papel"] in ("demanda", "mencionado_opiniao")
    item["o_que_falta"] = _clip(str(parsed.get("o_que_falta") or ""), 300)
    item["pergunta"] = _clip(str(parsed.get("pergunta") or ""), 200)
    if item["needs_context"] and not item["o_que_falta"]:
        item["o_que_falta"] = "Não encontrei no e-mail, no cérebro ou nas suas decisões anteriores base para sugerir um caminho."
    item["source"] = "llm"
    return item


def _msg_count(body: str | None) -> int:
    return len(_messages(body or ""))


def _persist(row: dict, item: dict, prev: dict | None, body: str | None = None) -> None:
    moved = bool(prev) and int(row.get("internal_date") or 0) > int(prev.get("internal_date_snapshot") or 0)
    keep_status = prev and not moved and prev.get("status") in STATUS
    done = {t.get("texto") for t in _loads(prev.get("tarefas_json") if prev else None, []) if t.get("feita")}
    for t in item["tarefas"]:
        t["feita"] = t["texto"] in done
    fields = {
        "papel": item["papel"],
        "o_que_aconteceu": item["o_que_aconteceu"],
        "opcoes_json": json.dumps(item["opcoes"], ensure_ascii=False),
        "urgencia": item["urgencia"],
        "depende_de_outros": int(item["depende_de_outros"]),
        "sem_resposta_desde": item["sem_resposta_desde"],
        "prazo": item["prazo"],
        "quem_pediu_json": json.dumps(item["quem_pediu"], ensure_ascii=False),
        "tarefas_json": json.dumps(item["tarefas"], ensure_ascii=False),
        "needs_context": int(item["needs_context"]),
        "o_que_falta": item["o_que_falta"],
        "pergunta": item["pergunta"],
        "source": item["source"],
        "internal_date_snapshot": row.get("internal_date") or 0,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
    }
    if body:
        fields["msg_count_snapshot"] = _msg_count(body)
    if not keep_status:
        # Item novo ou mensagem nova na thread: volta a ser lido do zero.
        fields.update(status="aberto", delegado_json=None, bola_json=json.dumps(item["bola"], ensure_ascii=False))
    elif prev.get("status") == "aberto":
        fields["bola_json"] = json.dumps(item["bola"], ensure_ascii=False)
    elif prev.get("status") in ("delegado", "cobrado", "aguardando"):
        # Delegou/cobrou e nada mudou na thread: a releitura não desfaz isso.
        fields["depende_de_outros"] = 1
    store.save_copilot_item(row["id"], **fields)


def _save_analysis_to_learning_base(row: dict, item: dict, sources: list | None = None) -> None:
    """Grava um resumo curto da leitura do copiloto em radar-contextos/
    (Learning Base), sem chamar LLM de destino — path fixo em emails.
    Só na análise nova (não no short-circuit _fresh)."""
    try:
        from .assistant import _cleanup_old_exports, _slug
        from .config import LEARNING_BASE_DEFAULT
    except Exception:
        return
    export_dir = LEARNING_BASE_DEFAULT / "radar-contextos"
    try:
        export_dir.mkdir(parents=True, exist_ok=True)
        _cleanup_old_exports(export_dir)
    except OSError:
        return
    tid = row.get("id") or ""
    subject = row.get("subject") or "(sem assunto)"
    lines = [
        f"# Copiloto · {subject}",
        "",
        f"- **Thread:** `{tid}`",
        f"- **De:** {row.get('from_name') or ''} <{row.get('from_email') or ''}>",
        f"- **Analisado em:** {item.get('analyzed_at') or ''}",
        f"- **Fonte:** {item.get('source') or ''}",
        f"- **Papel:** {item.get('papel') or ''}",
        f"- **Urgência:** {item.get('urgencia') or ''}",
        "",
        "## O que aconteceu",
        "",
        item.get("o_que_aconteceu") or "—",
        "",
    ]
    if item.get("needs_context"):
        lines += ["## Precisa de contexto", "", item.get("o_que_falta") or "", ""]
        if item.get("pergunta"):
            lines += [f"**Pergunta:** {item['pergunta']}", ""]
    opts = item.get("opcoes") or []
    if opts:
        lines += ["## O que eu faria", ""]
        for i, op in enumerate(opts, 1):
            lines.append(f"{i}. **{op.get('acao') or ''}** — {op.get('texto') or ''} (confiança {op.get('confianca', '')})")
            for ev in op.get("evidencias") or []:
                lines.append(f"   - [{ev.get('tipo') or ''}] {ev.get('titulo') or ev.get('texto') or ''}")
            lines.append("")
    if sources:
        lines += ["## Contexto carregado", ""]
        for s in sources[:12]:
            lines.append(f"- [{s.get('tipo') or s.get('kind') or ''}] {s.get('titulo') or s.get('title') or ''}")
        lines.append("")
    filename = f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}_copilot_{_slug(subject)}_{tid[:8]}.md"
    for old in export_dir.glob(f"*_copilot_*_{tid[:8]}.md"):
        try:
            old.unlink()
        except OSError:
            pass
    try:
        (export_dir / filename).write_text("\n".join(lines), encoding="utf-8")
    except OSError:
        pass


def analyze(thread_id: str, *, force: bool = False) -> dict:
    """Lê uma thread (com IA quando dá) e grava o item. Sem chave de LLM,
    sem corpo legível ou com credencial no texto, grava a leitura por regra.
    Se já há leitura final e a thread não mudou, devolve o cache (a menos
    que force=True — Pedir leitura / Ler de novo)."""
    from . import assistant  # import tardio: assistant importa copilot no gancho do piloto

    row = store.get_thread(thread_id)
    if not row:
        raise RuntimeError("Thread não está no radar.")
    prev = store.get_copilot_item(thread_id)
    if not force and _fresh(row, prev):
        return detail(thread_id)
    try:
        body = assistant._ensure_body(thread_id)
    except Exception as exc:
        # Sem conexão/sem acesso: não grava leitura "corpo ilegível" falsa --
        # sobe o erro e o item continua na fila até o Gmail voltar.
        if netstatus.kind_of(exc) != "error":
            raise
        body = row.get("body_text") or ""
    base = heuristic(row, body)

    if row.get("is_marketing") or row.get("is_automatic"):
        item = {**base, "source": "regra"}
    elif not llm.has_key():
        item = base
    elif secrets_guard.looks_like_secret(f"{row.get('subject') or ''}\n{body}"):
        item = {**base, "needs_context": base["papel"] in ("demanda", "mencionado_opiniao"), "source": "regra",
                "o_que_falta": "O e-mail traz senha ou credencial: não mandei para a IA. Veja com calma."}
    elif len(re.sub(r"\s+", "", re.sub(r"^(De|Data):.*$", "", body, flags=re.M))) < 25:
        item = {**base, "source": "regra", "o_que_falta": "Não consegui ler o texto (vazio, só imagem ou anexo)."}
    else:
        sources = _sources(row, body)
        try:
            parsed = _parse(llm.complete(_prompt(row, body, sources, base), system=llm.SYSTEM))
        except Exception:
            _FAILED[thread_id] = time.time()
            raise
        item = interpret(row, body, parsed, sources) if parsed else base
    if item["source"] == "heuristica" and llm.has_key():
        _FAILED[thread_id] = time.time()
    else:
        _FAILED.pop(thread_id, None)
    _persist(row, item, prev, body)
    if item.get("source") == "llm":
        saved = store.get_copilot_item(thread_id) or {}
        snap = {**item, "analyzed_at": saved.get("analyzed_at") or item.get("analyzed_at")}
        _save_analysis_to_learning_base(row, snap, locals().get("sources"))
    return detail(thread_id)


# ── lote incremental ──
def _count_changed(row: dict, prev: dict | None) -> bool:
    """A IA leu N mensagens; o corpo atual (o mesmo do /mail) tem outro
    número. Pega o caso em que a leitura foi feita num corpo em cache velho
    (só a 1ª mensagem) mesmo com internal_date já atualizado. Leituras
    antigas, sem contagem gravada, não entram (não dá para saber)."""
    snap = int((prev or {}).get("msg_count_snapshot") or 0)
    body = row.get("body_text") or ""
    return bool(snap and body) and _msg_count(body) != snap


def _fresh(row: dict, prev: dict | None) -> bool:
    return (
        bool(prev) and prev.get("source") in _FINAL
        and int(row.get("internal_date") or 0) <= int(prev.get("internal_date_snapshot") or 0)
        and not _count_changed(row, prev)
    )


def candidates(limit: int = DEFAULT_LIMIT, force: bool = False) -> list[str]:
    """Threads sem leitura da IA ou com mensagem nova desde a última.
    Não lidas primeiro: é o que o painel mostra por padrão."""
    items = store.list_copilot_items()
    rows = sorted(store.list_visible()[:LIST_LIMIT], key=lambda r: not r.get("is_unread"))
    out = []
    for row in rows:
        if _fresh(row, items.get(row["id"])) and not force:
            continue
        out.append(row["id"])
        if len(out) >= limit:
            break
    return out


def _status_unlocked() -> dict:
    return {k: (list(v) if k == "pending" else v) for k, v in _JOB.items() if k != "cancel"}


def job_status() -> dict:
    with _LOCK:
        return _status_unlocked()


def _launch(ids: list[str]) -> None:
    """Chamar com _LOCK preso."""
    _JOB.pop("paused", None)
    _JOB.update(running=bool(ids), done=0, total=len(ids), current="", current_id="", pending=list(ids), errors=0,
                cancel=False, finished_at=None if ids else datetime.now().isoformat())
    if ids:
        threading.Thread(target=_run, args=(ids,), daemon=True).start()


def _offline_status() -> dict | None:
    """Sem conexão com o Gmail o lote nem começa (leria corpo que não vem e
    encheria a fila de falhas): devolve o status com o motivo da pausa."""
    state = netstatus.status()
    if state == netstatus.ONLINE:
        return None
    return {**_status_unlocked(), "paused": state}


def start(limit: int = DEFAULT_LIMIT, force: bool = False) -> dict:
    limit = max(1, min(int(limit), 40))
    with _LOCK:
        paused = _offline_status()
        if paused:
            return paused
        if not _JOB.get("running"):
            _launch(candidates(limit, force))
        return _status_unlocked()


def ensure_batch(limit: int = DEFAULT_LIMIT) -> dict:
    """Chamada ao abrir o painel: com chave de IA e e-mail sem leitura, já
    começa o lote em segundo plano (sem esperar o Leo clicar em ⟳)."""
    if not AUTO_BATCH or not llm.has_key():
        return job_status()
    with _LOCK:
        paused = _offline_status()
        if paused:
            return paused
        if not _JOB.get("running"):
            now = time.time()
            ids = [t for t in candidates(limit * 3) if now - _TRIED.get(t, 0) > _RETRY_AFTER][:limit]
            if ids:
                _launch(ids)
        return _status_unlocked()


def _run(ids: list[str]) -> None:
    for thread_id in ids:
        with _LOCK:
            if _JOB.get("cancel"):
                break
            row = store.get_thread(thread_id) or {}
            _JOB.update(current=row.get("subject") or "", current_id=thread_id)
            _TRIED[thread_id] = time.time()
        failed = 0
        # o Leo pode ter aberto (e lido) este item enquanto o lote andava
        if not (row and _fresh(row, store.get_copilot_item(thread_id))):
            try:
                analyze(thread_id)
            except Exception as exc:
                if netstatus.is_network_error(exc) or netstatus.is_auth_error(exc):
                    # caiu a conexão no meio do lote: para em silêncio, sem
                    # marcar falha (volta sozinho no próximo lote, já online)
                    _FAILED.pop(thread_id, None)
                    _TRIED.pop(thread_id, None)
                    with _LOCK:
                        _JOB["paused"] = "offline"
                    break
                failed = 1
                _FAILED[thread_id] = time.time()
        with _LOCK:
            _JOB["done"] += 1
            _JOB["errors"] += failed
            if thread_id in _JOB["pending"]:
                _JOB["pending"].remove(thread_id)
    with _LOCK:
        _JOB.update(running=False, current="", current_id="", pending=[], finished_at=datetime.now().isoformat())


# ── apresentação ──
def _from_db(row: dict, db: dict | None) -> dict:
    if not db:
        return heuristic(row, row.get("body_text") or "")
    if db.get("source") != "llm":
        # leitura por regra antiga guardava o snippet cru: mostra a linha da regra
        bola = _loads(db.get("bola_json"), {"com": "ninguem", "email": "", "nome": ""})
        db = {**db, "o_que_aconteceu": _rule_summary(row, db.get("papel") or "fyi", db.get("prazo") or "", bola)}
    return {
        "papel": db.get("papel") or "fyi",
        "o_que_aconteceu": db.get("o_que_aconteceu") or "",
        "opcoes": _loads(db.get("opcoes_json"), []),
        "urgencia": db.get("urgencia") or "neutra",
        "bola": _loads(db.get("bola_json"), {"com": "ninguem", "email": "", "nome": ""}),
        "depende_de_outros": bool(db.get("depende_de_outros")),
        "sem_resposta_desde": db.get("sem_resposta_desde"),
        "prazo": db.get("prazo") or "",
        "quem_pediu": _loads(db.get("quem_pediu_json"), {"nome": "", "email": ""}),
        "tarefas": _loads(db.get("tarefas_json"), []),
        "needs_context": bool(db.get("needs_context")),
        "o_que_falta": db.get("o_que_falta") or "",
        "pergunta": db.get("pergunta") or "",
        "status": db.get("status") or "aberto",
        "source": db.get("source") or "heuristica",
        "delegado": _loads(db.get("delegado_json"), {}),
        "analyzed_at": db.get("analyzed_at"),
    }


def tab_for(item: dict) -> str:
    if item["status"] == "resolvido":
        return "resolvido"
    if item["status"] in ("delegado", "cobrado", "aguardando") or item["bola"].get("com") == "outros":
        return "bola_com_outros"
    if item["papel"] in _KNOWLEDGE and item["status"] != "assumido":
        return "so_conhecimento"
    return "precisa_de_voce"


def history_key(item: dict) -> str:
    """Em que histórico o item aparece: "resolvido" (o Leo fechou) ou
    "lidos" (lido no Gmail, já com leitura/ação do copiloto). "" = nenhum."""
    if item.get("status") == "resolvido":
        return "resolvido"
    if not item.get("is_unread") and item.get("no_copiloto") and not item.get("pendente"):
        return "lidos"
    return ""


FILA = {"key": "analisando", "title": "Analisando"}


def classified(item: dict, acted: bool = False) -> bool:
    """Item "classificado" = já tem dono para a coluna: a IA leu (llm), a
    regra leu de propósito (propaganda, credencial, corpo ilegível) ou o Leo
    já agiu nele (status fora de "aberto" ou qualquer ação registrada -- a
    decisão humana também classifica). Mensagem nova depois da leitura não
    desfaz isso: o cartão fica na coluna, marcado "desatualizado"."""
    return item["source"] in _FINAL or item["status"] != "aberto" or acted


def _present(row: dict, db: dict | None, acted: bool = False, ai: bool | None = None) -> dict:
    item = _from_db(row, db)
    # quem pediu / sem resposta: das mensagens reais (corpo em cache), não do último remetente
    _apply_conversa(item, conversa(_messages(row.get("body_text") or ""), _participants(row)))
    item.setdefault("delegado", {})
    item.setdefault("analyzed_at", None)
    snapshot = int((db or {}).get("internal_date_snapshot") or 0)
    # Com IA, o que ela ainda não leu fica na fila "Analisando" e não entra
    # nas colunas (o palpite da heurística não é classificação). Sem chave
    # de IA não há quem leia: vale o comportamento antigo, colunas pela regra.
    pendente = (llm.has_key() if ai is None else ai) and not classified(item, acted)
    return {
        "thread_id": row["id"],
        "subject": row.get("subject") or "(sem assunto)",
        "from_name": row.get("from_name") or row.get("from_email") or "",
        "from_email": row.get("from_email") or "",
        "internal_date": int(row.get("internal_date") or 0),
        "is_unread": bool(row.get("is_unread")),
        "no_copiloto": bool(db),
        "analisado": item["source"] == "llm",
        # propaganda, credencial ou corpo ilegível: a regra basta, a IA não precisa ler
        "lido_por_regra": item["source"] == "regra",
        "desatualizado": bool(db) and (int(row.get("internal_date") or 0) > snapshot or _count_changed(row, db)),
        "tab": FILA["key"] if pendente else tab_for(item),
        "pendente": pendente,
        # a leitura deu erro: continua na fila até o Leo pedir de novo
        "falhou": pendente and row["id"] in _FAILED,
        **item,
    }


def _sort_key(it: dict):
    return (_URG_ORDER.get(it["urgencia"], 9), it["prazo"] or "9999", -(it["internal_date"] or 0))


def list_items(show_all: bool | None = None, user: str | None = None) -> dict:
    """Por padrão só os não lidos; a preferência "show_all" (ou o parâmetro)
    devolve tudo. Abas, cartões Hoje/Esperando e contagens seguem o modo."""
    if show_all is None:
        show_all = bool(get_prefs(user)["show_all"])
    stored = store.list_copilot_items()
    acted = store.copilot_acted_thread_ids()
    ai = llm.has_key()
    items = [_present(row, stored.get(row["id"]), row["id"] in acted, ai) for row in store.list_visible()[:LIST_LIMIT]]
    seen = {i["thread_id"] for i in items}
    # Resolvidos/delegados podem ter saído da caixa visível (respondidos): continuam na aba deles.
    for tid, db in stored.items():
        if tid not in seen and db.get("status") in ("resolvido", "delegado", "cobrado", "aguardando"):
            row = store.get_thread(tid)
            if row:
                items.append(_present(row, db, tid in acted, ai))
    total = len(items)
    # histórico conta sempre sobre a caixa inteira (resolvido = já lido no Gmail)
    historico = [
        {**h, "count": sum(1 for i in items if history_key(i) == h["key"])} for h in HISTORY
    ]
    if not show_all:
        items = [i for i in items if i["is_unread"] and i["tab"] != "resolvido"]
    items.sort(key=_sort_key)
    # abas, "Hoje" e "Esperando outros" contam só o que já foi classificado;
    # a fila "Analisando" vem à parte (os itens dela têm tab == "analisando")
    tabs = [{**t, "count": sum(1 for i in items if i["tab"] == t["key"])} for t in TABS]
    fila = [i for i in items if i["pendente"]]
    now = _now()
    today = now.date().isoformat()
    start_ms = int(datetime(now.year, now.month, now.day, tzinfo=config.TZ).timestamp() * 1000)
    hoje = [
        i for i in items
        if i["tab"] == "precisa_de_voce"
        and (i["urgencia"] == "alta" or (i["prazo"] and i["prazo"] <= today) or i["internal_date"] >= start_ms)
    ]
    return {
        "saudacao": greeting(now),
        "data": now.strftime("%d/%m"),
        "cards": {"hoje": len(hoje), "esperando_outros": tabs[1]["count"]},
        "tabs": tabs,
        "historico": historico,
        "fila": {**FILA, "count": len(fila), "falhas": sum(1 for i in fila if i["falhou"]), "ativa": ai},
        "items": items,
        "show_all": show_all,
        "total": total,
        "job": job_status(),
        "llm": llm.has_key(),
    }


def greeting(now: datetime | None = None) -> str:
    hour = (now or _now()).hour
    return "Bom dia, Leo" if 5 <= hour < 12 else "Boa tarde, Leo" if 12 <= hour < 18 else "Boa noite, Leo"


def _originators(row: dict) -> list[dict]:
    """Quem já está na conversa (remetente, Para, Cc), sem o Leo -- vão em
    Cc quando ele delega às claras."""
    me, seen, out = _me(), set(), []
    for a in _addresses(f"{row.get('last_from_header') or ''},{row.get('to_header') or ''},{row.get('cc_header') or ''}"):
        if a["email"] != me and a["email"] not in seen:
            seen.add(a["email"])
            out.append(a)
    if not out and row.get("from_email") and row["from_email"] != me:
        out.append({"name": row.get("from_name") or "", "email": row["from_email"]})
    return out


_HEAD_RE = re.compile(r"^(De|Data):[ \t]*(.*)$", re.M)


def _messages(body: str) -> list[dict]:
    """Thread completa, mensagem a mensagem (o corpo vem do Gmail em blocos
    "De:/Data:" separados por ----)."""
    out = []
    for block in (b for b in (body or "").split("\n\n----\n\n") if b.strip()):
        head = {m.group(1): m.group(2).strip() for m in _HEAD_RE.finditer(block[:600])}
        text = _HEAD_RE.sub("", block, count=len(head)).strip() if head else block.strip()
        out.append({"de": head.get("De", ""), "data": head.get("Data", ""), "texto": text})
    return out


_QUOTE_START_RE = re.compile(r"\n>? ?(?:Em [\s\S]{0,160}?escreveu:|On [\s\S]{0,160}?wrote:)")


def _own_text(text: str) -> str:
    """Só o que a pessoa escreveu: sem o histórico citado ("Em ... escreveu:")
    nem linhas com ">"."""
    m = _QUOTE_START_RE.search("\n" + (text or ""))
    text = (text or "")[: max(0, m.start() - 1)] if m else (text or "")
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith(">")).strip()


def _who(header: str) -> dict:
    found = _addresses(header)
    if found:
        return {"nome": _short_name(found[0]["name"], found[0]["email"]), "email": found[0]["email"]}
    return {"nome": (header or "").strip() or "Alguém", "email": ""}


def resumo_contexto(item: dict, mensagens: list[dict]) -> dict:
    """Contexto da conversa para o card de sugestão: quem abriu pedindo o
    quê, o que você já respondeu e quem escreveu por último. Tirado das
    mensagens (sem IA); a linha da camada 2 vem junto."""
    me = _me()
    out = {
        "o_que_aconteceu": item.get("o_que_aconteceu") or "",
        "total_mensagens": len(mensagens),
        "abertura": None,
        "sua_resposta": None,
        "ultima": None,
    }
    if not mensagens:
        return out

    def view(m: dict, n: int) -> dict:
        who = _who(m.get("de") or "")
        return {**who, "data": m.get("data") or "", "trecho": _clip(_own_text(m.get("texto") or ""), n)}

    first = mensagens[0]
    out["abertura"] = view(first, 280)
    mine = [m for m in mensagens[1:] if _who(m.get("de") or "")["email"] == me]
    if _who(first.get("de") or "")["email"] == me:
        out["abertura"]["voce"] = True
    if mine:
        out["sua_resposta"] = view(mine[-1], 240)
    if len(mensagens) > 1:
        last = view(mensagens[-1], 240)
        last["voce"] = last["email"] == me
        out["ultima"] = last
    return out


# ── estado da conversa: quem pediu, se já responderam, quem falou por último ──
# Tirado das mensagens reais da thread (a mesma fonte do /mail), não do
# cabeçalho da última mensagem: "quem pediu" é o autor da mensagem que abriu
# o pedido em aberto (mensagens seguidas dele ou de terceiros são reforço),
# "respondido" é quando o destinatário do pedido escreveu depois dele.
def _msg_ts(raw: str) -> int | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError, IndexError):
        dt = None
    if dt is None:
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=config.TZ)
    return int(dt.timestamp() * 1000)


def _fmt_when(ms: int | None) -> str:
    """dd/mm HH:MM no fuso do app (America/Fortaleza); só dd/mm sem hora."""
    if not ms:
        return ""
    dt = datetime.fromtimestamp(ms / 1000, config.TZ)
    return dt.strftime("%d/%m") if (dt.hour, dt.minute) == (0, 0) else dt.strftime("%d/%m %H:%M")


def _fold(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text or "") if not unicodedata.combining(c)).casefold()


_VOCATIVE_RE = re.compile(r"^\s*(?:oi|ol[aá]|bom dia|boa tarde|boa noite)?[\s,]*([A-ZÀ-Ý][a-zà-ÿ]{2,})\s*[,!:]")


def conversa(mensagens: list[dict], participantes: list[dict] | None = None) -> dict | None:
    """Fonte única para cabeçalho e cards do detalhe (e para o "sem resposta"
    da lista). None quando não há mensagens (corpo ainda não baixado).
    participantes: Para/Cc da thread, para reconhecer o destinatário citado
    pelo nome mesmo antes de ele escrever."""
    me = _me()
    msgs = []
    for m in mensagens or []:
        who = _who(m.get("de") or "")
        msgs.append({**who, "voce": who["email"] == me, "ts": _msg_ts(m.get("data") or ""), "texto": _own_text(m.get("texto") or "")})
    if not msgs:
        return None
    firsts = {}
    for p in msgs + [{"nome": a.get("name") or "", "email": a.get("email") or ""} for a in participantes or []]:
        if p["email"] and p["email"] not in firsts:
            fn = _fold(_first_name(p["nome"], p["email"]))
            if len(fn) >= 3:
                firsts[p["email"]] = fn

    def para(m: dict) -> set | None:
        """Destinatários do pedido: participantes citados pelo nome no texto
        (ou o Leo, se citado). Ninguém citado = qualquer outra pessoa responde."""
        text = _fold(m["texto"])
        out = {e for e, fn in firsts.items() if e != m["email"] and re.search(rf"\b{re.escape(fn)}\b", text)}
        if not m["voce"] and _mentions_me(m["texto"]):
            out.add(me)
        voc = _VOCATIVE_RE.match(m["texto"])  # "Denis, pode ver...?" sem o Denis na thread ainda
        if not out and voc and _fold(voc.group(1)) != _fold(_first_name(m["nome"], m["email"])):
            out.add("~" + _fold(voc.group(1)))
        return out or None

    def responde(m: dict, pedido: dict) -> bool:
        if m["email"] == pedido["autor"]["email"]:
            return False
        alvo = pedido["para"]
        return alvo is None or m["email"] in alvo or "~" + _fold(_first_name(m["nome"], m["email"])) in alvo

    aberto = None  # {"autor": msg, "para": set | None, "ultimo": msg}
    resposta = None  # {"pedido": aberto, "msg": msg}
    for m in msgs:
        if aberto is not None:
            if responde(m, aberto):
                resposta, aberto = {"pedido": aberto, "msg": m}, None
                if "?" in m["texto"]:  # respondeu perguntando de volta: pedido novo dele
                    aberto, resposta = {"autor": m, "para": para(m), "ultimo": m}, None
            else:
                aberto["ultimo"] = m  # reforço do solicitante ou terceiro no meio
            continue
        pede = bool(_PEDIDO_RE.search(m["texto"]))
        if pede and (resposta is None or "?" in m["texto"]):
            aberto, resposta = {"autor": m, "para": para(m), "ultimo": m}, None
        elif resposta is not None and m["email"] != resposta["pedido"]["autor"]["email"]:
            resposta["msg"] = m  # mais alguém respondeu depois: vale o último

    def pessoa(m: dict) -> dict:
        return {"nome": "Você" if m["voce"] else m["nome"], "email": m["email"], "voce": m["voce"], "em": m["ts"], "quando": _fmt_when(m["ts"])}

    out = {
        "status": "sem_pedido",
        "solicitante": None,
        "pedido_em": None,
        "para": [],
        "respondido": None,
        "aguardando_desde": None,
        "ultimo": pessoa(msgs[-1]),
        "total": len(msgs),
    }
    if aberto is not None:
        a = aberto["autor"]
        out.update(status="aguardando", solicitante=pessoa(a), pedido_em=a["ts"], aguardando_desde=aberto["ultimo"]["ts"] or a["ts"])
        out["para"] = sorted(e for e in aberto["para"] or [] if not e.startswith("~"))
    elif resposta is not None:
        a = resposta["pedido"]["autor"]
        out.update(status="respondido", solicitante=pessoa(a), pedido_em=a["ts"], respondido=pessoa(resposta["msg"]))
        out["para"] = sorted(e for e in resposta["pedido"]["para"] or [] if not e.startswith("~"))
    u = out["ultimo"]
    out["rotulo_ultimo"] = u["nome"] + (f" · {u['quando']}" if u["quando"] else "")
    if out["status"] == "respondido":
        r = out["respondido"]
        out["rotulo_resposta"] = f"Respondido por {'você' if r['voce'] else r['nome']}" + (f" · {r['quando']}" if r["quando"] else "")
    elif out["status"] == "aguardando":
        since = _fmt_when(out["aguardando_desde"])
        out["rotulo_resposta"] = "Sem resposta" + (f" desde {since}" if since else "")
    else:
        out["rotulo_resposta"] = ""
    return out


def _participants(row: dict) -> list[dict]:
    return _addresses(f"{row.get('to_header') or ''},{row.get('cc_header') or ''},{row.get('last_from_header') or ''}")


def _apply_conversa(item: dict, conv: dict | None) -> dict:
    """Quem pediu / sem resposta saem da conversa real quando ela existe; sem
    corpo baixado fica o que estava salvo (leitura da IA ou regra)."""
    item["conversa"] = conv
    if not conv:
        return item
    s = conv["solicitante"]
    if s and s["email"]:
        item["quem_pediu"] = {"nome": s["nome"], "email": s["email"], "voce": s["voce"]}
    if conv["status"] == "respondido":
        item["sem_resposta_desde"] = None
    elif conv["status"] == "aguardando":
        item["sem_resposta_desde"] = conv["aguardando_desde"] or item.get("sem_resposta_desde")
    elif item.get("sem_resposta_desde") and conv["ultimo"]["em"]:
        item["sem_resposta_desde"] = conv["ultimo"]["em"]
    return item


def _thread_body(row: dict) -> str:
    """Mesma fonte do /mail (assistant._ensure_body): body_text em cache,
    que o store zera quando chega mensagem nova (internal_date sobe), senão
    busca a thread inteira no Gmail. Sem conexão: o que houver em cache."""
    from . import assistant

    try:
        return assistant._ensure_body(row["id"])
    except Exception:
        return row.get("body_text") or ""


def detail(thread_id: str) -> dict:
    row = store.get_thread(thread_id)
    if not row:
        raise LookupError("Thread não encontrada.")
    actions = store.list_copilot_actions(thread_id=thread_id, limit=20)
    item = _present(row, store.get_copilot_item(thread_id), bool(actions))
    body = _thread_body(row)
    item["thread_text"] = body
    item["mensagens"] = _messages(body)
    _apply_conversa(item, conversa(item["mensagens"], _participants(row)))
    item["resumo_contexto"] = resumo_contexto(item, item["mensagens"])
    item["originarios"] = _originators(row)
    item["historico"] = [{"acao": a["action"], "at": a["at"], **_loads(a.get("payload_json"), {})} for a in actions]
    # rascunho de resposta já salvo na thread (o mesmo do /mail): o composer
    # do detalhe abre com ele em vez de gerar de novo
    item["draft"] = row.get("draft") or ""
    # conversa com a IA (instruções + respostas/rascunhos), a mesma do chat do /mail
    try:
        from . import assistant

        item["chat"] = assistant._load_chat(row)
    except Exception:
        item["chat"] = []
    try:
        from . import outbox

        item["outbox"] = outbox.queued_for_thread(thread_id)
    except Exception:
        item["outbox"] = []
    return item


# ── ações (nunca enviam nada) ──
def _ensure_item(thread_id: str) -> tuple[dict, dict]:
    row = store.get_thread(thread_id)
    if not row:
        raise LookupError("Thread não encontrada.")
    if not store.get_copilot_item(thread_id):
        base = heuristic(row, row.get("body_text") or "")
        _persist(row, base, None)
    return row, _present(row, store.get_copilot_item(thread_id))


def _first_name(name: str, email: str) -> str:
    name = (name or "").strip().strip('"')
    if name and "@" not in name:
        return name.split()[0]
    return (email or "").split("@")[0].split(".")[0].capitalize()


def _save_thread_draft(thread_id: str, row: dict, text: str, note: str) -> None:
    from . import assistant

    chat = assistant._load_chat(row)
    if note:
        chat.append({"role": "ai", "text": note, "kind": "answer"})
    chat.append({"role": "ai", "text": text, "kind": "draft"})
    store.save_ai(thread_id, draft=text, chat_json=json.dumps(chat), chat_anchor_date=row.get("internal_date") or 0)


_SIGN = "Atenciosamente,\nLettiery D'Lamare"


def _assumir(row, item, body):
    store.save_copilot_item(row["id"], status="assumido", bola_json=json.dumps({"com": "leo", "email": _me(), "nome": "Você"}), depende_de_outros=0)
    return {}


def _cobrar(row, item, body):
    target = item.get("delegado") or {}
    bola = item["bola"] if item["bola"].get("com") == "outros" else {}
    email = target.get("para") or bola.get("email") or ""
    nome = target.get("nome") or bola.get("nome") or ""
    if not email:
        raise ValueError("Não sei de quem cobrar: a bola não está com ninguém identificado.")
    prazo = f" até {datetime.fromisoformat(item['prazo']).strftime('%d/%m')}" if item.get("prazo") else ""
    text = (
        f"Olá, {_first_name(nome, email)}.\n\n"
        f"Passando para saber como está \"{row.get('subject') or 'este assunto'}\". "
        f"Consegue me dar um retorno{prazo}?\n\n{_SIGN}"
    )
    mode = target.get("modo") or "thread"
    if mode == "novo_silencioso":
        query = urlencode({"to": email, "subject": f"Re: {target.get('assunto') or row.get('subject') or ''}", "draft": text})
        open_url = f"/compose?{query}"
    else:
        _save_thread_draft(row["id"], row, text, "Cobrança preparada pelo Copiloto (não foi enviada).")
        cc = email if email != (row.get("from_email") or "") else ""
        open_url = f"/mail/{row['id']}" + (f"?{urlencode({'cc': cc})}" if cc else "")
    store.save_copilot_item(row["id"], status="cobrado", depende_de_outros=1)
    return {"draft": text, "open_url": open_url, "para": email}


def _delegar(row, item, body):
    para = str(body.get("para") or "").strip().lower()
    if not re.fullmatch(r"[^@\s,]+@[^@\s,]+\.[a-z]{2,}", para):
        raise ValueError("Informe um e-mail válido para delegar.")
    if para == _me():
        raise ValueError("Delegar para você mesmo é assumir.")
    modo = body.get("modo") or "cc_originais"
    if modo not in ("cc_originais", "novo_silencioso"):
        raise ValueError("Modo de delegar desconhecido.")
    nome = str(body.get("nome") or "").strip()
    nota = str(body.get("nota") or "").strip()
    first = _first_name(nome, para)
    resumo = item.get("o_que_aconteceu") or row.get("subject") or ""
    if modo == "cc_originais":
        originais = [a["email"] for a in _originators(row) if a["email"] != para]
        text = (
            f"{first}, pode assumir este assunto, por favor?"
            + (f" {nota}" if nota else "")
            + "\n\nDeixo todos em cópia para acompanharem.\n\n"
            + _SIGN
        )
        _save_thread_draft(row["id"], row, text, f"Delegação preparada pelo Copiloto para {para} (não foi enviada).")
        cc = ", ".join([para, *[e for e in originais if e != (row.get("from_email") or "")]])
        payload = {"modo": modo, "para": para, "nome": nome, "cc": cc, "draft": text, "open_url": f"/mail/{row['id']}?{urlencode({'cc': cc})}"}
    else:
        assunto = f"Pode assumir? {row.get('subject') or ''}".strip()
        text = (
            f"Olá, {first}.\n\nChegou para mim o assunto \"{row.get('subject') or ''}\": {resumo}\n\n"
            + (f"{nota}\n\n" if nota else "")
            + "Consegue assumir? Prefiro que você trate direto com quem pediu.\n\n"
            + _SIGN
        )
        payload = {"modo": modo, "para": para, "nome": nome, "assunto": assunto, "draft": text,
                   "open_url": f"/compose?{urlencode({'to': para, 'subject': assunto, 'draft': text})}"}
    store.save_copilot_item(
        row["id"], status="delegado", depende_de_outros=1,
        bola_json=json.dumps({"com": "outros", "email": para, "nome": nome}, ensure_ascii=False),
        delegado_json=json.dumps(
            {"modo": modo, "para": para, "nome": nome, "assunto": payload.get("assunto", "")}, ensure_ascii=False
        ),
    )
    return payload


def _aplicar(row, item, body):
    from . import assistant

    try:
        idx = int(body.get("opcao") or 0)
        opt = item["opcoes"][idx]
    except (TypeError, ValueError, IndexError):
        raise ValueError("Sugestão não encontrada.") from None
    acao = opt["acao"]
    if acao == "direcionar":
        if not opt.get("para"):
            raise ValueError("A sugestão não diz para quem direcionar: use Delegar.")
        return {**_delegar(row, item, {"para": opt["para"], "modo": body.get("modo") or "cc_originais", "nota": body.get("nota") or ""}), "acao": acao}
    if acao == "aguardar":
        store.save_copilot_item(row["id"], status="aguardando", depende_de_outros=1)
        return {"acao": acao}
    if acao == "estudar_depois_responder":
        tarefas = item["tarefas"] + [{"texto": _clip(f"Estudar: {opt['texto']}", 140), "feita": False}]
        store.save_copilot_item(row["id"], status="assumido", tarefas_json=json.dumps(tarefas, ensure_ascii=False))
        return {"acao": acao}
    base = "; ".join(e["titulo"] for e in opt["evidencias"] if e["tipo"] in _PRECEDENT)
    if acao == "pedir_contexto":
        instruction = f"Peça o contexto que falta, de forma curta: {opt['texto']}"
    else:
        instruction = f"{opt['texto']}" + (f" (base: {base})" if base else "")
    result = assistant.draft(row["id"], instruction)
    store.save_copilot_item(row["id"], status="assumido")
    return {"acao": acao, "draft": result.get("draft") or "", "open_url": f"/mail/{row['id']}"}


def _set_status(status):
    def run(row, item, body):
        store.save_copilot_item(row["id"], status=status)
        if status == "resolvido":
            # Metáfora WhatsApp: resolvido = lido (duplo check). Marca no Gmail;
            # falha de scope/API não desfaz o resolve local.
            try:
                from . import gmail_client
                gmail_client.mark_threads_read([row["id"]])
                store.mark_local_read([row["id"]])
            except Exception:
                pass
        return {}
    return run


def _aguardar(row, item, body):
    store.save_copilot_item(row["id"], status="aguardando", depende_de_outros=1)
    return {}


def _so_saber(row, item, body):
    # Leo arrastou para "Só conhecimento": vale como correção do papel até a próxima releitura.
    store.save_copilot_item(
        row["id"], status="aberto", papel="fyi", depende_de_outros=0,
        bola_json=json.dumps({"com": "ninguem", "email": "", "nome": ""}),
    )
    return {}


def _tarefa(row, item, body):
    try:
        idx = int(body.get("index"))
        item["tarefas"][idx]["feita"] = bool(body.get("feita", True))
    except (TypeError, ValueError, IndexError):
        raise ValueError("Tarefa não encontrada.") from None
    store.save_copilot_item(row["id"], tarefas_json=json.dumps(item["tarefas"], ensure_ascii=False))
    return {}


ACTIONS = {
    "assumir": _assumir,
    "acompanhar": _assumir,  # alias UI: Assumir → Acompanhar
    "cobrar": _cobrar,
    "delegar": _delegar,
    "aplicar": _aplicar,
    "resolver": _set_status("resolvido"),
    "reabrir": _set_status("aberto"),
    "aguardar": _aguardar,
    "so_saber": _so_saber,
    "tarefa": _tarefa,
}


def act(thread_id: str, action: str, body: dict | None = None) -> dict:
    body = body or {}
    if action not in ACTIONS:
        raise ValueError("Ação desconhecida.")
    row, item = _ensure_item(thread_id)
    result = ACTIONS[action](row, item, body)
    log = {k: v for k, v in result.items() if k in ("para", "modo", "acao")}
    store.log_copilot_action(thread_id, action, log)
    return {"ok": True, "action": action, **result, "item": detail(thread_id)}


# ── gancho do piloto automático ──
def pilot_block_reason(thread_id: str) -> str | None:
    """O piloto nunca responde sozinho uma demanda em aberto, algo delegado
    ou um caso em que o copiloto não achou precedente."""
    db = store.get_copilot_item(thread_id)
    if not db:
        return None
    status = db.get("status") or "aberto"
    if status in ("delegado", "cobrado", "aguardando"):
        return "o copiloto registrou que a bola está com outra pessoa"
    if db.get("papel") == "demanda" and status != "resolvido":
        return "o copiloto marcou como demanda em aberto"
    if db.get("needs_context"):
        return "o copiloto não achou precedente no cérebro nem em decisões anteriores"
    return None


# ── preferências e digest ──
DEFAULT_PREFS = {
    "skin": "clean", "digest_daily": "08:00", "digest_weekly_day": 0, "digest_weekly_time": "08:30", "digest_enabled": True, "show_all": False,
    # cards da coluna lateral do detalhe (Configurações → Copiloto)
    "show_tasks_card": True, "show_facts_card": True,
}
_BOOL_PREFS = ("digest_enabled", "show_all", "show_tasks_card", "show_facts_card")
# Padrão por pessoa antes de ela salvar algo: o Leo prefere sem o card "Tarefas".
USER_DEFAULT_PREFS = {"leo@confrapag.com.br": {"show_tasks_card": False}}
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_WEEKDAYS = ("segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo")


def get_prefs(user: str | None = None) -> dict:
    user = (user or _me()).strip().lower()
    saved = (store.get_settings().get("copilot_users") or {}).get(user) or {}
    base = {**DEFAULT_PREFS, **USER_DEFAULT_PREFS.get(user, {})}
    return {**base, **{k: v for k, v in saved.items() if k in DEFAULT_PREFS}, "user": user}


def save_prefs(user: str | None, **fields) -> dict:
    user = (user or _me()).strip().lower()
    clean = {}
    for key, value in fields.items():
        if value is None or key not in DEFAULT_PREFS:
            continue
        if key == "skin" and value not in ("clean", "caderno"):
            raise ValueError("Skin desconhecida.")
        if key in ("digest_daily", "digest_weekly_time") and not _TIME_RE.match(str(value)):
            raise ValueError("Horário inválido (use HH:MM).")
        if key == "digest_weekly_day" and (isinstance(value, bool) or value not in range(7)):
            raise ValueError("Dia da semana inválido (0 = segunda … 6 = domingo).")
        clean[key] = bool(value) if key in _BOOL_PREFS else value
    users = dict(store.get_settings().get("copilot_users") or {})
    users[user] = {**{k: v for k, v in get_prefs(user).items() if k != "user"}, **clean}
    store.save_settings(copilot_users=users)
    return get_prefs(user)


def next_run(period: str, prefs: dict, now: datetime | None = None) -> datetime:
    now = now or _now()
    hh, mm = map(int, (prefs["digest_daily"] if period == "daily" else prefs["digest_weekly_time"]).split(":"))
    at = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if period == "daily":
        return at if at > now else at + timedelta(days=1)
    at += timedelta(days=(int(prefs["digest_weekly_day"]) - now.weekday()) % 7)
    return at if at > now else at + timedelta(days=7)


def _age_days(ms: int | None, now: datetime) -> int:
    if not ms:
        return 0
    return max(0, (now - datetime.fromtimestamp(int(ms) / 1000, config.TZ)).days)


def _line(it: dict) -> str:
    extra = f" · prazo {it['prazo'][8:10]}/{it['prazo'][5:7]}" if it.get("prazo") else ""
    return f"{it['subject']} — {it['o_que_aconteceu'] or it['from_name']}{extra}"


def digest(period: str = "daily", user: str | None = None, now: datetime | None = None) -> dict:
    """Só gera o conteúdo; quem agenda/entrega fica para outra rodada."""
    if period not in ("daily", "weekly"):
        raise ValueError("Período deve ser daily ou weekly.")
    now = now or _now()
    prefs = get_prefs(user)
    # o resumo olha a caixa inteira, independente do filtro de não lidos do painel
    data = list_items(show_all=True)
    items = data["items"]
    # o resumo agrupa também o que ainda está na fila "Analisando" (pela regra)
    by_tab = {t["key"]: [i for i in items if tab_for(i) == t["key"]] for t in TABS}
    soon = (now.date() + timedelta(days=3)).isoformat()
    secoes = []
    if period == "daily":
        titulo = f"{greeting(now)} — seu dia nos e-mails"
        need = by_tab["precisa_de_voce"]
        secoes.append({"titulo": f"Precisa de você ({len(need)})", "itens": [_line(i) for i in need[:5]]})
        late = [i for i in by_tab["bola_com_outros"] if _age_days(i.get("sem_resposta_desde"), now) >= 2]
        secoes.append({"titulo": f"Esperando outros há 2+ dias ({len(late)}) — vale cobrar?", "itens": [_line(i) for i in late[:5]]})
        due = [i for i in items if i["prazo"] and i["prazo"] <= soon and tab_for(i) != "resolvido"]
        secoes.append({"titulo": f"Prazos até {soon[8:10]}/{soon[5:7]} ({len(due)})", "itens": [_line(i) for i in due[:5]]})
        secoes.append({"titulo": f"Só conhecimento ({len(by_tab['so_conhecimento'])})", "itens": []})
    else:
        since = (now - timedelta(days=7)).astimezone(timezone.utc).isoformat()
        acts = store.list_copilot_actions(since_iso=since, limit=1000)
        count = {k: sum(1 for a in acts if a["action"] == k) for k in ("resolver", "delegar", "cobrar", "assumir")}
        titulo = "Sua semana nos e-mails"
        secoes.append({"titulo": "Últimos 7 dias", "itens": [
            f"{count['resolver']} resolvidos", f"{count['delegar']} delegados",
            f"{count['cobrar']} cobranças preparadas", f"{count['assumir']} assumidos",
        ]})
        stuck = [i for i in by_tab["precisa_de_voce"] if _age_days(i.get("sem_resposta_desde"), now) >= 7]
        secoes.append({"titulo": f"Parados com você há 7+ dias ({len(stuck)})", "itens": [_line(i) for i in stuck[:7]]})
        waiting = [i for i in by_tab["bola_com_outros"] if _age_days(i.get("sem_resposta_desde"), now) >= 5]
        secoes.append({"titulo": f"Esperando outros há 5+ dias ({len(waiting)})", "itens": [_line(i) for i in waiting[:7]]})
        people: dict[str, int] = {}
        for i in by_tab["precisa_de_voce"]:
            who = (i.get("quem_pediu") or {}).get("nome") or i["from_name"]
            if who:
                people[who] = people.get(who, 0) + 1
        top = sorted(people.items(), key=lambda kv: -kv[1])[:5]
        secoes.append({"titulo": "Quem mais espera por você", "itens": [f"{n} ({c})" for n, c in top]})
    texto = titulo + "\n\n" + "\n\n".join(
        s["titulo"] + ("\n" + "\n".join(f"• {x}" for x in s["itens"]) if s["itens"] else "") for s in secoes
    )
    when = next_run(period, prefs, now)
    return {
        "period": period,
        "user": prefs["user"],
        "titulo": titulo,
        "secoes": secoes,
        "texto": texto,
        "gerado_em": now.isoformat(),
        "agendado_para": when.isoformat(),
        "agendamento": (
            f"todo dia às {prefs['digest_daily']}" if period == "daily"
            else f"toda {_WEEKDAYS[int(prefs['digest_weekly_day'])]} às {prefs['digest_weekly_time']}"
        ),
        "ativo": bool(prefs["digest_enabled"]),
    }
