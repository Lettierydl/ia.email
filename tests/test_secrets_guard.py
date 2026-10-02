from __future__ import annotations

import json

import pytest

from app import assistant, config, llm, rag, secrets_guard, store


@pytest.mark.parametrize(
    "text",
    [
        "Credenciais Staging: usuário joao.teste / senha 654321 (Lojista Teste)",  # o caso real que vazou
        "senha: Abc12345",
        "password=hunter2xyz",
        "api key: sk-abcdefghijklmnop1234",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
        "-----BEGIN RSA PRIVATE KEY-----",
        "token = ghp_abcdefghijklmnopqrstuvwxyz",
    ],
)
def test_detects_credentials(text):
    assert secrets_guard.looks_like_secret(text)


@pytest.mark.parametrize(
    "text",
    [
        "Precisamos redefinir a senha para o usuário novo",
        "O token de acesso expira em 1 hora, conforme a política",
        "Reunião sobre segurança e gestão de senhas na terça",
        "Decisão: manteremos o roteamento do F6-C",
        "",
        None,
    ],
)
def test_does_not_flag_normal_text_about_passwords(text):
    assert not secrets_guard.looks_like_secret(text)


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    monkeypatch.setattr(config, "RAG_DB_PATH", tmp_path / "rag.sqlite")
    store.init()
    store.save_settings(rag_enabled=False)
    return tmp_path


def _thread(thread_id="t1", body="De: A <a@x.com>\nData: 2026-09-01\n\nOlá, segue o pedido normal."):
    store.upsert_thread(
        {
            "id": thread_id, "subject": "Acesso", "from_email": "a@x.com", "from_name": "A", "snippet": "",
            "internal_date": 5, "is_unread": 1, "last_from_me": 0, "is_automatic": 0, "is_marketing": 0,
            "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 1, "hidden": 0,
            "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
        }
    )
    store.save_ai(thread_id, body_text=body)


def test_capture_note_with_credentials_is_never_offered(isolated, monkeypatch):
    _thread()
    monkeypatch.setattr(llm, "has_key", lambda: True)
    monkeypatch.setattr(
        llm,
        "complete",
        lambda *a, **k: json.dumps(
            {"resumo": "Pedido: x.\nFatos:\n- y\nDecisão/ação de Leo:\n- z\nRuído: nenhum",
             "acao_leo": False, "sugestao": "", "so_copia": False,
             "nota_captura": "Credenciais de homologação: usuário joao / senha 654321", "eh_propaganda": False}
        ),
    )
    out = assistant.analyze("t1")
    assert out["capture_note"] == "" and out["capture_status"] is None


def test_approving_an_old_pending_note_with_credentials_is_refused(isolated, tmp_path, monkeypatch):
    _thread()
    store.save_ai("t1", capture_note="usuário joao / senha 654321", capture_status="pending")
    written = []
    monkeypatch.setattr(assistant, "_pick_destination", lambda *a: written.append("escolheu destino") or ("x", {}))
    with pytest.raises(RuntimeError, match="senha ou credencial"):
        assistant.approve_capture("t1")
    assert written == [], "nem chegou a escolher um destino para gravar"
    assert store.get_thread("t1")["capture_status"] == "dismissed"


def test_rag_never_indexes_chunks_that_look_like_secrets(isolated, monkeypatch):
    root = isolated / "base"
    root.mkdir()
    (root / "acesso.md").write_text(
        "# Acessos\nProcesso normal de acesso ao ambiente.\n\n## Homologação\nusuário joao / senha 654321\n"
    )
    store.save_settings(context_global_paths=[str(root)])
    _thread("t2", "De: B <b@x.com>\nData: 2026-09-02\n\nSeu login: maria, password: Zx9q8w7e6r")
    rag.sync()
    assert rag.search("usuario joao senha 654321") == []
    assert rag.search("password Zx9q8w7e6r") == []
    assert rag.search("processo normal de acesso ao ambiente"), "o resto do arquivo continua pesquisável"


def test_autopilot_never_auto_replies_to_an_email_with_credentials(isolated):
    _thread("t3")
    row = store.get_thread("t3")
    store.upsert_thread({**row, "id": "t3-older"})  # remetente já conhecido
    reason = assistant._hard_exclusions(row, "meu acesso: senha: Abc12345", "")
    assert reason and "credencial" in reason
