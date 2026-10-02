from app import assistant, board, store


def test_friendly_reason_hides_rule_jargon():
    text, kind = board._friendly("Exclusão de segurança: assunto financeiro.")
    assert kind == "security"
    assert "Exclusão" not in text and text.startswith("Assunto financeiro")
    assert "regra" in text


def test_friendly_reason_keeps_model_text():
    assert board._friendly("Pedem uma decisão nova.") == ("Pedem uma decisão nova.", "model")
    assert board._friendly("")[1] == "model"


def test_clip():
    assert board._clip("a " * 200, 20).endswith("…")
    assert board._clip("curto") == "curto"


def test_build_has_always_shown_zones_when_empty():
    data = board.build()
    keys = [z["key"] for z in data["zones"]]
    assert keys[:3] == ["can", "gap", "none"]
    assert data["total"] == 0


def test_dismiss_pilot_alert_only():
    did = store.create_autopilot_decision(
        thread_id="x", action="alert", confidence=0.0, reasoning="Exclusão de segurança: x.",
        draft_text="", cc="", sensitivity_level="conservador", scheduled_send_at=None, status="resolved",
    )
    assert assistant.dismiss_autopilot_decision(did) == {"ok": True}
    assert store.get_autopilot_decision(did)["status"] == "dismissed"
    try:
        assistant.dismiss_autopilot_decision(did)
        raise AssertionError("deveria recusar")
    except RuntimeError:
        pass
