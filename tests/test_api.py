from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.store import init, upsert_thread


def test_radar_groups(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    init()
    upsert_thread(
        {
            "id": "u1",
            "subject": "Chamados fora do SLA",
            "from_email": "suzane.dantas@confrapag.com.br",
            "from_name": "Suzane",
            "snippet": "validar",
            "internal_date": 1,
            "is_unread": 1,
            "last_from_me": 0,
            "is_automatic": 0,
            "is_marketing": 0,
            "needs_action_hint": 1,
            "awaiting_reply": 0,
            "conferido": 1,
            "hide_as_replied": 0,
            "last_from_header": "Suzane",
            "labels_json": ["UNREAD"],
        }
    )
    client = TestClient(app)
    data = client.get("/api/radar").json()
    assert data["unread"][0]["id"] == "u1"
    assert data["unanswered"] == 1
    assert data["needs_action"] == 1


def test_mail_page_serves_app():
    client = TestClient(app)
    res = client.get("/mail/u1")
    assert res.status_code == 200
    assert "IA.Email" in res.text
