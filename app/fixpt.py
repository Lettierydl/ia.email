"""Corrigir português sem reescrever ("Corrigir português" / "Usar meu texto").

A IA só pode mexer em ortografia, gramática, pontuação e acentuação: nada de
tom, conteúdo, ordem, saudação ou assinatura. Como modelo nenhum é 100%
obediente, a saída passa por uma verificação defensiva (similaridade com o
original): se divergiu demais, é rejeitada e o texto do Leo fica como estava.
"""
from __future__ import annotations

import difflib
import re
import unicodedata

from . import llm, secrets_guard

# Abaixo disso a "correção" virou reescrita. Medido sem acento/caixa (corrigir
# acento não conta como mudança) e por caractere (trocar "nao" por "não" é
# pequeno; trocar o e-mail inteiro é grande).
MIN_SIMILARITY = 0.80
# Também recusa se o tamanho mudou muito (acrescentou parágrafo, cortou frase).
MAX_LEN_RATIO = 1.25

PROMPT = (
    "Você é um revisor de português do Brasil. Corrija SOMENTE ortografia, gramática, "
    "concordância, pontuação, acentuação e maiúsculas do texto abaixo.\n"
    "Regras obrigatórias:\n"
    "- NÃO mude o tom, o conteúdo, a ordem das frases nem o significado.\n"
    "- NÃO troque palavras por sinônimos, NÃO deixe mais formal nem mais curto.\n"
    "- NÃO acrescente saudação, despedida, assinatura, explicação nem frases novas.\n"
    "- Mantenha nomes próprios, números, e-mails, links, siglas e quebras de linha como estão.\n"
    "- Se não houver nada a corrigir, devolva o texto idêntico.\n"
    "Responda APENAS com o texto corrigido: sem aspas, sem markdown, sem comentários.\n\n"
    "Texto:\n<<<\n{text}\n>>>"
)


class FixRejected(ValueError):
    """A saída da IA mudou demais o texto (virou reescrita) ou veio vazia."""


def _fold(text: str) -> str:
    """Sem acento, minúsculo, espaços normalizados: base da comparação."""
    norm = unicodedata.normalize("NFD", text or "")
    norm = "".join(c for c in norm if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", norm.lower()).strip()


def similarity(original: str, fixed: str) -> float:
    a, b = _fold(original), _fold(fixed)
    if not a and not b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def check(original: str, fixed: str) -> None:
    """Levanta FixRejected se `fixed` não parece só uma correção de `original`."""
    if not (fixed or "").strip():
        raise FixRejected("A IA não devolveu o texto corrigido. Nada foi trocado.")
    la, lb = len(_fold(original)), len(_fold(fixed))
    if la and (lb / la > MAX_LEN_RATIO or la / max(lb, 1) > MAX_LEN_RATIO):
        raise FixRejected("A correção mudou demais o tamanho do texto; mantive o seu como estava.")
    if similarity(original, fixed) < MIN_SIMILARITY:
        raise FixRejected("A correção mudou demais o texto (parecia uma reescrita); mantive o seu como estava.")


def _clean(raw: str, original: str) -> str:
    """Tira embrulho (```, <<< >>>, aspas, "Texto corrigido:") e devolve com o
    mesmo espaço em branco nas pontas do original."""
    text = (raw or "").strip()
    fence = re.match(r"^```[a-zA-Z]*\n(.*)\n```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    if text.startswith("<<<") and text.endswith(">>>"):
        text = text[3:-3].strip()
    text = re.sub(r"^(texto corrigido|texto|corre[cç][aã]o)\s*:\s*", "", text, flags=re.IGNORECASE).strip()
    pairs = {'"': '"', "“": "”", "'": "'", "«": "»"}
    stripped = original.strip()
    if len(text) >= 2 and text[0] in pairs and text[-1] == pairs[text[0]] and not (stripped[:1] == text[0] and stripped[-1:] == text[-1]):
        text = text[1:-1].strip()
    lead = original[: len(original) - len(original.lstrip())]
    trail = original[len(original.rstrip()):]
    return f"{lead}{text}{trail}" if text else ""


def fix(text: str) -> dict:
    """{text, changed}. Levanta FixRejected (divergiu/vazio) ou RuntimeError (sem LLM)."""
    text = text or ""
    if not text.strip():
        return {"text": text, "changed": False}
    if not llm.has_key():
        raise RuntimeError("Falta chave de LLM (Claude/Gemini/OpenRouter) para corrigir o português.")
    fixed = _clean(llm.complete(PROMPT.format(text=text.strip())), text)
    check(text, fixed)
    if secrets_guard.looks_like_secret(fixed) and not secrets_guard.looks_like_secret(text):
        raise FixRejected("A IA devolveu algo com cara de senha/token; nada foi trocado.")
    return {"text": fixed, "changed": fixed != text}


# ── "Usar meu texto (só corrigir)" ──
# "Escreva da mesma forma: …", "escreva exatamente isso: …", "use este texto: …",
# "manda assim: …" → o que vem depois dos dois-pontos é o e-mail.
_KEEP_VERBS = (
    r"escreva\s+(?:da\s+mesma\s+forma|do\s+mesmo\s+jeito|exatamente(?:\s+(?:isso|assim|isto|desse\s+jeito|deste\s+jeito))?|assim|isso)"
    r"|escrev[ea]\s+igual"
    r"|(?:use|usa|utilize|mantenha|mant[eé]m|deixe|deixa)\s+(?:o\s+)?(?:meu|este|esse|o\s+meu|exatamente\s+(?:este|esse|o\s+meu))\s+texto(?:\s+(?:como\s+est[aá]|assim))?"
    r"|(?:manda|mande|mandar|envia|envie|enviar|responda|responde)\s+(?:exatamente\s+)?(?:assim|isso|isto|desse\s+jeito|deste\s+jeito|do\s+jeito\s+que\s+escrevi)"
    r"|(?:s[oó]\s+)?corri(?:ja|gir|ge)\s+(?:s[oó]\s+)?(?:o\s+)?portugu[eê]s(?:\s+(?:disso|disto|deste|desse|do\s+texto))?"
    r"|copie\s+(?:exatamente\s+)?(?:isso|isto|este\s+texto|esse\s+texto)"
)
# Entre o verbo e os dois-pontos só cabe enfeite ("aqui", "abaixo", "por favor"):
# "escreva isso de forma mais formal: …" é pedido de reescrita, não "usar meu texto".
_KEEP_FILLER = r"(?:\s*,?\s*(?:aqui|abaixo|a\s+seguir|pra\s+mim|para\s+mim|por\s+favor|o\s+e-?mail|a\s+resposta|na\s+resposta|no\s+e-?mail))*"
_KEEP_RE = re.compile(rf"^\s*(?:por\s+favor,?\s*)?(?:{_KEEP_VERBS}){_KEEP_FILLER}\s*:\s*(.+)$", re.IGNORECASE | re.DOTALL)


def keep_text_request(instruction: str) -> str | None:
    """Texto do Leo quando o pedido é "escreva da mesma forma: …" (sem aspas
    em volta); None quando é um pedido normal à IA."""
    m = _KEEP_RE.match(instruction or "")
    if not m:
        return None
    text = m.group(1).strip()
    if len(text) >= 2 and text[0] in "\"“'«" and text[-1] in "\"”'»":
        text = text[1:-1].strip()
    return text or None


# ── assinatura do rascunho atual (mantida quando o texto do Leo não tem) ──
_CLOSING_RE = re.compile(
    r"^(abra[cç]os?|abs\.?|att\.?|atenciosamente|at\.?te|obrigad[oa]s?|grato|grata|saudações|cordialmente|um abra[cç]o|forte abra[cç]o|valeu|até mais|leo|leonardo)\b[,.!]?",
    re.IGNORECASE,
)


def signature_of(draft: str) -> str:
    """Último bloco do rascunho se ele for despedida/assinatura ("Abraço,\\nLeo")."""
    blocks = [b for b in re.split(r"\n\s*\n", (draft or "").strip()) if b.strip()]
    if len(blocks) < 2:
        return ""
    last = blocks[-1].strip()
    lines = [ln.strip() for ln in last.splitlines() if ln.strip()]
    if not lines or len(lines) > 4 or any(len(ln) > 60 for ln in lines):
        return ""
    return last if _CLOSING_RE.match(lines[0]) else ""


def has_signature(text: str) -> bool:
    lines = [ln.strip() for ln in (text or "").strip().splitlines() if ln.strip()]
    return any(_CLOSING_RE.match(ln) for ln in lines[-3:])


def with_signature(text: str, previous_draft: str) -> str:
    """Põe a assinatura do rascunho atual no fim, se o texto do Leo não tem uma."""
    sig = signature_of(previous_draft)
    if not sig or has_signature(text):
        return text
    return f"{text.rstrip()}\n\n{sig}"
