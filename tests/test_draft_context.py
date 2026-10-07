from __future__ import annotations

import json

import pytest

from app import assistant, llm, store


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    store.init()
    store.save_settings(rag_enabled=False)
    monkeypatch.setattr(llm, "has_key", lambda: True)


def _thread(chat):
    store.upsert_thread(
        {
            "id": "t1", "subject": "Dados bancários", "from_email": "fin@x.com", "from_name": "Fin",
            "snippet": "", "internal_date": 5, "is_unread": 0, "last_from_me": 0, "is_automatic": 0,
            "is_marketing": 0, "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 1,
            "hidden": 0, "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
        }
    )
    store.save_ai("t1", body_text="De: Fin <fin@x.com>\nData: 2026-09-29\n\nSegue conta 0052-3.",
                  chat_json=json.dumps(chat), chat_anchor_date=5)


def test_previous_instructions_and_answers_reach_the_draft_prompt(monkeypatch):
    _thread(
        [
            {"role": "user", "text": "Essa solicitação tem que ser via chamado direto de alguém da Confrapag."},
            {"role": "ai", "kind": "answer", "text": "Quem deve abrir é o BKO ou o Comercial."},
            {"role": "ai", "text": "texto temporário", "placeholder": True},
        ]
    )
    seen = {}

    def fake_complete(prompt, **kwargs):
        seen["prompt"] = prompt
        return json.dumps({"kind": "draft", "text": "Olá, abra o chamado.", "cc_names": []})

    monkeypatch.setattr(llm, "complete", fake_complete)
    assistant.draft("t1", "crie o e-mail de resposta com essas informações")

    prompt = seen["prompt"]
    assert "via chamado direto de alguém da Confrapag" in prompt
    assert "BKO ou o Comercial" in prompt
    assert "texto temporário" not in prompt
    assert prompt.index("via chamado direto") < prompt.index("Instrução do Leo")


def test_chat_context_keeps_the_most_recent_messages_when_too_long():
    chat = [{"role": "user", "text": f"mensagem {i} " + "x" * 400} for i in range(40)]
    out = assistant._chat_context(chat, max_chars=2000)
    assert "mensagem 39" in out and "mensagem 0 " not in out
    assert len(out) < 2600


def test_bank_data_is_a_hard_exclusion_pattern():
    assert assistant._MONEY_RE.search("Banco do Brasil, agência 0052-3, conta corrente 000100770-X")
    assert assistant._MONEY_RE.search("Nossa chave Pix é o CNPJ")
    assert not assistant._MONEY_RE.search("Reunião de alinhamento do projeto amanhã às 14h")


def test_thread_outline_points_to_latest_message_from_someone_else():
    body = (
        "De: Paulo <paulo@x.com>\nData: 1\ntexto\n\n----\n\n"
        "De: \"Leo\" <leo@confrapag.com.br>\nData: 2\nresposta\n\n----\n\n"
        "De: Eudocio <eudocio@x.com>\nData: 3\npergunta\n"
    )
    out = assistant._thread_outline(body)
    assert "nº 3, de Eudocio" in out
    assert "Leo (já enviada)" in out


def test_thread_outline_skipped_for_single_message():
    assert assistant._thread_outline("De: A <a@x.com>\nData: 1\noi") == ""


def _two_turn_chat():
    return [
        {"role": "user", "text": "diga que vou chamar o Rodrigo da MTBank"},
        {"role": "ai", "kind": "draft", "text": "Paulo,\n\nVou chamar o Rodrigo da MTBank.\n\nAbs"},
    ]


def test_follow_up_sends_history_previous_draft_and_revision_block(monkeypatch):
    _thread(_two_turn_chat())
    prompts = []

    def fake_complete(prompt, **kwargs):
        prompts.append(prompt)
        return json.dumps({"kind": "draft", "text": "Paulo,\n\nVou chamar o Rodrigo. Faz sentido?\n\nAbs"})

    monkeypatch.setattr(llm, "complete", fake_complete)
    out = assistant.draft(
        "t1", "Pergunta se faz sentido fazer isso", current_draft="Paulo,\n\nVou chamar o Rodrigo da MTBank.\n\nAbs"
    )

    assert len(prompts) == 1
    p = prompts[0]
    assert "diga que vou chamar o Rodrigo da MTBank" in p  # turno anterior do chat vai como contexto
    assert "REVISÃO" in p and p.index("REVISÃO") < p.index("Instrução do Leo: Pergunta se faz sentido")
    assert "Rascunho anterior:\nPaulo,\n\nVou chamar o Rodrigo da MTBank." in p
    assert out["draft"].endswith("Faz sentido?\n\nAbs") and out["unchanged"] is False
    users = [m["text"] for m in out["chat"] if m["role"] == "user"]
    assert users == ["diga que vou chamar o Rodrigo da MTBank", "Pergunta se faz sentido fazer isso"]
    assert store.get_thread("t1")["draft"] == out["draft"]


def test_follow_up_retries_once_when_the_ai_returns_the_same_draft(monkeypatch):
    _thread(_two_turn_chat())
    same = "Paulo,\n\nVou chamar o Rodrigo da MTBank.\n\nAbs"
    replies = iter([same, "Paulo,\n\nVou chamar o Rodrigo da MTBank. Faz sentido?\n\nAbs"])
    prompts = []

    def fake_complete(prompt, **kwargs):
        prompts.append(prompt)
        return json.dumps({"kind": "draft", "text": next(replies)})

    monkeypatch.setattr(llm, "complete", fake_complete)
    out = assistant.draft("t1", "Pergunta se faz sentido", current_draft=same)

    assert len(prompts) == 2 and "ATENÇÃO" in prompts[1] and "Pergunta se faz sentido" in prompts[1]
    assert "Faz sentido?" in out["draft"] and out["unchanged"] is False


def test_follow_up_flags_unchanged_when_the_retry_is_still_the_same(monkeypatch):
    _thread(_two_turn_chat())
    same = "Paulo,\n\nVou chamar o Rodrigo da MTBank.\n\nAbs"
    calls = []

    def fake_complete(prompt, **kwargs):
        calls.append(1)
        return json.dumps({"kind": "draft", "text": same + "  "})

    monkeypatch.setattr(llm, "complete", fake_complete)
    out = assistant.draft("t1", "Pergunta se faz sentido", current_draft=same)
    assert len(calls) == 2 and out["unchanged"] is True


def test_first_draft_without_previous_has_no_revision_block_nor_retry(monkeypatch):
    _thread([])
    prompts = []

    def fake_complete(prompt, **kwargs):
        prompts.append(prompt)
        return json.dumps({"kind": "draft", "text": "Olá"})

    monkeypatch.setattr(llm, "complete", fake_complete)
    out = assistant.draft("t1", "responda que sim")
    assert len(prompts) == 1 and "REVISÃO" not in prompts[0] and out["unchanged"] is False
