from __future__ import annotations

import concurrent.futures
import json
import re
import time
from datetime import datetime

import httpx

from . import store
from .config import _first_env

SYSTEM = """Você é o assistente de e-mail do Leo (Lettiery D'Lamare, leo@confrapag.com.br),
TI/Confrapag. Português do Brasil. Direto, com fato. Não use 'urgente' sem prazo real.
Não invente dado. Assinatura: Atenciosamente, Lettiery D'Lamare.
Resposta só ao remetente, sem reply-all, salvo se a instrução pedir.
"""

_LABELS = {"anthropic": "Claude", "gemini": "Gemini", "openrouter": "OpenRouter"}
_PROVIDERS = tuple(_LABELS)

# Cadeia padrão (quando nada foi escolhido nas Configurações): Gemini
# principal; se acabar a cota ou falhar, cai nos gratuitos do OpenRouter.
_DEFAULT_CHAIN = [
    "gemini:gemini-flash-latest",
    "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
    "openrouter:google/gemma-4-31b-it:free",
]

_MAX_FALLBACK_ATTEMPTS = 5
_COOLDOWN_SECONDS = 300
_COOLDOWN_STATUS = {401, 402, 403, 429}
_COOLDOWN: dict[str, float] = {}
_COOLDOWN_WHY: dict[str, str] = {}
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="llm")


class LLMError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def reasoning_enabled() -> bool:
    """Os modelos gratuitos disponíveis são de "raciocínio": gastam ~90% dos tokens
    pensando antes de responder (um resumo levava 26-64 s; sem isso, ~2 s). O
    padrão é DESLIGADO; dá pra ligar nas Configurações se a qualidade importar
    mais que a velocidade."""
    return bool(store.get_settings().get("llm_reasoning", False))


def _keys() -> dict[str, str]:
    return {
        "anthropic": _first_env("ANTHROPIC_API_KEY"),
        "gemini": _first_env("GOOGLE_API_KEY", "GEMINI_API_KEY"),
        "openrouter": _first_env("OPENROUTER_API_KEY"),
    }


def has_key() -> bool:
    return any(_keys().values())


# ── Cadeia de modelos ──
# Cada item é "provedor:modelo" (ex.: "gemini:gemini-flash-latest",
# "openrouter:nvidia/nemotron-3-super-120b-a12b:free"). Item sem provedor
# conhecido na frente (formato antigo) é tratado como OpenRouter.

def normalize_entry(entry: str) -> str:
    entry = (entry or "").strip()
    head = entry.split(":", 1)[0]
    return entry if head in _PROVIDERS and ":" in entry else f"openrouter:{entry}"


def parse_entry(entry: str) -> tuple[str, str]:
    provider, model_name = normalize_entry(entry).split(":", 1)
    return provider, model_name


def default_chain() -> list[str]:
    forced = _first_env("RADAR_LLM_PROVIDER").strip().lower()
    forced = {"claude": "anthropic", "google": "gemini"}.get(forced, forced)
    chain = list(_DEFAULT_CHAIN)
    if _keys()["anthropic"]:
        chain.append(f"anthropic:{_first_env('ANTHROPIC_MODEL') or 'claude-sonnet-5'}")
    if forced in _PROVIDERS:
        chain.sort(key=lambda e: 0 if e.split(":", 1)[0] == forced else 1)
    return chain


def chain() -> list[str]:
    configured = [normalize_entry(m) for m in (store.get_settings().get("llm_models") or []) if str(m).strip()]
    return configured or default_chain()


def usable_chain() -> list[str]:
    keys = _keys()
    return [e for e in chain() if keys.get(parse_entry(e)[0])]


def models_in_order() -> list[str]:
    return chain()


def provider() -> str:
    usable = usable_chain()
    return parse_entry(usable[0])[0] if usable else "openrouter"


def provider_label() -> str:
    return _LABELS.get(provider(), provider()) if has_key() else ""


def model() -> str:
    usable = usable_chain()
    return parse_entry(usable[0])[1] if usable else ""


# ── Nomes legíveis ──
_GEMINI_NAMES = {
    "gemini-flash-latest": "Gemini Flash",
    "gemini-flash-lite-latest": "Gemini Flash-Lite",
    "gemini-pro-latest": "Gemini Pro",
}
_CLAUDE_NAMES = {
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    "claude-opus-5-5": "Claude Opus 5.5",
    "claude-fable-5-1": "Claude Fable 5.1",
}
_VENDORS = {
    "nvidia": "NVIDIA", "google": "Google", "cohere": "Cohere", "meta-llama": "Meta", "mistralai": "Mistral",
    "deepseek": "DeepSeek", "qwen": "Qwen", "openai": "OpenAI", "anthropic": "Anthropic", "x-ai": "xAI",
    "microsoft": "Microsoft", "moonshotai": "Moonshot", "z-ai": "Z.ai", "poolside": "Poolside",
}
_OR_CATALOG: dict = {"at": 0.0, "items": []}


def _pretty_slug(slug: str) -> str:
    parts = [w for w in re.split(r"[-_]+", slug) if w]
    # "-it" / "-instruct" / "-chat" no fim só dizem que o modelo é ajustado
    # pra conversa -- ruído num nome pra humanos.
    while len(parts) > 2 and parts[-1].lower() in {"it", "instruct", "chat"}:
        parts.pop()
    words = []
    for w in parts:
        if re.fullmatch(r"\d+(\.\d+)?[bkm]?", w, re.IGNORECASE) or re.fullmatch(r"[a-z]\d+[a-z]?", w, re.IGNORECASE):
            words.append(w.upper())
        else:
            words.append(w.capitalize())
    return " ".join(words)


def humanize_openrouter(model_id: str, raw_name: str = "") -> str:
    """'NVIDIA: Nemotron 3 Super 120B A12B (free)' -> 'Nemotron 3 Super 120B A12B (NVIDIA)'."""
    vendor_slug, _, rest = model_id.partition("/")
    vendor = _VENDORS.get(vendor_slug, vendor_slug.replace("-", " ").title())
    if raw_name and ": " in raw_name:
        v, _, n = raw_name.partition(": ")
        name, vendor = n, v.strip() or vendor
    elif raw_name:
        name = raw_name
    else:
        name = _pretty_slug(rest.split(":", 1)[0])
    name = re.sub(r"\s*\((free|grátis)\)\s*$", "", name, flags=re.IGNORECASE).strip()
    return f"{name} ({vendor})"


def display_name(entry: str) -> str:
    provider_name, model_name = parse_entry(entry)
    if provider_name == "gemini":
        return f"{_GEMINI_NAMES.get(model_name) or _pretty_slug(model_name)} (Google)"
    if provider_name == "anthropic":
        return f"{_CLAUDE_NAMES.get(model_name) or _pretty_slug(model_name)} (Anthropic)"
    for item in _OR_CATALOG["items"]:
        if item["id"] == model_name:
            return humanize_openrouter(model_name, item.get("name", ""))
    return humanize_openrouter(model_name)


def openrouter_catalog() -> list[dict]:
    """Catálogo público do OpenRouter (sem chave), em cache por 1h."""
    now = time.time()
    if _OR_CATALOG["items"] and now - _OR_CATALOG["at"] < 3600:
        return _OR_CATALOG["items"]
    try:
        response = httpx.get("https://openrouter.ai/api/v1/models", timeout=20)
        response.raise_for_status()
        items = []
        for m in response.json().get("data", []):
            pricing = m.get("pricing") or {}
            free = m["id"].endswith(":free") or (
                str(pricing.get("prompt")) == "0" and str(pricing.get("completion")) == "0"
            )
            items.append(
                {"id": m["id"], "name": m.get("name") or "", "context": m.get("context_length") or 0, "free": bool(free)}
            )
        _OR_CATALOG.update(at=now, items=items)
    except Exception:
        if not _OR_CATALOG["items"]:
            raise RuntimeError("Não consegui listar os modelos do OpenRouter agora.") from None
    return _OR_CATALOG["items"]


def catalog() -> list[dict]:
    """Tudo que dá pra escolher: modelos diretos (só dos provedores com chave
    configurada) + o catálogo do OpenRouter. Cada item já vem com nome legível."""
    keys = _keys()
    out = []
    if keys["gemini"]:
        for model_name in _GEMINI_NAMES:
            e = f"gemini:{model_name}"
            out.append({"entry": e, "name": display_name(e), "provider": "gemini", "free": False, "context": 0})
    if keys["anthropic"]:
        for model_name in _CLAUDE_NAMES:
            e = f"anthropic:{model_name}"
            out.append({"entry": e, "name": display_name(e), "provider": "anthropic", "free": False, "context": 0})
    if keys["openrouter"]:
        items = sorted(openrouter_catalog(), key=lambda i: (not i["free"], i["id"]))
        for m in items:
            out.append(
                {
                    "entry": f"openrouter:{m['id']}",
                    "name": humanize_openrouter(m["id"], m["name"]),
                    "provider": "openrouter",
                    "free": m["free"],
                    "context": m["context"],
                }
            )
    return out


# ── Estado do último uso ──
_LAST_USED_KEY = "llm_last_used"


def last_used() -> dict | None:
    raw = store.get_meta(_LAST_USED_KEY)
    try:
        data = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    if not data.get("name"):
        data["name"] = display_name(data.get("model") or "")
    data["skipped"] = [
        s if isinstance(s, dict) else {"name": str(s).split(":")[0], "reason": ""}
        for s in (data.get("skipped") or [])
    ]
    return data


def _remember_last_used(entry: str, seconds: float, skipped: list[dict]) -> None:
    store.set_meta(
        _LAST_USED_KEY,
        json.dumps(
            {
                "model": entry,
                "name": display_name(entry),
                "seconds": round(seconds, 1),
                "skipped": skipped,
                "at": datetime.now().isoformat(),
            }
        ),
    )


# ── Chamadas ──
def _post(provider_name: str, url: str, secret: str, **kwargs) -> dict:
    """POST que nunca deixa a chave vazar na mensagem de erro: o httpx
    inclui a URL inteira (com ?key=...) no texto do HTTPStatusError. Aqui o
    erro vira uma frase curta com o motivo que o próprio provedor deu."""
    label = _LABELS.get(provider_name, provider_name)
    # Prazo TOTAL por tentativa. O timeout do httpx é por leitura, e o OpenRouter
    # manda bytes de "ainda processando" que o reiniciam: um modelo lento (de
    # raciocínio) chegava a levar 4 min sem nunca estourar. Passado o prazo, a
    # tentativa é abandonada e a cadeia segue pro próximo modelo.
    total = float(kwargs.pop("total_timeout", 0) or (float(kwargs.get("timeout") or 45.0) + 10.0))
    future = _POOL.submit(httpx.post, url, **kwargs)
    try:
        response = future.result(timeout=total)
    except concurrent.futures.TimeoutError:
        future.cancel()
        raise LLMError(f"{label} demorou mais de {int(total)}s e foi pulado.") from None
    except httpx.TimeoutException:
        raise LLMError(f"{label} não respondeu a tempo.") from None
    except httpx.RequestError:
        raise LLMError(f"Não consegui falar com {label} (erro de rede).") from None
    if response.status_code >= 400:
        reason = ""
        try:
            err = response.json().get("error")
            reason = err.get("message", "") if isinstance(err, dict) else str(err or "")
        except ValueError:
            reason = response.text[:200]
        reason = reason.replace(secret, "***") if secret else reason
        raise LLMError(
            f"{label} recusou a chamada (HTTP {response.status_code}): {reason[:300]}",
            status=response.status_code,
        ) from None
    return response.json()


def _call_anthropic(model_name: str, user: str, system: str, timeout: float) -> str:
    key = _keys()["anthropic"]
    data = _post(
        "anthropic",
        "https://api.anthropic.com/v1/messages",
        key,
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
        json={
            "model": model_name,
            "max_tokens": 2000,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
        timeout=timeout,
    )
    usage = data.get("usage") or {}
    store.add_llm_usage(int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0)))
    parts = data.get("content") or []
    return "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()


def _call_gemini(model_name: str, user: str, system: str, timeout: float) -> str:
    key = _keys()["gemini"]
    payload = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
    }
    # Gemini 2.5 "pensa" por padrão; orçamento 0 desliga (o Pro não aceita 0, por isso só flash).
    if not reasoning_enabled() and "flash" in model_name:
        payload["generationConfig"] = {"thinkingConfig": {"thinkingBudget": 0}}

    def send(body):
        return _post(
            "gemini",
            f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent",
            key,
            headers={"x-goog-api-key": key},
            json=body,
            timeout=timeout,
        )

    try:
        data = send(payload)
    except LLMError as exc:
        if exc.status == 400 and "generationConfig" in payload and "think" in str(exc).lower():
            payload.pop("generationConfig")
            data = send(payload)
        else:
            raise
    store.add_llm_usage(int((data.get("usageMetadata") or {}).get("totalTokenCount", 0)))
    candidates = data.get("candidates") or []
    if not candidates:
        return ""
    parts = candidates[0].get("content", {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts).strip()


def _call_openrouter(model_name: str, user: str, system: str, timeout: float) -> str:
    key = _keys()["openrouter"]
    payload = {
        "model": model_name,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    if not reasoning_enabled():
        payload["reasoning"] = {"enabled": False}

    def send(body):
        return _post(
            "openrouter",
            "https://openrouter.ai/api/v1/chat/completions",
            key,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=body,
            timeout=timeout,
        )

    try:
        data = send(payload)
    except LLMError as exc:
        # alguns modelos não deixam desligar o raciocínio: tenta de novo sem o pedido
        if exc.status == 400 and "reasoning" in payload and "reason" in str(exc).lower():
            payload.pop("reasoning")
            data = send(payload)
        else:
            raise
    try:
        text = (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        raise LLMError("resposta inesperada") from None
    store.add_llm_usage(int((data.get("usage") or {}).get("total_tokens", 0)))
    return text


_CALLERS = {"anthropic": _call_anthropic, "gemini": _call_gemini, "openrouter": _call_openrouter}


def complete(user: str, *, system: str = SYSTEM, timeout: float = 45.0) -> str:
    """Tenta cada modelo da cadeia, na ordem; se um falhar (cota, cobrança,
    fora do ar, resposta vazia), cai no próximo. Modelos que acabaram de
    falhar por cota/cobrança/chave ficam de molho por 5 min, pra não perder
    tempo batendo neles a cada chamada."""
    keys = _keys()
    entries = chain()
    if not any(keys.get(parse_entry(e)[0]) for e in entries):
        raise RuntimeError("Falta chave de LLM (Gemini, OpenRouter ou Claude) no .env do cérebro.")
    now = time.time()
    ready = [e for e in entries if _COOLDOWN.get(e, 0) <= now]
    attempts = ready if any(keys.get(parse_entry(e)[0]) for e in ready) else entries
    skipped: list[dict] = []
    # modelos em pausa continuam aparecendo (com o motivo) em vez de sumirem em silêncio
    for entry in entries:
        if entry not in attempts and keys.get(parse_entry(entry)[0]):
            why = _COOLDOWN_WHY.get(entry, "falhou há pouco")
            skipped.append({"name": display_name(entry), "reason": f"em pausa por alguns minutos — {why}"})
    tried = 0
    for entry in attempts:
        provider_name, model_name = parse_entry(entry)
        if not keys.get(provider_name):
            skipped.append({"name": display_name(entry), "reason": "sem chave configurada"})
            continue
        if tried >= _MAX_FALLBACK_ATTEMPTS:
            break
        tried += 1
        started = time.time()
        try:
            text = _CALLERS[provider_name](model_name, user, system, timeout)
            if not text:
                raise LLMError("resposta vazia")
        except LLMError as exc:
            skipped.append({"name": display_name(entry), "reason": str(exc)[:160]})
            if exc.status in _COOLDOWN_STATUS:
                _COOLDOWN[entry] = time.time() + _COOLDOWN_SECONDS
                _COOLDOWN_WHY[entry] = str(exc)[:160]
            continue
        _COOLDOWN.pop(entry, None)
        _COOLDOWN_WHY.pop(entry, None)
        _remember_last_used(entry, time.time() - started, skipped)
        return text
    detail = " | ".join(f"{s['name']}: {s['reason']}" for s in skipped)
    raise RuntimeError(f"Nenhum modelo respondeu. {detail}")
