from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import metrics, store
from app.main import app


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    store.init()


NOW = datetime(2026, 10, 15, 15, 0, tzinfo=timezone.utc)


def _ago(days):
    return (NOW - timedelta(days=days)).isoformat()


def test_counts_and_time_saved_use_the_configured_assumptions():
    store.save_settings(metric_minutes_summary=2, metric_minutes_reply=5)
    for i in range(4):
        store.log_event("summary", f"t{i}", _ago(1))
    store.log_event("sent", "t0", _ago(1))
    store.log_event("auto_sent", "t1", _ago(2))
    store.log_event("compose_sent", "", _ago(3))
    m = metrics.compute(7, now=NOW)
    assert m["analyzed"] == 4 and m["summaries"] == 4
    assert m["answered"] == 3 and m["answered_by_autopilot"] == 1
    assert m["saved_minutes"] == 4 * 2 + 3 * 5
    assert m["saved_per_day_minutes"] == round(23 / 7, 1)
    assert m["saved_per_item_minutes"] == round(23 / 7, 1)


def test_windows_only_count_events_inside_the_period():
    store.log_event("summary", "recent", _ago(2))
    store.log_event("summary", "old", _ago(20))
    assert metrics.compute(7, now=NOW)["analyzed"] == 1
    assert metrics.compute(30, now=NOW)["analyzed"] == 2


def test_daily_series_has_one_entry_per_day_even_when_empty():
    store.log_event("sent", "t", _ago(0))
    daily = metrics.compute(7, now=NOW)["daily"]
    assert len(daily) == 7
    assert daily[-1]["answered"] == 1 and sum(d["answered"] for d in daily[:-1]) == 0


def test_same_thread_summarized_twice_counts_as_one_analyzed_thread():
    store.log_event("summary", "t1", _ago(1))
    store.log_event("summary", "t1", _ago(1))
    m = metrics.compute(7, now=NOW)
    assert m["analyzed"] == 1 and m["summaries"] == 2


def test_empty_state_has_no_division_errors():
    m = metrics.compute(7, now=NOW)
    assert m["saved_minutes"] == 0 and m["saved_per_item_minutes"] == 0


def test_old_app_sends_are_backfilled_once(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "fresh.sqlite")
    store.init()
    store.upsert_thread(
        {
            "id": "old1", "subject": "x", "from_email": "a@x.com", "from_name": "A", "snippet": "",
            "internal_date": 1, "is_unread": 0, "last_from_me": 0, "is_automatic": 0, "is_marketing": 0,
            "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 1, "hidden": 0,
            "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
        }
    )
    store.save_ai("old1", sent_via_app_at=int((datetime.now(timezone.utc) - timedelta(days=1)).timestamp() * 1000))
    # simula um banco de antes das métricas: sem a marca de backfill
    with store._connect() as conn:
        conn.execute("DELETE FROM meta WHERE key='events_backfilled'")
        conn.execute("DELETE FROM usage_events")
    store.init()
    store.init()  # rodar de novo não pode duplicar
    assert metrics.compute(7)["answered"] == 1


def test_metrics_api_and_assumption_settings_round_trip():
    client = TestClient(app)
    assert client.post("/api/settings", json={"metric_minutes_reply": 8}).status_code == 200
    store.log_event("sent", "t1")
    data = client.get("/api/metrics").json()
    assert data["week"]["answered"] == 1
    assert data["week"]["assumptions"]["minutes_per_reply"] == 8
    assert data["month"]["days"] == 30


def _decision(action, status, days_ago, **extra):
    store.create_autopilot_decision(
        thread_id="t", action=action, status=status, confidence=0.9, reasoning="", draft_text="",
        sensitivity_level="moderado", decided_at=_ago(days_ago), **extra,
    )


def test_autopilot_block_counts_outcomes_and_rate():
    store.save_settings(autopilot_enabled=True, autopilot_level="moderado", metric_minutes_reply=5)
    _decision("auto_send", "sent", 1)
    _decision("auto_send", "sent", 2)
    _decision("auto_send", "cancelled", 2)
    _decision("auto_send", "failed", 3)
    _decision("auto_send", "pending", 0)
    _decision("draft_only", "resolved", 1)
    _decision("alert", "resolved", 1)
    _decision("alert", "resolved", 40)  # fora das janelas de 7 e 30 dias
    ap = metrics.compute(7, now=NOW)["autopilot"]
    assert ap["enabled"] is True and ap["level"] == "moderado"
    assert ap["decisions"] == 7
    assert (ap["auto_sent"], ap["auto_cancelled"], ap["auto_failed"], ap["auto_pending"]) == (2, 1, 1, 1)
    assert (ap["drafts"], ap["alerts"]) == (1, 1)
    assert ap["automation_rate"] == round(2 / 7 * 100)
    assert ap["saved_minutes"] == 10
    assert len(ap["daily"]) == 7 and sum(d["auto_sent"] for d in ap["daily"]) == 2
    assert metrics.compute(30, now=NOW)["autopilot"]["decisions"] == 7


def test_autopilot_block_is_empty_and_safe_when_never_used():
    ap = metrics.compute(7, now=NOW)["autopilot"]
    assert ap["decisions"] == 0 and ap["automation_rate"] == 0 and ap["saved_minutes"] == 0
    assert ap["enabled"] is False and ap["level"] == "conservador"
