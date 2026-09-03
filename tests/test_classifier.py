from app.classifier import classify, parse_email


def test_parse_email():
    assert parse_email("Paulo <paulo.lemes@confrapag.com.br>") == "paulo.lemes@confrapag.com.br"


def test_unread_needs_action():
    result = classify(
        label_ids=["UNREAD", "INBOX"],
        last_from_header="Paulo <paulo.lemes@confrapag.com.br>",
        subject="Vendas abaixo do custo — urgente",
        snippet="preciso que voce valide o prazo ate 05/09",
    )
    assert result.is_unread
    assert result.awaiting_reply is False
    assert result.needs_action_hint
    assert result.hide_as_replied is False


def test_waiting_reply_not_from_leo():
    result = classify(
        label_ids=["INBOX"],
        last_from_header="AWS <marielut@amazon.com>",
        subject="Convite AWS Summit",
        snippet="participe",
    )
    assert result.awaiting_reply
    assert result.is_unread is False


def test_replied_hides():
    result = classify(
        label_ids=["INBOX"],
        last_from_header="Leo <leo@confrapag.com.br>",
        subject="Re: Day Off",
        snippet="ok, pode fazer",
    )
    assert result.last_from_me
    assert result.hide_as_replied
    assert result.awaiting_reply is False


def test_automatic_aceite():
    result = classify(
        label_ids=["UNREAD", "INBOX"],
        last_from_header="Calendar <calendar-notification@google.com>",
        subject="Aceito: Reuniao Semanal",
        snippet="",
    )
    assert result.is_automatic
    assert result.awaiting_reply is False
