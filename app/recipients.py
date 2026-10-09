"""Destinatários da resposta: validação do Para/Cc escolhido no composer e
detecção de "a saudação/o pedido fala com outra pessoa".

Sem Gmail e sem IA aqui: só texto. O front (static/recipients.js) tem a mesma
detecção para reagir na hora; o /draft usa esta para devolver
`sugestao_destinatarios` quando o pedido à IA troca o destinatário."""
from __future__ import annotations

import re
import unicodedata
from email.utils import getaddresses

_EMAIL_RE = re.compile(r"^[^@\s,;<>\"]+@[^@\s,;<>\"]+\.[^@\s,;<>\"]+$")


def clean_addresses(value) -> list[str]:
    """Lista ou string ("a@x.com, Nome <b@y.com>") -> e-mails em minúsculo,
    sem repetição. E-mail inválido -> ValueError (mensagem para o Leo)."""
    if value is None:
        return []
    items = value if isinstance(value, (list, tuple)) else [value]
    out: list[str] = []
    for item in items:
        for name, addr in getaddresses([str(item or "")]):
            addr = (addr or name or "").strip().lower()
            if not addr:
                continue
            if not _EMAIL_RE.match(addr):
                raise ValueError(f"E-mail inválido: {addr}")
            if addr not in out:
                out.append(addr)
    return out


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c)).lower().strip()


_GREETING_PREFIX = re.compile(
    r"^(?:ol[aá]|oi|ei|prezad[oa]s?|car[oa]s?|bom dia|boa tarde|boa noite)[\s,!.]+", re.I
)
_NAME = r"([A-ZÀ-Ý][\wÀ-ÿ'-]+)"


def greeting_name(text: str) -> str:
    """Nome da saudação na 1ª linha do rascunho: "Paulo," / "Olá, Paulo!" /
    "Bom dia, Paulo." -> "Paulo". Sem saudação com nome -> ""."""
    first = next((ln.strip() for ln in (text or "").splitlines() if ln.strip()), "")
    if not first:
        return ""
    rest = _GREETING_PREFIX.sub("", first, count=1).strip()
    m = re.match(_NAME + r"\s*[,!.:]?\s*$", rest) or re.match(_NAME + r"\s*[,!:]", rest)
    if not m:
        return ""
    name = m.group(1)
    if _fold(name) in ("pessoal", "todos", "time", "equipe", "senhores", "senhoras", "prezados", "obrigado", "obrigada"):
        return ""
    return name


_INSTR_RE = re.compile(
    r"(?:respond[ae]r?|mand[ae]r?|envi[ae]r?|escrev[ae]r?)\s+(?:s[oó]\s+)?(?:a|ao|à|para|pro|pra)\s+(?:o\s+|a\s+)?" + _NAME,
    re.I,
)
_NOT_RE = re.compile(r"n[aã]o\s+(?:respond[ae]r?|mand[ae]r?|envi[ae]r?)\s+(?:a|ao|à|para|pro|pra)\s+(?:o\s+|a\s+)?" + _NAME, re.I)


def instruction_target(instruction: str) -> dict:
    """"Não responda a Douglas, responda a Paulo." -> {"para": "Paulo",
    "nao": "Douglas"}. Nada disso no pedido -> {}."""
    text = instruction or ""
    nao = _NOT_RE.search(text)
    blocked = (nao.start(), nao.end()) if nao else None
    para = ""
    for m in _INSTR_RE.finditer(text):
        if blocked and blocked[0] <= m.start() < blocked[1]:
            continue
        para = m.group(1)
        break
    out = {}
    if para:
        out["para"] = para
    if nao:
        out["nao"] = nao.group(1)
    return out


def person_matches(name: str, person: dict) -> bool:
    """O nome bate com o nome de exibição ou com o começo do e-mail?"""
    n = _fold(name)
    if not n:
        return False
    disp = _fold(person.get("name") or "")
    local = _fold((person.get("email") or "").split("@")[0])
    words = re.split(r"[\s.,_-]+", disp) + re.split(r"[._-]+", local)
    return n in [w for w in words if w]


def find_person(name: str, people: list[dict]) -> dict | None:
    hits = [p for p in people if person_matches(name, p)]
    return hits[0] if len(hits) == 1 else None


def suggest(draft: str, to: list[str], cc: list[str], participants: list[dict], instruction: str = "", me: str = "") -> dict | None:
    """Saudação (ou pedido) aponta para alguém que não está no Para ->
    sugestão de troca: o novo vai para o Para e quem estava no Para vai
    para o Cc. Sem nome claro, ou nome que já bate com o Para -> None."""
    me = (me or "").lower()
    target = instruction_target(instruction).get("para") if instruction else ""
    origem = "pedido" if target else "saudacao"
    name = target or greeting_name(draft)
    if not name:
        return None
    to_l = [a.lower() for a in to or []]
    people = [p for p in participants or [] if (p.get("email") or "").lower() != me]
    to_people = [next((p for p in people if (p.get("email") or "").lower() == a), {"email": a, "name": ""}) for a in to_l]
    if any(person_matches(name, p) for p in to_people):
        return None
    hit = find_person(name, people)
    if not hit:
        return None
    email = hit["email"].lower()
    novo_cc = [a for a in (cc or []) if a.lower() != email]
    for a in to_l:
        if a not in [c.lower() for c in novo_cc]:
            novo_cc.append(a)
    atual = ", ".join(to_l) or "ninguém"
    return {
        "nome": name,
        "email": email,
        "origem": origem,
        "para": [email],
        "cc": novo_cc,
        "mensagem": (f"O pedido é para {name}, mas o Para é {atual}." if origem == "pedido"
                     else f"A saudação é para {name}, mas o Para é {atual}."),
    }
