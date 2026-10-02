from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app import llm, store
from app.main import app


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    store.init()
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-secret")
    monkeypatch.setenv("GOOGLE_API_KEY", "g-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("RADAR_LLM_PROVIDER", raising=False)
    llm._COOLDOWN.clear()
    llm._COOLDOWN_WHY.clear()


def _gemini_ok(text="resposta gemini"):
    return {"candidates": [{"content": {"parts": [{"text": text}]}}], "usageMetadata": {"totalTokenCount": 3}}


def _or_ok(text="resposta openrouter"):
    return {"choices": [{"message": {"content": text}}], "usage": {"total_tokens": 5}}


def _fake(monkeypatch, behaviour):
    calls = []

    def fake_post(provider, url, secret, **kwargs):
        model = kwargs["json"].get("model") or url.split("/models/")[-1].split(":")[0]
        calls.append((provider, model))
        return behaviour(provider, model)

    monkeypatch.setattr(llm, "_post", fake_post)
    return calls


def test_default_chain_has_gemini_first_then_free_openrouter():
    assert llm.chain()[0] == "gemini:gemini-flash-latest"
    assert all(e.startswith("openrouter:") for e in llm.chain()[1:])


def test_gemini_answers_first_when_healthy(monkeypatch):
    calls = _fake(monkeypatch, lambda p, m: _gemini_ok() if p == "gemini" else _or_ok())
    assert llm.complete("oi") == "resposta gemini"
    assert calls == [("gemini", "gemini-flash-latest")]
    assert llm.last_used()["name"] == "Gemini Flash (Google)"


def test_falls_to_openrouter_when_gemini_is_billing_blocked(monkeypatch):
    def behaviour(provider, model):
        if provider == "gemini":
            raise llm.LLMError("Gemini recusou a chamada (HTTP 403): dunning", status=403)
        return _or_ok()

    calls = _fake(monkeypatch, behaviour)
    assert llm.complete("oi") == "resposta openrouter"
    assert calls[0][0] == "gemini" and calls[1][0] == "openrouter"
    skipped = llm.last_used()["skipped"]
    assert skipped[0]["name"] == "Gemini Flash (Google)" and "403" in skipped[0]["reason"]


def test_model_that_failed_with_quota_error_is_skipped_for_a_while(monkeypatch):
    def behaviour(provider, model):
        if provider == "gemini":
            raise llm.LLMError("cota estourada", status=429)
        return _or_ok()

    calls = _fake(monkeypatch, behaviour)
    llm.complete("um")
    llm.complete("dois")
    assert [c for c in calls if c[0] == "gemini"] == [("gemini", "gemini-flash-latest")]
    paused = llm.last_used()["skipped"][0]
    assert paused["name"] == "Gemini Flash (Google)" and "em pausa" in paused["reason"] and "cota" in paused["reason"]


def test_empty_answer_counts_as_failure(monkeypatch):
    store.save_settings(llm_models=["openrouter:a/free", "openrouter:b/free"])
    _fake(monkeypatch, lambda p, m: _or_ok("") if m == "a/free" else _or_ok("tem texto"))
    assert llm.complete("oi") == "tem texto"


def test_all_failing_raises_with_every_reason(monkeypatch):
    store.save_settings(llm_models=["openrouter:a/free", "openrouter:b/free"])

    def behaviour(provider, model):
        raise llm.LLMError("fora do ar")

    _fake(monkeypatch, behaviour)
    with pytest.raises(RuntimeError) as exc:
        llm.complete("oi")
    assert "Nenhum modelo respondeu" in str(exc.value)
    assert "A (" in str(exc.value) or "Free" in str(exc.value) or "fora do ar" in str(exc.value)


def test_provider_without_key_is_skipped(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    calls = _fake(monkeypatch, lambda p, m: _or_ok())
    llm.complete("oi")
    assert all(c[0] == "openrouter" for c in calls)


def test_legacy_entries_without_provider_are_treated_as_openrouter():
    assert llm.normalize_entry("nvidia/nemotron-3-super-120b-a12b:free") == (
        "openrouter:nvidia/nemotron-3-super-120b-a12b:free"
    )
    assert llm.normalize_entry("gemini:gemini-flash-latest") == "gemini:gemini-flash-latest"


def test_human_readable_names():
    assert llm.display_name("gemini:gemini-flash-latest") == "Gemini Flash (Google)"
    assert llm.display_name("openrouter:nvidia/nemotron-3-super-120b-a12b:free") == "Nemotron 3 Super 120B A12B (NVIDIA)"
    assert llm.humanize_openrouter("x/y", "NVIDIA: Nemotron 3 Super (free)") == "Nemotron 3 Super (NVIDIA)"


def test_error_message_never_contains_the_api_key(monkeypatch):
    class FakeResponse:
        status_code = 403
        text = "forbidden for key g-secret"

        def json(self):
            return {"error": {"message": "bad key g-secret"}}

    monkeypatch.setattr(llm.httpx, "post", lambda *a, **k: FakeResponse())
    with pytest.raises(RuntimeError) as exc:
        llm._post("gemini", "https://x.test/v1?key=g-secret", "g-secret")
    assert "g-secret" not in str(exc.value)
    assert "403" in str(exc.value)


def test_models_setting_round_trips_and_normalizes_through_api():
    client = TestClient(app)
    res = client.post("/api/settings", json={"llm_models": ["x/one:free", "gemini:gemini-flash-latest", "x/one:free"]})
    assert res.status_code == 200
    cfg = client.get("/api/llm/config").json()
    assert [m["entry"] for m in cfg["models"]] == ["openrouter:x/one:free", "gemini:gemini-flash-latest"]
    assert cfg["models"][1]["name"] == "Gemini Flash (Google)"
    assert cfg["is_default"] is False


def test_last_used_survives_old_records_without_name():
    store.set_meta(
        "llm_last_used",
        json.dumps({"model": "nvidia/nemotron-3-super-120b-a12b:free", "seconds": 3, "skipped": ["a/b: erro"]}),
    )
    last = llm.last_used()
    assert last["name"] == "Nemotron 3 Super 120B A12B (NVIDIA)"
    assert last["skipped"] == [{"name": "a/b", "reason": ""}]


def test_noise_suffix_is_dropped_from_derived_names():
    assert llm.display_name("openrouter:google/gemma-4-31b-it:free") == "Gemma 4 31B (Google)"


def _capture_post(monkeypatch, behaviour=None):
    sent = []

    def fake_post(provider, url, secret, **kwargs):
        sent.append(json.loads(json.dumps(kwargs["json"])))  # cópia: o código altera o dict entre tentativas
        if behaviour:
            return behaviour(len(sent))
        return _or_ok("ok")

    monkeypatch.setattr(llm, "_post", fake_post)
    return sent


def test_openrouter_reasoning_is_off_by_default_and_can_be_turned_on(monkeypatch):
    sent = _capture_post(monkeypatch)
    llm._call_openrouter("a/free", "oi", "sys", 5)
    assert sent[-1]["reasoning"] == {"enabled": False}
    store.save_settings(llm_reasoning=True)
    llm._call_openrouter("a/free", "oi", "sys", 5)
    assert "reasoning" not in sent[-1]


def test_model_that_cannot_disable_reasoning_is_retried_without_the_flag(monkeypatch):
    def behaviour(n):
        if n == 1:
            raise llm.LLMError("OpenRouter recusou a chamada (HTTP 400): Reasoning is mandatory for this endpoint", status=400)
        return _or_ok("deu certo")

    sent = _capture_post(monkeypatch, behaviour)
    assert llm._call_openrouter("a/free", "oi", "sys", 5) == "deu certo"
    assert "reasoning" in sent[0] and "reasoning" not in sent[1]


def test_unrelated_400_errors_are_not_retried(monkeypatch):
    def behaviour(n):
        raise llm.LLMError("OpenRouter recusou a chamada (HTTP 400): modelo inexistente", status=400)

    sent = _capture_post(monkeypatch, behaviour)
    with pytest.raises(llm.LLMError):
        llm._call_openrouter("a/free", "oi", "sys", 5)
    assert len(sent) == 1


def test_gemini_thinking_is_disabled_only_for_flash_and_retried_if_rejected(monkeypatch):
    sent = _capture_post(monkeypatch, lambda n: _gemini_ok("g"))
    llm._call_gemini("gemini-flash-latest", "oi", "sys", 5)
    assert sent[-1]["generationConfig"]["thinkingConfig"]["thinkingBudget"] == 0
    llm._call_gemini("gemini-pro-latest", "oi", "sys", 5)
    assert "generationConfig" not in sent[-1], "o Pro não aceita orçamento 0"

    def behaviour(n):
        if n == 1:
            raise llm.LLMError("Gemini recusou a chamada (HTTP 400): thinking budget invalid", status=400)
        return _gemini_ok("sem a opção")

    sent = _capture_post(monkeypatch, behaviour)
    assert llm._call_gemini("gemini-flash-latest", "oi", "sys", 5) == "sem a opção"
    assert "generationConfig" in sent[0] and "generationConfig" not in sent[1]


def test_a_model_that_never_answers_is_abandoned_after_the_total_deadline(monkeypatch):
    import threading

    gate = threading.Event()

    def slow_post(url, **kwargs):
        gate.wait(5)
        raise AssertionError("não devia ter esperado por isso")

    monkeypatch.setattr(llm.httpx, "post", slow_post)
    started = time.time()
    with pytest.raises(llm.LLMError, match="demorou mais de 1s"):
        llm._post("openrouter", "https://x.test", "k", json={}, timeout=45, total_timeout=1)
    assert time.time() - started < 3
    gate.set()
