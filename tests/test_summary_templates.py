from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import assistant, llm, store, summary_templates
from app.main import app


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    store.init()
    store.save_settings(rag_enabled=False)
    monkeypatch.setattr(llm, "has_key", lambda: True)


def _thread():
    store.upsert_thread(
        {
            "id": "t1", "subject": "Prazos", "from_email": "a@x.com", "from_name": "A", "snippet": "",
            "internal_date": 5, "is_unread": 1, "last_from_me": 0, "is_automatic": 0, "is_marketing": 0,
            "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 0, "hidden": 0,
            "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
        }
    )
    store.save_ai("t1", body_text="De: A <a@x.com>\nData: 2026-09-01\n\nPrecisamos fechar o prazo do projeto até sexta.")


def _capture(monkeypatch, resumo):
    seen = {}

    def fake(prompt, **kwargs):
        seen["prompt"], seen["system"] = prompt, kwargs.get("system", "")
        return json.dumps({"resumo": resumo, "acao_leo": True, "sugestao": "", "so_copia": False,
                           "nota_captura": "", "eh_propaganda": False})

    monkeypatch.setattr(llm, "complete", fake)
    return seen


def test_default_template_is_the_current_format(monkeypatch):
    _thread()
    seen = _capture(monkeypatch, "Pedido: fechar prazo.\nFatos:\n- sexta\nDecisão/ação de Leo:\n- responder\nRuído: nenhum")
    assistant.analyze("t1")
    assert "Pedido: uma linha" in seen["system"]
    assert "so_copia=true" in seen["system"]


def test_chosen_template_and_custom_instruction_reach_the_prompt(monkeypatch):
    _thread()
    store.save_settings(summary_template="pessoa", summary_custom="Sempre destaque o tom de quem escreve.")
    seen = _capture(monkeypatch, "Pessoas:\n- A: cobra o prazo, tom firme.\nPra você: responder até sexta.")
    out = assistant.analyze("t1")
    assert "organizado por PESSOA" in seen["system"]
    assert "Sempre destaque o tom de quem escreve." in seen["system"]
    assert "so_copia=true" in seen["system"], "regras de classificação valem pra todos os modelos"
    assert out["summary"].startswith("Pessoas:")


def test_non_default_summary_is_not_discarded_as_badly_formatted(monkeypatch):
    _thread()
    store.save_settings(summary_template="curto")
    _capture(monkeypatch, "Quem pede: A.\nPonto-chave: prazo sexta.\nPra você: responder.")
    out = assistant.analyze("t1")
    assert "Não identificado com segurança" not in out["summary"]
    assert out["summary"].startswith("Quem pede:")


def test_template_catalog_and_validation_through_api():
    client = TestClient(app)
    cat = client.get("/api/summary/templates").json()
    assert {i["key"] for i in cat["items"]} == set(summary_templates.TEMPLATES)
    assert "Pedido:" in cat["headers"] and "Pra você:" in cat["headers"]
    assert client.post("/api/settings", json={"summary_template": "nao-existe"}).status_code == 400
    assert client.post("/api/settings", json={"summary_template": "acao", "summary_custom": "curto"}).status_code == 200
    assert client.get("/api/summary/templates").json()["selected"] == "acao"
