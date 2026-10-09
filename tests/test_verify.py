"""Verificador ("Verificar na caixa"): IA e Gmail sempre falsos.

O serviço do Gmail é um MagicMock: qualquer chamada fica registrada, e os
testes conferem que só houve messages.list/get (nunca modify/send/trash/labels).
"""
from __future__ import annotations

import json
import time
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app import config, copilot, gmail_client, llm, rag, store, verify
from app.main import app

ME = config.ACCOUNT
BODY = (
    "De: Ana Souza <ana@x.com>\nData: Mon, 6 Oct 2026 10:00:00 -0300\n\n"
    "Leo, te mandei no dia 03/10 o e-mail com o link de acesso ao portal. Confere aí?"
)

EXTRACT = {
    "afirmacoes": [
        {"texto": "Você recebeu de Ana um e-mail com o link de acesso por volta de 03/10",
         "consultas": ["from:ana@x.com after:2026/10/01 before:2026/10/06 in:anywhere label:segredo",
                       "acesso portal in:anywhere {x}"]},
        {"texto": "Ana mandou um anexo com o contrato", "consultas": ["from:ana@x.com has:attachment contrato"]},
    ]
}
JUDGE = {
    "avaliacoes": [
        {"n": 1, "veredito": "confirmado", "explicacao": "Ana mandou o link em 03/10.", "evidencias": ["E1", "E99"]},
        {"n": 2, "veredito": "nao_encontrado", "explicacao": "Nenhum anexo de Ana.", "evidencias": []},
    ]
}

HITS = {
    "from:ana@x.com after:2026/10/01 before:2026/10/06 in:anywhere": [
        {"id": "m1", "threadId": "t-link", "internalDate": "1",
         "snippet": "Segue o link de acesso ao portal &amp; instru&ccedil;&otilde;es",
         "labelIds": ["INBOX"],
         "payload": {"headers": [{"name": "From", "value": "Ana Souza <ana@x.com>"}, {"name": "Subject", "value": "Link de acesso"},
                                 {"name": "Date", "value": "Fri, 3 Oct 2026 09:00:00 -0300"}, {"name": "To", "value": ME}]}},
    ],
    "acesso portal in:anywhere": [
        {"id": "m2", "threadId": "t-old", "internalDate": "1", "snippet": "usuário leo senha: Abc12345", "labelIds": ["SPAM"],
         "payload": {"headers": [{"name": "From", "value": "noreply@portal.com"}, {"name": "Subject", "value": "Acesso"}]}},
    ],
    "from:ana@x.com has:attachment contrato": [],
}
# a mesma mensagem achada por duas consultas
HITS["acesso portal in:anywhere"].insert(0, HITS["from:ana@x.com after:2026/10/01 before:2026/10/06 in:anywhere"][0])


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    monkeypatch.setattr(config, "RAG_DB_PATH", tmp_path / "rag.sqlite")
    store.init()
    monkeypatch.setattr(llm, "has_key", lambda: True)
    rag._last_sync = time.time()

    def boom(*a, **k):
        raise AssertionError("o Verificador tentou enviar/ler pelo caminho errado")

    monkeypatch.setattr(gmail_client, "send_reply", boom)
    monkeypatch.setattr(gmail_client, "send_new", boom)
    monkeypatch.setattr(gmail_client, "get_thread_text", boom)
    monkeypatch.setattr(gmail_client, "mark_threads_read", boom)


def _thread(tid="t1", *, date=10, body=BODY):
    store.upsert_thread({
        "id": tid, "subject": "Acesso ao portal", "from_email": "ana@x.com", "from_name": "Ana Souza",
        "snippet": "link de acesso", "internal_date": date, "is_unread": 1, "last_from_me": 0, "is_automatic": 0,
        "is_marketing": 0, "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 1, "hidden": 0,
        "hide_as_replied": 0, "last_from_header": "Ana Souza <ana@x.com>", "labels_json": [], "to_header": ME, "cc_header": "",
    })
    store.save_ai(tid, body_text=body)


def _gmail(monkeypatch, hits=HITS, fail=False):
    """Serviço do Gmail falso (MagicMock) -> devolve o serviço para inspecionar."""
    service = MagicMock(name="gmail")
    messages = service.users.return_value.messages.return_value
    by_id = {h["id"]: h for lst in hits.values() for h in lst}

    def list_(userId, q, maxResults):
        req = MagicMock()
        if fail:
            req.execute.side_effect = RuntimeError("503 backend")
        else:
            req.execute.return_value = {"messages": [{"id": h["id"], "threadId": h["threadId"]} for h in hits.get(q, [])]}
        return req

    def get_(userId, id, format, metadataHeaders):
        assert format == "metadata"
        req = MagicMock()
        req.execute.return_value = by_id[id]
        return req

    messages.list.side_effect = list_
    messages.get.side_effect = get_
    monkeypatch.setattr(gmail_client, "load_credentials", lambda: object())
    monkeypatch.setattr(gmail_client, "_service", lambda creds: service)
    return service


def _llm(monkeypatch, *payloads):
    calls = []

    def fake(prompt, **kw):
        calls.append(prompt)
        return json.dumps(payloads[min(len(calls), len(payloads)) - 1])

    monkeypatch.setattr(llm, "complete", fake)
    return calls


def _assert_read_only(service):
    names = [c[0] for c in service.mock_calls]
    forbidden = ("modify", "batchModify", "send", "trash", "untrash", "delete", "insert", "import_", "labels", "drafts")
    bad = [n for n in names if any(f"{f}(" in n + "(" or f".{f}" in n for f in forbidden)]
    assert not bad, f"chamada proibida no Gmail: {bad}"
    called = {n.split(".")[-1] for n in names if not n.endswith("execute") and "()" not in n.split(".")[-1]}
    assert called <= {"users", "messages", "list", "get"}, called


# ── consulta saneada ──
@pytest.mark.parametrize("raw,clean", [
    ("from:ana@x.com after:2026-10-1 before:2026/10/08 in:anywhere", "from:ana@x.com after:2026/10/01 before:2026/10/08 in:anywhere"),
    ("label:foo deliveredto:x@y.com {a b} (link) acesso", "link acesso"),
    ('subject:"Link de acesso!" has:attachment -in:spam OR', 'subject:"Link de acesso" has:attachment -in:spam'),
    ("OR in:everything has:virus older_than:2w after:2026/13/01", ""),
    ('from:"Ana Souza" boleto OR fatura', 'from:"Ana Souza" boleto OR fatura'),
    ("in:sent to:ana@x.com newer_than:14d", "in:sent to:ana@x.com newer_than:14d"),
])
def test_sanitize_query(raw, clean):
    assert verify.sanitize_query(raw) == clean


def test_sanitize_query_limita_tamanho():
    assert len(verify.sanitize_query("palavra " * 200)) <= verify.MAX_QUERY_LEN


# ── fluxo: extrai -> consulta -> veredito ──
def test_verificar_extrai_consulta_e_avalia(monkeypatch):
    _thread()
    _thread("t-link", date=5, body="De: Ana <ana@x.com>\nData: x\n\nSegue o link.")
    service = _gmail(monkeypatch)
    calls = _llm(monkeypatch, EXTRACT, JUDGE)
    out = TestClient(app).post("/api/copilot/t1/verificar", json={}).json()
    assert len(calls) == 2 and out["cached"] is False and out["gerado_em"]
    assert "link de acesso ao portal" in calls[0]  # a IA leu a thread

    a1, a2 = out["afirmacoes"]
    assert a1["veredito"] == "confirmado" and a1["veredito_label"] == "Confirmado"
    assert a1["explicacao"] == "Ana mandou o link em 03/10."
    # consultas saneadas (label: e {x} caíram) e contadas
    assert [c["q"] for c in a1["consultas"]] == ["from:ana@x.com after:2026/10/01 before:2026/10/06 in:anywhere", "acesso portal in:anywhere"]
    assert [c["resultados"] for c in a1["consultas"]] == [1, 2]
    # só a evidência citada e existente (E99 é inventada pela IA)
    assert [e["message_id"] for e in a1["evidencias"]] == ["m1"]
    ev = a1["evidencias"][0]
    assert ev["assunto"] == "Link de acesso" and ev["de"] == "Ana Souza <ana@x.com>" and ev["thread_id"] == "t-link"
    assert ev["snippet"] == "Segue o link de acesso ao portal & instruções"
    assert ev["gmail_url"].startswith("https://mail.google.com/mail/?authuser=") and ev["gmail_url"].endswith("#all/t-link")
    assert ev["app_url"] == "/copilot/t-link" and ev["pasta"] == "Caixa de entrada"
    assert a2["veredito"] == "nao_encontrado" and a2["evidencias"] == []

    # a mensagem achada por duas consultas vira uma evidência só; a senha não vai para a IA
    assert calls[1].count("[E1] De:") == 2 and "[E2] De:" in calls[1]
    assert "Abc12345" not in calls[1] and "senha ou credencial" in calls[1]
    _assert_read_only(service)
    msgs = service.users.return_value.messages.return_value
    assert msgs.list.call_count == 3 and msgs.get.call_count == 3
    assert not msgs.modify.called and not msgs.send.called and not msgs.trash.called and not msgs.batchModify.called


def test_evidencia_fora_do_radar_sem_app_url(monkeypatch):
    _thread()
    _gmail(monkeypatch)
    _llm(monkeypatch, EXTRACT, JUDGE)
    out = verify.verificar("t1")
    assert out["afirmacoes"][0]["evidencias"][0]["app_url"] == ""  # t-link não está no store


def test_veredito_invalido_cai_no_padrao(monkeypatch):
    _thread()
    _gmail(monkeypatch)
    _llm(monkeypatch, EXTRACT, {"avaliacoes": [{"n": 1, "veredito": "talvez"}]})
    a1, a2 = verify.verificar("t1")["afirmacoes"]
    assert a1["veredito"] == "inconclusivo" and a1["evidencias"]  # achou algo, sem conclusão
    assert a2["veredito"] == "nao_encontrado" and "não acharam" in a2["explicacao"]


def test_sem_resultados_nao_chama_ia_para_avaliar(monkeypatch):
    _thread()
    _gmail(monkeypatch, hits={})
    calls = _llm(monkeypatch, EXTRACT)
    out = verify.verificar("t1")
    assert len(calls) == 1
    assert {a["veredito"] for a in out["afirmacoes"]} == {"nao_encontrado"}


def test_sem_afirmacoes_avisa(monkeypatch):
    _thread()
    service = _gmail(monkeypatch)
    _llm(monkeypatch, {"afirmacoes": []})
    out = verify.verificar("t1")
    assert out["afirmacoes"] == [] and "nenhuma afirmação" in out["aviso"]
    assert not service.mock_calls


def test_limites_de_afirmacoes_e_consultas(monkeypatch):
    _thread()
    _gmail(monkeypatch, hits={})
    many = {"afirmacoes": [{"texto": f"Afirmação {i}", "consultas": [f"palavra{j} in:anywhere" for j in range(6)]} for i in range(10)]}
    _llm(monkeypatch, many)
    out = verify.verificar("t1")
    assert len(out["afirmacoes"]) == verify.MAX_AFIRMACOES
    assert all(len(a["consultas"]) == verify.MAX_CONSULTAS for a in out["afirmacoes"])


# ── cache e regerar ──
def test_cache_get_e_post(monkeypatch):
    _thread()
    _gmail(monkeypatch)
    calls = _llm(monkeypatch, EXTRACT, JUDGE)
    client = TestClient(app)
    assert client.get("/api/copilot/t1/verificar").json()["afirmacoes"] is None  # GET nunca gera
    assert calls == []
    first = client.post("/api/copilot/t1/verificar").json()
    again = client.post("/api/copilot/t1/verificar", json={}).json()
    cached = client.get("/api/copilot/t1/verificar").json()
    assert len(calls) == 2
    assert again["cached"] is True and again["afirmacoes"] == first["afirmacoes"]
    assert cached["cached"] is True and cached["gerado_em"] == first["gerado_em"] and cached["desatualizado"] is False


def test_regerar_refaz(monkeypatch):
    _thread()
    _gmail(monkeypatch)
    calls = _llm(monkeypatch, EXTRACT, JUDGE, EXTRACT, JUDGE)
    client = TestClient(app)
    client.post("/api/copilot/t1/verificar")
    out = client.post("/api/copilot/t1/verificar", json={"regerar": True}).json()
    assert out["cached"] is False and len(calls) == 4


def test_mensagem_nova_invalida_cache(monkeypatch):
    _thread()
    _gmail(monkeypatch)
    calls = _llm(monkeypatch, EXTRACT, JUDGE, EXTRACT, JUDGE)
    verify.verificar("t1")
    _thread(date=20, body=BODY + "\n\n----\n\nDe: Ana Souza <ana@x.com>\nData: x\n\nLeo, achou?")
    assert TestClient(app).get("/api/copilot/t1/verificar").json()["desatualizado"] is True
    out = verify.verificar("t1")
    assert out["cached"] is False and len(calls) == 4
    assert store.get_copilot_verificacao("t1")["msg_count_snapshot"] == 2


# ── erros amigáveis ──
def test_sem_chave_de_ia(monkeypatch):
    _thread()
    _gmail(monkeypatch)
    monkeypatch.setattr(llm, "has_key", lambda: False)
    r = TestClient(app).post("/api/copilot/t1/verificar")
    assert r.status_code == 400 and "chave de IA" in r.json()["detail"]


def test_sem_gmail(monkeypatch):
    _thread()
    monkeypatch.setattr(gmail_client, "load_credentials", lambda: None)
    _llm(monkeypatch, EXTRACT)
    r = TestClient(app).post("/api/copilot/t1/verificar")
    assert r.status_code == 400 and "Gmail não está conectado" in r.json()["detail"]


def test_credencial_na_thread_nao_vai_para_ia(monkeypatch):
    _thread(body="De: Ana <ana@x.com>\nData: x\n\nLeo, seu acesso: usuário leo, senha: Xyz98765 — confirma que recebeu?")
    service = _gmail(monkeypatch)
    calls = _llm(monkeypatch, EXTRACT)
    r = TestClient(app).post("/api/copilot/t1/verificar")
    assert r.status_code == 400 and "credencial" in r.json()["detail"]
    assert calls == [] and not service.mock_calls


def test_gmail_fora_do_ar(monkeypatch):
    _thread()
    _gmail(monkeypatch, fail=True)
    _llm(monkeypatch, EXTRACT, JUDGE)
    monkeypatch.setattr(gmail_client, "_execute", lambda req, attempts=6: req.execute())
    r = TestClient(app).post("/api/copilot/t1/verificar")
    assert r.status_code == 400 and "Gmail não respondeu" in r.json()["detail"]
    assert store.get_copilot_verificacao("t1") is None


def test_thread_inexistente():
    assert TestClient(app).get("/api/copilot/nada/verificar").status_code == 404
    assert TestClient(app).post("/api/copilot/nada/verificar").status_code == 404


def test_cli_consulta_so_saneia_sem_gmail(monkeypatch, capsys):
    from app import verify_cli

    service = _gmail(monkeypatch, hits={"acesso in:anywhere": HITS["acesso portal in:anywhere"][:1]})
    assert verify_cli.main(["--consulta", "acesso label:x in:anywhere"]) == 0
    out = capsys.readouterr().out
    assert "'acesso in:anywhere'" in out and "Link de acesso" in out
    _assert_read_only(service)


def test_front_tem_botao_e_rota():
    js = (config.ROOT / "static" / "copilot.js").read_text(encoding="utf-8")
    assert "Verificar na caixa" in js and "/verificar" in js
