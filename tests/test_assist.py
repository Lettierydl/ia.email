from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app import assist, assistant, config, gmail_client, llm, metrics, rag, store
from app.main import app


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    monkeypatch.setattr(config, "RAG_DB_PATH", tmp_path / "rag.sqlite")
    store.init()
    store.save_settings(rag_enabled=True)
    monkeypatch.setattr(llm, "has_key", lambda: True)
    rag._last_sync = time.time()
    assist._JOB.clear()
    assist._JOB.update({**assist._new_job(0), "running": False})
    # o auxiliar NUNCA pode enviar: qualquer tentativa derruba o teste
    def boom(*a, **k):
        raise AssertionError("o Auxiliar tentou enviar um e-mail")

    monkeypatch.setattr(gmail_client, "send_reply", boom)
    monkeypatch.setattr(gmail_client, "send_new", boom)


def _thread(tid, subject="Prazo do projeto", body=None, unread=1, date=10, marketing=0, auto=0, sender="a@x.com"):
    store.upsert_thread(
        {
            "id": tid, "subject": subject, "from_email": sender, "from_name": "A", "snippet": "",
            "internal_date": date, "is_unread": unread, "last_from_me": 0, "is_automatic": auto,
            "is_marketing": marketing, "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 1,
            "hidden": 0, "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
        }
    )
    store.save_ai(tid, body_text=body or "De: A <a@x.com>\nData: 2026-09-01\n\nQual o status do roteamento do pix estatico?")


def _kb(tmp_path, text="# Decisão\nO pix estático deve ser encerrado com o EC e o roteamento segue a conta da Confrapag."):
    root = tmp_path / "base"
    root.mkdir(exist_ok=True)
    (root / "pix.md").write_text(text)
    store.save_settings(context_global_paths=[str(root)])
    rag.sync()


def _llm(monkeypatch, payload):
    seen = {}

    def fake(prompt, **kw):
        seen["prompt"] = prompt
        return json.dumps(payload)

    monkeypatch.setattr(llm, "complete", fake)
    return seen


def test_suggests_only_when_the_answer_cites_a_real_source(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread("t1")
    seen = _llm(monkeypatch, {"can_answer": True, "confidence": 0.9, "draft_text": "Vamos encerrar o pix estático com o EC.",
                              "based_on": [{"n": 1, "why": "decisão registrada sobre pix estático"}], "missing": "", "question": ""})
    d = assist.decide("t1")
    assert d["action"] == "suggest" and d["status"] == "open"
    assert "[1]" in seen["prompt"] and "pix.md" in seen["prompt"], "os trechos numerados chegam ao modelo"
    item = assist.report()["suggestions"][0]
    assert item["evidence"][0]["title"].startswith("pix.md") and "decisão registrada" in item["evidence"][0]["why"]
    assert item["draft_text"].startswith("Vamos encerrar")


def test_confident_answer_without_a_cited_source_is_held_back(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread("t1")
    _llm(monkeypatch, {"can_answer": True, "confidence": 0.95, "draft_text": "Pode seguir, está aprovado.", "based_on": []})
    d = assist.decide("t1")
    assert d["action"] == "needs_context" and d["draft_text"] == ""
    assert "não apontou nenhuma base" in d["reasoning"]


def test_invented_citation_numbers_do_not_count_as_evidence(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread("t1")
    _llm(monkeypatch, {"can_answer": True, "confidence": 0.9, "draft_text": "ok", "based_on": [{"n": 99, "why": "x"}]})
    assert assist.decide("t1")["action"] == "needs_context"


def test_low_confidence_is_not_suggested(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread("t1")
    _llm(monkeypatch, {"can_answer": True, "confidence": 0.2, "draft_text": "talvez", "based_on": [{"n": 1, "why": "ligação fraca"}]})
    assert assist.decide("t1")["action"] == "needs_context"


def test_missing_context_reports_what_is_missing_and_the_question(tmp_path, monkeypatch):
    _thread("t1", subject="Contrato novo", body="De: B <b@x.com>\nData: 2026-09-01\n\nPodemos fechar nas condições X?")
    _llm(monkeypatch, {"can_answer": False, "confidence": 0.1, "missing": "Não há decisão anterior sobre condições X.",
                       "question": "Você aceita as condições X?"})
    d = assist.decide("t1")
    assert d["action"] == "needs_context"
    item = assist.report()["gaps"][0]
    assert "decisão anterior" in item["reasoning"] and item["question"] == "Você aceita as condições X?"


def test_sensitive_topics_still_get_a_draft_but_are_flagged(tmp_path, monkeypatch):
    _kb(tmp_path, "# Regra\npagamento acima de mil exige aprovação do financeiro")
    _thread("t1", subject="Pagamento do boleto", body="De: A <a@x.com>\nData: 2026-09-01\n\nPrecisamos pagar o boleto de R$ 1.200 hoje.")
    _llm(monkeypatch, {"can_answer": True, "confidence": 0.8, "draft_text": "Vou validar com o financeiro.",
                       "based_on": [{"n": 1, "why": "regra de aprovação"}]})
    assert assist.decide("t1")["action"] == "suggest"
    assert assist.report()["suggestions"][0]["sensitive"] is True


def test_emails_with_credentials_are_never_drafted(tmp_path, monkeypatch):
    _thread("t1", body="De: A <a@x.com>\nData: 2026-09-01\n\nSeu acesso: senha: Abc12345")
    called = []
    monkeypatch.setattr(llm, "complete", lambda *a, **k: called.append(1) or "{}")
    d = assist.decide("t1")
    assert d["action"] == "needs_context" and called == [], "nem chamou a IA"
    assert "credencial" in d["reasoning"]


def test_candidates_skip_marketing_automatic_read_and_already_analyzed(tmp_path, monkeypatch):
    _thread("novo", date=50)
    _thread("lido", unread=0, date=40)
    _thread("promo", marketing=1, date=30)
    _thread("auto", auto=1, date=20)
    _thread("ja", date=10)
    store.create_autopilot_decision(thread_id="ja", action="suggest", status="open", internal_date_snapshot=10,
                                    confidence=0.9, reasoning="", draft_text="x", cc="", sensitivity_level="auxiliar")
    assert assist.candidates(10) == ["novo"]
    store.upsert_thread({**store.get_thread("ja"), "internal_date": 99})  # chegou mensagem nova
    assert set(assist.candidates(10)) == {"novo", "ja"}
    assert assist.candidates(10, force=True)[0] == "ja"


def test_batch_job_reports_progress_and_never_sends(tmp_path, monkeypatch):
    _kb(tmp_path)
    for i in range(3):
        _thread(f"t{i}", date=10 + i)
    answers = iter(
        [
            {"can_answer": True, "confidence": 0.9, "draft_text": "a", "based_on": [{"n": 1, "why": "x"}]},
            {"can_answer": False, "missing": "falta contexto"},
            {"can_answer": True, "confidence": 0.9, "draft_text": "c", "based_on": []},
        ]
    )
    monkeypatch.setattr(llm, "complete", lambda *a, **k: json.dumps(next(answers)))
    st = assist.start(limit=5)
    assert st["total"] == 3
    deadline = time.time() + 10
    while assist.status()["running"] and time.time() < deadline:
        time.sleep(0.05)
    st = assist.status()
    assert (st["done"], st["suggested"], st["gaps"], st["errors"]) == (3, 1, 2, 0)
    assert st["running"] is False and st["finished_at"]


def test_a_failing_email_does_not_stop_the_batch(tmp_path, monkeypatch):
    _thread("t1", date=2)
    _thread("t2", date=1)
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("fora do ar")
        return json.dumps({"can_answer": False, "missing": "sem contexto"})

    monkeypatch.setattr(llm, "complete", flaky)
    assist.start(limit=5)
    deadline = time.time() + 10
    while assist.status()["running"] and time.time() < deadline:
        time.sleep(0.05)
    st = assist.status()
    assert (st["done"], st["errors"], st["gaps"]) == (2, 1, 1)


def test_use_puts_the_draft_and_its_basis_in_the_thread_without_sending(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread("t1")
    _llm(monkeypatch, {"can_answer": True, "confidence": 0.9, "draft_text": "Vamos encerrar com o EC.",
                       "based_on": [{"n": 1, "why": "decisão registrada"}]})
    d = assist.decide("t1")
    out = assist.use(d["id"])
    assert out == {"thread_id": "t1"}
    row = store.get_thread("t1")
    assert row["draft"] == "Vamos encerrar com o EC."
    chat = json.loads(row["chat_json"])
    assert chat[-1] == {"role": "ai", "text": "Vamos encerrar com o EC.", "kind": "draft"}
    assert chat[0]["kind"] == "answer" and "Como cheguei" in chat[0]["text"] and "pix.md" in chat[0]["text"]
    assert store.get_autopilot_decision(d["id"])["status"] == "used"
    assert row["sent_via_app_at"] is None
    with pytest.raises(RuntimeError, match="já foi tratada"):
        assist.use(d["id"])


def test_dismiss_and_gap_cannot_be_used_as_a_draft(tmp_path, monkeypatch):
    _thread("t1")
    _llm(monkeypatch, {"can_answer": False, "missing": "falta contexto"})
    d = assist.decide("t1")
    with pytest.raises(RuntimeError, match="Só dá pra usar"):
        assist.use(d["id"])
    assist.dismiss(d["id"])
    assert assist.report() == {"suggestions": [], "gaps": [], "no_reply": []}


def test_assistant_mode_makes_the_pilot_tick_a_no_op_and_decisions_do_not_count_as_alerts(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread("t1")
    store.save_settings(autopilot_enabled=True, autopilot_mode="auxiliar", autopilot_level="autonomo")
    out = assistant.run_autopilot_scan_tick()
    assert out["decided"] == 0 and out["dispatched"] == [] and store.list_autopilot_decisions() == []
    _llm(monkeypatch, {"can_answer": True, "confidence": 0.9, "draft_text": "x", "based_on": [{"n": 1, "why": "y"}]})
    assist.decide("t1")
    ap = metrics.compute(7)["autopilot"]
    assert ap["alerts"] == 0 and ap["decisions"] == 0, "decisão do auxiliar não conta como alerta do piloto"
    assert ap["assist"] == {"suggested": 1, "used": 0, "gaps": 0}
    # e o piloto continua enxergando a thread como "ainda sem decisão"
    assert store.recent_decision_for_thread("t1") is None


def test_endpoints_and_mode_validation(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread("t1")
    client = TestClient(app)
    assert client.post("/api/settings", json={"autopilot_mode": "x"}).status_code == 400
    assert client.post("/api/settings", json={"autopilot_mode": "auxiliar"}).status_code == 200
    _llm(monkeypatch, {"can_answer": True, "confidence": 0.9, "draft_text": "ok", "based_on": [{"n": 1, "why": "y"}]})
    assert client.post("/api/assistant/run?limit=5").json()["total"] == 1
    deadline = time.time() + 10
    while client.get("/api/assistant/status").json()["running"] and time.time() < deadline:
        time.sleep(0.05)
    rep = client.get("/api/assistant/report").json()
    assert len(rep["suggestions"]) == 1
    did = rep["suggestions"][0]["id"]
    assert client.post(f"/api/assistant/{did}/use").json() == {"thread_id": "t1"}
    assert client.post(f"/api/assistant/{did}/use").status_code == 400
    assert client.post("/api/assistant/nao-existe/dismiss").status_code == 400


def test_informational_email_goes_to_no_reply_not_to_missing_context(tmp_path, monkeypatch):
    _thread("t1", subject="Ata da reunião", body="De: C <c@x.com>\nData: 2026-09-01\n\nSegue a ata da reunião de hoje para registro.")
    _llm(monkeypatch, {"needs_reply": False, "can_answer": False, "confidence": 0.9, "missing": "É só uma ata compartilhada, sem pedido."})
    d = assist.decide("t1")
    assert d["action"] == "no_reply"
    rep = assist.report()
    assert [i["subject"] for i in rep["no_reply"]] == ["Ata da reunião"] and rep["gaps"] == [] and rep["suggestions"] == []
    assert metrics.compute(7)["autopilot"]["alerts"] == 0 and metrics.compute(7)["autopilot"]["assist"]["gaps"] == 0
    assert assist.candidates(10) == [], "não reanalisa o que já foi classificado"


def test_needs_reply_false_is_ignored_if_the_model_also_claims_it_can_answer(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread("t1")
    _llm(monkeypatch, {"needs_reply": False, "can_answer": True, "confidence": 0.9, "draft_text": "ok",
                       "based_on": [{"n": 1, "why": "x"}]})
    assert assist.decide("t1")["action"] == "suggest"


def test_empty_email_body_is_reported_without_calling_the_model(tmp_path, monkeypatch):
    _thread("t1", body="De: D <d@x.com>\nData: 2026-09-01\n\n  ")
    called = []
    monkeypatch.setattr(llm, "complete", lambda *a, **k: called.append(1) or "{}")
    d = assist.decide("t1")
    assert d["action"] == "needs_context" and called == []
    assert "Não consegui ler" in d["reasoning"]


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Conforme decisão de set/2026 (trecho [6]), a TI não abre.", "Conforme decisão de set/2026, a TI não abre."),
        ("Conforme combinado [1], seguimos.", "Conforme combinado, seguimos."),
        ("Isso vale (trechos 2 e 3) para todos.", "Isso vale para todos."),
        ("Segue a lista [1, 2] atualizada.", "Segue a lista atualizada."),
        ("Texto normal sem marcadores.", "Texto normal sem marcadores."),
        ("Reunião [online] às 15h.", "Reunião [online] às 15h."),
    ],
)
def test_internal_citation_markers_never_reach_the_draft(raw, expected):
    assert assist.clean_draft(raw) == expected


def test_draft_saved_by_the_assistant_has_no_internal_markers(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread("t1")
    _llm(monkeypatch, {"can_answer": True, "confidence": 0.9, "draft_text": "Conforme a decisão (trecho [1]), vamos encerrar.",
                       "based_on": [{"n": 1, "why": "decisão"}]})
    d = assist.decide("t1")
    assert "trecho" not in d["draft_text"] and "[1]" not in d["draft_text"]
    assert d["draft_text"] == "Conforme a decisão, vamos encerrar."
