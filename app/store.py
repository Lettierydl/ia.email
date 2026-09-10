from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from .config import DB_PATH, LEARNING_BASE_DEFAULT


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY,
                subject TEXT,
                from_email TEXT,
                from_name TEXT,
                snippet TEXT,
                internal_date INTEGER,
                is_unread INTEGER,
                last_from_me INTEGER,
                is_automatic INTEGER,
                is_marketing INTEGER,
                needs_action_hint INTEGER,
                awaiting_reply INTEGER,
                conferido INTEGER,
                hidden INTEGER,
                hide_as_replied INTEGER,
                last_from_header TEXT,
                labels_json TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS blocked_senders (
                email TEXT PRIMARY KEY,
                created_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS avatar_cache (
                email TEXT PRIMARY KEY,
                photo_url TEXT,
                resolved_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS aliases (
                alias TEXT PRIMARY KEY,
                name TEXT,
                email TEXT,
                created_at TEXT
            )
            """
        )
        for col, typ in (
            ("summary", "TEXT"),
            ("draft", "TEXT"),
            ("body_text", "TEXT"),
            ("chat_json", "TEXT"),
            ("fyi_only", "INTEGER"),
            ("capture_note", "TEXT"),
            ("capture_status", "TEXT"),
            ("chat_anchor_date", "INTEGER"),
        ):
            try:
                conn.execute(f"ALTER TABLE threads ADD COLUMN {col} {typ}")
            except sqlite3.OperationalError:
                pass
        # Threads de antes desse controle existir nao tem uma base de
        # comparacao -- da um ponto de partida agora pra passar a detectar
        # mensagem nova a partir daqui (nao reseta o que ja esta desatualizado
        # hoje, so evita que fique nesse limbo pra sempre).
        conn.execute(
            "UPDATE threads SET chat_anchor_date = internal_date "
            "WHERE chat_anchor_date IS NULL AND (summary IS NOT NULL AND summary != '')"
        )


def upsert_thread(row: dict[str, Any]) -> None:
    fields = [
        "id",
        "subject",
        "from_email",
        "from_name",
        "snippet",
        "internal_date",
        "is_unread",
        "last_from_me",
        "is_automatic",
        "is_marketing",
        "needs_action_hint",
        "awaiting_reply",
        "conferido",
        "hidden",
        "hide_as_replied",
        "last_from_header",
        "labels_json",
        "updated_at",
    ]
    row = dict(row)
    row.setdefault("hidden", 0)
    row["updated_at"] = datetime.now(timezone.utc).isoformat()
    if isinstance(row.get("labels_json"), list):
        row["labels_json"] = json.dumps(row["labels_json"])
    placeholders = ", ".join("?" for _ in fields)
    assignments = ", ".join(
        f"{name}=excluded.{name}"
        for name in fields
        if name not in {"id", "hidden"}
    )
    values = [row.get(name) for name in fields]
    with _connect() as conn:
        conn.execute(
            f"""
            INSERT INTO threads ({", ".join(fields)})
            VALUES ({placeholders})
            ON CONFLICT(id) DO UPDATE SET {assignments}
            """,
            values,
        )


def set_hidden(thread_id: str, hidden: bool) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE threads SET hidden=? WHERE id=?",
            (1 if hidden else 0, thread_id),
        )


def list_visible(*, include_hidden: bool = False) -> list[dict[str, Any]]:
    sql = "SELECT * FROM threads"
    if not include_hidden:
        sql += " WHERE hidden=0 AND hide_as_replied=0"
    sql += " ORDER BY internal_date DESC"
    with _connect() as conn:
        rows = conn.execute(sql).fetchall()
    return [dict(item) for item in rows]


def hidden_count() -> int:
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM threads WHERE hidden=1 OR hide_as_replied=1"
        ).fetchone()
    return int(row["n"]) if row else 0


def set_meta(key: str, value: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def get_meta(key: str) -> str | None:
    with _connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def conferido_ids() -> set[str]:
    with _connect() as conn:
        rows = conn.execute("SELECT id FROM threads WHERE conferido=1").fetchall()
    return {row["id"] for row in rows}


def get_thread(thread_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM threads WHERE id=?", (thread_id,)).fetchone()
    return dict(row) if row else None


def save_ai(thread_id: str, **fields: Any) -> None:
    allowed = {
        "summary",
        "draft",
        "body_text",
        "needs_action_hint",
        "chat_json",
        "fyi_only",
        "capture_note",
        "capture_status",
        "chat_anchor_date",
        "is_marketing",
    }
    sets = []
    values = []
    for key, value in fields.items():
        if key not in allowed or value is None:
            continue
        sets.append(f"{key}=?")
        values.append(value)
    if not sets:
        return
    values.append(thread_id)
    with _connect() as conn:
        conn.execute(f"UPDATE threads SET {', '.join(sets)} WHERE id=?", values)


def unread_automatic_ids() -> list[str]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id FROM threads
            WHERE is_automatic=1 AND is_unread=1 AND hidden=0 AND hide_as_replied=0
            ORDER BY internal_date DESC
            """
        ).fetchall()
    return [row["id"] for row in rows]


def mark_local_read(ids: list[str]) -> None:
    if not ids:
        return
    placeholders = ", ".join("?" for _ in ids)
    with _connect() as conn:
        conn.execute(
            f"UPDATE threads SET is_unread=0 WHERE id IN ({placeholders})",
            ids,
        )


def add_llm_usage(tokens: int) -> None:
    if tokens <= 0:
        return
    key = f"llm_tokens_{datetime.now(timezone.utc).date().isoformat()}"
    current = int(get_meta(key) or 0)
    set_meta(key, str(current + tokens))


def llm_usage_today() -> int:
    key = f"llm_tokens_{datetime.now(timezone.utc).date().isoformat()}"
    return int(get_meta(key) or 0)


def block_sender(email: str) -> None:
    email = (email or "").strip().lower()
    if not email:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT INTO blocked_senders(email, created_at) VALUES(?, ?) "
            "ON CONFLICT(email) DO NOTHING",
            (email, datetime.now(timezone.utc).isoformat()),
        )


def is_blocked_sender(email: str) -> bool:
    email = (email or "").strip().lower()
    if not email:
        return False
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM blocked_senders WHERE email=?", (email,)
        ).fetchone()
    return row is not None


def get_avatar(email: str) -> tuple[bool, str | None]:
    """(ja_resolvido, url). ja_resolvido=False significa que nunca foi
    buscado -- url vazia (mas ja_resolvido=True) significa que foi
    buscado e nao achou foto nenhuma (nao tenta de novo)."""
    email = (email or "").strip().lower()
    if not email:
        return True, None
    with _connect() as conn:
        row = conn.execute(
            "SELECT photo_url FROM avatar_cache WHERE email=?", (email,)
        ).fetchone()
    if row is None:
        return False, None
    return True, (row["photo_url"] or None)


def save_avatar(email: str, photo_url: str | None) -> None:
    email = (email or "").strip().lower()
    if not email:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT INTO avatar_cache(email, photo_url, resolved_at) VALUES(?, ?, ?) "
            "ON CONFLICT(email) DO UPDATE SET photo_url=excluded.photo_url, resolved_at=excluded.resolved_at",
            (email, photo_url or "", datetime.now(timezone.utc).isoformat()),
        )


DEFAULT_SETTINGS = {
    "context_enabled": False,
    "context_paths": [str(LEARNING_BASE_DEFAULT)],
    "style_preset": "neutro",
    "style_custom": "",
    "preload_enabled": True,
    "preload_count": 2,
}


def get_settings() -> dict[str, Any]:
    raw = get_meta("settings_json")
    if not raw:
        return dict(DEFAULT_SETTINGS)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return dict(DEFAULT_SETTINGS)
    merged = dict(DEFAULT_SETTINGS)
    merged.update({k: v for k, v in data.items() if k in DEFAULT_SETTINGS})
    return merged


def save_settings(**fields: Any) -> dict[str, Any]:
    current = get_settings()
    current.update({k: v for k, v in fields.items() if k in DEFAULT_SETTINGS})
    set_meta("settings_json", json.dumps(current))
    return current


def list_aliases() -> list[dict[str, str]]:
    with _connect() as conn:
        rows = conn.execute("SELECT alias, name, email FROM aliases ORDER BY alias").fetchall()
    return [dict(row) for row in rows]


def save_alias(alias: str, name: str, email: str) -> None:
    alias = (alias or "").strip().lower()
    if not alias:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT INTO aliases(alias, name, email, created_at) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(alias) DO UPDATE SET name=excluded.name, email=excluded.email",
            (alias, (name or "").strip(), (email or "").strip().lower(), datetime.now(timezone.utc).isoformat()),
        )


def delete_alias(alias: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM aliases WHERE alias=?", ((alias or "").strip().lower(),))


def thread_count() -> int:
    with _connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM threads").fetchone()
    return int(row["n"] if row else 0)
