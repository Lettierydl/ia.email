"""Regras de ruido/importancia do context.md — sem LLM nesta fase."""

from __future__ import annotations

import re
from dataclasses import dataclass

ME_DEFAULT = "leo@confrapag.com.br"

ACEITE = re.compile(
    r"^\s*(aceito|aceita|aceite)\s*:",
    re.IGNORECASE,
)
REACAO = re.compile(
    r"reagiu pelo gmail",
    re.IGNORECASE,
)
MARKETING_FROM = re.compile(
    r"(no-?reply|noreply|newsletter|mailer-daemon|notifications?@)",
    re.IGNORECASE,
)
ACAO_HINT = re.compile(
    r"\b(urgente|prazo|at[eé]\s+\d{1,2}[/-]\d{1,2}|validar|aprovar|decis[aã]o|"
    r"day off|hora extra|bonifica)",
    re.IGNORECASE,
)


@dataclass
class Classified:
    is_unread: bool
    last_from_me: bool
    is_automatic: bool
    is_marketing: bool
    needs_action_hint: bool
    awaiting_reply: bool
    hide_as_replied: bool


def parse_email(header: str) -> str:
    if not header:
        return ""
    match = re.search(r"<([^>]+)>", header)
    raw = (match.group(1) if match else header).strip().lower()
    return raw


def classify(
    *,
    label_ids: list[str],
    last_from_header: str,
    subject: str,
    snippet: str,
    me: str = ME_DEFAULT,
) -> Classified:
    me = me.strip().lower()
    labels = {item.upper() for item in label_ids}
    is_unread = "UNREAD" in labels
    last_from = parse_email(last_from_header)
    last_from_me = last_from == me

    blob = f"{subject}\n{snippet}"
    is_automatic = bool(ACEITE.search(subject or "") or REACAO.search(blob))
    is_marketing = bool(MARKETING_FROM.search(last_from_header or ""))
    needs_action_hint = bool(ACAO_HINT.search(blob)) and not is_automatic and not is_marketing
    hide_as_replied = last_from_me and not is_unread
    awaiting_reply = (
        not is_unread
        and not last_from_me
        and not is_automatic
        and not hide_as_replied
    )
    return Classified(
        is_unread=is_unread,
        last_from_me=last_from_me,
        is_automatic=is_automatic,
        is_marketing=is_marketing,
        needs_action_hint=needs_action_hint,
        awaiting_reply=awaiting_reply,
        hide_as_replied=hide_as_replied,
    )
