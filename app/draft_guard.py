"""Separa o pedido do Leo (instrução + comentários [n] sobre trechos) do texto
do e-mail e confere se o rascunho gerado não copiou o pedido para dentro do
e-mail.

Caso real que motivou: o Leo comentou trechos do e-mail da Kennedy
(`[4] Sobre "2 - Concorrência...": Sobre a concorrência concordo com você...`)
e pediu "Continue a resposta dos outros pontos da forma como você fez no
primeiro ponto." -- o rascunho saiu com as duas frases coladas literalmente e
as perguntas da Kennedy sem resposta. Aqui ficam:
- parse_instruction(): quebra o texto composto pelo front (Annotate.compose)
  em citações {n, fonte, trecho, comentário} + pedido livre;
- expand_quote(): o front corta trechos longos com "…"; volta o trecho inteiro
  achando o começo dele na thread / no rascunho;
- find_leaks(): trechos do rascunho que são cópia (quase) literal do pedido do
  Leo ou frases de meta ("continue os outros pontos", "[1] Sobre ..."). Só
  cópia longa (>= 10 palavras seguidas) ou frase quase idêntica conta: comentário
  que é conteúdo e volta reformulado não dispara.
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

# `[n] Sobre "trecho": comentário` / `[n] Sobre o trecho do rascunho "trecho": comentário`
_CITE_RE = re.compile(r'^\[(\d+)\] Sobre( o trecho do rascunho)? "([\s\S]*?)": ', re.M)
_ELLIPSIS = ("…", "...")

MIN_RUN_WORDS = 10  # cópia literal: tantas palavras seguidas do pedido
MIN_SENTENCE_WORDS = 8  # frase curta demais não entra na comparação por similaridade
SIMILARITY = 0.95  # reformulação leve de comentário que já era conteúdo fica em ~0.92-0.94

ALERTA_COPIA = "A IA pode ter copiado parte do seu pedido no texto — revise os trechos destacados."
ALERTA_COLADO = "A IA pode ter colado pontos do e-mail original sem responder — revise os trechos destacados."
QUOTE_SIMILARITY = 0.93  # resposta que reusa o ponto como contexto fica abaixo (~0.91)

# Frase de meta que só pode estar no e-mail se o Leo NÃO a usou no pedido
# (normalizada: minúsculas, sem acento, sem pontuação).
_META_IF_IN_REQUEST = [
    r"continue (a resposta|respondendo|os outros|as outras|com os outros|nos outros|o resto)",
    r"como voce fez",
    r"da (mesma )?forma (como|que) voce",
    r"do mesmo jeito que voce",
    r"\breescrev(a|e) (o|a|os|as|este|esse|isso|tudo)\b",
    r"responda (todos|todas|os outros|as outras|cada)",
    r"(deixe|deixa|fique|faca|faz) (mais )?(curto|curta|longo|formal|direto)",
    r"\bcite (o|a|os|as)\b",
]
# Sempre meta (não existe em e-mail de verdade). Sobre o texto normalizado,
# menos _META_ALWAYS_RAW, que olha a frase como está ("[1] Sobre").
_META_ALWAYS_RAW = re.compile(r"\[\d+\]\s*Sobre\b", re.I)
_META_ALWAYS = [
    r"sobre o trecho do rascunho",
    r"\binstruc(ao|oes) do leo\b",
    r"\bo leo (pediu|disse|quer|comentou|explicou|esclareceu)\b",
    r"\bcomentario do leo\b",
]


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", (text or "").lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(re.findall(r"\w+", text))


def parse_instruction(instruction: str) -> dict:
    """{"citacoes": [{n, fonte ("email"|"rascunho"), trecho, comentario}], "livre": str}.
    Sem citações: livre = instrução inteira."""
    text = (instruction or "").strip()
    found = list(_CITE_RE.finditer(text))
    if not found:
        return {"citacoes": [], "livre": text}
    cites = []
    tail_free = ""
    for i, m in enumerate(found):
        end = found[i + 1].start() if i + 1 < len(found) else len(text)
        comment = text[m.end():end].strip()
        if i + 1 == len(found):
            # Annotate.compose põe o pedido livre depois de uma linha em branco
            parts = re.split(r"\n\s*\n", comment, maxsplit=1)
            comment = parts[0].strip()
            tail_free = parts[1].strip() if len(parts) > 1 else ""
        if comment == "(sem comentário)":
            comment = ""
        cites.append({
            "n": int(m.group(1)),
            "fonte": "rascunho" if m.group(2) else "email",
            "trecho": m.group(3).strip(),
            "comentario": comment,
        })
    head_free = text[: found[0].start()].strip()
    livre = "\n\n".join(p for p in (head_free, tail_free) if p)
    return {"citacoes": cites, "livre": livre}


def _loose_pattern(snippet: str) -> re.Pattern | None:
    words = snippet.split()
    if not words:
        return None
    return re.compile(r"\s+".join(re.escape(w) for w in words))


def locate(quote: str, source: str) -> int:
    """Posição do trecho na fonte (espaços flexíveis); -1 se não achar."""
    q = (quote or "").strip()
    for end in _ELLIPSIS:
        if q.endswith(end):
            q = q[: -len(end)].rstrip()
    pat = _loose_pattern(q[:300])
    if not pat or not source:
        return -1
    m = pat.search(source)
    return m.start() if m else -1


def expand_quote(quote: str, sources: list[str], max_chars: int = 2000) -> str:
    """Trecho cortado com "…" volta inteiro: acha o começo dele numa das
    fontes e vai até o fim do parágrafo (linha em branco), no máximo max_chars."""
    q = (quote or "").strip()
    cut = next((e for e in _ELLIPSIS if q.endswith(e)), None)
    if not cut:
        return q
    prefix = q[: -len(cut)].rstrip()
    pat = _loose_pattern(prefix)
    if not pat:
        return q
    for src in sources:
        m = pat.search(src or "")
        if not m:
            continue
        rest = src[m.end():]
        stop = re.search(r"\n\s*\n", rest)
        tail = rest[: stop.start()] if stop else rest
        full = (src[m.start():m.end()] + tail)[:max_chars].strip()
        if len(full) >= len(prefix):
            return full
    return q


def _strip_quoted(text: str) -> str:
    """Texto entre aspas no pedido livre é o que o Leo quer escrito assim
    ('diga: "fechamos na sexta"'): pode ir literal, não conta como cópia."""
    return re.sub(r'"[^"\n]{3,}"|“[^”\n]{3,}”|«[^»\n]{3,}»', " ", text or "")


def request_segments(instruction: str, earlier_requests: list[str] | None = None) -> list[str]:
    """Pedaços do pedido do Leo que nunca deveriam ir literais para o e-mail:
    comentários das citações e pedido livre (do pedido atual e dos turnos
    anteriores do chat). Os trechos citados ficam de fora (são texto do e-mail)."""
    out = []
    for text in [instruction, *(earlier_requests or [])]:
        parsed = parse_instruction(text)
        out.extend(c["comentario"] for c in parsed["citacoes"] if c["comentario"])
        if parsed["livre"]:
            out.append(parsed["livre"])
    segs = []
    for seg in out:
        seg = _strip_quoted(seg)
        # "diga que X" / "responda que X": X é o que o Leo quer dito no e-mail
        kept = [seg[s:e] for s, e in _sentences(seg) if not _DICTATION.match(norm(seg[s:e]))]
        if any(k.strip() for k in kept):
            segs.append("\n".join(kept))
    return segs


_DICTATION = re.compile(
    r"^(diga|diz|fala|fale|responda|responde|avise|avisa|informe|explique|escreva|coloque|pergunte|pergunta|"
    r"agradeca|confirme|peca|pede|mande|manda|comente|reforce|lembre|deixe claro|coloca)\b"
)
_SENT_RE = re.compile(r"[^.!?\n]+[.!?]*")


def _sentences(text: str) -> list[tuple[int, int]]:
    spans = []
    for m in _SENT_RE.finditer(text or ""):
        s, e = m.start(), m.end()
        while s < e and text[s].isspace():
            s += 1
        while e > s and text[e - 1].isspace():
            e -= 1
        if e > s:
            spans.append((s, e))
    return spans


def _ngrams(words: list[str], n: int) -> set[tuple[str, ...]]:
    return {tuple(words[i:i + n]) for i in range(len(words) - n + 1)}


def find_leaks(draft: str, segments: list[str], allowed: str = "") -> list[str]:
    """Frases do rascunho (texto exato, na ordem) que copiam o pedido do Leo.
    allowed: texto do e-mail (thread) -- o que já está lá não conta como cópia."""
    draft = draft or ""
    if not draft.strip():
        return []
    allowed_n = norm(allowed)
    allowed_grams = _ngrams(allowed_n.split(), MIN_RUN_WORDS)
    seg_grams: set[tuple[str, ...]] = set()
    seg_sents: list[str] = []
    request_n = norm(" ".join(segments))
    for seg in segments:
        seg_grams |= _ngrams(norm(seg).split(), MIN_RUN_WORDS) - allowed_grams
        for s, e in _sentences(seg):
            sn = norm(seg[s:e])
            if len(sn.split()) >= MIN_SENTENCE_WORDS and sn not in allowed_n:
                seg_sents.append(sn)
    meta_req = [p for p in _META_IF_IN_REQUEST if re.search(p, request_n) and not re.search(p, allowed_n)]

    # palavras do rascunho com posição, para marcar quais caem numa cópia longa
    tokens = [(m.start(), norm(m.group(0))) for m in re.finditer(r"\w+", draft)]
    words = [t[1] for t in tokens]
    copied = [False] * len(words)
    for i in range(len(words) - MIN_RUN_WORDS + 1):
        if tuple(words[i:i + MIN_RUN_WORDS]) in seg_grams:
            for k in range(i, i + MIN_RUN_WORDS):
                copied[k] = True

    leaks = []
    for s, e in _sentences(draft):
        sent = draft[s:e]
        sn = norm(sent)
        hit = any(copied[k] for k, (pos, _w) in enumerate(tokens) if s <= pos < e)
        if not hit and len(sn.split()) >= MIN_SENTENCE_WORDS and sn not in allowed_n:
            hit = any(SequenceMatcher(None, sn, ref).ratio() >= SIMILARITY for ref in seg_sents)
        if not hit:
            hit = bool(_META_ALWAYS_RAW.search(sent)) or any(re.search(p, sn) for p in _META_ALWAYS) or any(re.search(p, sn) for p in meta_req)
        if hit and sent not in leaks:
            leaks.append(sent)
    return leaks


def find_pasted_quotes(draft: str, quotes: list[str]) -> list[str]:
    """Frases do rascunho que são o ponto do remetente (trecho citado pelo Leo)
    colado de volta quase igual, em vez da resposta do Leo àquele ponto.
    Usar parte do ponto como contexto numa frase maior não conta."""
    refs: list[str] = []
    for q in quotes:
        if len(norm(q).split()) >= MIN_SENTENCE_WORDS:
            refs.append(norm(q))  # o trecho inteiro (rascunho pode juntar frases do ponto)
        for s, e in _sentences(q):
            qn = norm(q[s:e])
            if len(qn.split()) >= MIN_SENTENCE_WORDS:
                refs.append(qn)
    if not refs:
        return []
    out = []
    for s, e in _sentences(draft or ""):
        sent = draft[s:e]
        sn = norm(sent)
        if len(sn.split()) < MIN_SENTENCE_WORDS:
            continue
        if any(sn in r or SequenceMatcher(None, sn, r).ratio() >= QUOTE_SIMILARITY for r in refs) and sent not in out:
            out.append(sent)
    return out
