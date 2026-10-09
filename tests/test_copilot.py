from __future__ import annotations

import json
import sqlite3
import time
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app import assistant, config, copilot, gmail_client, llm, rag, store
from app.main import app

ME = config.ACCOUNT
BODY = (
    "De: Ana Souza <ana@x.com>\nData: 2026-10-01\n\n"
    "Leo, você pode validar o roteamento do pix estático até 10/10? Precisamos fechar com o EC."
)


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    monkeypatch.setattr(config, "RAG_DB_PATH", tmp_path / "rag.sqlite")
    store.init()
    monkeypatch.setattr(llm, "has_key", lambda: True)
    monkeypatch.setattr(copilot, "_save_analysis_to_learning_base", lambda *a, **k: None)
    rag._last_sync = time.time()

    # o copiloto NUNCA pode enviar: qualquer tentativa derruba o teste
    def boom(*a, **k):
        raise AssertionError("o Copiloto tentou enviar um e-mail")

    monkeypatch.setattr(gmail_client, "send_reply", boom)
    monkeypatch.setattr(gmail_client, "send_new", boom)
    monkeypatch.setattr(gmail_client, "get_thread_text", boom)
    # lote automático desligado por padrão nos testes (rodaria LLM de verdade em segundo plano)
    monkeypatch.setattr(copilot, "AUTO_BATCH", False)
    monkeypatch.setattr(copilot, "_TRIED", {})
    monkeypatch.setattr(copilot, "_FAILED", {})
    copilot._JOB.update(running=False, pending=[], current_id="")


def _thread(tid="t1", *, to=ME, cc="", body=BODY, last_from_me=0, marketing=0, date=10, sender="ana@x.com", hint=0, unread=1):
    store.upsert_thread(
        {
            "id": tid, "subject": "Roteamento do pix estático", "from_email": sender, "from_name": "Ana Souza",
            "snippet": "Leo, você pode validar o roteamento?", "internal_date": date, "is_unread": unread,
            "last_from_me": last_from_me, "is_automatic": 0, "is_marketing": marketing, "needs_action_hint": hint,
            "awaiting_reply": 0, "conferido": 1, "hidden": 0, "hide_as_replied": 0,
            "last_from_header": f"Ana Souza <{sender}>", "labels_json": [], "to_header": to, "cc_header": cc,
        }
    )
    store.save_ai(tid, body_text=body)
    return store.get_thread(tid)


def _kb(tmp_path):
    root = tmp_path / "base"
    root.mkdir(exist_ok=True)
    (root / "pix.md").write_text("# Decisão\nO roteamento do pix estático segue a conta da Confrapag; validar com o EC.")
    store.save_settings(context_global_paths=[str(root)])
    rag.sync()


def _llm(monkeypatch, payload):
    seen = {}

    def fake(prompt, **kw):
        seen["prompt"] = prompt
        return json.dumps(payload)

    monkeypatch.setattr(llm, "complete", fake)
    return seen


# ── papel do Leo ──
def test_role_only_cc_is_so_copia():
    row = _thread(to="bia@x.com", cc=ME, body="De: Ana <ana@x.com>\nData: x\n\nBia, segue a ata da reunião de ontem.")
    assert copilot.heuristic(row, row["body_text"])["papel"] == "so_copia"


def test_role_cc_but_named_is_opinion():
    row = _thread(to="bia@x.com", cc=ME, body="De: Ana <ana@x.com>\nData: x\n\nBia, e o Leo, o que acha disso?")
    assert copilot.heuristic(row, row["body_text"])["papel"] == "mencionado_opiniao"


def test_role_direct_request_is_demand_with_deadline_and_ball_with_leo():
    row = _thread()
    item = copilot.heuristic(row, row["body_text"])
    assert item["papel"] == "demanda"
    assert item["bola"]["com"] == "leo"
    assert item["prazo"].endswith("-10-10")
    assert item["quem_pediu"]["email"] == "ana@x.com"


def test_role_marketing_is_ignorable_and_neutral():
    row = _thread(marketing=1)
    item = copilot.heuristic(row, row["body_text"])
    assert item["papel"] == "pode_ignorar" and item["urgencia"] == "neutra"
    assert copilot.tab_for({**item, "status": "aberto"}) == "so_conhecimento"


def test_last_from_me_puts_ball_with_others():
    row = _thread(last_from_me=1, to="Bia <bia@x.com>", sender=ME)
    item = copilot.heuristic(row, row["body_text"])
    assert item["bola"] == {"com": "outros", "email": "bia@x.com", "nome": "Bia"}
    assert copilot.tab_for({**item, "status": "aberto"}) == "bola_com_outros"


def test_invalid_role_from_model_falls_back_to_rule():
    row = _thread(to="bia@x.com", cc=ME, body="De: Ana <ana@x.com>\nData: x\n\nBia, segue a ata.")
    item = copilot.interpret(row, row["body_text"], {"papel_leo": "chefe_supremo"}, [])
    assert item["papel"] == "so_copia"


# ── evidência ──
SOURCES = [{"tipo": "learning_base", "titulo": "pix.md › Decisão", "texto": "O roteamento segue a conta da Confrapag."}]


def test_option_with_invented_quote_is_dropped_and_real_quote_kept():
    row = _thread()
    parsed = {
        "papel_leo": "demanda",
        "o_que_eu_faria": [
            {"acao": "pedir_contexto", "texto": "x", "confianca": 0.9, "evidencias": [{"tipo": "mensagem", "citacao": "o diretor já aprovou tudo"}]},
            {"acao": "estudar_depois_responder", "texto": "y", "confianca": 0.6, "evidencias": [{"tipo": "mensagem", "citacao": "validar o roteamento do pix estático"}]},
        ],
    }
    item = copilot.interpret(row, row["body_text"], parsed, SOURCES)
    assert [o["acao"] for o in item["opcoes"]] == ["estudar_depois_responder"]
    assert item["opcoes"][0]["evidencias"][0]["tipo"] == "mensagem"


def test_source_number_out_of_range_is_not_evidence():
    row = _thread()
    parsed = {"papel_leo": "demanda", "o_que_eu_faria": [{"acao": "aguardar", "confianca": 0.7, "evidencias": [{"tipo": "fonte", "n": 9}]}]}
    item = copilot.interpret(row, row["body_text"], parsed, SOURCES)
    assert item["opcoes"] == [] and item["needs_context"] is True and item["o_que_falta"]


def test_reply_requires_precedent_from_base_or_decision():
    row = _thread()
    quote_only = {"acao": "responder", "confianca": 0.95, "evidencias": [{"tipo": "mensagem", "citacao": "Precisamos fechar com o EC"}]}
    with_base = {"acao": "responder", "confianca": 0.8, "evidencias": [{"tipo": "fonte", "n": 1, "porque": "decisão registrada"}]}
    assert copilot.interpret(row, row["body_text"], {"o_que_eu_faria": [quote_only]}, SOURCES)["opcoes"] == []
    kept = copilot.interpret(row, row["body_text"], {"o_que_eu_faria": [quote_only, with_base]}, SOURCES)["opcoes"]
    assert len(kept) == 1 and kept[0]["evidencias"][0]["tipo"] == "learning_base"
    assert kept[0]["evidencias"][0]["porque"] == "decisão registrada"


def test_options_are_capped_at_three_and_sorted_by_confidence():
    row = _thread()
    ev = [{"tipo": "fonte", "n": 1}]
    opts = [{"acao": a, "confianca": c, "evidencias": ev} for a, c in
            (("aguardar", 0.2), ("pedir_contexto", 0.9), ("estudar_depois_responder", 0.5), ("direcionar", 0.7))]
    out = copilot.interpret(row, row["body_text"], {"o_que_eu_faria": opts}, SOURCES)["opcoes"]
    assert [o["confianca"] for o in out] == [0.9, 0.7, 0.5]


def test_analyze_end_to_end_with_rag_and_api(tmp_path, monkeypatch):
    _kb(tmp_path)
    _thread()
    seen = _llm(monkeypatch, {
        "papel_leo": "demanda", "o_que_aconteceu": "Ana pede validação do roteamento do pix até 10/10.",
        "urgencia": "media", "bola": "leo", "prazo": "2026-10-10", "tarefas": ["Validar roteamento"],
        "o_que_eu_faria": [{"acao": "responder", "texto": "Confirmar que segue a conta da Confrapag", "confianca": 0.8,
                            "evidencias": [{"tipo": "fonte", "n": 1, "porque": "decisão no cérebro"}]}],
    })
    copilot.analyze("t1")
    assert "[1]" in seen["prompt"] and "pix.md" in seen["prompt"]
    client = TestClient(app)
    data = client.get("/api/copilot").json()
    it = next(i for i in data["items"] if i["thread_id"] == "t1")
    assert it["tab"] == "precisa_de_voce" and it["analisado"] and it["opcoes"][0]["acao"] == "responder"
    assert data["saudacao"].endswith("Leo") and "hoje" in data["cards"]
    det = client.get("/api/copilot/t1").json()
    assert det["o_que_aconteceu"].startswith("Ana pede") and det["tarefas"][0]["texto"] == "Validar roteamento"
    assert client.get("/api/copilot/nao-existe").status_code == 404


def test_incremental_only_rereads_threads_with_new_messages(monkeypatch):
    _thread("t1")
    _thread("t2", date=20)
    _llm(monkeypatch, {"papel_leo": "fyi"})
    copilot.analyze("t1")
    assert copilot.candidates() == ["t2"]
    _thread("t1", date=99)  # mensagem nova
    assert set(copilot.candidates()) == {"t1", "t2"}


# ── delegar / cobrar (nunca envia) ──
def test_delegate_in_thread_keeps_originators_in_cc():
    _thread(to=f"{ME}, carla@x.com", cc="dani@x.com")
    res = TestClient(app).post("/api/copilot/t1/action", json={"action": "delegar", "para": "bia@x.com", "nome": "Bia Lima", "modo": "cc_originais", "nota": "Você já tratou disso antes."}).json()
    cc = [e.strip() for e in res["cc"].split(",")]
    assert cc[0] == "bia@x.com" and {"carla@x.com", "dani@x.com"} <= set(cc) and ME not in cc
    assert "ana@x.com" not in cc, "quem escreveu já vai no Para da resposta"
    row = store.get_thread("t1")
    assert row["draft"].startswith("Bia, pode assumir") and "Você já tratou disso antes." in row["draft"]
    assert parse_qs(urlparse(res["open_url"]).query)["cc"][0] == res["cc"]
    item = res["item"]
    assert item["status"] == "delegado" and item["tab"] == "bola_com_outros"
    assert item["bola"]["email"] == "bia@x.com" and item["depende_de_outros"]
    assert store.list_copilot_actions(thread_id="t1")[0]["action"] == "delegar"


def test_delegate_silent_new_email_goes_only_to_delegate():
    _thread(to=f"{ME}, carla@x.com")
    res = copilot.act("t1", "delegar", {"para": "bia@x.com", "modo": "novo_silencioso"})
    q = parse_qs(urlparse(res["open_url"]).query)
    assert urlparse(res["open_url"]).path == "/compose"
    assert q["to"] == ["bia@x.com"] and "cc" not in q
    assert "carla@x.com" not in res["draft"] and "ana@x.com" not in res["open_url"]
    assert not store.get_thread("t1").get("draft"), "silencioso não mexe no rascunho da thread"
    assert res["item"]["delegado"]["modo"] == "novo_silencioso"


def test_delegate_validation():
    _thread()
    client = TestClient(app)
    assert client.post("/api/copilot/t1/action", json={"action": "delegar", "para": "nao-é-email"}).status_code == 400
    assert client.post("/api/copilot/t1/action", json={"action": "delegar", "para": ME}).status_code == 400
    assert client.post("/api/copilot/t1/action", json={"action": "delegar", "para": "b@x.com", "modo": "grito"}).status_code == 400
    assert client.post("/api/copilot/t1/action", json={"action": "explodir"}).status_code == 400


def test_follow_up_after_silent_delegation_goes_to_delegate():
    _thread()
    copilot.act("t1", "delegar", {"para": "bia@x.com", "nome": "Bia", "modo": "novo_silencioso"})
    res = copilot.act("t1", "cobrar")
    assert res["para"] == "bia@x.com" and res["open_url"].startswith("/compose?")
    assert res["item"]["status"] == "cobrado"


def test_follow_up_without_anyone_holding_the_ball_is_refused():
    _thread()
    with pytest.raises(ValueError):
        copilot.act("t1", "cobrar")


def test_assume_resolve_and_reopen():
    _thread(to="bia@x.com", cc=ME, body="De: Ana <ana@x.com>\nData: x\n\nBia, segue a ata.")
    assert copilot.act("t1", "assumir")["item"]["tab"] == "precisa_de_voce"
    assert copilot.act("t1", "resolver")["item"]["tab"] == "resolvido"
    assert copilot.act("t1", "reabrir")["item"]["status"] == "aberto"


def test_kanban_drop_actions_move_between_columns():
    _thread()
    assert copilot.act("t1", "aguardar")["item"]["tab"] == "bola_com_outros"
    item = copilot.act("t1", "so_saber")["item"]
    assert item["tab"] == "so_conhecimento" and item["papel"] == "fyi"
    assert copilot.act("t1", "assumir")["item"]["tab"] == "precisa_de_voce"


def test_apply_reply_suggestion_only_creates_draft(monkeypatch):
    _thread()
    sources = SOURCES
    item = copilot.interpret(store.get_thread("t1"), BODY, {"o_que_eu_faria": [
        {"acao": "responder", "texto": "Confirmar a conta", "confianca": 0.8, "evidencias": [{"tipo": "fonte", "n": 1}]}]}, sources)
    copilot._persist(store.get_thread("t1"), item, None)
    calls = {}

    def fake_draft(tid, instruction, comment=""):
        calls["instruction"] = instruction
        store.save_ai(tid, draft="Olá Ana, confirmo.")
        return {"draft": "Olá Ana, confirmo."}

    monkeypatch.setattr(assistant, "draft", fake_draft)
    res = copilot.act("t1", "aplicar", {"opcao": 0})
    assert res["draft"] == "Olá Ana, confirmo." and res["open_url"] == "/mail/t1"
    assert "pix.md" in calls["instruction"], "a base citada vai junto da instrução"


# ── piloto ──
def test_pilot_never_answers_open_demand_or_delegated(monkeypatch):
    _thread("old", date=1)  # remetente já visto antes
    row = _thread("t1")
    assert copilot.pilot_block_reason("t1") is None, "sem leitura do copiloto, as regras de sempre valem"
    copilot.act("t1", "assumir")  # grava o item (demanda aberta)
    assert "demanda" in assistant._hard_exclusions(row, BODY, "ok")
    copilot.act("t1", "resolver")
    assert copilot.pilot_block_reason("t1") is None
    copilot.act("t1", "delegar", {"para": "bia@x.com", "modo": "novo_silencioso"})
    assert "outra pessoa" in copilot.pilot_block_reason("t1")


def test_pilot_blocks_without_precedent():
    row = _thread(to="bia@x.com", cc=ME, body="De: Ana <ana@x.com>\nData: x\n\nBia, e o Leo, o que acha?")
    item = copilot.interpret(row, row["body_text"], {"papel_leo": "mencionado_opiniao", "o_que_eu_faria": []}, [])
    copilot._persist(row, item, None)
    assert "precedente" in copilot.pilot_block_reason("t1")


# ── digest + preferências ──
def test_digest_daily_and_weekly(monkeypatch):
    _thread()
    copilot.act("t1", "resolver")
    _thread("t2", date=20)
    client = TestClient(app)
    daily = client.get("/api/copilot/digest?period=daily").json()
    assert daily["period"] == "daily" and daily["texto"].startswith(daily["titulo"]) and daily["agendado_para"]
    assert "Precisa de você" in daily["texto"]
    weekly = client.get("/api/copilot/digest?period=weekly").json()
    assert "1 resolvidos" in weekly["texto"] and weekly["agendamento"].startswith("toda segunda")
    assert client.get("/api/copilot/digest?period=mensal").status_code == 400


def test_list_shows_only_unread_by_default_and_all_when_configured(monkeypatch):
    # sem IA: colunas pela regra (com IA, os não lidos pela IA iriam para a fila "Analisando")
    monkeypatch.setattr(llm, "has_key", lambda: False)
    _thread("t1", date=10)
    _thread("t2", date=20, unread=0)
    _thread("t3", date=30, last_from_me=1, to="bia@x.com", unread=0)
    client = TestClient(app)

    data = client.get("/api/copilot").json()
    assert [i["thread_id"] for i in data["items"]] == ["t1"]
    assert data["show_all"] is False and data["total"] == 3
    assert sum(t["count"] for t in data["tabs"]) == 1
    assert data["cards"]["esperando_outros"] == 0, "t3 (bola com outros) foi lido: não conta"

    assert len(client.get("/api/copilot?all=true").json()["items"]) == 3, "override pontual pela query"

    saved = client.post("/api/copilot/settings", json={"show_all": True}).json()
    assert saved["show_all"] is True
    data = client.get("/api/copilot").json()
    assert data["show_all"] is True and len(data["items"]) == 3
    assert data["cards"]["esperando_outros"] == 1
    assert client.get("/api/copilot?user=outra@x.com").json()["show_all"] is False, "preferência é por usuário"


def test_digest_ignores_unread_filter():
    _thread("t1", unread=0)
    assert copilot.list_items()["items"] == []
    assert "Precisa de você (1)" in copilot.digest("daily")["texto"]


def test_prefs_are_per_user_and_validated():
    client = TestClient(app)
    assert client.get("/api/copilot/settings").json()["skin"] == "clean"
    saved = client.post("/api/copilot/settings?user=outra@x.com", json={"skin": "caderno", "digest_daily": "07:15", "digest_weekly_day": 4}).json()
    assert saved["skin"] == "caderno" and saved["digest_weekly_day"] == 4
    assert client.get("/api/copilot/settings").json()["skin"] == "clean", "não vaza para outro usuário"
    assert client.post("/api/copilot/settings", json={"digest_daily": "25:00"}).status_code == 400
    assert client.post("/api/copilot/settings", json={"skin": "neon"}).status_code == 400
    d = client.get("/api/copilot/digest?period=weekly&user=outra@x.com").json()
    assert d["agendamento"] == "toda sexta às 08:30"


def test_next_run_rolls_forward():
    from datetime import datetime

    prefs = {**copilot.DEFAULT_PREFS}
    monday_after = datetime(2026, 10, 5, 9, 0, tzinfo=config.TZ)  # segunda, depois das 08:30
    assert copilot.next_run("weekly", prefs, monday_after).date().isoformat() == "2026-10-12"
    assert copilot.next_run("daily", prefs, monday_after).date().isoformat() == "2026-10-06"


# ── páginas e migração ──
def test_copilot_page_is_served():
    res = TestClient(app).get("/copilot")
    assert res.status_code == 200 and "copilot.js" in res.text


def test_migration_backs_up_before_creating_copilot_tables(tmp_path, monkeypatch):
    db = tmp_path / "antigo.sqlite"
    monkeypatch.setattr("app.store.DB_PATH", db)
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, subject TEXT, internal_date INTEGER)")
        conn.execute("INSERT INTO threads(id, subject) VALUES ('x', 'antiga')")
    store.init()
    backups = list((tmp_path / "backups").glob("antigo-antes-copiloto-*.sqlite"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as conn:
        assert conn.execute("SELECT subject FROM threads").fetchone()[0] == "antiga"
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='copilot_items'").fetchone() is None
    cols = {r[1] for r in sqlite3.connect(db).execute("PRAGMA table_info(threads)")}
    assert {"to_header", "cc_header"} <= cols
    store.init()
    assert len(list((tmp_path / "backups").glob("*.sqlite"))) == 1, "só faz backup uma vez"


# ── leitura automática, resumo e thread completa ──
def test_candidates_prefer_unread():
    _thread("lido_novo", date=50, unread=0)
    _thread("nao_lido_velho", date=5, unread=1)
    assert copilot.candidates() == ["nao_lido_velho", "lido_novo"]


def test_rule_read_items_are_final_and_leave_the_queue(monkeypatch):
    _thread("mk", marketing=1)
    monkeypatch.setattr(llm, "complete", lambda *a, **k: (_ for _ in ()).throw(AssertionError("não chama IA")))
    item = copilot.analyze("mk")
    assert item["lido_por_regra"] and not item["analisado"]
    assert "mk" not in copilot.candidates()


def test_heuristic_summary_is_not_raw_snippet():
    long_snippet = "Leo, " + "texto cru do e-mail " * 30
    _thread()
    store.upsert_thread({**store.get_thread("t1"), "snippet": long_snippet, "labels_json": []})
    row = store.get_thread("t1")
    line = copilot.heuristic(row, row["body_text"])["o_que_aconteceu"]
    assert "texto cru" not in line and len(line) < 80
    assert line.startswith("Ana Souza pede algo a você") and "10/10" in line


def test_old_stored_rule_summary_is_replaced_on_read():
    row = _thread()
    copilot._persist(row, {**copilot.heuristic(row, BODY), "o_que_aconteceu": "Leo, você pode validar o roteamento?"}, None)
    assert copilot.detail("t1")["o_que_aconteceu"] == "Ana Souza pede algo a você (prazo 10/10)."


def test_ensure_batch_starts_in_background_when_list_loads(monkeypatch):
    _thread("t1")
    _thread("t2", date=20, unread=0)
    started = {}
    monkeypatch.setattr(copilot, "AUTO_BATCH", True)
    monkeypatch.setattr(copilot.threading, "Thread", lambda target, args, daemon: type("T", (), {"start": lambda self: started.setdefault("ids", args[0])})())
    job = TestClient(app).get("/api/copilot").json()["job"]
    assert started["ids"] == ["t1", "t2"] and job["running"] and job["pending"] == ["t1", "t2"]
    copilot._JOB.update(running=False)
    copilot._TRIED.update({"t1": time.time(), "t2": time.time()})
    started.clear()
    copilot.ensure_batch()
    assert not started, "o que acabou de falhar não volta em laço"


def test_ensure_batch_needs_key(monkeypatch):
    _thread()
    monkeypatch.setattr(copilot, "AUTO_BATCH", True)
    monkeypatch.setattr(llm, "has_key", lambda: False)
    assert copilot.ensure_batch()["running"] is False


def test_batch_run_reads_and_skips_already_fresh(monkeypatch):
    _thread("t1")
    _thread("t2", date=20)
    calls = []
    seen = _llm(monkeypatch, {"papel_leo": "fyi", "o_que_aconteceu": "Ana avisou."})
    real = copilot.analyze
    monkeypatch.setattr(copilot, "analyze", lambda tid: (calls.append(tid), real(tid))[1])
    real("t2")  # Leo abriu t2 antes de o lote chegar nele
    copilot._JOB.update(running=True, pending=["t1", "t2"])
    copilot._run(["t1", "t2"])
    assert calls == ["t1"] and seen["prompt"]
    assert copilot.job_status()["running"] is False and copilot.job_status()["pending"] == []
    assert copilot.detail("t1")["o_que_aconteceu"] == "Ana avisou."


def test_detail_includes_full_thread():
    body = BODY + "\n\n----\n\nDe: Leo <" + ME + ">\nData: 2026-10-02\n\nVou olhar, Ana."
    _thread(body=body)
    det = TestClient(app).get("/api/copilot/t1").json()
    assert det["thread_text"] == body
    assert [m["de"] for m in det["mensagens"]] == ["Ana Souza <ana@x.com>", f"Leo <{ME}>"]
    assert det["mensagens"][1]["texto"] == "Vou olhar, Ana." and det["mensagens"][0]["data"] == "2026-10-01"


def test_detail_without_body_does_not_break_when_gmail_fails():
    _thread(body="")
    det = copilot.detail("t1")
    assert det["thread_text"] == "" and det["mensagens"] == []
    assert det["resumo_contexto"]["abertura"] is None and det["resumo_contexto"]["total_mensagens"] == 0


def test_detail_has_context_summary():
    body = (
        BODY
        + "\n\n----\n\nDe: Leo <" + ME + ">\nData: 2026-10-02\n\nVou olhar, Ana.\n\nEm 01/10, Ana escreveu:\n> Leo, você pode validar"
        + "\n\n----\n\nDe: Ana Souza <ana@x.com>\nData: 2026-10-03\n\nObrigada! Fico no aguardo."
    )
    _thread(body=body)
    rc = TestClient(app).get("/api/copilot/t1").json()["resumo_contexto"]
    assert rc["total_mensagens"] == 3 and rc["o_que_aconteceu"]
    assert rc["abertura"]["nome"] == "Ana Souza" and "validar o roteamento" in rc["abertura"]["trecho"]
    assert rc["sua_resposta"]["trecho"] == "Vou olhar, Ana.", "sem o histórico citado"
    assert rc["ultima"]["email"] == "ana@x.com" and not rc["ultima"]["voce"] and rc["ultima"]["data"] == "2026-10-03"


def test_analyze_fills_ai_summary_and_options(monkeypatch):
    _thread()
    _llm(monkeypatch, {
        "papel_leo": "demanda", "o_que_aconteceu": "Ana quer o roteamento do pix validado até 10/10.",
        "o_que_eu_faria": [{"acao": "estudar_depois_responder", "texto": "Revisar o roteamento", "confianca": 0.7,
                            "evidencias": [{"tipo": "mensagem", "citacao": "validar o roteamento do pix estático"}]}],
    })
    det = TestClient(app).get("/api/copilot/t1?refresh=1").json()
    assert det["analisado"] and det["o_que_aconteceu"].startswith("Ana quer")
    assert det["opcoes"][0]["acao"] == "estudar_depois_responder" and det["opcoes"][0]["evidencias"]
    assert det["mensagens"], "a thread completa vem junto da leitura"


# ── fila "Analisando": só o que foi classificado entra nas colunas ──
def _tabs(data):
    return {t["key"]: t["count"] for t in data["tabs"]}


def test_unread_by_ai_goes_to_queue_and_not_to_tabs_or_today():
    _thread("t1")  # demanda urgente pela regra, mas a IA ainda não leu
    data = copilot.list_items(show_all=True)
    it = data["items"][0]
    assert it["tab"] == "analisando" and it["pendente"] and not it["falhou"]
    assert sum(_tabs(data).values()) == 0 and data["cards"] == {"hoje": 0, "esperando_outros": 0}
    assert data["fila"] == {"key": "analisando", "title": "Analisando", "count": 1, "falhas": 0, "ativa": True}


def test_item_read_by_ai_goes_to_its_column(monkeypatch):
    _thread("t1")
    _thread("t2", date=20)
    _llm(monkeypatch, {"papel_leo": "demanda", "urgencia": "alta", "bola": "leo"})
    copilot.analyze("t1")
    data = copilot.list_items(show_all=True)
    tabs = {i["thread_id"]: i["tab"] for i in data["items"]}
    assert tabs == {"t1": "precisa_de_voce", "t2": "analisando"}
    assert _tabs(data)["precisa_de_voce"] == 1 and data["cards"]["hoje"] == 1 and data["fila"]["count"] == 1


def test_rule_read_item_goes_to_column():
    _thread("mk", marketing=1)
    copilot.analyze("mk")
    it = copilot.list_items(show_all=True)["items"][0]
    assert it["lido_por_regra"] and not it["pendente"] and it["tab"] == "so_conhecimento"


def test_leo_action_classifies_even_without_reading():
    _thread("t1")
    _thread("t2", date=20)
    copilot.act("t1", "resolver")
    copilot.act("t2", "so_saber")  # status volta a "aberto", mas foi decisão do Leo
    tabs = {i["thread_id"]: i["tab"] for i in copilot.list_items(show_all=True)["items"]}
    assert tabs == {"t1": "resolvido", "t2": "so_conhecimento"}
    assert copilot.detail("t2")["tab"] == "so_conhecimento"


def test_outdated_item_stays_in_its_column(monkeypatch):
    _thread("t1")
    _llm(monkeypatch, {"papel_leo": "demanda", "bola": "leo"})
    copilot.analyze("t1")
    _thread("t1", date=99)  # mensagem nova depois da leitura
    it = copilot.list_items(show_all=True)["items"][0]
    assert it["desatualizado"] and not it["pendente"] and it["tab"] == "precisa_de_voce"
    assert "t1" in copilot.candidates(), "volta para o lote, mas não para a fila"


def test_without_ai_key_columns_use_heuristic(monkeypatch):
    monkeypatch.setattr(llm, "has_key", lambda: False)
    _thread("t1")
    data = copilot.list_items(show_all=True)
    it = data["items"][0]
    assert it["tab"] == "precisa_de_voce" and not it["pendente"] and not it["analisado"]
    assert data["fila"]["count"] == 0 and data["fila"]["ativa"] is False


def test_failed_reading_stays_in_queue_marked(monkeypatch):
    _thread("t1")
    _thread("t2", date=20)

    def boom(*a, **k):
        raise RuntimeError("modelo fora do ar")

    monkeypatch.setattr(llm, "complete", boom)
    copilot._JOB.update(running=True, pending=["t1"])
    copilot._run(["t1"])
    assert copilot.job_status()["errors"] == 1
    monkeypatch.setattr(llm, "complete", lambda *a, **k: "não é json")  # resposta fora do formato
    copilot.analyze("t2")
    data = copilot.list_items(show_all=True)
    assert all(i["tab"] == "analisando" and i["falhou"] for i in data["items"])
    assert data["fila"]["count"] == 2 and data["fila"]["falhas"] == 2 and sum(_tabs(data).values()) == 0
    _llm(monkeypatch, {"papel_leo": "fyi"})
    copilot.analyze("t1")  # o Leo pediu de novo e deu certo
    it = next(i for i in copilot.list_items(show_all=True)["items"] if i["thread_id"] == "t1")
    assert it["tab"] == "so_conhecimento" and not it["falhou"]


def test_queue_respects_unread_filter_and_sort():
    _thread("t1", date=10)
    _thread("t2", date=20, unread=0)
    _thread("t3", date=30)
    data = copilot.list_items(show_all=False)
    assert [i["thread_id"] for i in data["items"]] == ["t3", "t1"] and data["fila"]["count"] == 2
    assert copilot.list_items(show_all=True)["fila"]["count"] == 3


# ── Acompanhar alias + Resolvido marca lido + cache analyze ──
def test_acompanhar_alias_matches_assumir():
    _thread(to="bia@x.com", cc=ME, body="De: Ana <ana@x.com>\nData: x\n\nBia, segue a ata.")
    res = copilot.act("t1", "acompanhar")
    assert res["action"] == "acompanhar"
    assert res["item"]["status"] == "assumido"
    assert res["item"]["tab"] == "precisa_de_voce"


def test_resolver_marks_gmail_thread_read(monkeypatch):
    _thread()
    calls = []
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: (calls.append(list(ids)), ids)[1])
    res = copilot.act("t1", "resolver")
    assert res["item"]["tab"] == "resolvido"
    assert calls == [["t1"]]
    assert not store.get_thread("t1")["is_unread"], "lido também no radar local"
    assert copilot.list_items(show_all=False)["items"] == [], "sai do quadro de não lidos"


def test_board_has_three_columns_without_resolvido():
    data = copilot.list_items(show_all=False)
    assert [t["key"] for t in data["tabs"]] == ["precisa_de_voce", "bola_com_outros", "so_conhecimento"]
    assert data["tabs"][1]["title"] == "Aguardando outras pessoas"
    assert [h["key"] for h in data["historico"]] == ["resolvido", "lidos"]


def test_resolved_stays_off_board_even_if_gmail_still_unread(monkeypatch):
    def boom(_ids):
        raise RuntimeError("sem gmail.modify")

    monkeypatch.setattr(gmail_client, "mark_threads_read", boom)
    _thread("t1")
    copilot.act("t1", "resolver")
    assert store.get_thread("t1")["is_unread"], "Gmail falhou: local continua não lido"
    data = copilot.list_items(show_all=False)
    assert data["items"] == [] and sum(_tabs(data).values()) == 0
    assert {h["key"]: h["count"] for h in data["historico"]}["resolvido"] == 1


def test_history_resolved_and_read(monkeypatch):
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: ids)
    _thread("t1")
    _thread("t2", date=20, unread=0)
    _thread("t3", date=30, unread=0)  # lido, mas o copiloto nunca leu nem agiu: fora do histórico
    _thread("t4", date=40)
    copilot.act("t1", "resolver")
    copilot.act("t2", "assumir")
    data = copilot.list_items(show_all=True)
    keys = {i["thread_id"]: copilot.history_key(i) for i in data["items"]}
    assert keys == {"t1": "resolvido", "t2": "lidos", "t3": "", "t4": ""}
    assert {h["key"]: h["count"] for h in data["historico"]} == {"resolvido": 1, "lidos": 1}
    api = TestClient(app).get("/api/copilot?all=1").json()
    assert {h["key"]: h["count"] for h in api["historico"]} == {"resolvido": 1, "lidos": 1}


def test_resolver_survives_gmail_mark_read_failure(monkeypatch):
    _thread()

    def boom(_ids):
        raise RuntimeError("sem gmail.modify")

    monkeypatch.setattr(gmail_client, "mark_threads_read", boom)
    res = copilot.act("t1", "resolver")
    assert res["item"]["status"] == "resolvido"


def test_analyze_skips_llm_when_fresh_unless_forced(monkeypatch):
    _thread()
    calls = {"n": 0}
    payload = {
        "papel_leo": "demanda",
        "o_que_aconteceu": "Pedido de PIX.",
        "urgencia": "media",
        "bola": "leo",
        "depende_de_outros": False,
        "o_que_eu_faria": [{
            "acao": "responder",
            "texto": "Confirmar",
            "confianca": 0.8,
            "evidencias": [{"tipo": "fonte", "n": 1}],
        }],
    }

    def fake_complete(*a, **k):
        calls["n"] += 1
        import json as _json
        return _json.dumps(payload)

    monkeypatch.setattr(llm, "has_key", lambda: True)
    monkeypatch.setattr(llm, "complete", fake_complete)
    monkeypatch.setattr(
        rag, "search",
        lambda *a, **k: [{"source": "kb", "title": "pix.md › Decisão", "body": "O roteamento segue a conta da Confrapag."}],
    )
    monkeypatch.setattr(copilot, "_save_analysis_to_learning_base", lambda *a, **k: None)

    copilot.analyze("t1", force=True)
    assert calls["n"] == 1
    # segunda chamada sem mudança: cache (não chama LLM)
    copilot.analyze("t1")
    assert calls["n"] == 1
    # force=True: releitura
    copilot.analyze("t1", force=True)
    assert calls["n"] == 2


# ── composer "Responder" do detalhe: mesmo rascunho e mesmo envio do /mail ──
_REAL_SEND_REPLY = gmail_client.send_reply  # guardado antes do monkeypatch "boom"


@pytest.fixture
def _send_env(tmp_path, monkeypatch):
    """Envio mockado: grava o que seria enviado e não fala com o Gmail."""
    from app import attachments

    monkeypatch.setattr(attachments, "ROOT", tmp_path / "anexos")
    sent = []

    def fake_send(tid, text, cc=""):
        sent.append({"tid": tid, "text": text, "cc": cc})
        return {"to": "ana@x.com", "cc": cc}

    monkeypatch.setattr(gmail_client, "send_reply", fake_send)
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: len(ids))
    monkeypatch.setattr(gmail_client, "refresh_thread", lambda tid: None)
    return sent


def test_detail_exposes_cached_draft_without_generating(monkeypatch):
    _thread()
    store.save_ai("t1", draft="Olá Ana, valido até 10/10.")

    def no_llm(*a, **k):
        raise AssertionError("abrir o detalhe não pode gerar rascunho")

    monkeypatch.setattr(llm, "complete", no_llm)
    monkeypatch.setattr(assistant, "draft", no_llm)
    det = TestClient(app).get("/api/copilot/t1").json()
    assert det["draft"] == "Olá Ana, valido até 10/10."


def test_detail_without_draft_returns_empty():
    _thread()
    assert TestClient(app).get("/api/copilot/t1").json()["draft"] == ""


def test_regenerate_reuses_assistant_draft_and_detail_sees_it(monkeypatch):
    _thread()
    seen = _llm(monkeypatch, {"kind": "draft", "text": "Olá Ana, valido o roteamento até 10/10.", "cc_names": []})
    calls = []
    real_draft = assistant.draft

    def spy(tid, instruction, comment=""):
        calls.append(tid)
        return real_draft(tid, instruction, comment)

    monkeypatch.setattr(assistant, "draft", spy)
    client = TestClient(app)
    res = client.post("/api/threads/t1/draft", json={"instruction": "", "comment": ""})
    assert res.status_code == 200 and res.json()["draft"] == "Olá Ana, valido o roteamento até 10/10."
    assert calls == ["t1"] and "Roteamento do pix" in seen["prompt"]
    assert client.get("/api/copilot/t1").json()["draft"] == "Olá Ana, valido o roteamento até 10/10."


def test_apply_ask_context_leaves_draft_for_composer(monkeypatch):
    _thread()
    item = copilot.interpret(store.get_thread("t1"), BODY, {"o_que_eu_faria": [
        {"acao": "pedir_contexto", "texto": "Qual EC?", "confianca": 0.6,
         "evidencias": [{"tipo": "mensagem", "citacao": "Precisamos fechar com o EC"}]}]}, [])
    copilot._persist(store.get_thread("t1"), item, None)
    _llm(monkeypatch, {"kind": "draft", "text": "Ana, qual EC exatamente?", "cc_names": []})
    res = TestClient(app).post("/api/copilot/t1/action", json={"action": "aplicar", "opcao": 0}).json()
    assert res["acao"] == "pedir_contexto" and res["open_url"] == "/mail/t1"
    assert res["draft"] == "Ana, qual EC exatamente?" and res["item"]["draft"] == res["draft"]


def test_follow_up_in_thread_draft_is_in_detail():
    _thread()
    copilot.act("t1", "delegar", {"para": "bia@x.com", "nome": "Bia", "modo": "cc_originais"})
    res = copilot.act("t1", "cobrar")
    assert res["open_url"].startswith("/mail/t1") and "cc=bia" in res["open_url"]
    assert res["item"]["draft"] == res["draft"] and "Bia" in res["draft"]


def test_copilot_send_uses_same_endpoint_and_logs_reply_edit(_send_env):
    _thread()
    store.save_ai("t1", draft="Olá Ana, valido até 10/10.")
    res = TestClient(app).post(
        "/api/threads/t1/send",
        json={"text": "Olá Ana, valido até sexta.", "cc": "bia@x.com", "source": "copilot"},
    )
    assert res.status_code == 200 and res.json()["to"] == "ana@x.com"
    assert _send_env == [{"tid": "t1", "text": "Olá Ana, valido até sexta.", "cc": "bia@x.com"}]
    edits = store.list_reply_edits(thread_id="t1")
    assert len(edits) == 1
    e = edits[0]
    assert (e["ai_draft"], e["sent_text"], e["edited"], e["source"]) == (
        "Olá Ana, valido até 10/10.", "Olá Ana, valido até sexta.", 1, "copilot")
    assert store.get_thread("t1")["draft"] == "", "o envio limpa o rascunho, igual ao /mail"


def test_mail_send_stays_compatible_default_source(_send_env):
    _thread()
    client = TestClient(app)
    # sem rascunho da IA: envia, mas não há o que comparar
    assert client.post("/api/threads/t1/send", json={"text": "Feito."}).status_code == 200
    assert store.list_reply_edits(thread_id="t1") == []
    store.save_ai("t1", draft="Feito, Ana.")
    assert client.post("/api/threads/t1/send", json={"text": "Feito, Ana.", "source": "qualquer"}).status_code == 200
    e = store.list_reply_edits(thread_id="t1")[0]
    assert e["source"] == "mail" and e["edited"] == 0


def test_failed_send_does_not_log_reply_edit():
    # o autouse troca send_reply por "boom": o endpoint falha e nada é gravado
    _thread()
    store.save_ai("t1", draft="Olá Ana.")
    res = TestClient(app).post("/api/threads/t1/send", json={"text": "Olá Ana.", "source": "copilot"})
    assert res.status_code == 502
    assert store.list_reply_edits() == []
    assert store.get_thread("t1")["draft"] == "Olá Ana."


def test_guard_real_gmail_send_is_never_reachable(monkeypatch):
    # Guarda: mesmo chamando a função real, ela não consegue chegar no Gmail.
    def no_gmail(*a, **k):
        raise AssertionError("teste tentou falar com o Gmail de verdade")

    monkeypatch.setattr(gmail_client, "_service", no_gmail)
    monkeypatch.setattr(gmail_client, "load_credentials", lambda: object())
    monkeypatch.setattr(gmail_client, "has_send_scope", lambda creds: True)
    with pytest.raises(AssertionError, match="Gmail de verdade"):
        _REAL_SEND_REPLY("t1", "não pode sair")
    # e o send_reply que o app enxerga nos testes é o "boom", não o real
    assert gmail_client.send_reply is not _REAL_SEND_REPLY


# ── estado da conversa: quem pediu / respondido / sem resposta (das mensagens reais) ──
CAINA = "Cainã Sena <caina@confrapag.com.br>"
DENIS = "Denis Nascimento <denis@mtbank.com.br>"
EUDOCIO = "Eudocio Lima <eudocio@confrapag.com.br>"


def _msg(who, when, text):
    return f"De: {who}\nData: {when}\n\n{text}"


def _body(*msgs):
    return "\n\n----\n\n".join(_msg(*m) for m in msgs)


BOLETO = [
    (CAINA, "Mon, 5 Oct 2026 15:18:00 -0300", "Denis, pode verificar as pendências de boleto do MT Bank?"),
    (CAINA, "Mon, 5 Oct 2026 15:25:00 -0300", "Reforçando: são os boletos de setembro."),
    (EUDOCIO, "Mon, 5 Oct 2026 16:56:00 -0300", "Incluo aqui o relatório que tenho, por favor considerem."),
]


def test_conversa_request_answered_by_recipient():
    body = _body(*BOLETO, (DENIS, "Mon, 5 Oct 2026 17:48:00 -0300", "Verifiquei, as pendências já foram baixadas."))
    conv = copilot.conversa(copilot._messages(body))
    assert conv["status"] == "respondido"
    assert conv["solicitante"]["email"] == "caina@confrapag.com.br", "quem pediu é quem abriu o pedido, não o último a escrever"
    assert conv["respondido"]["email"] == "denis@mtbank.com.br"
    assert conv["rotulo_resposta"] == "Respondido por Denis Nascimento · 05/10 17:48"
    assert conv["rotulo_ultimo"] == "Denis Nascimento · 05/10 17:48"
    assert conv["aguardando_desde"] is None


def test_conversa_request_without_answer_counts_from_last_waiting_message():
    conv = copilot.conversa(copilot._messages(_body(*BOLETO[:2])), [{"name": "Denis Nascimento", "email": "denis@mtbank.com.br"}])
    assert conv["status"] == "aguardando" and conv["solicitante"]["nome"] == "Cainã Sena"
    assert conv["para"] == ["denis@mtbank.com.br"]
    assert conv["rotulo_resposta"] == "Sem resposta desde 05/10 15:25", "várias mensagens do solicitante: vale a última"
    assert copilot._fmt_when(conv["pedido_em"]) == "05/10 15:18"


def test_conversa_third_party_in_the_middle_is_not_an_answer():
    conv = copilot.conversa(copilot._messages(_body(*BOLETO)))
    assert conv["status"] == "aguardando", "Eudocio no meio não responde um pedido feito ao Denis"
    assert conv["solicitante"]["email"] == "caina@confrapag.com.br"
    assert conv["rotulo_resposta"] == "Sem resposta desde 05/10 16:56"
    assert conv["ultimo"]["email"] == "eudocio@confrapag.com.br"


def test_conversa_reply_with_question_opens_new_request():
    body = _body(BOLETO[0], (DENIS, "Mon, 5 Oct 2026 17:48:00 -0300", "Cainã, qual o número do contrato?"))
    conv = copilot.conversa(copilot._messages(body))
    assert conv["status"] == "aguardando" and conv["solicitante"]["email"] == "denis@mtbank.com.br"


def test_conversa_my_request_answered():
    body = _body((f"Leo <{ME}>", "Mon, 5 Oct 2026 09:00:00 -0300", "Ana, pode me mandar o extrato?"),
                 ("Ana Souza <ana@x.com>", "Mon, 5 Oct 2026 10:30:00 -0300", "Segue o extrato."))
    conv = copilot.conversa(copilot._messages(body))
    assert conv["solicitante"]["voce"] and conv["rotulo_resposta"] == "Respondido por Ana Souza · 05/10 10:30"


def test_detail_and_list_use_conversation_for_requester_and_answer():
    body = _body(*BOLETO, (DENIS, "Mon, 5 Oct 2026 17:48:00 -0300", "Verifiquei, as pendências já foram baixadas."))
    _thread(body=body, sender="denis@mtbank.com.br")
    det = TestClient(app).get("/api/copilot/t1").json()
    assert det["quem_pediu"]["email"] == "caina@confrapag.com.br"
    assert det["sem_resposta_desde"] is None and det["conversa"]["status"] == "respondido"
    assert det["conversa"]["rotulo_resposta"].startswith("Respondido por Denis")
    it = copilot.list_items(show_all=True)["items"][0]
    assert it["quem_pediu"]["email"] == "caina@confrapag.com.br" and it["sem_resposta_desde"] is None


def test_detail_sem_resposta_comes_from_messages_not_row_date():
    _thread(body=_body(*BOLETO[:2]), date=int(time.time() * 1000))
    det = copilot.detail("t1")
    assert det["sem_resposta_desde"] == det["conversa"]["aguardando_desde"]
    assert copilot._fmt_when(det["sem_resposta_desde"]) == "05/10 15:25"


def test_detail_includes_chat_history_from_mail():
    _thread()
    store.save_ai("t1", chat_json=json.dumps([{"role": "user", "text": "mais curto"}, {"role": "ai", "text": "Ok.", "kind": "draft"}]))
    det = copilot.detail("t1")
    assert [m["role"] for m in det["chat"]] == ["user", "ai"] and det["chat"][1]["kind"] == "draft"


def test_side_card_prefs_default_hide_tasks_for_leo_only():
    client = TestClient(app)
    leo = client.get("/api/copilot/settings?user=leo@confrapag.com.br").json()
    assert leo["show_tasks_card"] is False and leo["show_facts_card"] is True
    other = client.get("/api/copilot/settings?user=outra@x.com").json()
    assert other["show_tasks_card"] is True and other["show_facts_card"] is True
    saved = client.post("/api/copilot/settings?user=outra@x.com", json={"show_facts_card": False}).json()
    assert saved["show_facts_card"] is False and saved["show_tasks_card"] is True
    assert client.get("/api/copilot/settings?user=outra@x.com").json()["show_facts_card"] is False


def test_copilot_thread_page_route_serves_app():
    r = TestClient(app).get("/copilot/abc123")
    assert r.status_code == 200 and "copilot.js" in r.text


def test_pages_load_shared_icon_chat_and_composer_modules():
    client = TestClient(app)
    cp = client.get("/copilot").text
    for asset in ("/static/icons.js", "/static/chat.js", "/static/composer.js", "/static/composer.css"):
        assert asset in cp, f"/copilot sem {asset}"
    home = client.get("/").text
    for asset in ("/static/icons.js", "/static/chat.js", "/static/composer.js", "/static/composer.css"):
        assert asset in home, f"/ sem {asset}"
    assert 'id="st-cp-tasks"' in client.get("/settings").text and 'id="st-cp-facts"' in home
    assert "/static/icons.js" in client.get("/board").text
    # ícones vêm do módulo, nada de emoji/seta solta no cabeçalho do copiloto
    assert "⟳" not in cp and "⚙" not in cp


def test_copilot_card_quick_actions_in_static():
    """Cards do kanban/lista expõem Marcar como lido (resolver) e Delegar sem abrir detalhe."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "static"
    js = (root / "copilot.js").read_text(encoding="utf-8")
    css = (root / "copilot.css").read_text(encoding="utf-8")
    html = (root / "copilot.html").read_text(encoding="utf-8")
    assert 'data-card-act="resolver"' in js
    assert 'data-card-act="delegar"' in js
    assert "function cardActsHTML" in js
    assert "function runCardAct" in js
    assert "handleCardActEvent" in js
    assert "Marcar como lido" in js
    assert ".cp-card-acts" in css and ".cp-card-act" in css
    assert "copilot.js?v=" in html and "copilot.css?v=" in html



# ── só em Cc nunca vai para "Precisa de você" (regra do Leo) ──
CC_BODY = (
    "De: Ana <ana@x.com>\nData: x\n\n"
    "Bia, pode verificar as pendências do boleto até amanhã? Leo segue em cópia para acompanhar."
)
CC_RULE = "Se eu fui só copiado não deveria tá na classificação da coluna de precisa de você. E sim apenas cópia."


def test_only_cc_with_request_to_someone_else_is_so_copia():
    row = _thread(to="bia@x.com", cc=ME, body=CC_BODY)
    item = copilot.heuristic(row, row["body_text"])
    assert item["papel"] == "so_copia"
    assert copilot.tab_for({**item, "status": "aberto"}) == "so_conhecimento"


def test_only_cc_quoted_history_mentioning_leo_is_not_a_request():
    body = (
        "De: Ana <ana@x.com>\nData: x\n\nBia, consegue revisar?\n\n"
        "Em 01/10/2026, Carlos escreveu:\n> Leo, pode aprovar o layout?"
    )
    row = _thread(to="bia@x.com", cc=ME, body=body)
    assert copilot.heuristic(row, body)["papel"] == "so_copia"


def test_llm_cannot_promote_only_cc_to_demand():
    row = _thread(to="bia@x.com", cc=ME, body=CC_BODY)
    parsed = {
        "papel_leo": "demanda", "urgencia": "alta", "bola": "leo",
        "o_que_eu_faria": [{"acao": "pedir_contexto", "confianca": 0.8,
                            "evidencias": [{"tipo": "mensagem", "citacao": "pode verificar as pendências do boleto"}]}],
    }
    item = copilot.interpret(row, row["body_text"], parsed, [])
    assert item["papel"] == "so_copia"
    assert item["bola"]["com"] == "ninguem" and item["urgencia"] != "alta"
    assert copilot.tab_for({**item, "status": "aberto"}) == "so_conhecimento"


def test_only_cc_with_explicit_ask_to_leo_is_at_most_opinion():
    body = "De: Ana <ana@x.com>\nData: x\n\nBia, segue o boleto. Leo, você pode validar o layout?"
    row = _thread(to="bia@x.com", cc=ME, body=body)
    item = copilot.interpret(row, body, {"papel_leo": "demanda", "bola": "leo"}, [])
    assert item["papel"] == "mencionado_opiniao"


def test_direct_to_leo_with_request_stays_in_precisa_de_voce():
    row = _thread()  # Para: Leo, pedido direto
    item = copilot.interpret(row, row["body_text"], {"papel_leo": "demanda", "bola": "leo"}, [])
    assert item["papel"] == "demanda"
    assert copilot.tab_for({**item, "status": "aberto"}) == "precisa_de_voce"


def test_prompt_states_only_cc_rule_and_learned_note(tmp_path, monkeypatch):
    from app import learned

    monkeypatch.setattr(config, "LEARNED_NOTES_MD", tmp_path / "lb" / "aprendizados.md")
    _thread(to="bia@x.com", cc=ME, body=CC_BODY)
    learned.add("general", CC_RULE)
    learned.add("thread", CC_RULE, thread_id="t1")
    seen = _llm(monkeypatch, {"papel_leo": "demanda", "bola": "leo"})
    out = copilot.analyze("t1", force=True)
    assert "SÓ em Cc" in seen["prompt"] and "NUNCA demanda" in seen["prompt"]
    assert "(geral) " + CC_RULE in seen["prompt"] and "(neste assunto) " + CC_RULE in seen["prompt"]
    assert out["papel"] == "so_copia" and out["tab"] == "so_conhecimento"


def test_stale_only_cc_demand_is_healed_to_so_conhecimento():
    row = _thread(to="bia@x.com", cc=ME, body=CC_BODY)
    store.save_copilot_item(
        "t1", papel="demanda", status="aberto", source="llm", urgencia="alta", internal_date_snapshot=row["internal_date"],
        bola_json=json.dumps({"com": "leo", "email": ME, "nome": "Você"}), opcoes_json="[]",
    )
    it = next(i for i in copilot.list_items(show_all=True)["items"] if i["thread_id"] == "t1")
    assert it["papel"] == "so_copia" and it["tab"] == "so_conhecimento"
    assert store.get_copilot_item("t1")["papel"] == "so_copia", "corrigido no banco"


def test_heal_keeps_leo_decision_when_he_took_it():
    _thread(to="bia@x.com", cc=ME, body=CC_BODY)
    store.save_copilot_item("t1", papel="demanda", status="assumido", source="llm",
                            bola_json=json.dumps({"com": "leo", "email": ME, "nome": "Você"}))
    it = next(i for i in copilot.list_items(show_all=True)["items"] if i["thread_id"] == "t1")
    assert it["papel"] == "demanda" and it["tab"] == "precisa_de_voce"


# ── busca ──
def test_search_finds_read_and_resolved_beyond_unread_board(monkeypatch):
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: ids)
    _thread("t1")
    copilot.act("t1", "resolver")  # sai do quadro de não lidos
    store.upsert_thread({**store.get_thread("t1"), "id": "t2", "subject": "Boleto MT Bank", "from_name": "Carlos",
                         "from_email": "carlos@mt.com", "snippet": "pendências do boleto", "is_unread": 0, "internal_date": 20})
    assert copilot.list_items(show_all=False)["items"] == []
    hits = copilot.list_items(q="pix estatico")["items"]  # sem acento também acha
    assert [i["thread_id"] for i in hits] == ["t1"] and hits[0]["tab"] == "resolvido"
    assert [i["thread_id"] for i in copilot.list_items(q="carlos boleto")["items"]] == ["t2"]
    assert copilot.list_items(q="nada-a-ver")["items"] == []
    api = TestClient(app).get("/api/copilot", params={"q": "MT Bank"}).json()
    assert [i["thread_id"] for i in api["items"]] == ["t2"] and api["q"] == "MT Bank"


# ── abrir/ler NÃO marca como lido; só Resolvido ──
def test_opening_or_reading_never_marks_read(monkeypatch):
    calls = []
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: calls.append(("gmail", list(ids))) or ids)
    real_local = store.mark_local_read
    monkeypatch.setattr(store, "mark_local_read", lambda ids: calls.append(("local", list(ids))) or real_local(ids))
    _thread()
    _llm(monkeypatch, {"papel_leo": "demanda", "bola": "leo"})
    client = TestClient(app)
    assert client.get("/api/copilot/t1").status_code == 200
    assert client.get("/api/copilot/t1?refresh=1").status_code == 200
    copilot.detail("t1")
    copilot.analyze("t1", force=True)
    client.get("/api/copilot")
    client.get("/api/copilot?all=1&q=pix")
    assert calls == [], f"abrir/ler marcou lido: {calls}"
    assert store.get_thread("t1")["is_unread"] == 1
    assert any(i["thread_id"] == "t1" for i in copilot.list_items(show_all=False)["items"]), "continua no quadro de não lidos"
    copilot.act("t1", "resolver")
    assert ("gmail", ["t1"]) in calls and ("local", ["t1"]) in calls


def test_copilot_frontend_open_paths_do_not_call_mark_read():
    from pathlib import Path

    js = (Path(__file__).resolve().parents[1] / "static" / "copilot.js").read_text(encoding="utf-8")
    assert "mark-read" not in js and "mark_read" not in js


# ── alvo do pedido: pedido a outra pessoa não é demanda do Leo ──
def test_ask_to_douglas_with_leo_only_cc_is_not_precisa_de_voce():
    body = "De: Ana <ana@x.com>\nData: x\n\nDouglas, pode enviar o prazo da migração?"
    row = _thread(to="Douglas Lima <douglas@x.com>", cc=ME, body=body)
    item = copilot.heuristic(row, body)
    assert copilot.tab_for({**item, "status": "aberto"}) != "precisa_de_voce"


def test_ask_to_douglas_with_leo_in_to_is_not_demand():
    body = "De: Ana <ana@x.com>\nData: x\n\nDouglas, pode enviar o prazo da migração?"
    row = _thread(to=f"Douglas Lima <douglas@x.com>, Leo <{ME}>", body=body)
    assert copilot._ask_target(row, body) == "outros"
    item = copilot.heuristic(row, body)
    assert item["papel"] not in ("demanda", "mencionado_opiniao")
    assert copilot.tab_for({**item, "status": "aberto"}) != "precisa_de_voce"
    # a IA insiste em demanda: o cap rebaixa (bola com o Douglas -> Aguardando outras)
    parsed = {"papel_leo": "demanda", "urgencia": "alta", "bola": "outros", "bola_email": "douglas@x.com"}
    item = copilot.interpret(row, body, parsed, [])
    assert item["papel"] == "fyi" and item["urgencia"] != "alta"
    assert copilot.tab_for({**item, "status": "aberto"}) == "bola_com_outros"
    parsed = {"papel_leo": "demanda", "bola": "leo"}
    item = copilot.interpret(row, body, parsed, [])
    assert copilot.tab_for({**item, "status": "aberto"}) == "so_conhecimento"


def test_ask_to_douglas_even_with_leo_only_recipient_in_to():
    body = "De: Ana <ana@x.com>\nData: x\n\nOi Douglas, pode enviar o prazo?"
    row = _thread(to=ME, body=body)
    item = copilot.interpret(row, body, {"papel_leo": "demanda", "bola": "leo"}, [])
    assert copilot.tab_for({**item, "status": "aberto"}) != "precisa_de_voce"


def test_ask_to_leo_by_name_is_demand():
    body = "De: Ana <ana@x.com>\nData: x\n\nLeo, pode revisar o contrato?"
    row = _thread(to=f"Douglas Lima <douglas@x.com>, Leo <{ME}>", body=body)
    assert copilot._ask_target(row, body) == "voce"
    item = copilot.interpret(row, body, {"papel_leo": "demanda", "bola": "leo"}, [])
    assert item["papel"] == "demanda"
    assert copilot.tab_for({**item, "status": "aberto"}) == "precisa_de_voce"
    assert copilot.heuristic(row, body)["papel"] in ("demanda", "mencionado_opiniao")


def test_generic_ask_with_leo_sole_recipient_is_demand():
    body = "De: Ana <ana@x.com>\nData: x\n\nPrezados, podem enviar o relatório de conciliação até 10/10?"
    row = _thread(to=ME, body=body)
    assert copilot._ask_target(row, body) == ""
    item = copilot.heuristic(row, body)
    assert item["papel"] == "demanda"
    assert copilot.tab_for({**item, "status": "aberto"}) == "precisa_de_voce"


def test_prompt_states_ask_target_rule(monkeypatch):
    body = "De: Ana <ana@x.com>\nData: x\n\nDouglas, pode enviar o prazo?"
    _thread(to=f"Douglas Lima <douglas@x.com>, Leo <{ME}>", body=body)
    seen = _llm(monkeypatch, {"papel_leo": "demanda", "bola": "leo"})
    out = copilot.analyze("t1", force=True)
    assert "pedido a X ≠ demanda do Leo" in seen["prompt"]
    assert "dirigido a OUTRA pessoa" in seen["prompt"]
    assert out["tab"] != "precisa_de_voce"


def test_stale_demand_asked_to_someone_else_is_healed():
    body = "De: Ana <ana@x.com>\nData: x\n\nDouglas, pode enviar o prazo?"
    row = _thread(to=f"Douglas Lima <douglas@x.com>, Leo <{ME}>", body=body)
    store.save_copilot_item(
        "t1", papel="demanda", status="aberto", source="llm", urgencia="alta", internal_date_snapshot=row["internal_date"],
        bola_json=json.dumps({"com": "leo", "email": ME, "nome": "Você"}), opcoes_json="[]",
    )
    it = next(i for i in copilot.list_items(show_all=True)["items"] if i["thread_id"] == "t1")
    assert it["papel"] == "fyi" and it["tab"] == "so_conhecimento"
    assert store.get_copilot_item("t1")["papel"] == "fyi", "corrigido no banco"


# ── "Resolver todos" da coluna ──
def _llm_item(tid, papel, bola=None):
    row = store.get_thread(tid)
    store.save_copilot_item(
        tid, papel=papel, status="aberto", source="llm", urgencia="media", internal_date_snapshot=row["internal_date"],
        bola_json=json.dumps(bola or {"com": "leo", "email": ME, "nome": "Você"}), opcoes_json="[]",
    )


def test_resolve_column_resolves_only_that_tab(monkeypatch):
    calls = []
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: calls.append(list(ids)) or ids)
    _thread("t1")
    _thread("t2", date=11)
    _thread("t3", date=12, to="bia@x.com", cc=ME, body=CC_BODY)
    _llm_item("t1", "demanda")
    _llm_item("t2", "demanda")
    _llm_item("t3", "so_copia", {"com": "ninguem", "email": "", "nome": ""})
    tabs = {i["thread_id"]: i["tab"] for i in copilot.list_items(show_all=False)["items"]}
    assert tabs == {"t1": "precisa_de_voce", "t2": "precisa_de_voce", "t3": "so_conhecimento"}

    r = TestClient(app).post("/api/copilot/resolve-column", json={"tab": "precisa_de_voce"})
    assert r.status_code == 200
    assert r.json()["resolvidos"] == 2 and sorted(r.json()["thread_ids"]) == ["t1", "t2"]
    assert sorted(calls[0]) == ["t1", "t2"]
    for tid in ("t1", "t2"):
        assert store.get_copilot_item(tid)["status"] == "resolvido"
        assert store.get_thread(tid)["is_unread"] == 0
    # a outra coluna não mexe
    assert store.get_copilot_item("t3")["status"] == "aberto" and store.get_thread("t3")["is_unread"] == 1
    left = copilot.list_items(show_all=False)["items"]
    assert [i["thread_id"] for i in left] == ["t3"]


def test_resolve_column_thread_ids_only_restrict_and_bad_tab_is_rejected(monkeypatch):
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: ids)
    _thread("t1")
    _thread("t2", date=11)
    _thread("t3", date=12, to="bia@x.com", cc=ME, body=CC_BODY)
    _llm_item("t1", "demanda")
    _llm_item("t2", "demanda")
    _llm_item("t3", "so_copia", {"com": "ninguem", "email": "", "nome": ""})
    client = TestClient(app)
    r = client.post("/api/copilot/resolve-column", json={"tab": "precisa_de_voce", "thread_ids": ["t1", "t3"]})
    assert r.json()["thread_ids"] == ["t1"], "t3 é de outra coluna: não entra mesmo se o cliente mandar"
    assert store.get_copilot_item("t2")["status"] == "aberto"
    assert client.post("/api/copilot/resolve-column", json={"tab": "resolvido"}).status_code == 400
    assert client.post("/api/copilot/resolve-column", json={"tab": "so_conhecimento", "thread_ids": []}).json()["resolvidos"] == 0


def test_resolve_column_survives_gmail_failure(monkeypatch):
    def boom(ids):
        raise RuntimeError("sem scope")

    monkeypatch.setattr(gmail_client, "mark_threads_read", boom)
    _thread("t1")
    _llm_item("t1", "demanda")
    out = copilot.resolve_column("precisa_de_voce")
    assert out["resolvidos"] == 1 and out["gmail_ok"] is False
    assert store.get_copilot_item("t1")["status"] == "resolvido" and store.get_thread("t1")["is_unread"] == 0


def test_frontend_has_resolve_all_button():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "static"
    js = (root / "copilot.js").read_text(encoding="utf-8")
    assert "/api/copilot/resolve-column" in js and "Resolver todos" in js
    assert "Serão marcados como lidos no Gmail" in js


# ── resumo detalhado (IA sob demanda, em cache por thread) ──
_RD = {
    "contexto": "Ana pede validação do roteamento do pix estático.",
    "pontos_principais": ["Pedido de validação do roteamento"],
    "numeros_dados": [],
    "pedidos_ao_leo": ["Validar o roteamento do pix estático"],
    "pedidos_a_outros": [{"nome": "Douglas", "pedido": "enviar o prazo"}, {"nome": "x", "pedido": ""}],
    "prazos": [{"data": "10/10", "o_que": "fechar com o EC"}],
    "decisoes_riscos": [], "anexos_mencionados": [], "proximos_passos": ["Validar e responder à Ana"],
}


def _rd_llm(monkeypatch):
    calls = {"n": 0}

    def fake(prompt, **kw):
        calls["n"] += 1
        calls["prompt"] = prompt
        return json.dumps(_RD)

    monkeypatch.setattr(llm, "complete", fake)
    monkeypatch.setattr(gmail_client, "list_thread_attachments", lambda tid: {"files": [{"filename": "proposta.pdf"}]})
    return calls


def test_resumo_detalhado_gera_e_salva(monkeypatch):
    _thread()
    calls = _rd_llm(monkeypatch)
    out = TestClient(app).get("/api/copilot/t1/resumo-detalhado").json()
    assert calls["n"] == 1 and out["cached"] is False and out["desatualizado"] is False and out["gerado_em"]
    assert out["resumo"]["pedidos_ao_leo"] == ["Validar o roteamento do pix estático"]
    assert out["resumo"]["pedidos_a_outros"] == [{"nome": "Douglas", "pedido": "enviar o prazo"}]  # vazio cai
    assert "proposta.pdf" in calls["prompt"] and "pix estático até 10/10" in calls["prompt"]
    assert store.get_copilot_resumo("t1")["msg_count_snapshot"] == 1


def test_resumo_detalhado_reabrir_usa_cache(monkeypatch):
    _thread()
    calls = _rd_llm(monkeypatch)
    client = TestClient(app)
    first = client.get("/api/copilot/t1/resumo-detalhado").json()
    second = client.get("/api/copilot/t1/resumo-detalhado").json()
    assert calls["n"] == 1
    assert second["cached"] is True and second["resumo"] == first["resumo"] and second["gerado_em"] == first["gerado_em"]


def test_resumo_detalhado_mensagem_nova_invalida(monkeypatch):
    _thread()
    calls = _rd_llm(monkeypatch)
    copilot.resumo_detalhado("t1")
    _thread(date=20, body=BODY + "\n\n----\n\nDe: Ana Souza <ana@x.com>\nData: 2026-10-02\n\nLeo, alguma novidade sobre isso?")
    out = copilot.resumo_detalhado("t1")
    assert calls["n"] == 2 and out["cached"] is False
    assert store.get_copilot_resumo("t1")["msg_count_snapshot"] == 2


def test_resumo_detalhado_regerar_forca(monkeypatch):
    _thread()
    calls = _rd_llm(monkeypatch)
    client = TestClient(app)
    client.get("/api/copilot/t1/resumo-detalhado")
    assert client.post("/api/copilot/t1/resumo-detalhado").json()["cached"] is False
    assert client.get("/api/copilot/t1/resumo-detalhado?regerar=1").json()["cached"] is False
    assert calls["n"] == 3


def test_resumo_detalhado_credencial_nao_vai_para_ia(monkeypatch):
    _thread(body="De: Ana <ana@x.com>\nData: x\n\nLeo, segue o acesso do painel. usuário: ana / senha: Abc12345 pode validar?")
    monkeypatch.setattr(llm, "complete", lambda *a, **k: (_ for _ in ()).throw(AssertionError("não chama IA")))
    res = TestClient(app).get("/api/copilot/t1/resumo-detalhado")
    assert res.status_code == 400 and "credencial" in res.json()["detail"]
    assert store.get_copilot_resumo("t1") is None


def test_resumo_detalhado_sem_chave_erro_amigavel(monkeypatch):
    _thread()
    monkeypatch.setattr(llm, "has_key", lambda: False)
    res = TestClient(app).get("/api/copilot/t1/resumo-detalhado")
    assert res.status_code == 400 and "chave de IA" in res.json()["detail"]


def test_resumo_detalhado_falha_da_ia_mantem_cache_velho(monkeypatch):
    _thread()
    _rd_llm(monkeypatch)
    copilot.resumo_detalhado("t1")
    _thread(date=20, body=BODY + "\n\n----\n\nDe: Ana Souza <ana@x.com>\nData: 2026-10-02\n\nLeo, alguma novidade sobre isso?")
    monkeypatch.setattr(llm, "complete", lambda *a, **k: (_ for _ in ()).throw(llm.LLMError("fora do ar")))
    out = copilot.resumo_detalhado("t1")
    assert out["cached"] is True and out["desatualizado"] is True and "IA não respondeu" in out["aviso"]


# ── envio resolve; a própria resposta do Leo nunca reabre ──
_T_ANA = "2026-10-07 15:54"
_T_LEO = "2026-10-07 16:13"
_T_PAULO = "2026-10-07 17:30"
_ANA_MSG = f"De: Ana Souza <ana@x.com>\nData: {_T_ANA}\n\nLeo, você pode validar o roteamento do pix estático até 10/10? Precisamos fechar com o EC."


def _ms(when: str) -> int:
    return copilot._msg_ts(when)


def _read_by_ai(tid="t1"):
    """Thread com a mensagem da Ana, já lida pela IA (retrato no internal_date dela)."""
    row = _thread(tid, body=_ANA_MSG, date=_ms(_T_ANA))
    copilot._persist(row, {**copilot.heuristic(row, _ANA_MSG), "source": "llm"}, None, _ANA_MSG)
    return row


def _arrives(tid, *, sender, when, text, from_me):
    """Simula o refresh_thread do Gmail: mensagem nova no fim da thread."""
    row = store.get_thread(tid)
    name = "Leo" if from_me else sender.split("@")[0].capitalize()
    body = f"{row['body_text']}\n\n----\n\nDe: {name} <{sender}>\nData: {when}\n\n{text}"
    store.upsert_thread({**{k: row[k] for k in ("id", "subject", "from_name", "snippet", "is_automatic", "is_marketing",
                                                 "needs_action_hint", "awaiting_reply", "conferido", "hidden", "hide_as_replied",
                                                 "to_header", "cc_header")},
                         "labels_json": [], "from_email": sender, "internal_date": _ms(when), "is_unread": 0 if from_me else 1,
                         "last_from_me": int(from_me), "last_from_header": f"{name} <{sender}>"})
    store.save_ai(tid, body_text=body)


@pytest.fixture
def _send_resolve(_send_env, monkeypatch):
    """Envio mockado em que o refresh pós-envio traz a mensagem do próprio Leo."""
    read_calls = []
    monkeypatch.setattr(gmail_client, "mark_threads_read", lambda ids: read_calls.append(list(ids)) or len(ids))
    monkeypatch.setattr(gmail_client, "refresh_thread",
                        lambda tid: _arrives(tid, sender=ME, when=_T_LEO, text="Valido até sexta.", from_me=True))
    return read_calls


def test_send_resolves_marks_read_and_takes_post_send_snapshot(_send_resolve):
    _read_by_ai()
    res = TestClient(app).post("/api/threads/t1/send", json={"text": "Valido até sexta.", "source": "copilot"})
    assert res.status_code == 200
    assert _send_resolve == [["t1"]], "marca lido no Gmail"
    item = store.get_copilot_item("t1")
    assert item["status"] == "resolvido"
    assert int(item["internal_date_snapshot"]) == _ms(_T_LEO), "retrato pós-envio"
    assert int(item["msg_count_snapshot"]) == 2
    assert store.get_thread("t1")["is_unread"] == 0
    det = TestClient(app).get("/api/copilot/t1").json()
    assert det["status"] == "resolvido" and det["desatualizado"] is False


def test_own_reply_never_reopens_on_reread(monkeypatch):
    # retrato velho (antes do envio, ex.: versão antiga sem snapshot pós-envio) + mensagem do Leo depois
    _read_by_ai()
    store.save_copilot_item("t1", status="resolvido")
    _arrives("t1", sender=ME, when=_T_LEO, text="Valido até sexta.", from_me=True)
    row, prev = store.get_thread("t1"), store.get_copilot_item("t1")
    assert copilot._fresh(row, prev), "não volta para a fila da IA"
    assert "t1" not in copilot.candidates()
    assert copilot._present(row, prev)["desatualizado"] is False
    _llm(monkeypatch, {"papel": "demanda", "o_que_aconteceu": "Leo respondeu.", "o_que_eu_faria": []})
    det = copilot.analyze("t1", force=True)  # "Ler de novo" / readNow
    assert det["status"] == "resolvido" and det["desatualizado"] is False
    item = store.get_copilot_item("t1")
    assert item["status"] == "resolvido" and int(item["internal_date_snapshot"]) == _ms(_T_LEO)


def test_new_message_from_someone_else_after_reply_reopens(monkeypatch):
    _read_by_ai()
    _arrives("t1", sender=ME, when=_T_LEO, text="Valido até sexta.", from_me=True)
    copilot.resolve_after_send("t1")
    assert store.get_copilot_item("t1")["status"] == "resolvido"
    _arrives("t1", sender="paulo@x.com", when=_T_PAULO, text="Leo, e o EC 123? Consegue ver hoje?", from_me=False)
    row, prev = store.get_thread("t1"), store.get_copilot_item("t1")
    assert not copilot._fresh(row, prev) and copilot._present(row, prev)["desatualizado"] is True
    _llm(monkeypatch, {"papel": "demanda", "o_que_aconteceu": "Paulo pediu o EC 123.", "o_que_eu_faria": []})
    assert copilot.analyze("t1", force=True)["status"] == "aberto"


def test_someone_else_then_leo_still_counts_as_new():
    # Paulo escreveu e o Leo respondeu fora do app antes da releitura: a do Paulo é novidade para a IA
    _read_by_ai()
    store.save_copilot_item("t1", status="resolvido")
    _arrives("t1", sender="paulo@x.com", when=_T_PAULO, text="E o EC 123?", from_me=False)
    _arrives("t1", sender=ME, when="2026-10-07 18:00", text="Vejo amanhã.", from_me=True)
    row, prev = store.get_thread("t1"), store.get_copilot_item("t1")
    assert copilot._present(row, prev)["desatualizado"] is True


# ── "Resumir este e-mail": uma mensagem só, direto ou abrangente, em cache ──
_MR_BODY = (
    "De: Ana Souza <ana@x.com>\nData: 2026-10-01 09:00\n\n"
    "Leo, segue o fechamento de setembro: 1.240 transações, R$ 98.300,00. Conferir divergência do EC 4471.\n\n----\n\n"
    "De: Paulo Lima <paulo@x.com>\nData: 2026-10-02 10:00\n\n"
    "Leo, preciso que você aprove o repasse de R$ 12.000,00 até sexta 10/10. O Douglas confirma o lote.\n\n"
    "Em qua., 1 de out. de 2026 às 09:00, Ana Souza <ana@x.com> escreveu:\n"
    "> Leo, segue o fechamento de setembro: 1.240 transações, R$ 98.300,00.\n\n----\n\n"
    "De: Bia Reis <bia@x.com>\nData: 2026-10-03 11:00\n\n"
    "Pessoal, a reunião de alinhamento do roteamento ficou para quinta às 15h."
)
_MR_DIRETO = {"principal": "Paulo pede aprovação do repasse", "bullets": ["Aprovar repasse de R$ 12.000,00", "Prazo 10/10", "Douglas confirma o lote", "  "]}
_MR_ABR = {
    "contexto": "Paulo pede aprovação.", "pontos_principais": ["Aprovar repasse"], "numeros_dados": ["R$ 12.000,00 — repasse"],
    "pedidos_por_pessoa": [{"nome": "Você", "pedido": "aprovar o repasse"}, {"nome": "x", "pedido": ""}],
    "prazos": [{"data": "10/10", "o_que": "aprovar"}], "riscos": [],
}


def _mr_llm(monkeypatch):
    calls = {"n": 0, "prompts": []}

    def fake(prompt, **kw):
        calls["n"] += 1
        calls["prompts"].append(prompt)
        calls["system"] = kw.get("system")
        return json.dumps(_MR_DIRETO if '"bullets"' in prompt else _MR_ABR)

    monkeypatch.setattr(llm, "complete", fake)
    return calls


def _mr_url(idx=1, tid="t1"):
    return f"/api/copilot/{tid}/mensagens/{idx}/resumo"


def test_resumo_mensagem_direto_gera_e_salva(monkeypatch):
    _thread(body=_MR_BODY)
    calls = _mr_llm(monkeypatch)
    out = TestClient(app).post(_mr_url(), json={"modo": "direto"}).json()
    assert calls["n"] == 1 and calls["system"] == llm.SYSTEM
    assert out["cached"] is False and out["modo"] == "direto" and out["idx"] == 1 and out["gerado_em"]
    assert out["resumo"]["principal"] == "Paulo pede aprovação do repasse"
    assert out["resumo"]["bullets"] == ["Aprovar repasse de R$ 12.000,00", "Prazo 10/10", "Douglas confirma o lote"]
    digest = copilot._msg_resumo_target("t1", 1, "direto")[4]
    assert json.loads(store.get_copilot_msg_resumo("t1", digest, "direto")["resumo_json"]) == out["resumo"]


def test_resumo_mensagem_abrangente_gera_e_salva(monkeypatch):
    _thread(body=_MR_BODY)
    calls = _mr_llm(monkeypatch)
    out = TestClient(app).post(_mr_url(), json={"modo": "abrangente"}).json()
    assert calls["n"] == 1 and out["modo"] == "abrangente" and out["cached"] is False
    assert out["resumo"]["pedidos_por_pessoa"] == [{"nome": "Você", "pedido": "aprovar o repasse"}]  # vazio cai
    assert out["resumo"]["prazos"] == [{"data": "10/10", "o_que": "aprovar"}] and out["resumo"]["contexto"]
    assert "pedidos_por_pessoa" in calls["prompts"][0] and "riscos" in calls["prompts"][0]


def test_resumo_mensagem_segunda_chamada_usa_cache_e_regerar_forca(monkeypatch):
    _thread(body=_MR_BODY)
    calls = _mr_llm(monkeypatch)
    client = TestClient(app)
    first = client.post(_mr_url(), json={"modo": "direto"}).json()
    second = client.post(_mr_url(), json={"modo": "direto"}).json()
    assert calls["n"] == 1 and second["cached"] is True and second["resumo"] == first["resumo"]
    assert second["gerado_em"] == first["gerado_em"]
    # GET só consulta o cache (nunca chama a IA)
    assert client.get(_mr_url() + "?modo=direto").json()["cached"] is True
    assert client.get(_mr_url() + "?modo=abrangente").json()["resumo"] is None and calls["n"] == 1
    # outro modo é outro cache
    client.post(_mr_url(), json={"modo": "abrangente"})
    assert calls["n"] == 2
    again = client.post(_mr_url(), json={"modo": "direto", "regerar": True}).json()
    assert calls["n"] == 3 and again["cached"] is False


def test_resumo_mensagem_texto_mudou_regenera(monkeypatch):
    _thread(body=_MR_BODY)
    calls = _mr_llm(monkeypatch)
    copilot.resumo_mensagem("t1", 1, "direto")
    _thread(body=_MR_BODY.replace("R$ 12.000,00", "R$ 15.000,00", 1))
    copilot.resumo_mensagem("t1", 1, "direto")
    assert calls["n"] == 2
    # outra mensagem nova no fim não muda o texto da mensagem 1: cache vale
    _thread(body=_MR_BODY.replace("R$ 12.000,00", "R$ 15.000,00", 1) + "\n\n----\n\nDe: Ana <ana@x.com>\nData: 2026-10-04\n\nOk, obrigado a todos.")
    assert copilot.resumo_mensagem("t1", 1, "direto")["cached"] is True and calls["n"] == 2


def test_resumo_mensagem_so_o_texto_daquela_mensagem_vai_ao_prompt(monkeypatch):
    _thread(body=_MR_BODY, cc="bia@x.com")
    calls = _mr_llm(monkeypatch)
    TestClient(app).post(_mr_url(), json={"modo": "abrangente"})
    p = calls["prompts"][0]
    assert "aprove o repasse de R$ 12.000,00" in p
    assert "Paulo Lima <paulo@x.com>" in p and "2026-10-02 10:00" in p and "bia@x.com" in p  # remetente/data/destinatários
    assert "1.240 transações" not in p and "escreveu:" not in p  # nem a msg 0 nem o histórico citado
    assert "reunião de alinhamento" not in p  # nem a msg 2
    assert "2 de 3" in p


def test_resumo_mensagem_idx_invalido_404_e_modo_invalido_400(monkeypatch):
    _thread(body=_MR_BODY)
    calls = _mr_llm(monkeypatch)
    client = TestClient(app)
    assert client.post(_mr_url(3), json={"modo": "direto"}).status_code == 404
    assert client.post(_mr_url(-1), json={"modo": "direto"}).status_code == 404
    assert client.post(_mr_url(0, tid="nao-existe"), json={"modo": "direto"}).status_code == 404
    res = client.post(_mr_url(), json={"modo": "poema"})
    assert res.status_code == 400 and "Modo" in res.json()["detail"]
    assert client.get(_mr_url() + "?modo=poema").status_code == 400
    assert calls["n"] == 0


def test_resumo_mensagem_credencial_nao_vai_para_ia(monkeypatch):
    body = _MR_BODY.replace("O Douglas confirma o lote.", "Acesso do painel: usuário: paulo / senha: Abc12345")
    _thread(body=body)
    monkeypatch.setattr(llm, "complete", lambda *a, **k: (_ for _ in ()).throw(AssertionError("não chama IA")))
    res = TestClient(app).post(_mr_url(), json={"modo": "direto"})
    assert res.status_code == 400 and "credencial" in res.json()["detail"]
    # a mensagem sem credencial continua resumível (o guarda olha só a mensagem que vai)
    calls = _mr_llm(monkeypatch)
    assert TestClient(app).post(_mr_url(2), json={"modo": "direto"}).status_code == 200 and calls["n"] == 1


def test_resumo_mensagem_sem_chave_erro_amigavel(monkeypatch):
    _thread(body=_MR_BODY)
    monkeypatch.setattr(llm, "has_key", lambda: False)
    res = TestClient(app).post(_mr_url(), json={"modo": "direto"})
    assert res.status_code == 400 and "chave de IA" in res.json()["detail"]


def test_frontend_has_per_message_summary():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "static"
    mod = (root / "msgsummary.js").read_text(encoding="utf-8")
    assert "/mensagens/" in mod and "Resumir este e-mail" in mod and "Resumindo…" in mod
    for page, js in (("copilot.html", "copilot.js"), ("index.html", "app.js")):
        assert "/static/msgsummary.js" in (root / page).read_text(encoding="utf-8")
        assert "MsgSummary" in (root / js).read_text(encoding="utf-8")
