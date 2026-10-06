"""Sync do Gmail (staleness), modo offline e fila de envio.

Nada aqui fala com o Gmail de verdade: serviço do Gmail falso, envio
mockado (nunca o send_reply/send_new reais) e erros de rede simulados."""
import json
import socket

import pytest
from fastapi.testclient import TestClient

from app import copilot, gmail_client, netstatus, outbox, store
from app.main import app

_REAL_SEND_REPLY = gmail_client.send_reply
_REAL_SEND_NEW = gmail_client.send_new


def _boom(*a, **k):
    raise AssertionError("teste tentou falar com o Gmail de verdade")


@pytest.fixture(autouse=True)
def _isolado(monkeypatch, tmp_path):
    from app import attachments

    monkeypatch.setattr(attachments, "ROOT", tmp_path / "anexos")
    for name in ("send_reply", "send_new", "get_thread_text", "mark_threads_read", "refresh_thread", "load_credentials"):
        monkeypatch.setattr(gmail_client, name, _boom)
    store.set_meta("sync_status", "{}")
    with store._connect() as conn:
        conn.execute("DELETE FROM threads")
        conn.execute("DELETE FROM copilot_items")
        conn.execute("DELETE FROM reply_edits")
        conn.execute("DELETE FROM outbox")
    copilot._FAILED.clear()
    copilot._TRIED.clear()
    copilot._JOB.update(running=False, pending=[], done=0, total=0)
    copilot._JOB.pop("paused", None)
    yield


def _thread(tid="t1", internal=1000, unread=1, history="h1", **extra):
    row = {
        "id": tid, "subject": f"Assunto {tid}", "from_email": "ana@x.com", "from_name": "Ana",
        "snippet": "oi", "internal_date": internal, "is_unread": unread, "last_from_me": 0,
        "is_automatic": 0, "is_marketing": 0, "needs_action_hint": 1, "awaiting_reply": 0,
        "conferido": 1, "hide_as_replied": 0, "last_from_header": "Ana <ana@x.com>",
        "labels_json": ["INBOX", "UNREAD"] if unread else ["INBOX"], "history_id": history,
    }
    row.update(extra)
    store.upsert_thread(row)


def _body(n):
    return "\n\n----\n\n".join(
        f"De: {'Leo <leo@confrapag.com.br>' if i % 2 else 'Eudocio <eudocio@x.com>'}\nData: dia {i}\n\nmensagem {i}"
        for i in range(n)
    )


def _gaierror():
    return socket.gaierror(8, "nodename nor servname provided, or not known")


def _reply_edits():
    with store._connect() as conn:
        return conn.execute("SELECT * FROM reply_edits").fetchall()


# ── classificação de erros ──
def test_error_kinds():
    from google.auth.exceptions import RefreshError

    class Resp:
        def __init__(self, status):
            self.status = status

    class FakeHttp(Exception):
        def __init__(self, status):
            self.resp = Resp(status)

    assert netstatus.kind_of(_gaierror()) == "offline"
    assert netstatus.kind_of(ConnectionRefusedError()) == "offline"
    assert netstatus.kind_of(FakeHttp(503)) == "offline"
    assert netstatus.kind_of(RefreshError("invalid_grant: Token has been expired or revoked.")) == "auth_error"
    assert netstatus.kind_of(FakeHttp(401)) == "auth_error"
    assert netstatus.kind_of(RuntimeError("Gmail nao autenticado.")) == "auth_error"
    assert netstatus.kind_of(RuntimeError("Thread vazia.")) == "error"
    # erro de rede embrulhado (raise ... from) continua sendo de rede
    try:
        try:
            raise _gaierror()
        except OSError as inner:
            raise RuntimeError("falhou") from inner
    except RuntimeError as wrapped:
        assert netstatus.kind_of(wrapped) == "offline"
    assert netstatus.is_ambiguous_send_error(socket.timeout("timed out"))
    assert not netstatus.is_ambiguous_send_error(_gaierror())


def test_sync_status_offline_auth_and_back(monkeypatch):
    client = TestClient(app)

    def down():
        raise _gaierror()

    monkeypatch.setattr(gmail_client, "refresh", down)
    with pytest.raises(socket.gaierror):
        netstatus.run_sync()
    st = client.get("/api/sync/status").json()
    assert st["status"] == "offline"
    assert "gaierror" in st["last_error"]
    assert st["offline_since"]
    assert st["outbox"]["queued"] == 0

    from google.auth.exceptions import RefreshError

    def expired():
        raise RefreshError("invalid_grant")

    monkeypatch.setattr(gmail_client, "refresh", expired)
    with pytest.raises(RefreshError):
        netstatus.run_sync()
    assert client.get("/api/sync/status").json()["status"] == "auth_error"

    monkeypatch.setattr(gmail_client, "refresh", lambda: {"fetched": 0})
    netstatus.run_sync()
    st = client.get("/api/sync/status").json()
    assert st["status"] == "online" and st["offline_since"] is None

    # /api/refresh (botão Atualizar) passa pelo mesmo registro de estado
    monkeypatch.setattr(gmail_client, "refresh", down)
    res = client.post("/api/refresh")
    assert res.status_code == 503
    assert client.get("/api/sync/status").json()["status"] == "offline"


def test_sync_label_shows_date_when_not_today():
    from datetime import datetime
    from app import config

    now = datetime(2026, 10, 6, 11, 0, tzinfo=config.TZ)
    assert netstatus.sync_label("2026-10-06T10:58:00-03:00", now) == "10:58"
    assert netstatus.sync_label("2026-10-02T18:19:00-03:00", now) == "02/10 18:19"


# ── refresh: o que re-buscar ──
class _Req:
    def __init__(self, fn):
        self.fn = fn

    def execute(self):
        return self.fn()


class _FakeGmail:
    def __init__(self, lists, threads, counts):
        self.lists, self.threads_raw, self.counts = lists, threads, counts
        self.got = []

    def users(self):
        return self

    def threads(self):
        return self

    def labels(self):
        outer = self

        class L:
            def get(self, userId, id):
                return _Req(lambda: {"threadsUnread": outer.counts.get(id, 0)})

        return L()

    def list(self, userId, q, maxResults, pageToken=None):
        return _Req(lambda: {"threads": self.lists.get(q, [])})

    def get(self, userId, id, format="metadata", **k):
        self.got.append(id)
        return _Req(lambda: self.threads_raw[id])


def _raw(tid, history, labels, internal):
    return {
        "historyId": history,
        "messages": [{
            "labelIds": labels,
            "snippet": "oi",
            "internalDate": str(internal),
            "payload": {"headers": [{"name": "Subject", "value": f"Assunto {tid}"}, {"name": "From", "value": "Ana <ana@x.com>"}]},
        }],
    }


def test_refresh_refetches_changed_and_stale_unread_only(monkeypatch):
    _thread("t_same", unread=0, history="h1")
    _thread("t_changed", unread=0, history="h1", internal=1000)
    _thread("t_stale", unread=1, history="h9")  # lida no celular: some da lista de não lidos
    store.save_ai("t_changed", body_text=_body(1))
    primary, unread_q = "in:inbox category:primary", "in:inbox category:primary is:unread"
    fake = _FakeGmail(
        lists={
            primary: [{"id": "t_same", "historyId": "h1"}, {"id": "t_changed", "historyId": "h2"}, {"id": "t_new", "historyId": "h5"}],
            unread_q: [{"id": "t_new", "historyId": "h5"}, {"id": "t_changed", "historyId": "h2"}],
        },
        threads={
            "t_changed": _raw("t_changed", "h2", ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], 2000),
            "t_new": _raw("t_new", "h5", ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], 3000),
            "t_stale": _raw("t_stale", "h10", ["INBOX", "CATEGORY_PERSONAL"], 1000),
        },
        counts={"CATEGORY_PERSONAL": 29, "INBOX": 900},
    )
    monkeypatch.setattr(gmail_client, "load_credentials", lambda: object())
    monkeypatch.setattr(gmail_client, "_service", lambda creds: fake)
    monkeypatch.setattr(gmail_client.time, "sleep", lambda s: None)

    out = gmail_client.refresh()

    assert sorted(fake.got) == ["t_changed", "t_new", "t_stale"]  # t_same (historyId igual) não
    assert out["fetched"] == 3 and out["primary_unread_gmail"] == 29
    assert store.get_thread("t_stale")["is_unread"] == 0
    assert store.get_thread("t_changed")["is_unread"] == 1
    assert store.get_thread("t_changed")["history_id"] == "h2"
    # mensagem nova: corpo em cache invalidado
    assert not store.get_thread("t_changed")["body_text"]
    assert store.get_thread("t_new")["is_unread"] == 1
    assert json.loads(store.get_meta("gmail_counts"))["primary_unread"] == 29
    assert store.get_meta("last_sync_at")
    st = TestClient(app).get("/api/sync/status").json()
    assert st["gmail_primary_unread"] == 29


# ── /copilot com o mesmo corpo do /mail (caso "Alerta Jira") ──
def test_body_cache_invalidated_when_new_message_arrives(monkeypatch):
    _thread("t1", internal=1000)
    store.save_ai("t1", body_text=_body(1))
    _thread("t1", internal=1000)  # mesmo estado: corpo continua
    assert store.get_thread("t1")["body_text"] == _body(1)
    _thread("t1", internal=2000)  # chegou mensagem nova
    assert not store.get_thread("t1")["body_text"]

    monkeypatch.setattr(gmail_client, "get_thread_text", lambda tid: _body(3))
    det = copilot.detail("t1")
    assert len(det["mensagens"]) == 3
    # /mail (assistant._ensure_body) e /copilot leem a mesma coisa
    from app import assistant

    assert assistant._ensure_body("t1") == det["thread_text"]


def test_analysis_stale_when_message_count_changes():
    _thread("t1", internal=2000)
    store.save_ai("t1", body_text=_body(3))
    store.save_copilot_item("t1", source="llm", status="aberto", papel="fyi", internal_date_snapshot=2000, msg_count_snapshot=1)
    row = store.get_thread("t1")
    prev = store.get_copilot_item("t1")
    assert not copilot._fresh(row, prev)
    assert "t1" in copilot.candidates(5)
    item = next(i for i in copilot.list_items(show_all=True)["items"] if i["thread_id"] == "t1")
    assert item["desatualizado"]
    # contagem igual: fresco
    store.save_copilot_item("t1", msg_count_snapshot=3)
    assert copilot._fresh(store.get_thread("t1"), store.get_copilot_item("t1"))


def test_analyze_records_message_count(monkeypatch):
    _thread("t1", internal=2000)
    store.save_ai("t1", body_text=_body(3))
    monkeypatch.setattr(copilot.llm, "has_key", lambda: False)
    copilot.analyze("t1", force=True)
    assert store.get_copilot_item("t1")["msg_count_snapshot"] == 3


def test_analyze_offline_does_not_persist_fake_unreadable(monkeypatch):
    _thread("t1")

    def down(tid):
        raise _gaierror()

    monkeypatch.setattr(gmail_client, "get_thread_text", down)
    with pytest.raises(socket.gaierror):
        copilot.analyze("t1", force=True)
    assert store.get_copilot_item("t1") is None


# ── lote da IA pausa sem conexão ──
def test_batch_pauses_when_offline(monkeypatch):
    _thread("t1")
    netstatus.mark_error(_gaierror())
    launched = []
    monkeypatch.setattr(copilot, "_launch", lambda ids: launched.append(ids))
    monkeypatch.setattr(copilot.llm, "has_key", lambda: True)
    assert copilot.start(5)["paused"] == "offline"
    assert copilot.ensure_batch(5)["paused"] == "offline"
    assert launched == []


def test_batch_stops_quietly_on_network_error(monkeypatch):
    _thread("t1")
    _thread("t2")
    calls = []

    def down(tid, force=False):
        calls.append(tid)
        raise _gaierror()

    monkeypatch.setattr(copilot, "analyze", down)
    copilot._JOB.update(running=True, pending=["t1", "t2"])
    copilot._run(["t1", "t2"])
    assert len(calls) == 1  # parou no primeiro erro de rede
    # sem marcar falha (outros testes podem ter lotes próprios em segundo plano)
    assert "t1" not in copilot._FAILED and "t2" not in copilot._FAILED
    assert copilot._JOB["paused"] == "offline"
    assert copilot._JOB["running"] is False


# ── fila de envio ──
@pytest.fixture
def fake_send(monkeypatch):
    sent = []

    def send_reply(tid, text, cc="", only_files=None):
        sent.append({"tid": tid, "text": text, "cc": cc, "files": only_files})
        return {"id": "m1", "to": "ana@x.com", "cc": cc}

    def send_new(to, cc, subject, text):
        sent.append({"to": to, "subject": subject, "text": text})
        return {"id": "m2", "thread_id": "", "to": to}

    monkeypatch.setattr(gmail_client, "send_reply", send_reply)
    monkeypatch.setattr(gmail_client, "send_new", send_new)
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: list(ids))
    monkeypatch.setattr(gmail_client, "refresh_thread", lambda tid: None)
    return sent


def test_send_while_offline_goes_to_outbox_and_worker_sends_later(fake_send):
    _thread("t1")
    store.save_ai("t1", draft="Rascunho da IA")
    netstatus.mark_error(_gaierror())
    client = TestClient(app)

    res = client.post("/api/threads/t1/send", json={"text": "Oi Ana, segue.", "source": "copilot"})
    assert res.status_code == 202
    body = res.json()
    assert body["queued"] is True and body["outbox_id"]
    assert fake_send == []  # nem tentou: está offline
    assert _reply_edits() == []  # reply_edits só depois do envio real
    assert store.get_thread("t1")["draft"] == "Rascunho da IA"
    st = client.get("/api/sync/status").json()
    assert st["outbox"]["queued"] == 1
    assert client.get("/api/copilot/t1").json()["outbox"][0]["status"] == "queued"
    # duplo clique não duplica
    assert client.post("/api/threads/t1/send", json={"text": "Oi Ana, segue.", "source": "copilot"}).json()["outbox_id"] == body["outbox_id"]
    assert len(client.get("/api/outbox").json()["items"]) == 1

    # conexão volta: worker manda (respeitando a espera)
    assert outbox.flush() == 0  # ainda dentro do backoff
    import time as _t

    assert outbox.flush(now=_t.time() + 3600) == 1
    assert len(fake_send) == 1 and fake_send[0]["text"] == "Oi Ana, segue."
    item = outbox.get(body["outbox_id"])
    assert item["status"] == "sent"
    edits = _reply_edits()
    assert len(edits) == 1 and edits[0]["source"] == "copilot" and edits[0]["ai_draft"] == "Rascunho da IA"
    assert store.get_thread("t1")["draft"] == ""
    assert netstatus.status() == "online"
    assert outbox.flush(now=_t.time() + 7200) == 0  # não reenvia


def test_send_network_failure_queues_instead_of_failing(monkeypatch, fake_send):
    _thread("t1")

    def down(*a, **k):
        raise _gaierror()

    monkeypatch.setattr(gmail_client, "send_reply", down)
    res = TestClient(app).post("/api/threads/t1/send", json={"text": "Oi"})
    assert res.status_code == 202 and res.json()["queued"]
    assert netstatus.status() == "offline"
    assert outbox.counts()["queued"] == 1
    assert _reply_edits() == []


def test_send_other_error_still_fails_and_is_not_queued(monkeypatch, fake_send):
    _thread("t1")

    def bad(*a, **k):
        raise RuntimeError("Thread vazia.")

    monkeypatch.setattr(gmail_client, "send_reply", bad)
    res = TestClient(app).post("/api/threads/t1/send", json={"text": "Oi"})
    assert res.status_code == 400
    assert outbox.counts()["queued"] == 0


def test_post_send_failure_does_not_report_send_as_failed(monkeypatch, fake_send):
    """O e-mail saiu; marcar como lido/re-buscar falhou: não é 502 (o Leo
    reenviaria e mandaria duas vezes)."""
    _thread("t1")

    def down(*a, **k):
        raise _gaierror()

    monkeypatch.setattr(gmail_client, "mark_threads_read", down)
    res = TestClient(app).post("/api/threads/t1/send", json={"text": "Oi"})
    assert res.status_code == 200 and res.json()["ok"]
    assert len(fake_send) == 1


def test_cancel_queued_item_is_never_sent(fake_send):
    _thread("t1")
    netstatus.mark_error(_gaierror())
    client = TestClient(app)
    oid = client.post("/api/threads/t1/send", json={"text": "Oi"}).json()["outbox_id"]
    res = client.post(f"/api/outbox/{oid}/cancel")
    assert res.status_code == 200 and res.json()["status"] == "cancelled"
    import time as _t

    assert outbox.flush(now=_t.time() + 3600) == 0
    assert fake_send == []
    assert client.get("/api/outbox").json()["items"] == []


def test_flush_network_error_backs_off_and_ambiguous_timeout_is_not_resent(monkeypatch, fake_send):
    import time as _t

    _thread("t1")
    item = outbox.enqueue(kind="reply", thread_id="t1", body="Oi")

    def down(*a, **k):
        raise _gaierror()

    monkeypatch.setattr(gmail_client, "send_reply", down)
    assert outbox.flush(now=_t.time() + 3600) == 0
    again = outbox.get(item["id"])
    assert again["status"] == "queued" and again["attempts"] == 1 and "gaierror" in again["last_error"]

    def timeout(*a, **k):
        raise socket.timeout("timed out")

    monkeypatch.setattr(gmail_client, "send_reply", timeout)
    outbox.flush(now=_t.time() + 7200)
    assert outbox.get(item["id"])["status"] == "failed"
    assert "pode ter saído" in outbox.get(item["id"])["last_error"]
    monkeypatch.setattr(gmail_client, "send_reply", lambda *a, **k: (_ for _ in ()).throw(AssertionError("reenviou")))
    outbox.flush(now=_t.time() + 99999)  # falhou = não volta sozinho


def test_interrupted_send_is_not_resent_automatically(fake_send):
    item = outbox.enqueue(kind="reply", thread_id="t1", body="Oi")
    outbox._set(item["id"], status="sending")
    assert outbox.recover_interrupted() == 1
    assert outbox.get(item["id"])["status"] == "failed"


def test_queued_reply_keeps_attachment_snapshot(fake_send):
    from app import attachments
    import time as _t

    _thread("t1")
    attachments.save_file("t1", "proposta.pdf", b"%PDF")
    netstatus.mark_error(_gaierror())
    oid = TestClient(app).post("/api/threads/t1/send", json={"text": "Segue anexo"}).json()["outbox_id"]
    assert outbox.get(oid)["attachments"] == ["proposta.pdf"]
    attachments.save_file("t1", "outro.txt", b"x")  # chegou depois da confirmação
    outbox.flush(now=_t.time() + 3600)
    assert fake_send[0]["files"] == ["proposta.pdf"]
    assert attachments.list_files("t1") == []  # limpa a pasta após o envio real


def test_compose_offline_is_queued(fake_send):
    import time as _t

    netstatus.mark_error(_gaierror())
    res = TestClient(app).post("/api/compose/send", json={"to": "bia@x.com", "subject": "Oi", "text": "Tudo bem?"})
    assert res.status_code == 202 and res.json()["queued"]
    assert fake_send == []
    outbox.flush(now=_t.time() + 3600)
    assert fake_send == [{"to": "bia@x.com", "subject": "Oi", "text": "Tudo bem?"}]


def test_copilot_page_loads_netstatus_script():
    html = TestClient(app).get("/copilot").text
    assert "/static/netstatus.js" in html
