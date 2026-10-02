from __future__ import annotations

import sqlite3

from app import store

OLD_AUTOPILOT_TABLE = """
CREATE TABLE autopilot_decisions (
    id TEXT PRIMARY KEY, thread_id TEXT, action TEXT, confidence REAL, reasoning TEXT, draft_text TEXT,
    cc TEXT, sensitivity_level TEXT, decided_at TEXT, scheduled_send_at TEXT, status TEXT, sent_at TEXT, error TEXT
)
"""


def test_old_database_without_the_newer_autopilot_columns_is_migrated(tmp_path, monkeypatch):
    db = tmp_path / "old.sqlite"
    monkeypatch.setattr("app.store.DB_PATH", db)
    with sqlite3.connect(db) as conn:
        conn.execute(OLD_AUTOPILOT_TABLE)
        conn.execute("INSERT INTO autopilot_decisions(id, thread_id, action, status) VALUES ('antiga','t','alert','resolved')")
    store.init()
    store.init()  # idempotente
    cols = {r[1] for r in sqlite3.connect(db).execute("PRAGMA table_info(autopilot_decisions)")}
    assert {"internal_date_snapshot", "evidence_json"} <= cols
    new_id = store.create_autopilot_decision(
        thread_id="t2", action="suggest", status="open", internal_date_snapshot=5, evidence_json="{}",
        confidence=0.9, reasoning="", draft_text="x", cc="", sensitivity_level="auxiliar",
    )
    assert store.get_autopilot_decision(new_id)["internal_date_snapshot"] == 5
    assert store.get_autopilot_decision("antiga")["status"] == "resolved", "linha antiga continua intacta"
