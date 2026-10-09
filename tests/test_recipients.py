"""Destinatários da resposta (bug r8: saiu para o Douglas com saudação "Paulo,").

Nada aqui fala com o Gmail: o serviço do Gmail é falso e só guarda a
mensagem MIME que seria enviada."""
import base64
import email

import pytest
from fastapi.testclient import TestClient

from app import copilot, gmail_client, netstatus, outbox, recipients, store
from app.main import app

ME = gmail_client.ACCOUNT


class _Req:
    def __init__(self, fn):
        self.fn = fn

    def execute(self):
        return self.fn()


class FakeGmail:
    """users().threads().get(...) / users().messages().send(...) mínimos."""

    def __init__(self, msgs):
        self._msgs = msgs
        self.sent = []

    def users(self):
        return self

    def threads(self):
        return self

    def messages(self):  # o mesmo objeto faz threads() e messages()
        return self

    def get(self, **kw):
        return _Req(lambda: {"messages": self._msgs})

    def send(self, userId, body):
        self.sent.append(body)
        return _Req(lambda: {"id": "sent-1"})


def _msg(frm, to, cc="", mid="<m@x>"):
    headers = [{"name": "From", "value": frm}, {"name": "To", "value": to}, {"name": "Subject", "value": "Proposta"},
               {"name": "Message-ID", "value": mid}]
    if cc:
        headers.append({"name": "Cc", "value": cc})
    return {"payload": {"headers": headers}}


THREAD = [
    _msg("Paulo Lemes <paulo.lemes@confrapag.com.br>", f"Leo <{ME}>", "Evaldo <evaldo@confrapag.com.br>", "<m1@x>"),
    _msg("Douglas Pelegrini <douglas.pelegrini@confrapag.com.br>", f"Leo <{ME}>",
         "Paulo Lemes <paulo.lemes@confrapag.com.br>, Evaldo <evaldo@confrapag.com.br>", "<m2@x>"),
]


@pytest.fixture
def gmail(monkeypatch, tmp_path):
    from app import attachments

    monkeypatch.setattr(attachments, "ROOT", tmp_path / "anexos")
    fake = FakeGmail(THREAD)
    monkeypatch.setattr(gmail_client, "load_credentials", lambda: object())
    monkeypatch.setattr(gmail_client, "has_send_scope", lambda creds: True)
    monkeypatch.setattr(gmail_client, "_service", lambda creds: fake)
    monkeypatch.setattr(gmail_client, "_execute", lambda req, attempts=6: req.execute())
    return fake


def _sent_headers(fake):
    raw = base64.urlsafe_b64decode(fake.sent[-1]["raw"])
    return email.message_from_bytes(raw)


# ── send_reply ──
def test_send_reply_with_explicit_to_uses_it_and_keeps_threading(gmail):
    out = gmail_client.send_reply("t1", "Paulo, segue.", cc="douglas.pelegrini@confrapag.com.br, evaldo@confrapag.com.br",
                                  to=["paulo.lemes@confrapag.com.br"])
    msg = _sent_headers(gmail)
    assert msg["To"] == "paulo.lemes@confrapag.com.br"
    assert "douglas.pelegrini@confrapag.com.br" in msg["Cc"]
    assert msg["In-Reply-To"] == "<m2@x>" and msg["References"] == "<m2@x>"
    assert gmail.sent[-1]["threadId"] == "t1"
    assert out["to"] == "paulo.lemes@confrapag.com.br"


def test_send_reply_without_to_keeps_old_behavior(gmail):
    gmail_client.send_reply("t1", "Douglas, segue.", cc="paulo.lemes@confrapag.com.br")
    msg = _sent_headers(gmail)
    assert msg["To"] == "douglas.pelegrini@confrapag.com.br"
    assert msg["Cc"] == "paulo.lemes@confrapag.com.br"


def test_send_reply_to_string_and_cc_dedup(gmail):
    gmail_client.send_reply("t1", "Oi", cc="Paulo <paulo.lemes@confrapag.com.br>, evaldo@confrapag.com.br",
                            to="Paulo.Lemes@confrapag.com.br")
    msg = _sent_headers(gmail)
    assert msg["To"] == "paulo.lemes@confrapag.com.br"
    assert "paulo.lemes" not in msg["Cc"]  # quem está no Para não repete no Cc


def test_send_reply_invalid_to_raises_before_gmail(gmail):
    with pytest.raises(ValueError):
        gmail_client.send_reply("t1", "Oi", to=["nao-e-email"])
    assert gmail.sent == []


def test_recipients_defaults_and_participants(gmail):
    r = gmail_client.get_recipients("t1")
    assert r["reply_to"] == ["douglas.pelegrini@confrapag.com.br"]
    assert r["reply_cc"] == ["paulo.lemes@confrapag.com.br", "evaldo@confrapag.com.br"]
    emails = {p["email"] for p in r["participants"]}
    assert emails == {"paulo.lemes@confrapag.com.br", "douglas.pelegrini@confrapag.com.br", "evaldo@confrapag.com.br"}
    assert ME not in emails


# ── endpoint /send e fila ──
@pytest.fixture
def api_send(monkeypatch, tmp_path):
    from app import attachments

    monkeypatch.setattr(attachments, "ROOT", tmp_path / "anexos")
    sent = []

    def fake_send(tid, text, cc="", only_files=None, **kw):
        sent.append({"tid": tid, "text": text, "cc": cc, **kw})
        return {"id": "m1", "to": ", ".join(kw.get("to") or ["douglas@x.com"]), "cc": cc}

    monkeypatch.setattr(gmail_client, "send_reply", fake_send)
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: list(ids))
    monkeypatch.setattr(gmail_client, "refresh_thread", lambda tid: None)
    monkeypatch.setattr(copilot, "resolve_after_send", lambda tid: None)
    with store._connect() as conn:
        conn.execute("DELETE FROM outbox")
    monkeypatch.setattr(netstatus, "status", lambda: netstatus.ONLINE)
    store.upsert_thread({
        "id": "tr1", "subject": "Proposta", "from_email": "douglas@x.com", "from_name": "Douglas",
        "snippet": "oi", "internal_date": 1000, "is_unread": 0, "last_from_me": 0,
        "is_automatic": 0, "is_marketing": 0, "needs_action_hint": 1, "awaiting_reply": 0,
        "conferido": 1, "hide_as_replied": 0, "last_from_header": "Douglas <douglas@x.com>",
        "labels_json": ["INBOX"], "history_id": "h1",
    })
    return sent


def test_endpoint_send_passes_explicit_to(api_send):
    res = TestClient(app).post("/api/threads/tr1/send", json={"text": "Paulo, ok.", "cc": "douglas@x.com", "to": ["paulo@x.com"]})
    assert res.status_code == 200, res.text
    assert api_send[-1]["to"] == ["paulo@x.com"]
    assert res.json()["to"] == "paulo@x.com"


def test_endpoint_send_without_to_does_not_pass_it(api_send):
    res = TestClient(app).post("/api/threads/tr1/send", json={"text": "Douglas, ok."})
    assert res.status_code == 200, res.text
    assert "to" not in api_send[-1]


def test_endpoint_send_rejects_invalid_or_empty_to(api_send):
    c = TestClient(app)
    assert c.post("/api/threads/tr1/send", json={"text": "Oi", "to": ["xx"]}).status_code == 400
    assert c.post("/api/threads/tr1/send", json={"text": "Oi", "to": []}).status_code == 400
    assert c.post("/api/threads/tr1/send", json={"text": "Oi", "cc": "nada"}).status_code == 400
    assert api_send == []


def test_outbox_keeps_and_uses_chosen_to(api_send, monkeypatch):
    monkeypatch.setattr(netstatus, "status", lambda: "offline")
    res = TestClient(app).post("/api/threads/tr1/send", json={"text": "Paulo, ok.", "to": "paulo@x.com", "source": "copilot"})
    assert res.status_code == 202, res.text
    item = outbox.list_items()[0]
    assert item["reply_to"] == "paulo@x.com" and item["to_addr"] == "paulo@x.com"
    assert api_send == []
    outbox._deliver(item)
    assert api_send[-1]["to"] == "paulo@x.com"


def test_outbox_without_to_delivers_default(api_send, monkeypatch):
    monkeypatch.setattr(netstatus, "status", lambda: "offline")
    TestClient(app).post("/api/threads/tr1/send", json={"text": "Douglas, ok."})
    item = outbox.list_items()[0]
    assert not item.get("reply_to")
    outbox._deliver(item)
    assert "to" not in api_send[-1]


# ── saudação ≠ Para ──
PEOPLE = [
    {"email": "paulo.lemes@confrapag.com.br", "name": "Paulo Lemes"},
    {"email": "douglas.pelegrini@confrapag.com.br", "name": "Douglas Pelegrini"},
    {"email": "evaldo@confrapag.com.br", "name": ""},
]


@pytest.mark.parametrize("text,name", [
    ("Paulo,\n\nsegue.", "Paulo"), ("Olá, Paulo!\nTudo bem?", "Paulo"), ("Bom dia, Douglas.\n", "Douglas"),
    ("Paulo, segue o relatório.", "Paulo"), ("Oi pessoal,\n", ""), ("Segue o relatório em anexo.", ""), ("", ""),
])
def test_greeting_name(text, name):
    assert recipients.greeting_name(text) == name


def test_instruction_target():
    assert recipients.instruction_target("Não responda a Douglas, responda a Paulo.") == {"para": "Paulo", "nao": "Douglas"}
    assert recipients.instruction_target("mande para o Evaldo") == {"para": "Evaldo"}
    assert recipients.instruction_target("deixe mais curto") == {}


def test_suggest_when_greeting_differs_from_to():
    s = recipients.suggest("Paulo,\n\nok.", ["douglas.pelegrini@confrapag.com.br"], ["paulo.lemes@confrapag.com.br"], PEOPLE, me=ME)
    assert s["para"] == ["paulo.lemes@confrapag.com.br"]
    assert s["cc"] == ["douglas.pelegrini@confrapag.com.br"]  # Douglas vai para o Cc, Paulo sai do Cc
    assert "Paulo" in s["mensagem"] and "douglas" in s["mensagem"]


def test_no_suggest_when_greeting_matches_or_unknown():
    assert recipients.suggest("Douglas,\nok", ["douglas.pelegrini@confrapag.com.br"], [], PEOPLE) is None
    assert recipients.suggest("Evaldo,\nok", ["evaldo@confrapag.com.br"], [], PEOPLE) is None  # bate pelo e-mail
    assert recipients.suggest("Marina,\nok", ["douglas.pelegrini@confrapag.com.br"], [], PEOPLE) is None
    assert recipients.suggest("Segue o arquivo.", ["douglas.pelegrini@confrapag.com.br"], [], PEOPLE) is None


def test_suggest_from_instruction():
    s = recipients.suggest("Bom dia,\nok", ["douglas.pelegrini@confrapag.com.br"], [], PEOPLE,
                           instruction="Não responda a Douglas, responda a Paulo.")
    assert s["origem"] == "pedido" and s["para"] == ["paulo.lemes@confrapag.com.br"]


def test_draft_endpoint_returns_recipient_suggestion(monkeypatch):
    from app import assistant

    monkeypatch.setattr(assistant, "draft", lambda tid, instr, comment, **k: {"id": tid, "draft": "Paulo,\n\nok.", "chat": []})
    monkeypatch.setattr(gmail_client, "get_recipients", lambda tid: {
        "reply_to": ["douglas.pelegrini@confrapag.com.br"], "reply_cc": ["paulo.lemes@confrapag.com.br"], "participants": PEOPLE})
    c = TestClient(app)
    r = c.post("/api/threads/t9/draft", json={"instruction": "Não responda a Douglas, responda a Paulo."}).json()
    assert r["sugestao_destinatarios"]["para"] == ["paulo.lemes@confrapag.com.br"]
    r = c.post("/api/threads/t9/draft", json={"instruction": "mais curto"}).json()
    assert "sugestao_destinatarios" not in r


# ── pref "Ao enviar, marcar como resolvido e voltar ao quadro" ──
def test_send_resolve_back_pref_defaults_true_and_migrates():
    user = "pref-teste@x.com"
    users = dict(store.get_settings().get("copilot_users") or {})
    users[user] = {"skin": "caderno", "show_all": True}  # salvo antes do campo existir
    store.save_settings(copilot_users=users)
    assert copilot.get_prefs(user)["send_resolve_back"] is True
    c = TestClient(app)
    assert c.post(f"/api/copilot/settings?user={user}", json={"send_resolve_back": False}).json()["send_resolve_back"] is False
    assert c.get(f"/api/copilot/settings?user={user}").json()["send_resolve_back"] is False
    assert c.get("/api/copilot/settings?user=novo@x.com").json()["send_resolve_back"] is True


# ── front: diálogo próprio em todas as páginas, nenhum alert/confirm/prompt nativo ──
def test_pages_load_dialog_and_no_native_dialogs():
    import re
    from pathlib import Path

    static = Path(__file__).resolve().parents[1] / "static"
    for page in ("copilot.html", "index.html", "board.html"):
        html = (static / page).read_text(encoding="utf-8")
        assert "/static/dialog.js" in html and "/static/dialog.css" in html, page
    for page in ("copilot.html", "index.html"):
        assert "/static/recipients.js" in (static / page).read_text(encoding="utf-8"), page
    native = re.compile(r"(?<![.\w])(alert|confirm|prompt)\(|window\.(alert|confirm|prompt)\b")
    found = [f"{js.name}:{i}" for js in static.glob("*.js")
             for i, line in enumerate(js.read_text(encoding="utf-8").splitlines(), 1) if native.search(line)]
    assert found == []
