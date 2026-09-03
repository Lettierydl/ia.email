from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from .config import DB_PATH


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
        for col, typ in (
            ("summary", "TEXT"),
            ("draft", "TEXT"),
            ("body_text", "TEXT"),
            ("chat_json", "TEXT"),
            ("fyi_only", "INTEGER"),
        ):
            try:
                conn.execute(f"ALTER TABLE threads ADD COLUMN {col} {typ}")
            except sqlite3.OperationalError:
                pass


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
    allowed = {"summary", "draft", "body_text", "needs_action_hint", "chat_json", "fyi_only"}
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


def thread_count() -> int:
    with _connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM threads").fetchone()
    return int(row["n"] if row else 0)
