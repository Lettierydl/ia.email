from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app import assistant, config, copilot, gmail_client, learned, llm, rag, store
from app.main import app

ME = config.ACCOUNT


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    monkeypatch.setattr(config, "RAG_DB_PATH", tmp_path / "rag.sqlite")
    monkeypatch.setattr(config, "LEARNED_NOTES_MD", tmp_path / "lb" / "aprendizados.md")
    store.init()
    store.save_settings(rag_enabled=False)
    rag._last_sync = time.time()
    monkeypatch.setattr(llm, "has_key", lambda: True)
    monkeypatch.setattr(copilot, "_save_analysis_to_learning_base", lambda *a, **k: None)

    def boom(*a, **k):
        raise AssertionError("teste tentou falar com o Gmail / enviar e-mail")

    monkeypatch.setattr(gmail_client, "send_reply", boom)
    monkeypatch.setattr(gmail_client, "send_new", boom)
    monkeypatch.setattr(gmail_client, "get_thread_text", boom)


def _thread(tid="t1", subject="Roteamento do pix estático", sender="ana@x.com", cc="bia@x.com", draft=""):
    store.upsert_thread(
        {
            "id": tid, "subject": subject, "from_email": sender, "from_name": "Ana Souza",
            "snippet": "", "internal_date": 10, "is_unread": 1, "last_from_me": 0, "is_automatic": 0,
            "is_marketing": 0, "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 1,
            "hidden": 0, "hide_as_replied": 0, "last_from_header": f"Ana Souza <{sender}>",
            "labels_json": [], "to_header": ME, "cc_header": cc,
        }
    )
    store.save_ai(
        tid,
        body_text=f"De: Ana Souza <{sender}>\nData: 2026-10-01\n\nLeo, você pode validar o roteamento do pix estático até 10/10?",
        draft=draft,
    )


def _capture(monkeypatch, payload):
    seen = {}

    def fake(prompt, **kw):
        seen["prompt"] = prompt
        return json.dumps(payload)

    monkeypatch.setattr(llm, "complete", fake)
    return seen


def test_subject_key_strips_prefixes():
    assert learned.subject_key("Re: RES: Fwd:  Roteamento   do PIX") == "roteamento do pix"
    assert learned.subject_key("Enc: tr: Assunto") == "assunto"


def test_add_list_delete_and_markdown_mirror():
    _thread()
    g = learned.add("general", "Sempre assine como Léo.")
    p = learned.add("person", "Ana prefere respostas curtas.", person_email="ANA@x.com")
    t = learned.add("thread", "O pix estático segue a conta da Confrapag.", thread_id="t1")
    assert t["subject"] == "Roteamento do pix estático" and t["subject_key"] == "roteamento do pix estático"
    assert p["person_email"] == "ana@x.com"
    assert {n["id"] for n in store.list_learned_notes()} == {g["id"], p["id"], t["id"]}

    md = config.LEARNED_NOTES_MD.read_text(encoding="utf-8")
    assert "## Geral" in md and "Sempre assine como Léo." in md
    assert "### ana@x.com" in md and "### Roteamento do pix estático" in md

    assert learned.delete(p["id"]) is True
    assert learned.delete(p["id"]) is False
    md = config.LEARNED_NOTES_MD.read_text(encoding="utf-8")
    assert "Ana prefere" not in md and "Sempre assine" in md


def test_mirror_failure_does_not_break_saving(monkeypatch, tmp_path):
    blocker = tmp_path / "arquivo"
    blocker.write_text("x")
    monkeypatch.setattr(config, "LEARNED_NOTES_MD", blocker / "sub" / "aprendizados.md")
    note = learned.add("general", "Vale mesmo sem espelho.")
    assert store.list_learned_notes()[0]["id"] == note["id"]


def test_secret_is_blocked_and_validation():
    _thread()
    with pytest.raises(learned.LearnedError, match="senha"):
        learned.add("general", "a senha: Abc12345 do portal")
    with pytest.raises(learned.LearnedError):
        learned.add("person", "sem e-mail")
    with pytest.raises(learned.LearnedError):
        learned.add("thread", "thread inexistente", thread_id="nao-existe")
    with pytest.raises(learned.LearnedError):
        learned.add("outro", "escopo ruim")
    assert store.list_learned_notes() == []


def test_notes_block_filters_by_thread_subject_person_and_general():
    _thread("t1", subject="Roteamento do pix estático")
    _thread("t2", subject="RE: Roteamento do pix estático", sender="carlos@y.com", cc="")
    _thread("t3", subject="Outro assunto", sender="zed@z.com", cc="")
    learned.add("general", "Regra geral.")
    learned.add("person", "Sobre a Ana.", person_email="ana@x.com")
    learned.add("person", "Sobre a Bia.", person_email="bia@x.com")
    learned.add("thread", "Sobre o pix.", thread_id="t1")

    b1 = learned.notes_block("t1", "Roteamento do pix estático", learned.thread_emails(store.get_thread("t1")))
    assert "Aprendizados que o Leo registrou" in b1
    assert "(geral) Regra geral." in b1 and "(sobre ana@x.com) Sobre a Ana." in b1
    assert "Sobre a Bia." in b1  # participante em Cc
    assert "(neste assunto) Sobre o pix." in b1

    # mesmo assunto (sem o Re:) em outra thread também recebe a nota do assunto
    b2 = learned.notes_block("t2", "RE: Roteamento do pix estático", learned.thread_emails(store.get_thread("t2")))
    assert "Sobre o pix." in b2 and "Sobre a Ana." not in b2 and "Regra geral." in b2

    b3 = learned.notes_block("t3", "Outro assunto", ["zed@z.com"])
    assert "Regra geral." in b3 and "Sobre o pix." not in b3 and "Sobre a Ana." not in b3
    assert ME not in learned.thread_emails(store.get_thread("t1"))


def test_draft_prompt_includes_learned_notes(monkeypatch):
    _thread()
    learned.add("person", "Ana prefere respostas curtas e sem anexo.", person_email="ana@x.com")
    seen = _capture(monkeypatch, {"kind": "draft", "text": "Oi Ana, validado.", "cc_names": []})
    assistant.draft("t1", "confirme")
    assert "Ana prefere respostas curtas e sem anexo." in seen["prompt"]
    assert "Aprendizados que o Leo registrou" in seen["prompt"]


def test_copilot_analyze_prompt_includes_learned_notes(monkeypatch):
    _thread()
    learned.add("thread", "Esse tema é com o time de Produto.", thread_id="t1")
    seen = _capture(monkeypatch, {"papel_leo": "demanda", "o_que_aconteceu": "Ana pede validação.", "o_que_eu_faria": []})
    copilot.analyze("t1", force=True)
    assert "Esse tema é com o time de Produto." in seen["prompt"]


def test_compose_draft_includes_general_and_recipient_notes(monkeypatch):
    learned.add("general", "Regra geral do Leo.")
    learned.add("person", "Carlos é do jurídico.", person_email="carlos@y.com")
    learned.add("person", "Outra pessoa.", person_email="zed@z.com")
    seen = _capture(monkeypatch, {"kind": "draft", "text": "Oi", "cc_names": []})
    assistant.compose_draft("Carlos <carlos@y.com>", "Contrato", "escreva", "", [])
    assert "Regra geral do Leo." in seen["prompt"] and "Carlos é do jurídico." in seen["prompt"]
    assert "Outra pessoa." not in seen["prompt"]


def test_draft_endpoint_uses_current_draft_as_previous(monkeypatch):
    _thread(draft="Rascunho salvo antigo.")
    seen = _capture(monkeypatch, {"kind": "draft", "text": "Rascunho novo.", "cc_names": []})
    client = TestClient(app)
    instr = '[1] Sobre o trecho do rascunho "segunda-feira": troque por terça'
    r = client.post("/api/threads/t1/draft", json={"instruction": instr, "current_draft": "Texto editado pelo Leo na segunda-feira."})
    assert r.status_code == 200 and r.json()["draft"] == "Rascunho novo."
    assert "Rascunho anterior:\nTexto editado pelo Leo na segunda-feira." in seen["prompt"]
    assert "Rascunho salvo antigo." not in seen["prompt"]
    assert "Sobre o trecho do rascunho" in seen["prompt"]
    assert store.get_thread("t1")["draft"] == "Rascunho novo."

    # sem current_draft (o /mail): continua usando o rascunho salvo
    client.post("/api/threads/t1/draft", json={"instruction": "ajuste"})
    assert "Rascunho anterior:\nRascunho novo." in seen["prompt"]


def test_learned_api_endpoints():
    _thread()
    client = TestClient(app)
    r = client.post("/api/learned", json={"scope": "thread", "text": "Contexto da conversa.", "thread_id": "t1"})
    assert r.status_code == 200 and r.json()["note"]["subject"] == "Roteamento do pix estático"
    client.post("/api/learned", json={"scope": "person", "text": "Sobre Ana.", "person_email": "ana@x.com"})
    client.post("/api/learned", json={"scope": "person", "text": "Sobre outra.", "person_email": "zed@z.com"})

    bad = client.post("/api/learned", json={"scope": "general", "text": "token: abcdef123456"})
    assert bad.status_code == 400 and "segredo" in bad.json()["detail"]

    assert len(client.get("/api/learned").json()["notes"]) == 3
    only = client.get("/api/learned", params={"thread_id": "t1"}).json()["notes"]
    assert {n["text"] for n in only} == {"Contexto da conversa.", "Sobre Ana."}

    nid = only[0]["id"]
    assert client.delete(f"/api/learned/{nid}").status_code == 200
    assert client.delete(f"/api/learned/{nid}").status_code == 404
    assert len(client.get("/api/learned").json()["notes"]) == 2
