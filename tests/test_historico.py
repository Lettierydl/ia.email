"""Histórico de ações + Desfazer/Refazer (app/history.py). Gmail sempre mockado:
nenhum teste fala com o Gmail de verdade nem envia e-mail."""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app import config, copilot, gmail_client, history, llm, outbox, rag, store
from app.main import app

ME = config.ACCOUNT
BODY = "De: Ana Souza <ana@x.com>\nData: 2026-10-01\n\nLeo, você pode validar o roteamento do pix até 10/10?"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    monkeypatch.setattr(config, "RAG_DB_PATH", tmp_path / "rag.sqlite")
    store.init()
    monkeypatch.setattr(llm, "has_key", lambda: False)
    monkeypatch.setattr(copilot, "_save_analysis_to_learning_base", lambda *a, **k: None)
    monkeypatch.setattr(copilot, "AUTO_BATCH", False)
    rag._last_sync = time.time()

    def boom(*a, **k):
        raise AssertionError("teste tentou enviar e-mail de verdade")

    monkeypatch.setattr(gmail_client, "send_reply", boom)
    monkeypatch.setattr(gmail_client, "send_new", boom)


@pytest.fixture()
def gmail(monkeypatch):
    """Gmail simulado: guarda quem está não lido "no Gmail"."""
    state = {"unread": set(), "calls": [], "fail_unread": False}

    def read(ids):
        state["calls"].append(("read", list(ids)))
        state["unread"].difference_update(ids)
        store.mark_local_read(list(ids))  # igual ao real
        return list(ids)

    def unread(ids):
        if state["fail_unread"]:
            raise RuntimeError("Gmail fora do ar")
        state["calls"].append(("unread", list(ids)))
        state["unread"].update(ids)
        return list(ids)

    monkeypatch.setattr(gmail_client, "mark_threads_read", read)
    monkeypatch.setattr(gmail_client, "mark_threads_unread", unread)
    return state


def _thread(tid="t1", *, unread=1, subject="Roteamento do pix", sender="ana@x.com", date=10):
    store.upsert_thread(
        {
            "id": tid, "subject": subject, "from_email": sender, "from_name": "Ana Souza",
            "snippet": "Leo, você pode validar?", "internal_date": date, "is_unread": unread,
            "last_from_me": 0, "is_automatic": 0, "is_marketing": 0, "needs_action_hint": 0,
            "awaiting_reply": 0, "conferido": 1, "hidden": 0, "hide_as_replied": 0,
            "last_from_header": f"Ana Souza <{sender}>", "labels_json": [], "to_header": ME, "cc_header": "",
        }
    )
    store.save_ai(tid, body_text=BODY)


def _hist(client, **params):
    return client.get("/api/historico", params=params).json()["items"]


# ── registro ──

def test_mark_read_logs_and_undo_reverts_local_and_gmail(gmail):
    _thread("t1")
    gmail["unread"].add("t1")
    c = TestClient(app)
    res = c.post("/api/threads/t1/mark-read").json()
    assert res["historico"]["acao"] == "marcar_lido" and res["historico"]["desfazivel"]
    assert res["historico"]["rotulo"] == "Marcado como lido"
    assert not store.get_thread("t1")["is_unread"] and "t1" not in gmail["unread"]

    undone = c.post(f"/api/historico/{res['historico']['id']}/desfazer").json()
    assert undone["ok"] and undone["gmail"] == ["t1"]
    assert store.get_thread("t1")["is_unread"] == 1, "volta a não lido aqui"
    assert "t1" in gmail["unread"], "e no Gmail (label UNREAD)"
    item = _hist(c)[0]
    assert item["desfeito"] and item["estado"] == "desfeito"


def test_each_copilot_action_is_logged(gmail):
    for i, action in enumerate(("assumir", "aguardar", "so_saber", "resolver", "reabrir")):
        _thread(f"t{i}")
        copilot.act(f"t{i}", action)
    copilot.act("t0", "delegar", {"para": "bia@x.com", "modo": "cc_originais"})
    acoes = [(e["acao"], e["rotulo"]) for e in history.listing(limit=20)["items"]]
    assert acoes == [
        ("delegar", "Delegado para bia@x.com"),
        ("reabrir", "Reaberto"),
        ("resolvido", "Resolvido"),
        ("mover", "Movido para Só conhecimento"),
        ("mover", "Movido para Aguardando outras pessoas"),
        ("acompanhar", "Você acompanha"),
    ]
    assert all(e["origem"] == "copilot" for e in history.listing()["items"])


def test_undo_copilot_resolve_reopens_and_unreads_gmail(gmail):
    _thread("t1")
    gmail["unread"].add("t1")
    res = copilot.act("t1", "resolver")
    assert res["historico"]["acao"] == "resolvido"
    assert store.get_copilot_item("t1")["status"] == "resolvido"
    history.undo(res["historico"]["id"])
    assert store.get_copilot_item("t1")["status"] != "resolvido"
    assert store.get_thread("t1")["is_unread"] == 1 and "t1" in gmail["unread"]
    assert any(i["thread_id"] == "t1" for i in copilot.list_items(show_all=False)["items"]), "volta ao quadro"


def test_undo_delegar_restores_status_and_draft(gmail):
    _thread("t1")
    copilot.act("t1", "assumir")
    res = copilot.act("t1", "delegar", {"para": "bia@x.com", "modo": "cc_originais"})
    assert store.get_thread("t1")["draft"]
    history.undo(res["historico"]["id"])
    assert store.get_copilot_item("t1")["status"] == "assumido"
    assert store.get_copilot_item("t1")["delegado_json"] is None
    assert store.get_thread("t1")["draft"] == ""


def test_resolve_column_is_one_group_and_undo_reverts_all(gmail):
    for tid in ("a", "b", "c"):
        _thread(tid)
        gmail["unread"].add(tid)
        store.save_copilot_item(tid, papel="demanda", status="aberto")
    tab = copilot.list_items()["items"][0]["tab"]
    ids = [i["thread_id"] for i in copilot.list_items()["items"] if i["tab"] == tab]
    res = copilot.resolve_column(tab)
    entry = res["historico"]
    assert entry["acao"] == "resolver_coluna" and entry["n"] == len(ids) and entry["grupo_id"]
    assert len(history.listing()["items"]) == 1, "lote = uma linha"
    history.undo(entry["id"])
    for tid in ids:
        assert store.get_copilot_item(tid)["status"] == "aberto"
        assert store.get_thread(tid)["is_unread"] == 1
    assert set(ids) <= gmail["unread"]


def test_send_is_logged_but_not_undoable(gmail, monkeypatch):
    monkeypatch.setattr(gmail_client, "refresh_thread", lambda tid: None)
    _thread("t1")
    outbox.finalize_reply("t1", "Oi Ana, validado.", "", "copilot")
    items = history.listing()["items"]
    envio = next(e for e in items if e["acao"] == "enviar")
    assert not envio["desfazivel"] and envio["motivo"] == "E-mail já enviado"
    assert envio["estado"] == "nao_reversivel" and envio["origem"] == "copilot"
    with pytest.raises(history.HistoryError) as err:
        history.undo(envio["id"])
    assert err.value.status == 409 and "já enviado" in err.value.message
    # o resolvido pós-envio é a ação desfazível mais recente
    assert items[0]["acao"] == "resolvido" and items[0]["detalhe"] == "após o envio"


def test_undo_last_skips_not_undoable_and_already_undone(gmail, monkeypatch):
    monkeypatch.setattr(gmail_client, "refresh_thread", lambda tid: None)
    _thread("t1")
    _thread("t2")
    first = copilot.act("t1", "assumir")["historico"]
    second = copilot.act("t2", "aguardar")["historico"]
    history.undo(second["id"])  # já desfeita
    history.record_send("t2", "mail")  # não desfazível, mais recente
    store.add_historico(acao="salvar_rascunho", thread_ids=["t2"], anterior={"t2": {"thread.draft": ""}},
                        novo={"t2": {"thread.draft": "x"}})  # Ctrl+Z ignora rascunho
    c = TestClient(app)
    res = c.post("/api/historico/desfazer-ultimo").json()
    assert res["entry"]["id"] == first["id"]
    assert c.post("/api/historico/desfazer-ultimo").status_code == 404, "nada mais a desfazer"


def test_redo(gmail):
    _thread("t1")
    gmail["unread"].add("t1")
    c = TestClient(app)
    entry = c.post("/api/threads/t1/mark-read").json()["historico"]
    c.post(f"/api/historico/{entry['id']}/desfazer")
    assert store.get_thread("t1")["is_unread"] == 1
    res = c.post("/api/historico/refazer-ultimo").json()
    assert res["entry"]["id"] == entry["id"] and not res["entry"]["desfeito"] and res["entry"]["refeito_em"]
    assert store.get_thread("t1")["is_unread"] == 0 and "t1" not in gmail["unread"]
    assert c.post(f"/api/historico/{entry['id']}/refazer").status_code == 409, "não está desfeita"
    # ação nova depois de desfazer limpa o refazer-último (igual a editor)
    c.post(f"/api/historico/{entry['id']}/desfazer")
    _thread("t2")
    copilot.act("t2", "assumir")
    assert c.post("/api/historico/refazer-ultimo").status_code == 404


def test_undo_is_safe_when_state_changed_after(gmail):
    """Marcou lido, depois chegou mensagem nova (sync deixou não lido e a IA
    reabriu): desfazer não atropela o que veio depois."""
    _thread("t1")
    _thread("t2")
    # 1) o que veio depois já deixou tudo como antes: desfazer é no-op, sem Gmail
    entry = copilot.act("t1", "resolver")["historico"]
    store.set_thread_fields("t1", is_unread=1)  # sync: mensagem nova
    store.save_copilot_item("t1", status="aberto")  # releitura reabriu
    calls = len(gmail["calls"])
    assert history.undo(entry["id"])["aplicados"] == 0
    assert len(gmail["calls"]) == calls, "não mexe no Gmail"
    # 2) o estado foi para um terceiro valor: nada a desfazer, 409, não marca desfeita
    entry = copilot.act("t2", "resolver")["historico"]
    store.set_thread_fields("t2", is_unread=1)
    store.save_copilot_item("t2", status="delegado")  # outra ação depois
    calls = len(gmail["calls"])
    with pytest.raises(history.HistoryError) as err:
        history.undo(entry["id"])
    assert err.value.status == 409
    assert store.get_copilot_item("t2")["status"] == "delegado", "não atropela"
    assert len(gmail["calls"]) == calls
    assert not store.get_historico(entry["id"])["desfeito_em"]


def test_undo_partial_keeps_later_draft_edit(gmail):
    _thread("t1")
    entry = copilot.act("t1", "delegar", {"para": "bia@x.com", "modo": "cc_originais"})["historico"]
    store.save_ai("t1", draft="editei depois")
    res = history.undo(entry["id"])
    assert res["conflitos"] >= 1
    assert store.get_thread("t1")["draft"] == "editei depois", "edição posterior fica"
    assert store.get_copilot_item("t1")["status"] != "delegado"


def test_gmail_failure_keeps_local_state(gmail):
    _thread("t1")
    entry = TestClient(app).post("/api/threads/t1/mark-read").json()["historico"]
    gmail["fail_unread"] = True
    res = TestClient(app).post(f"/api/historico/{entry['id']}/desfazer")
    assert res.status_code == 502 and "Nada foi alterado" in res.json()["detail"]
    assert store.get_thread("t1")["is_unread"] == 0, "local continua igual ao Gmail"
    assert not store.get_historico(entry["id"])["desfeito_em"]


def test_resolve_without_gmail_undo_is_local_only(monkeypatch):
    def boom(_ids):
        raise RuntimeError("sem gmail.modify")

    monkeypatch.setattr(gmail_client, "mark_threads_read", boom)
    monkeypatch.setattr(gmail_client, "mark_threads_unread", lambda ids: (_ for _ in ()).throw(AssertionError("não devia")))
    _thread("t1")
    entry = copilot.act("t1", "resolver")["historico"]
    assert history.undo(entry["id"])["gmail"] == []
    assert store.get_copilot_item("t1")["status"] != "resolvido"


def test_hide_and_not_interested_undo():
    _thread("t1")
    c = TestClient(app)
    e1 = c.post("/api/threads/t1/hide").json()["historico"]
    assert e1["acao"] == "ocultar" and store.get_thread("t1")["hidden"] == 1
    c.post(f"/api/historico/{e1['id']}/desfazer")
    assert store.get_thread("t1")["hidden"] == 0
    e2 = c.post("/api/threads/t1/not-interested").json()["historico"]
    assert store.is_blocked_sender("ana@x.com")
    c.post(f"/api/historico/{e2['id']}/desfazer")
    assert not store.is_blocked_sender("ana@x.com") and store.get_thread("t1")["is_marketing"] == 0


def test_draft_saves_coalesce_and_undo_restores_previous():
    _thread("t1")
    store.save_ai("t1", draft="original")
    c = TestClient(app)
    for text in ("o", "ol", "olá Ana"):
        c.post("/api/threads/t1/save-draft", json={"text": text, "source": "copilot"})
    items = history.listing()["items"]
    assert len(items) == 1 and items[0]["acao"] == "salvar_rascunho" and items[0]["origem"] == "copilot"
    c.post(f"/api/historico/{items[0]['id']}/desfazer")
    assert store.get_thread("t1")["draft"] == "original"


def test_filters_and_paging(gmail):
    _thread("t1", subject="Pix estático")
    _thread("t2", subject="Contrato EC")
    copilot.act("t1", "assumir")
    copilot.act("t2", "resolver")
    copilot.act("t1", "aguardar")
    c = TestClient(app)
    assert [e["acao"] for e in _hist(c, tipo="resolvido")] == ["resolvido"]
    assert {e["acao"] for e in _hist(c, tipo="mover,acompanhar")} == {"mover", "acompanhar"}
    assert {e["thread_id"] for e in _hist(c, q="pix")} == {"t1"}
    page = c.get("/api/historico", params={"limit": 2}).json()
    assert len(page["items"]) == 2 and page["proximo"]
    rest = c.get("/api/historico", params={"limit": 2, "before": page["proximo"]}).json()
    assert len(rest["items"]) == 1 and rest["proximo"] is None
    assert any(t["key"] == "marcar_lido" for t in page["tipos"])


def test_analysis_is_not_logged():
    _thread("t1")
    copilot.analyze("t1")
    assert history.listing()["items"] == []
