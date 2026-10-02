from __future__ import annotations

import re

# Detecta texto que parece conter senha, token ou chave. Usado em três
# lugares onde um segredo NÃO pode passar: nota de "Guardar no cérebro",
# índice da busca (RAG) e decisão do piloto automático. Prefere errar pro
# lado de bloquear: perder um trecho é barato, vazar uma credencial pra
# dentro de um prompt (ou de um rascunho) não é.

_PATTERNS = [
    # senha: xyz / token=abc / api key: ...
    re.compile(
        r"\b(senha|password|passwd|pwd|secret|segredo|token|api[ _-]?key|apikey|client[ _-]?secret)\b\s*[:=]\s*\S{4,}",
        re.IGNORECASE,
    ),
    # "usuário x / senha 123456": senha seguida de algo que tem dígito
    re.compile(r"\b(senha|password|passwd|pwd)\b\s+(?=\S*\d)\S{4,}", re.IGNORECASE),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b"),
    re.compile(r"\bbearer\s+[A-Za-z0-9._-]{20,}", re.IGNORECASE),
]


def looks_like_secret(text: str | None) -> bool:
    if not text:
        return False
    return any(p.search(text) for p in _PATTERNS)
