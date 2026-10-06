from __future__ import annotations

import re
from email.utils import getaddresses
from typing import Any

from . import config, secrets_guard, store

# "Aprender" (copiloto): o Leo registra uma regra ou um contexto que a IA deve
# lembrar nos PRÓXIMOS e-mails -- não gera rascunho nenhum. Três escopos:
#   thread  -> esta conversa e qualquer outra com o mesmo assunto;
#   person  -> tudo que envolver aquele e-mail (remetente ou participante);
#   general -> vale sempre.
# A fonte da verdade é o SQLite; config.LEARNED_NOTES_MD é só um espelho
# legível na Learning Base, reescrito inteiro a cada mudança.

SCOPES = ("thread", "person", "general")
MAX_TEXT = 1000
_BLOCK_MAX_CHARS = 3000
_PREFIX_RE = re.compile(r"^\s*(?:(?:re|res|fw|fwd|enc|tr|encaminhado|resposta)\s*:\s*)+", re.IGNORECASE)


class LearnedError(ValueError):
    """Pedido inválido (vira 400 na API)."""


def subject_key(subject: str | None) -> str:
    """Assunto normalizado: sem Re:/Fwd:/Enc: (repetidos), espaços colapsados, minúsculo."""
    text = _PREFIX_RE.sub("", subject or "")
    return " ".join(text.split()).casefold()


def thread_emails(row: dict | None) -> list[str]:
    """Remetente + participantes (Para/Cc/último remetente), sem a própria conta."""
    row = row or {}
    header = ",".join(
        str(row.get(k) or "") for k in ("from_email", "last_from_header", "to_header", "cc_header")
    )
    out: list[str] = []
    for _name, addr in getaddresses([header]):
        email = addr.strip().lower()
        if "@" in email and email != config.ACCOUNT and email not in out:
            out.append(email)
    return out


def add(scope: str, text: str, thread_id: str = "", person_email: str = "") -> dict[str, Any]:
    scope = (scope or "").strip().lower()
    text = (text or "").strip()
    thread_id = (thread_id or "").strip()
    person_email = (person_email or "").strip().lower()
    if scope not in SCOPES:
        raise LearnedError("Escopo desconhecido (use thread, person ou general).")
    if not text:
        raise LearnedError("Escreva o que a IA deve saber.")
    if len(text) > MAX_TEXT:
        raise LearnedError(f"Texto longo demais (máx. {MAX_TEXT} caracteres).")
    if secrets_guard.looks_like_secret(text):
        raise LearnedError("Isso parece senha, token ou chave: não guardo segredos nos aprendizados. Tire a credencial e tente de novo.")
    row = store.get_thread(thread_id) if thread_id else None
    subject = (row or {}).get("subject") or ""
    if scope == "thread":
        if not row:
            raise LearnedError("Conversa não encontrada para o aprendizado.")
        person_email = ""
    elif scope == "person":
        if "@" not in person_email:
            raise LearnedError("Informe o e-mail da pessoa.")
    else:
        person_email = ""
    note = store.add_learned_note(
        scope=scope,
        text=text,
        thread_id=thread_id if scope == "thread" else "",
        subject=subject if scope == "thread" else "",
        subject_key=subject_key(subject) if scope == "thread" else "",
        person_email=person_email,
    )
    _write_mirror()
    return note


def delete(note_id: int) -> bool:
    ok = store.delete_learned_note(note_id)
    if ok:
        _write_mirror()
    return ok


def _matches(note: dict, thread_id: str, key: str, emails: set[str]) -> bool:
    scope = note.get("scope")
    if scope == "general":
        return True
    if scope == "person":
        return (note.get("person_email") or "") in emails
    if scope == "thread":
        return bool(thread_id and note.get("thread_id") == thread_id) or bool(key and note.get("subject_key") == key)
    return False


def relevant(thread_id: str = "", subject: str = "", emails: list[str] | None = None) -> list[dict[str, Any]]:
    """Notas que valem para esta conversa: gerais, de pessoas envolvidas e do
    mesmo thread_id ou do mesmo assunto normalizado. Mais antigas primeiro."""
    key = subject_key(subject)
    mails = {e.strip().lower() for e in (emails or []) if e}
    notes = [n for n in store.list_learned_notes() if _matches(n, thread_id, key, mails)]
    return sorted(notes, key=lambda n: n["id"])


def for_thread(thread_id: str) -> list[dict[str, Any]]:
    row = store.get_thread(thread_id) or {}
    return relevant(thread_id, row.get("subject") or "", thread_emails(row))


def notes_block(thread_id: str = "", subject: str = "", emails: list[str] | None = None) -> str:
    """Bloco pronto para o prompt (vazio se não houver nada)."""
    notes = relevant(thread_id, subject, emails)
    if not notes:
        return ""
    order = {"general": 0, "person": 1, "thread": 2}
    lines: list[str] = []
    used = 0
    for n in sorted(notes, key=lambda n: (order.get(n["scope"], 3), -n["id"])):
        if n["scope"] == "general":
            tag = "geral"
        elif n["scope"] == "person":
            tag = f"sobre {n.get('person_email')}"
        else:
            tag = "neste assunto"
        line = f"- ({tag}) {' '.join((n.get('text') or '').split())[:500]}"
        if used + len(line) > _BLOCK_MAX_CHARS and lines:
            break
        lines.append(line)
        used += len(line)
    return (
        "Aprendizados que o Leo registrou (regras e contexto — siga-os quando pertinentes):\n"
        + "\n".join(lines)
        + "\n\n"
    )


def _mirror_markdown(notes: list[dict]) -> str:
    def item(n: dict) -> str:
        text = " ".join((n.get("text") or "").split())
        return f"- {text} _({(n.get('created_at') or '')[:10]})_"

    general = [n for n in notes if n["scope"] == "general"]
    people: dict[str, list[dict]] = {}
    subjects: dict[str, list[dict]] = {}
    for n in notes:
        if n["scope"] == "person":
            people.setdefault(n.get("person_email") or "?", []).append(n)
        elif n["scope"] == "thread":
            subjects.setdefault(n.get("subject") or "(sem assunto)", []).append(n)
    out = [
        "# Aprendizados do IA.Email",
        "",
        "> Gerado pelo IA.Email (botão Aprender do copiloto) a partir do banco: é reescrito a cada mudança, "
        "não edite à mão. Para remover, use Configurações → Aprendizados.",
        "",
        "## Geral",
        "",
    ]
    out += [item(n) for n in general] or ["_Nada ainda._"]
    out += ["", "## Pessoas", ""]
    if not people:
        out.append("_Nada ainda._")
    for email in sorted(people):
        out += [f"### {email}", ""] + [item(n) for n in people[email]] + [""]
    out += ["", "## Assuntos", ""]
    if not subjects:
        out.append("_Nada ainda._")
    for subj in sorted(subjects, key=str.casefold):
        out += [f"### {subj}", ""] + [item(n) for n in subjects[subj]] + [""]
    return "\n".join(out).rstrip() + "\n"


def _write_mirror() -> None:
    """Espelho na Learning Base. Falha aqui nunca derruba o salvamento."""
    try:
        notes = sorted(store.list_learned_notes(), key=lambda n: n["id"])
        path = config.LEARNED_NOTES_MD
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_mirror_markdown(notes), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 -- espelho é best-effort
        print(f"[learned] não consegui escrever o espelho: {exc}")
