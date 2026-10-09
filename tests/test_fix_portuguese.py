"""Corrigir português (só correção, sem reescrever) e "Usar meu texto"."""
from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from app import assistant, fixpt, llm, store
from app.main import app

ORIGINAL = "Adriano, nao sei se e um incidente mas seria bom registrar"
FIXED = "Adriano, não sei se é um incidente, mas seria bom registrar."
REWRITE = "Bom dia, Ronalde. Obrigado pelo registro. Vamos analisar o caso com a equipe e retorno em breve."


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    store.init()
    store.save_settings(rag_enabled=False)
    monkeypatch.setattr(llm, "has_key", lambda: True)
    store.upsert_thread(
        {
            "id": "t1", "subject": "Incidente", "from_email": "ronalde@x.com", "from_name": "Ronalde",
            "snippet": "", "internal_date": 5, "is_unread": 0, "last_from_me": 0, "is_automatic": 0,
            "is_marketing": 0, "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 1,
            "hidden": 0, "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
        }
    )
    store.save_ai("t1", body_text="De: Ronalde <ronalde@x.com>\nData: 2026-10-08\n\nAconteceu de novo.",
                  draft="Bom dia, Ronalde.\n\nVou verificar.\n\nAbraço,\nLeo")


def _fake(seen, answer):
    def fake_complete(prompt, **kwargs):
        seen.setdefault("prompts", []).append(prompt)
        return answer(prompt) if callable(answer) else answer

    return fake_complete


def _words(s):
    return re.findall(r"\w+", s.lower())


# ── detector ──
@pytest.mark.parametrize(
    "instr, text",
    [
        ("Escreva da mesma forma:\nAdriano, não sei se é um incidente, mas seria bom registrar",
         "Adriano, não sei se é um incidente, mas seria bom registrar"),
        ("escreva exatamente isso: Pode seguir.", "Pode seguir."),
        ("Escreva exatamente assim: Pode seguir.", "Pode seguir."),
        ("use este texto: Combinado, obrigado.", "Combinado, obrigado."),
        ("Use meu texto: Combinado", "Combinado"),
        ("manda assim: Fechado!", "Fechado!"),
        ("Mande assim aqui: Fechado!", "Fechado!"),
        ("Por favor, escreva do mesmo jeito: \"Valeu, Paulo\"", "Valeu, Paulo"),
        ("Só corrija o português: nao vou poder", "nao vou poder"),
    ],
)
def test_keep_text_detector(instr, text):
    assert fixpt.keep_text_request(instr) == text


@pytest.mark.parametrize(
    "instr",
    ["mais curto", "Escreva isso de forma mais formal: obrigado", "Responda a Paulo: diga que sim",
     "diga que posso às 14h", "escreva da mesma forma", "Manda assim", ""],
)
def test_keep_text_detector_ignores_normal_requests(instr):
    assert fixpt.keep_text_request(instr) is None


# ── verificação defensiva ──
def test_check_accepts_corrections_and_rejects_rewrite():
    fixpt.check(ORIGINAL, FIXED)  # acento/pontuação: passa
    assert fixpt.similarity(ORIGINAL, FIXED) > 0.95
    with pytest.raises(fixpt.FixRejected):
        fixpt.check(ORIGINAL, REWRITE)
    with pytest.raises(fixpt.FixRejected):
        fixpt.check(ORIGINAL, ORIGINAL + " Fico no aguardo do retorno de vocês e agradeço desde já.")
    with pytest.raises(fixpt.FixRejected):
        fixpt.check(ORIGINAL, "")


def test_fix_keeps_words_only_corrections(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(llm, "complete", _fake(seen, f"```\n{FIXED}\n```"))
    res = fixpt.fix(ORIGINAL)
    assert res == {"text": FIXED, "changed": True}
    # mesmas palavras, na mesma ordem (só acento/pontuação)
    fold = lambda s: [fixpt._fold(w) for w in _words(s)]  # noqa: E731
    assert fold(res["text"]) == fold(ORIGINAL)
    p = seen["prompts"][0]
    assert "NÃO mude o tom" in p and "NÃO acrescente saudação" in p and ORIGINAL in p


# ── endpoint ──
def test_endpoint_whole_text(monkeypatch):
    monkeypatch.setattr(llm, "complete", _fake({}, FIXED))
    r = TestClient(app).post("/api/threads/t1/fix-portuguese", json={"text": ORIGINAL})
    assert r.status_code == 200, r.text
    assert r.json() == {"text": FIXED, "changed": True}
    # não salva nada (o front troca e o autosave grava)
    assert store.get_thread("t1")["draft"].startswith("Bom dia, Ronalde.")


def test_endpoint_passage_keeps_rest(monkeypatch):
    draft = f"Oi,\n\n{ORIGINAL}\n\nAbraço,\nLeo"
    start = draft.index(ORIGINAL)
    monkeypatch.setattr(llm, "complete", _fake({}, FIXED))
    r = TestClient(app).post("/api/threads/t1/fix-portuguese",
                             json={"draft": draft, "start": start, "end": start + len(ORIGINAL)})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["replacement"] == FIXED and d["start"] == start and d["end"] == start + len(ORIGINAL)


def test_endpoint_rejects_big_rewrite(monkeypatch):
    monkeypatch.setattr(llm, "complete", _fake({}, REWRITE))
    r = TestClient(app).post("/api/threads/t1/fix-portuguese", json={"text": ORIGINAL})
    assert r.status_code == 422
    assert "mudou demais" in r.json()["detail"]


def test_endpoint_bad_input(monkeypatch):
    monkeypatch.setattr(llm, "complete", _fake({}, FIXED))
    c = TestClient(app)
    assert c.post("/api/threads/t1/fix-portuguese", json={}).status_code == 400
    assert c.post("/api/threads/t1/fix-portuguese", json={"text": "   "}).status_code == 400
    assert c.post("/api/threads/t1/fix-portuguese", json={"draft": "abc", "start": 2, "end": 9}).status_code == 400


def test_endpoint_without_llm(monkeypatch):
    monkeypatch.setattr(llm, "has_key", lambda: False)
    r = TestClient(app).post("/api/threads/t1/fix-portuguese", json={"text": ORIGINAL})
    assert r.status_code == 400 and "LLM" in r.json()["detail"]


# ── /draft no modo "Usar meu texto" ──
def test_draft_escreva_da_mesma_forma_uses_leo_text(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(llm, "complete", _fake(seen, FIXED))
    instr = f"Escreva da mesma forma:\n{ORIGINAL}"
    r = TestClient(app).post("/api/threads/t1/draft", json={"instruction": instr})
    assert r.status_code == 200, r.text
    d = r.json()
    # o texto do Leo corrigido + a assinatura do rascunho atual (ele não escreveu uma)
    assert d["draft"] == f"{FIXED}\n\nAbraço,\nLeo"
    assert d["keep_text"] is True and d["corrigido"] is True and d["aviso"] == ""
    assert d["original"] == f"{ORIGINAL}\n\nAbraço,\nLeo"
    assert "Ronalde" not in d["draft"]
    # só uma chamada à IA, e é a de correção (não o prompt de rascunho)
    assert len(seen["prompts"]) == 1 and "revisor de português" in seen["prompts"][0]
    row = store.get_thread("t1")
    assert row["draft"] == d["draft"]
    chat = json.loads(row["chat_json"])
    assert chat[-2] == {"role": "user", "text": instr}
    assert chat[-1]["kind"] == "draft" and chat[-1]["keep_text"] is True


def test_draft_keep_text_flag_and_own_signature(monkeypatch):
    text = "Paulo, pode seguir\n\nAbs,\nLeo"
    monkeypatch.setattr(llm, "complete", _fake({}, "Paulo, pode seguir.\n\nAbs,\nLeo"))
    r = TestClient(app).post("/api/threads/t1/draft", json={"instruction": text, "keep_text": True})
    d = r.json()
    assert d["keep_text"] is True
    assert d["draft"] == "Paulo, pode seguir.\n\nAbs,\nLeo"  # já tinha assinatura: não duplica


def test_draft_keep_text_rejected_correction_keeps_original(monkeypatch):
    monkeypatch.setattr(llm, "complete", _fake({}, REWRITE))
    r = TestClient(app).post("/api/threads/t1/draft", json={"instruction": f"manda assim: {ORIGINAL}"})
    d = r.json()
    assert r.status_code == 200
    assert d["draft"] == f"{ORIGINAL}\n\nAbraço,\nLeo"
    assert d["corrigido"] is False and "mudou demais" in d["aviso"]


def test_draft_normal_request_unchanged(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(llm, "complete", _fake(seen, json.dumps({"kind": "draft", "text": "Oi Ronalde, tudo certo.", "cc_names": []})))
    d = TestClient(app).post("/api/threads/t1/draft", json={"instruction": "diga que está tudo certo"}).json()
    assert d["draft"] == "Oi Ronalde, tudo certo."
    assert "keep_text" not in d
    assert "revisor de português" not in seen["prompts"][0]


def test_draft_endpoint_passes_keep_text_only_when_set(monkeypatch):
    calls = []

    def fake_draft(thread_id, instruction, comment, **kw):
        calls.append(kw)
        return {"draft": "x", "chat": []}

    monkeypatch.setattr(assistant, "draft", fake_draft)
    c = TestClient(app)
    c.post("/api/threads/t1/draft", json={"instruction": "oi"})
    c.post("/api/threads/t1/draft", json={"instruction": "oi", "keep_text": True})
    assert "keep_text" not in calls[0] and calls[1]["keep_text"] is True


def test_signature_helpers():
    assert fixpt.signature_of("Oi,\n\nTexto.\n\nAtenciosamente,\nLeo") == "Atenciosamente,\nLeo"
    assert fixpt.signature_of("Oi,\n\nTexto longo sem despedida.") == ""
    assert fixpt.with_signature("Valeu", "") == "Valeu"


def test_pages_have_fix_button_and_option():
    c = TestClient(app)
    for path in ("/copilot", "/"):
        html = c.get(path).text
        assert 'id="select-fixpt"' in html
    assert 'id="pane-fixpt"' in c.get("/").text
