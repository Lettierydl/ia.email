// Cadeia de IA (porte de app/llm.py): tenta cada modelo na ordem; se um falha
// (cota, cobrança, fora do ar, resposta vazia), cai no próximo. Modelo que
// falhou por cota/cobrança/chave (401/402/403/404/429) fica de molho 5 min.
// Sem React e sem expo: tudo que toca o mundo (fetch, chaves, ajustes, uso)
// entra por createLlm(deps) — o app liga em core/ai.ts, os testes passam falsos.
//
// Chave nunca vai para log nem para mensagem de erro: o Gemini recebe a chave
// no cabeçalho (não na URL) e o motivo devolvido pelo provedor passa por mask().

export const SYSTEM = `Você é o assistente de e-mail do Leo (Lettiery D'Lamare, leo@confrapag.com.br),
TI/Confrapag. Português do Brasil. Direto, com fato. Não use 'urgente' sem prazo real.
Não invente dado. Assinatura: Atenciosamente, Lettiery D'Lamare.
Resposta só ao remetente, sem reply-all, salvo se a instrução pedir.
`;

const LABELS: Record<string, string> = { anthropic: 'Claude', gemini: 'Gemini', openrouter: 'OpenRouter' };
const PROVIDERS = Object.keys(LABELS);

export const DEFAULT_CHAIN = [
  'gemini:gemini-flash-latest',
  'gemini:gemini-flash-lite-latest',
  'openrouter:openrouter/free',
  'openrouter:google/gemma-4-31b-it:free',
];

export const MAX_FALLBACK_ATTEMPTS = 5;
export const COOLDOWN_MS = 5 * 60 * 1000;
export const COOLDOWN_STATUS = new Set([401, 402, 403, 404, 429]);
export const DEFAULT_TIMEOUT_MS = 45_000;

export class LLMError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

// ── Cadeia ──
// Cada item é "provedor:modelo". Item sem provedor conhecido na frente
// (formato antigo) é tratado como OpenRouter.
export function normalizeEntry(entry: string): string {
  const e = (entry || '').trim();
  const head = e.split(':', 1)[0];
  return PROVIDERS.includes(head) && e.includes(':') ? e : `openrouter:${e}`;
}

export function parseEntry(entry: string): [string, string] {
  const n = normalizeEntry(entry);
  const i = n.indexOf(':');
  return [n.slice(0, i), n.slice(i + 1)];
}

export function chainFrom(llmModels: unknown): string[] {
  const configured = (Array.isArray(llmModels) ? llmModels : [])
    .filter((m) => String(m ?? '').trim())
    .map((m) => normalizeEntry(String(m)));
  return configured.length ? configured : [...DEFAULT_CHAIN];
}

// ── Nomes legíveis ──
const GEMINI_NAMES: Record<string, string> = {
  'gemini-flash-latest': 'Gemini Flash',
  'gemini-flash-lite-latest': 'Gemini Flash-Lite',
  'gemini-pro-latest': 'Gemini Pro',
};
const CLAUDE_NAMES: Record<string, string> = {
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-fable-5-1': 'Claude Fable 5.1',
};
const VENDORS: Record<string, string> = {
  nvidia: 'NVIDIA', google: 'Google', cohere: 'Cohere', 'meta-llama': 'Meta', mistralai: 'Mistral',
  deepseek: 'DeepSeek', qwen: 'Qwen', openai: 'OpenAI', anthropic: 'Anthropic', 'x-ai': 'xAI',
  microsoft: 'Microsoft', moonshotai: 'Moonshot', 'z-ai': 'Z.ai', poolside: 'Poolside',
};

const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const titleCase = (s: string) => s.replace(/[A-Za-zÀ-ÿ]+/g, capitalize);

function prettySlug(slug: string): string {
  const parts = slug.split(/[-_]+/).filter(Boolean);
  // "-it" / "-instruct" / "-chat" no fim só dizem que o modelo é de conversa
  while (parts.length > 2 && ['it', 'instruct', 'chat'].includes(parts[parts.length - 1].toLowerCase())) parts.pop();
  return parts
    .map((w) => (/^\d+(\.\d+)?[bkm]?$/i.test(w) || /^[a-z]\d+[a-z]?$/i.test(w) ? w.toUpperCase() : capitalize(w)))
    .join(' ');
}

/** 'NVIDIA: Nemotron 3 Super 120B A12B (free)' -> 'Nemotron 3 Super 120B A12B (NVIDIA)'. */
export function humanizeOpenrouter(modelId: string, rawName = ''): string {
  const slash = modelId.indexOf('/');
  const vendorSlug = slash >= 0 ? modelId.slice(0, slash) : modelId;
  const rest = slash >= 0 ? modelId.slice(slash + 1) : '';
  let vendor = VENDORS[vendorSlug] ?? titleCase(vendorSlug.replace(/-/g, ' '));
  let name: string;
  if (rawName && rawName.includes(': ')) {
    const i = rawName.indexOf(': ');
    name = rawName.slice(i + 2);
    vendor = rawName.slice(0, i).trim() || vendor;
  } else if (rawName) {
    name = rawName;
  } else {
    name = prettySlug(rest.split(':', 1)[0]);
  }
  name = name.replace(/\s*\((free|grátis)\)\s*$/i, '').trim();
  return `${name} (${vendor})`;
}

export function displayName(entry: string): string {
  const [provider, model] = parseEntry(entry);
  if (provider === 'gemini') return `${GEMINI_NAMES[model] || prettySlug(model)} (Google)`;
  if (provider === 'anthropic') return `${CLAUDE_NAMES[model] || prettySlug(model)} (Anthropic)`;
  return humanizeOpenrouter(model);
}

// ── Dependências ──
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface LlmDeps {
  fetch: FetchLike;
  /** chave do provedor ('' = sem chave) */
  getKey(provider: 'gemini' | 'openrouter'): Promise<string>;
  getSettings(): Promise<{ llm_models?: unknown; llm_reasoning?: unknown }>;
  addUsage?(tokens: number): Promise<void>;
  saveLastUsed?(data: LastUsed): Promise<void>;
  now?(): number;
}

export interface Skipped {
  name: string;
  reason: string;
}

export interface LastUsed {
  model: string;
  name: string;
  seconds: number;
  skipped: Skipped[];
  at: string;
}

export interface CompleteResult extends LastUsed {
  text: string;
}

type Json = Record<string, any>;

function mask(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
}

export function createLlm(deps: LlmDeps) {
  const now = deps.now ?? (() => Date.now());
  const cooldown = new Map<string, number>();
  const cooldownWhy = new Map<string, string>();

  async function keys(): Promise<Record<string, string>> {
    const [gemini, openrouter] = await Promise.all([deps.getKey('gemini'), deps.getKey('openrouter')]);
    return { anthropic: '', gemini: (gemini || '').trim(), openrouter: (openrouter || '').trim() };
  }

  async function chain(): Promise<string[]> {
    return chainFrom((await deps.getSettings()).llm_models);
  }

  async function reasoningEnabled(): Promise<boolean> {
    return !!(await deps.getSettings()).llm_reasoning;
  }

  /** POST com prazo total (AbortController); erro vira frase curta, sem a chave. */
  async function post(provider: string, url: string, secret: string, headers: Record<string, string>, body: Json, timeoutMs: number): Promise<Json> {
    const label = LABELS[provider] || provider;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await deps.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch {
      if (timedOut) throw new LLMError(`${label} demorou mais de ${Math.round(timeoutMs / 1000)}s e foi pulado.`);
      throw new LLMError(`Não consegui falar com ${label} (erro de rede).`);
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 400) {
      let reason = '';
      try {
        const raw = await response.text();
        try {
          const err = (JSON.parse(raw) as Json)?.error;
          reason = err && typeof err === 'object' ? String(err.message ?? '') : String(err ?? '');
        } catch {
          reason = raw.slice(0, 200);
        }
      } catch {
        reason = '';
      }
      reason = mask(reason, secret);
      throw new LLMError(`${label} recusou a chamada (HTTP ${response.status}): ${reason.slice(0, 300)}`, response.status);
    }
    try {
      return (await response.json()) as Json;
    } catch {
      throw new LLMError('resposta inesperada');
    }
  }

  async function callGemini(model: string, user: string, system: string, key: string, timeoutMs: number): Promise<string> {
    const payload: Json = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
    };
    // Gemini "pensa" por padrão; orçamento 0 desliga (o Pro não aceita 0, por isso só flash).
    if (!(await reasoningEnabled()) && model.includes('flash')) {
      payload.generationConfig = { thinkingConfig: { thinkingBudget: 0 } };
    }
    const send = (body: Json) =>
      post('gemini', `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, key, { 'x-goog-api-key': key }, body, timeoutMs);
    let data: Json;
    try {
      data = await send(payload);
    } catch (e) {
      // alguns modelos (ex.: flash-lite) recusam thinkingBudget=0 com um 400
      // genérico ("invalid argument"): tenta de novo sem o generationConfig
      if (e instanceof LLMError && e.status === 400 && 'generationConfig' in payload) {
        delete payload.generationConfig;
        data = await send(payload);
      } else {
        throw e;
      }
    }
    await deps.addUsage?.(Number(data?.usageMetadata?.totalTokenCount ?? 0));
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    if (!candidates.length) return '';
    const parts = candidates[0]?.content?.parts;
    return (Array.isArray(parts) ? parts : []).map((p: Json) => String(p?.text ?? '')).join('').trim();
  }

  async function callOpenrouter(model: string, user: string, system: string, key: string, timeoutMs: number): Promise<string> {
    const payload: Json = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (!(await reasoningEnabled())) payload.reasoning = { enabled: false };
    const send = (body: Json) =>
      post('openrouter', 'https://openrouter.ai/api/v1/chat/completions', key, { Authorization: `Bearer ${key}` }, body, timeoutMs);
    let data: Json;
    try {
      data = await send(payload);
    } catch (e) {
      // alguns modelos não deixam desligar o raciocínio: tenta de novo sem o pedido
      if (e instanceof LLMError && e.status === 400 && 'reasoning' in payload && e.message.toLowerCase().includes('reason')) {
        delete payload.reasoning;
        data = await send(payload);
      } else {
        throw e;
      }
    }
    const content = data?.choices?.[0]?.message?.content;
    if (data?.choices?.[0]?.message === undefined) throw new LLMError('resposta inesperada');
    await deps.addUsage?.(Number(data?.usage?.total_tokens ?? 0));
    return String(content ?? '').trim();
  }

  const callers: Record<string, typeof callGemini> = { gemini: callGemini, openrouter: callOpenrouter };

  async function completeDetailed(user: string, opts: { system?: string; timeoutMs?: number } = {}): Promise<CompleteResult> {
    const system = opts.system ?? SYSTEM;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const k = await keys();
    const entries = await chain();
    const hasKey = (e: string) => !!k[parseEntry(e)[0]] && !!callers[parseEntry(e)[0]];
    if (!entries.some(hasKey)) {
      throw new Error('Falta chave de IA (Gemini ou OpenRouter): cadastre em Ajustes → Chaves de IA.');
    }
    const t = now();
    const ready = entries.filter((e) => (cooldown.get(e) ?? 0) <= t);
    const attempts = ready.some(hasKey) ? ready : entries;
    const skipped: Skipped[] = [];
    // modelos em pausa continuam aparecendo (com o motivo) em vez de sumirem em silêncio
    for (const e of entries) {
      if (!attempts.includes(e) && hasKey(e)) {
        skipped.push({ name: displayName(e), reason: `em pausa por alguns minutos — ${cooldownWhy.get(e) ?? 'falhou há pouco'}` });
      }
    }
    let tried = 0;
    for (const entry of attempts) {
      const [provider, model] = parseEntry(entry);
      if (!hasKey(entry)) {
        skipped.push({ name: displayName(entry), reason: 'sem chave configurada' });
        continue;
      }
      if (tried >= MAX_FALLBACK_ATTEMPTS) break;
      tried += 1;
      const started = now();
      try {
        const text = await callers[provider](model, user, system, k[provider], timeoutMs);
        if (!text) throw new LLMError('resposta vazia');
        cooldown.delete(entry);
        cooldownWhy.delete(entry);
        const result: LastUsed = {
          model: entry,
          name: displayName(entry),
          seconds: Math.round((now() - started) / 100) / 10,
          skipped,
          at: new Date(now()).toISOString(),
        };
        await deps.saveLastUsed?.(result);
        return { ...result, text };
      } catch (e) {
        const msg = mask(e instanceof Error ? e.message : String(e), k[provider]).slice(0, 160);
        skipped.push({ name: displayName(entry), reason: msg });
        if (e instanceof LLMError && e.status != null && COOLDOWN_STATUS.has(e.status)) {
          cooldown.set(entry, now() + COOLDOWN_MS);
          cooldownWhy.set(entry, msg);
        }
      }
    }
    const detail = skipped.map((s) => `${s.name}: ${s.reason}`).join(' | ');
    throw new Error(`Nenhum modelo respondeu. ${detail}`);
  }

  async function complete(user: string, opts: { system?: string; timeoutMs?: number } = {}): Promise<string> {
    return (await completeDetailed(user, opts)).text;
  }

  return {
    complete,
    completeDetailed,
    chain,
    /** só para testes/diagnóstico */
    _cooldown: cooldown,
    _post: post,
    _callGemini: callGemini,
    _callOpenrouter: callOpenrouter,
  };
}

export type Llm = ReturnType<typeof createLlm>;
