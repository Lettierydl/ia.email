from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import assistant, llm, store
from app.main import app

DRAFT = "Olá Ana,\n\nObrigado pela proposta. Podemos fechar em 30 dias, combinado?\n\nAbraço,\nLeo"
PASSAGE = "Podemos fechar em 30 dias, combinado?"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    store.init()
    store.save_settings(rag_enabled=False)
    monkeypatch.setattr(llm, "has_key", lambda: True)
    store.upsert_thread(
        {
            "id": "t1", "subject": "Proposta CAF", "from_email": "ana@x.com", "from_name": "Ana",
            "snippet": "", "internal_date": 5, "is_unread": 0, "last_from_me": 0, "is_automatic": 0,
            "is_marketing": 0, "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 1,
            "hidden": 0, "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
        }
    )
    store.save_ai("t1", body_text="De: Ana <ana@x.com>\nData: 2026-10-06\n\nSegue a proposta, prazo 30 dias.", draft="SALVO")


def _fake(seen, answer):
    def fake_complete(prompt, **kwargs):
        seen["prompt"] = prompt
        seen["calls"] = seen.get("calls", 0) + 1
        return answer

    return fake_complete


def _post(client, **over):
    start = DRAFT.index(PASSAGE)
    body = {"draft": DRAFT, "start": start, "end": start + len(PASSAGE), "passage": PASSAGE, "instruction": "mais firme"}
    body.update(over)
    return client.post("/api/threads/t1/rewrite-passage", json=body)


def test_only_the_passage_changes(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(llm, "complete", _fake(seen, '"Fechamos em 30 dias."'))
    r = _post(TestClient(app))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data == {"replacement": "Fechamos em 30 dias."}  # sem aspas, só o trecho
    start = DRAFT.index(PASSAGE)
    new = DRAFT[:start] + data["replacement"] + DRAFT[start + len(PASSAGE):]
    assert new.startswith(DRAFT[:start]) and new.endswith(DRAFT[start + len(PASSAGE):])
    assert new == "Olá Ana,\n\nObrigado pela proposta. Fechamos em 30 dias.\n\nAbraço,\nLeo"
    # não regera nem mexe no rascunho salvo / chat
    row = store.get_thread("t1")
    assert row["draft"] == "SALVO"
    assert seen["calls"] == 1


def test_divergent_passage_is_400(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(llm, "complete", _fake(seen, "x"))
    client = TestClient(app)
    assert _post(client, passage="Outro texto qualquer que nao bate").status_code == 400
    assert _post(client, start=0, end=5).status_code == 400  # "Olá A" != PASSAGE
    assert _post(client, start=10, end=9999).status_code == 400
    assert "calls" not in seen  # nem chamou a IA


def test_empty_instruction_uses_default_and_prompt_has_context(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(llm, "complete", _fake(seen, "```\nFechamos em 30 dias?\n```"))
    r = _post(TestClient(app), instruction="  ")
    assert r.status_code == 200, r.text
    assert r.json()["replacement"] == "Fechamos em 30 dias?"
    prompt = seen["prompt"]
    assert assistant.REWRITE_DEFAULT_INSTRUCTION in prompt
    assert PASSAGE in prompt
    assert "Obrigado pela proposta." in prompt and "Abraço,\nLeo" in prompt  # rascunho inteiro
    assert "Segue a proposta, prazo 30 dias." in prompt  # thread
    assert "Estilo de escrita pedido" in prompt  # estilo do Leo, como no draft()


def test_prompt_has_instruction_and_marked_draft(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(llm, "complete", _fake(seen, "Fechamos em 30 dias."))
    assert _post(TestClient(app), instruction="mais firme").status_code == 200
    prompt = seen["prompt"]
    assert "Instrução do Leo para o trecho: mais firme" in prompt
    assert f"⟦{PASSAGE}⟧" in prompt


def test_secret_in_replacement_is_refused(monkeypatch):
    monkeypatch.setattr(llm, "complete", _fake({}, "Senha: abc12345 e fechamos."))
    r = _post(TestClient(app))
    assert r.status_code == 400
    assert "senha" in r.json()["detail"].lower()


def test_clean_replacement_keeps_edge_whitespace():
    assert assistant._clean_replacement("“Novo.”", " velho. ") == " Novo. "
    assert assistant._clean_replacement("Trecho reescrito: Novo", "velho") == "Novo"
