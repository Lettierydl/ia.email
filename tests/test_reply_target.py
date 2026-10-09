"""Responder a UMA mensagem da thread (r8-B) + cabeçalhos por mensagem.

Gmail e LLM falsos: nada sai daqui. O serviço do Gmail só guarda a mensagem
MIME que seria enviada."""
import base64
import email
import json

import pytest
from fastapi.testclient import TestClient

from app import assistant, copilot, gmail_client, llm, netstatus, outbox, store
from app.main import app

ME = gmail_client.ACCOUNT
PAULO = "paulo.lemes@confrapag.com.br"
DOUG = "douglas.pelegrini@confrapag.com.br"
EVALDO = "evaldo@confrapag.com.br"


class _Req:
    def __init__(self, fn):
        self.fn = fn

    def execute(self):
        return self.fn()


class FakeGmail:
    """threads().get / messages().send mínimos; conta as leituras e falha se
    alguém tentar modificar alguma coisa."""

    def __init__(self, msgs):
        self._msgs = msgs
        self.sent = []
        self.gets = []

    def users(self):
        return self

    def threads(self):
        return self

    def messages(self):
        return self

    def get(self, **kw):
        self.gets.append(kw)
        return _Req(lambda: {"messages": self._msgs})

    def send(self, userId, body):
        self.sent.append(body)
        return _Req(lambda: {"id": "sent-1"})

    def modify(self, **kw):  # pragma: no cover - nunca deve acontecer aqui
        raise AssertionError("modify chamado")


def _msg(gid, frm, to, cc="", mid="", refs="", date="Tue, 07 Oct 2026 15:27:00 -0300", bcc=""):
    headers = [{"name": "From", "value": frm}, {"name": "To", "value": to}, {"name": "Subject", "value": "Proposta"},
               {"name": "Message-ID", "value": mid}, {"name": "Date", "value": date}]
    if cc:
        headers.append({"name": "Cc", "value": cc})
    if bcc:
        headers.append({"name": "Bcc", "value": bcc})
    if refs:
        headers.append({"name": "References", "value": refs})
    return {"id": gid, "payload": {"headers": headers}}


THREAD = [
    _msg("g0", f"Paulo Lemes <{PAULO}>", f"Leo <{ME}>, Douglas Pelegrini <{DOUG}>", f"Evaldo <{EVALDO}>", "<m0@x>"),
    _msg("g1", f"Douglas Pelegrini <{DOUG}>", f"Leo <{ME}>", f"Paulo Lemes <{PAULO}>", "<m1@x>", refs="<m0@x>",
         date="Wed, 08 Oct 2026 09:10:00 -0300"),
    _msg("g2", f"Leo <{ME}>", "Ana <ana@cliente.com>", "", "<m2@x>", refs="<m0@x> <m1@x>",
         date="Wed, 08 Oct 2026 10:00:00 -0300", bcc="arquivo@confrapag.com.br"),
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
    gmail_client._META_CACHE.clear()
    return fake


def _sent(fake):
    return email.message_from_bytes(base64.urlsafe_b64decode(fake.sent[-1]["raw"]))


# ── send_reply com alvo ──
def test_send_reply_to_middle_message_threads_on_it(gmail):
    out = gmail_client.send_reply("t1", "Paulo, fechado.", reply_to_message_id="g0")
    msg = _sent(gmail)
    assert msg["In-Reply-To"] == "<m0@x>"
    assert msg["References"] == "<m0@x>"
    assert msg["To"] == PAULO  # remetente DELA, não o da última
    assert gmail.sent[-1]["threadId"] == "t1"
    assert out["reply_to_message_id"] == "g0"


def test_send_reply_target_keeps_its_reference_chain(gmail):
    gmail_client.send_reply("t1", "Douglas, ok.", reply_to_message_id="g1")
    msg = _sent(gmail)
    assert msg["In-Reply-To"] == "<m1@x>"
    assert msg["References"] == "<m0@x> <m1@x>"
    assert msg["To"] == DOUG


def test_send_reply_target_by_message_id_header_and_leo_message(gmail):
    # alvo = mensagem do próprio Leo -> Para = os Para dela
    gmail_client.send_reply("t1", "Ana, segue.", reply_to_message_id="<m2@x>")
    msg = _sent(gmail)
    assert msg["To"] == "ana@cliente.com"
    assert msg["In-Reply-To"] == "<m2@x>"
    assert msg["References"] == "<m0@x> <m1@x> <m2@x>"


def test_send_reply_target_with_explicit_to_and_cc(gmail):
    gmail_client.send_reply("t1", "Paulo, ok.", to=[PAULO], cc=f"{DOUG}, {EVALDO}", reply_to_message_id="g0")
    msg = _sent(gmail)
    assert msg["To"] == PAULO and msg["Cc"] == f"{DOUG}, {EVALDO}"
    assert msg["In-Reply-To"] == "<m0@x>"


def test_send_reply_unknown_target_fails_before_sending(gmail):
    with pytest.raises(RuntimeError):
        gmail_client.send_reply("t1", "oi", reply_to_message_id="nao-existe")
    assert gmail.sent == []


def test_send_reply_without_target_is_unchanged(gmail):
    gmail_client.send_reply("t1", "oi")
    msg = _sent(gmail)
    assert msg["In-Reply-To"] == "<m2@x>" and msg["References"] == "<m2@x>"


# ── cabeçalhos por mensagem ──
def test_messages_meta_per_message_and_cached(gmail):
    store.upsert_thread({
        "id": "t1", "subject": "Proposta", "from_email": PAULO, "from_name": "Paulo", "snippet": "", "internal_date": 10,
        "is_unread": 0, "last_from_me": 0, "is_automatic": 0, "is_marketing": 0, "needs_action_hint": 0,
        "awaiting_reply": 0, "conferido": 1, "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
    })
    res = TestClient(app).get("/api/threads/t1/messages-meta")
    assert res.status_code == 200, res.text
    msgs = res.json()["messages"]
    assert [m["id"] for m in msgs] == ["g0", "g1", "g2"]
    assert msgs[0]["from"] == {"name": "Paulo Lemes", "email": PAULO}
    assert [a["email"] for a in msgs[0]["to"]] == [ME, DOUG]
    assert [a["email"] for a in msgs[0]["cc"]] == [EVALDO]
    assert msgs[0]["message_id"] == "<m0@x>" and msgs[0]["date"].startswith("Tue, 07 Oct 2026")
    assert [a["email"] for a in msgs[2]["bcc"]] == ["arquivo@confrapag.com.br"]
    assert gmail.gets[-1]["format"] == "metadata"
    n = len(gmail.gets)
    TestClient(app).get("/api/threads/t1/messages-meta")
    assert len(gmail.gets) == n, "segunda leitura vem do cache"
    store.upsert_thread({**store.get_thread("t1"), "internal_date": 20, "labels_json": []})  # mensagem nova
    TestClient(app).get("/api/threads/t1/messages-meta")
    assert len(gmail.gets) == n + 1, "mensagem nova invalida o cache"


def test_messages_meta_without_gmail_is_friendly(monkeypatch):
    gmail_client._META_CACHE.clear()
    monkeypatch.setattr(gmail_client, "load_credentials", lambda: None)
    res = TestClient(app).get("/api/threads/tx/messages-meta")
    assert res.status_code == 400


# ── endpoint /send + fila ──
@pytest.fixture
def api_send(monkeypatch):
    sent = []

    def fake_send(tid, text, cc="", only_files=None, **kw):
        sent.append({"tid": tid, "text": text, "cc": cc, **kw})
        return {"id": "m1", "to": ", ".join(kw.get("to") or [PAULO]), "cc": cc}

    monkeypatch.setattr(gmail_client, "send_reply", fake_send)
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: list(ids))
    monkeypatch.setattr(gmail_client, "refresh_thread", lambda tid: None)
    monkeypatch.setattr(copilot, "resolve_after_send", lambda tid: None)
    with store._connect() as conn:
        conn.execute("DELETE FROM outbox")
    monkeypatch.setattr(netstatus, "status", lambda: netstatus.ONLINE)
    store.upsert_thread({
        "id": "tr2", "subject": "Proposta", "from_email": DOUG, "from_name": "Douglas", "snippet": "oi",
        "internal_date": 1000, "is_unread": 0, "last_from_me": 0, "is_automatic": 0, "is_marketing": 0,
        "needs_action_hint": 1, "awaiting_reply": 0, "conferido": 1, "hide_as_replied": 0,
        "last_from_header": f"Douglas <{DOUG}>", "labels_json": ["INBOX"], "history_id": "h1",
    })
    return sent


def test_endpoint_send_passes_reply_to_message_id(api_send):
    res = TestClient(app).post("/api/threads/tr2/send", json={"text": "Paulo, ok.", "to": [PAULO], "cc": DOUG,
                                                             "reply_to_message_id": "g0"})
    assert res.status_code == 200, res.text
    assert api_send[-1]["reply_to_message_id"] == "g0"
    assert api_send[-1]["to"] == [PAULO]


def test_endpoint_send_without_target_does_not_pass_it(api_send):
    TestClient(app).post("/api/threads/tr2/send", json={"text": "Douglas, ok."})
    assert "reply_to_message_id" not in api_send[-1]


def test_outbox_keeps_and_uses_target(api_send, monkeypatch):
    monkeypatch.setattr(netstatus, "status", lambda: "offline")
    res = TestClient(app).post("/api/threads/tr2/send", json={"text": "Paulo, ok.", "to": [PAULO], "reply_to_message_id": "g0"})
    assert res.status_code == 202, res.text
    item = outbox.list_items()[0]
    assert item["reply_to_message_id"] == "g0"
    assert api_send == []
    outbox._deliver(item)
    assert api_send[-1]["reply_to_message_id"] == "g0" and api_send[-1]["to"] == PAULO


# ── rascunho com alvo ──
BODY = (
    f"De: Paulo Lemes <{PAULO}>\nData: Tue, 07 Oct 2026 15:27:00 -0300\n\nLeo, precisamos FECHAR_A_PROPOSTA até sexta."
    "\n\n----\n\n"
    f"De: Douglas Pelegrini <{DOUG}>\nData: Wed, 08 Oct 2026 09:10:00 -0300\n\nConcordo com o Paulo, MENSAGEM_DO_DOUGLAS."
)


@pytest.fixture
def draft_env(monkeypatch):
    store.save_settings(rag_enabled=False)
    store.upsert_thread({
        "id": "td1", "subject": "Proposta", "from_email": DOUG, "from_name": "Douglas", "snippet": "", "internal_date": 7,
        "is_unread": 0, "last_from_me": 0, "is_automatic": 0, "is_marketing": 0, "needs_action_hint": 0,
        "awaiting_reply": 0, "conferido": 1, "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
    })
    store.save_ai("td1", body_text=BODY, chat_json="[]", chat_anchor_date=7, draft="")
    monkeypatch.setattr(llm, "has_key", lambda: True)
    seen = {}

    def fake_complete(prompt, **kw):
        seen["prompt"] = prompt
        return json.dumps({"kind": "draft", "text": "Paulo, fechamos sexta.", "cc_names": []})

    monkeypatch.setattr(llm, "complete", fake_complete)
    return seen


def test_draft_with_target_highlights_that_message(draft_env):
    res = TestClient(app).post("/api/threads/td1/draft", json={"instruction": "diga que fechamos sexta", "alvo_idx": 0,
                                                              "reply_to_message_id": "g0"})
    assert res.status_code == 200, res.text
    prompt = draft_env["prompt"]
    assert "Você está respondendo a ESTA mensagem (mensagem 1 de 2)" in prompt
    block = prompt[prompt.index("Você está respondendo a ESTA mensagem"):prompt.index("Instrução do Leo")]
    assert "FECHAR_A_PROPOSTA" in block and PAULO in block
    assert "MENSAGEM_DO_DOUGLAS" not in block, "só a mensagem-alvo no destaque"
    assert "MENSAGEM_DO_DOUGLAS" in prompt, "o resto da thread continua como contexto"
    data = res.json()
    assert data["alvo"]["idx"] == 0 and data["alvo"]["message_id"] == "g0"
    chat = json.loads(store.get_thread("td1")["chat_json"])
    assert chat[-1]["alvo"]["idx"] == 0 and chat[-2]["alvo"]["message_id"] == "g0", "chat guarda o alvo"


def test_draft_without_target_has_no_target_block(draft_env):
    res = TestClient(app).post("/api/threads/td1/draft", json={"instruction": "mais curto"})
    assert res.status_code == 200, res.text
    assert "ESTA mensagem" not in draft_env["prompt"]
    assert "alvo" not in json.loads(store.get_thread("td1")["chat_json"])[-1]


def test_draft_target_by_gmail_id_and_out_of_range(draft_env, monkeypatch):
    monkeypatch.setattr(gmail_client, "get_messages_meta", lambda tid, **k: [{"id": "g0"}, {"id": "g1"}])
    c = TestClient(app)
    assert c.post("/api/threads/td1/draft", json={"instruction": "ok", "reply_to_message_id": "g1"}).status_code == 200
    assert "(mensagem 2 de 2)" in draft_env["prompt"] and "MENSAGEM_DO_DOUGLAS" in draft_env["prompt"]
    assert c.post("/api/threads/td1/draft", json={"instruction": "ok", "alvo_idx": 5}).status_code == 400
    assert c.post("/api/threads/td1/draft", json={"instruction": "ok", "reply_to_message_id": "zz"}).status_code == 400


def test_pages_load_msgreply():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "static"
    for page in ("copilot.html", "index.html"):
        assert "/static/msgreply.js?v=" in (root / page).read_text()
    js = (root / "msgreply.js").read_text()
    assert "Responder a esta mensagem" in js and "Responder a todos" in js and "voltar para a última" in js
