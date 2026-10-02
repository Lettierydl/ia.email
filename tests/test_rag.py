from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app import config, rag, store
from app.main import app


@pytest.fixture
def kb(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    monkeypatch.setattr(config, "RAG_DB_PATH", tmp_path / "rag.sqlite")
    store.init()
    rag._last_sync = time.time()  # evita reindexar sozinho no meio do teste
    root = tmp_path / "base"
    root.mkdir()
    store.save_settings(context_global_paths=[str(root)])
    return root


def _thread(thread_id: str, subject: str, body: str):
    store.upsert_thread(
        {
            "id": thread_id, "subject": subject, "from_email": "x@y.com", "from_name": "X",
            "snippet": "", "internal_date": 1, "is_unread": 0, "last_from_me": 0,
            "is_automatic": 0, "is_marketing": 0, "needs_action_hint": 0, "awaiting_reply": 0,
            "conferido": 1, "hidden": 0, "hide_as_replied": 0, "last_from_header": "",
            "labels_json": [],
        }
    )
    store.save_ai(thread_id, body_text=body)


def test_chunk_markdown_splits_by_heading():
    chunks = rag.chunk_markdown("# A\ntexto a\n\n## B\ntexto b")
    assert [h for h, _ in chunks] == ["A", "B"]


def test_search_is_accent_insensitive(kb):
    (kb / "pix.md").write_text("# PIX\nPix estático: encerrar com o EC e pedir reanálise.")
    rag.sync()
    hits = rag.search("como tratar pix estatico")
    assert hits and hits[0]["source"] == "kb"
    assert "pix.md" in hits[0]["title"]


def test_secret_and_ephemeral_files_are_never_indexed(kb):
    (kb / "credenciais").mkdir()
    (kb / "credenciais" / "chaves.md").write_text("segredoultrasecreto")
    (kb / "radar-contextos").mkdir()
    (kb / "radar-contextos" / "export.md").write_text("exportacaotemporaria")
    (kb / "senha-banco.md").write_text("segredodebanco")
    (kb / "ok.md").write_text("conteudolegitimo")
    rag.sync()
    assert rag.search("segredoultrasecreto") == []
    assert rag.search("exportacaotemporaria") == []
    assert rag.search("segredodebanco") == []
    assert rag.search("conteudolegitimo")


def test_sync_is_incremental(kb):
    f = kb / "a.md"
    f.write_text("alfa bravo")
    assert rag.sync()["added"] == 1
    assert rag.sync() == {"added": 0, "updated": 0, "removed": 0}
    f.write_text("alfa charlie delta")
    assert rag.sync()["updated"] == 1
    assert rag.search("delta")
    f.unlink()
    assert rag.sync()["removed"] == 1
    assert rag.search("delta") == []


def test_mail_is_indexed_and_current_thread_can_be_excluded(kb):
    body = (
        "De: Fulano <fulano@x.com>\nData: 2026-09-01\n\nPrecisamos decidir o roteamento do boleto zeta.\n\n----\n\n"
        f"De: Leo <{config.ACCOUNT}>\nData: 2026-09-02\n\nDecisão: manteremos o roteamento do boleto zeta no F6."
    )
    _thread("t1", "Roteamento", body)
    rag.sync()
    sources = {h["source"] for h in rag.search("roteamento boleto zeta")}
    assert sources == {"mail", "mail_sent"}
    assert rag.search("roteamento boleto zeta", exclude_ref="mail:t1") == []


def test_quoted_history_is_not_indexed(kb):
    body = (
        "De: A <a@x.com>\nData: 2026-09-01\n\nResposta nova sobre prazos do projeto.\n\n"
        "Em 01/09, B escreveu:\n> zzcitadozz antigo que não deve entrar"
    )
    _thread("t2", "Prazos", body)
    rag.sync()
    assert rag.search("zzcitadozz") == []
    assert rag.search("prazos projeto")


def test_build_query_drops_stopwords_and_short_words():
    q = rag.build_query("Olá, o pix da conta de teste")
    assert '"pix"' in q and '"conta"' in q and '"teste"' in q
    assert '"olá"' not in q and '"da"' not in q


def test_search_never_raises_when_index_is_broken(kb, tmp_path, monkeypatch):
    broken = tmp_path / "broken.sqlite"
    broken.write_bytes(b"isto nao e um banco sqlite" * 50)
    monkeypatch.setattr(config, "RAG_DB_PATH", broken)
    assert rag.search("qualquer coisa importante") == []


def test_rag_api_endpoints(kb):
    (kb / "n.md").write_text("# Regra\nCompras acima de mil exigem copia para o financeiro.")
    client = TestClient(app)
    assert client.post("/api/rag/reindex").json()["stats"]["added"] == 1
    items = client.get("/api/rag/search", params={"q": "compras financeiro"}).json()["items"]
    assert items and items[0]["source"] == "kb"
    assert client.get("/api/rag/status").json()["documents"] == 1


def test_personal_knowledge_is_excluded_unless_opted_in(kb):
    (kb / "lb-personal").mkdir()
    (kb / "lb-personal" / "financas.md").write_text("reembolsopessoalxyz")
    (kb / "lb-company").mkdir()
    (kb / "lb-company" / "regra.md").write_text("regradeempresaxyz")
    rag.sync()
    assert rag.search("reembolsopessoalxyz") == []
    assert rag.search("regradeempresaxyz")
    store.save_settings(rag_include_personal=True)
    rag.sync()
    assert rag.search("reembolsopessoalxyz")
    store.save_settings(rag_include_personal=False)
    assert rag.sync()["removed"] == 1
    assert rag.search("reembolsopessoalxyz") == []


def test_a_single_file_chosen_in_the_picker_is_indexed_and_read(kb):
    only = kb / "so-este.md"
    only.write_text("# Regra\nconteudounicoarquivo")
    (kb / "outro.md").write_text("conteudodeoutroarquivo")
    store.save_settings(context_global_paths=[str(only)])
    rag.sync()
    assert rag.search("conteudounicoarquivo")
    assert rag.search("conteudodeoutroarquivo") == []

    from app import context_base

    files = context_base.list_context_files([str(only)])
    assert [f["path"] for f in files] == [str(only)]
