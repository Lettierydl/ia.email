from __future__ import annotations

import httpx

from . import store
from .config import _first_env

SYSTEM = """Você é o assistente de e-mail do Leo (Lettiery D'Lamare, leo@confrapag.com.br),
TI/Confrapag. Português do Brasil. Direto, com fato. Não use 'urgente' sem prazo real.
Não invente dado. Assinatura: Atenciosamente, Lettiery D'Lamare.
Resposta só ao remetente, sem reply-all, salvo se a instrução pedir.
"""

_LABELS = {
    "anthropic": "Claude",
    "gemini": "Gemini",
    "openrouter": "OpenRouter",
}


def _keys() -> dict[str, str]:
    return {
        "anthropic": _first_env("ANTHROPIC_API_KEY"),
        "gemini": _first_env("GOOGLE_API_KEY", "GEMINI_API_KEY"),
        "openrouter": _first_env("OPENROUTER_API_KEY"),
    }


def provider() -> str:
    forced = _first_env("RADAR_LLM_PROVIDER").strip().lower()
    aliases = {"claude": "anthropic", "google": "gemini"}
    forced = aliases.get(forced, forced)
    keys = _keys()
    if forced in keys and keys[forced]:
        return forced
    for name in ("anthropic", "gemini", "openrouter"):
        if keys[name]:
            return name
    return "openrouter"


def provider_label() -> str:
    if not has_key():
        return ""
    return _LABELS.get(provider(), provider())


def model() -> str:
    active = provider()
    if active == "anthropic":
        return _first_env("ANTHROPIC_MODEL") or "claude-sonnet-5"
    if active == "gemini":
        return _first_env("GEMINI_MODEL") or "gemini-flash-latest"
    return _first_env("OPENROUTER_MODEL") or "deepseek/deepseek-chat-v3-0324:free"


def has_key() -> bool:
    return any(_keys().values())


def complete(user: str, *, system: str = SYSTEM, timeout: float = 45.0) -> str:
    active = provider()
    if active == "anthropic":
        return _complete_anthropic(user, system, timeout)
    if active == "gemini":
        return _complete_gemini(user, system, timeout)
    return _complete_openrouter(user, system, timeout)


def _complete_anthropic(user: str, system: str, timeout: float) -> str:
    key = _first_env("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("Falta ANTHROPIC_API_KEY no .env do cérebro.")
    response = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        json={
            "model": model(),
            "max_tokens": 2000,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    usage = data.get("usage") or {}
    store.add_llm_usage(int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0)))
    parts = data.get("content") or []
    return "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()


def _complete_gemini(user: str, system: str, timeout: float) -> str:
    key = _first_env("GOOGLE_API_KEY", "GEMINI_API_KEY")
    if not key:
        raise RuntimeError("Falta GOOGLE_API_KEY (ou GEMINI_API_KEY) no .env do cérebro.")
    response = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model()}:generateContent",
        params={"key": key},
        json={
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
        },
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    store.add_llm_usage(int((data.get("usageMetadata") or {}).get("totalTokenCount", 0)))
    candidates = data.get("candidates") or []
    if not candidates:
        return ""
    parts = candidates[0].get("content", {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts).strip()


def _complete_openrouter(user: str, system: str, timeout: float) -> str:
    key = _first_env("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("Falta OPENROUTER_API_KEY no .env do cérebro.")
    response = httpx.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model(),
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        },
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    store.add_llm_usage(int((data.get("usage") or {}).get("total_tokens", 0)))
    return (data["choices"][0]["message"]["content"] or "").strip()
