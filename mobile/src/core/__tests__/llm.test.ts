// Casos de tests/test_llm_fallback.py, com fetch falso (nenhuma chamada real).
import { COOLDOWN_MS, createLlm, displayName, FetchLike, humanizeOpenrouter, LastUsed, normalizeEntry } from '../llm';

const GEMINI_KEY = 'g-secret-123';
const OR_KEY = 'sk-or-secret-456';

type Call = { provider: string; model: string; body: Record<string, any>; url: string; headers: Record<string, string> };
type Reply = { status?: number; body?: unknown; text?: string; throws?: boolean; hang?: boolean };

const geminiOk = (text = 'resposta gemini') => ({ body: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { totalTokenCount: 3 } } });
const orOk = (text = 'resposta openrouter') => ({ body: { choices: [{ message: { content: text } }], usage: { total_tokens: 5 } } });
const httpError = (status: number, message: string): Reply => ({ status, body: { error: { message } } });

function setup(behaviour: (c: Call, n: number) => Reply, opts: { keys?: Partial<Record<'gemini' | 'openrouter', string>>; settings?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const usage: number[] = [];
  const last: LastUsed[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    const provider = url.includes('generativelanguage') ? 'gemini' : 'openrouter';
    const model = body.model ?? (url.split('/models/')[1] ?? '').split(':')[0];
    const call = { provider, model, body, url, headers: init.headers };
    calls.push(call);
    const r = behaviour(call, calls.length);
    if (r.throws) throw new TypeError(`Network request failed for ${url}`);
    if (r.hang) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    }
    const status = r.status ?? 200;
    const raw = r.text ?? JSON.stringify(r.body ?? {});
    return { ok: status < 400, status, json: async () => JSON.parse(raw), text: async () => raw };
  };
  const keys = { gemini: GEMINI_KEY, openrouter: OR_KEY, ...opts.keys };
  const llm = createLlm({
    fetch,
    getKey: async (p) => keys[p] ?? '',
    getSettings: async () => ({ llm_models: [], llm_reasoning: false, ...opts.settings }),
    addUsage: async (n) => {
      usage.push(n);
    },
    saveLastUsed: async (d) => {
      last.push(d);
    },
    now: () => clock,
  });
  return { llm, calls, usage, last, advance: (ms: number) => (clock += ms) };
}

test('ordem padrão: Gemini Flash → Flash-Lite → openrouter/free → Gemma', async () => {
  const { llm } = setup(() => orOk());
  expect(await llm.chain()).toEqual([
    'gemini:gemini-flash-latest',
    'gemini:gemini-flash-lite-latest',
    'openrouter:openrouter/free',
    'openrouter:google/gemma-4-31b-it:free',
  ]);
});

test('Gemini responde primeiro quando está saudável', async () => {
  const { llm, calls, last, usage } = setup((c) => (c.provider === 'gemini' ? geminiOk() : orOk()));
  expect(await llm.complete('oi')).toBe('resposta gemini');
  expect(calls.map((c) => [c.provider, c.model])).toEqual([['gemini', 'gemini-flash-latest']]);
  expect(last[0].name).toBe('Gemini Flash (Google)');
  expect(usage).toEqual([3]);
  // chave no cabeçalho, nunca na URL
  expect(calls[0].url).not.toContain(GEMINI_KEY);
  expect(calls[0].headers['x-goog-api-key']).toBe(GEMINI_KEY);
});

test('cai para o OpenRouter quando o Gemini está bloqueado (403), com o motivo', async () => {
  const { llm, calls } = setup((c) => (c.provider === 'gemini' ? httpError(403, 'dunning') : orOk()));
  const r = await llm.completeDetailed('oi');
  expect(r.text).toBe('resposta openrouter');
  expect(r.name).toBe('Free (Openrouter)'); // igual ao Python: 'openrouter'.title()
  expect(calls.slice(0, 3).map((c) => c.provider)).toEqual(['gemini', 'gemini', 'openrouter']);
  expect(r.skipped[0].name).toBe('Gemini Flash (Google)');
  expect(r.skipped[0].reason).toContain('403');
});

test.each([429, 404])('modelo que falhou com %i fica de molho 5 min', async (status) => {
  const { llm, calls, advance } = setup((c) => (c.provider === 'gemini' ? httpError(status, 'cota estourada') : orOk()));
  await llm.complete('um');
  const r = await llm.completeDetailed('dois');
  expect(calls.filter((c) => c.provider === 'gemini').map((c) => c.model)).toEqual(['gemini-flash-latest', 'gemini-flash-lite-latest']);
  expect(r.skipped[0].name).toBe('Gemini Flash (Google)');
  expect(r.skipped[0].reason).toContain('em pausa');
  expect(r.skipped[0].reason).toContain('cota');
  // passados os 5 min, volta a tentar
  advance(COOLDOWN_MS + 1);
  await llm.complete('três');
  expect(calls.filter((c) => c.provider === 'gemini')).toHaveLength(4);
});

test('erro 500 não põe o modelo de molho', async () => {
  const { llm, calls } = setup((c) => (c.model === 'gemini-flash-latest' ? httpError(500, 'interno') : geminiOk('lite')));
  await llm.complete('um');
  await llm.complete('dois');
  expect(calls.filter((c) => c.model === 'gemini-flash-latest')).toHaveLength(2);
});

test('resposta vazia conta como falha', async () => {
  const { llm } = setup((c) => (c.model === 'a/free' ? orOk('') : orOk('tem texto')), { settings: { llm_models: ['openrouter:a/free', 'openrouter:b/free'] } });
  expect(await llm.complete('oi')).toBe('tem texto');
});

test('todos falhando: erro com todos os motivos', async () => {
  const { llm } = setup(() => ({ throws: true }), { settings: { llm_models: ['openrouter:a/free', 'openrouter:b/free'] } });
  await expect(llm.complete('oi')).rejects.toThrow(/Nenhum modelo respondeu.*erro de rede/);
});

test('provedor sem chave é pulado', async () => {
  const { llm, calls } = setup(() => orOk(), { keys: { gemini: '' } });
  const r = await llm.completeDetailed('oi');
  expect(calls.every((c) => c.provider === 'openrouter')).toBe(true);
  expect(r.skipped.filter((s) => s.reason === 'sem chave configurada')).toHaveLength(2);
});

test('sem nenhuma chave: pede para cadastrar em Ajustes', async () => {
  const { llm, calls } = setup(() => orOk(), { keys: { gemini: '', openrouter: '' } });
  await expect(llm.complete('oi')).rejects.toThrow(/Chaves de IA/);
  expect(calls).toHaveLength(0);
});

test('override pela setting llm_models (formato antigo vira openrouter)', async () => {
  const { llm, calls } = setup(() => orOk(), { settings: { llm_models: ['x/one:free', ' ', 'gemini:gemini-pro-latest'] } });
  expect(await llm.chain()).toEqual(['openrouter:x/one:free', 'gemini:gemini-pro-latest']);
  await llm.complete('oi');
  expect(calls[0].model).toBe('x/one:free');
});

test('Gemini: 400 com generationConfig repete uma vez sem ele', async () => {
  const { llm, calls } = setup((c) =>
    c.body.generationConfig ? httpError(400, 'Request contains an invalid argument.') : geminiOk('sem a opção'),
  );
  expect(await llm._callGemini('gemini-flash-lite-latest', 'oi', 'sys', GEMINI_KEY, 5000)).toBe('sem a opção');
  expect(calls).toHaveLength(2);
  expect(calls[0].body.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
  expect(calls[1].body.generationConfig).toBeUndefined();
});

test('Gemini: 400 sem generationConfig (Pro) não repete; Pro não recebe orçamento 0', async () => {
  const { llm, calls } = setup(() => httpError(400, 'invalid'));
  await expect(llm._callGemini('gemini-pro-latest', 'oi', 'sys', GEMINI_KEY, 5000)).rejects.toThrow('HTTP 400');
  expect(calls).toHaveLength(1);
  expect(calls[0].body.generationConfig).toBeUndefined();
});

test('Gemini: raciocínio ligado não manda generationConfig', async () => {
  const { llm, calls } = setup(() => geminiOk(), { settings: { llm_reasoning: true } });
  await llm._callGemini('gemini-flash-latest', 'oi', 'sys', GEMINI_KEY, 5000);
  expect(calls[0].body.generationConfig).toBeUndefined();
});

test('OpenRouter: raciocínio desligado por padrão; 400 "reasoning" repete sem a flag', async () => {
  const { llm, calls } = setup((_c, n) => (n === 1 ? httpError(400, 'Reasoning is mandatory for this endpoint') : orOk('deu certo')));
  expect(await llm._callOpenrouter('a/free', 'oi', 'sys', OR_KEY, 5000)).toBe('deu certo');
  expect(calls[0].body.reasoning).toEqual({ enabled: false });
  expect(calls[1].body.reasoning).toBeUndefined();
});

test('OpenRouter: 400 sem relação com raciocínio não repete', async () => {
  const { llm, calls } = setup(() => httpError(400, 'modelo inexistente'));
  await expect(llm._callOpenrouter('a/free', 'oi', 'sys', OR_KEY, 5000)).rejects.toThrow('HTTP 400');
  expect(calls).toHaveLength(1);
});

test('a chave nunca aparece no erro (nem quando o provedor a ecoa)', async () => {
  const { llm } = setup((c) =>
    c.provider === 'gemini' ? httpError(403, `bad key ${GEMINI_KEY}`) : { status: 401, text: `invalid token ${OR_KEY} for Bearer ${OR_KEY}` },
  );
  let message = '';
  try {
    await llm.complete('oi');
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message).toContain('Nenhum modelo respondeu');
  expect(message).toContain('403');
  expect(message).toContain('401');
  expect(message).not.toContain(GEMINI_KEY);
  expect(message).not.toContain(OR_KEY);
});

test('erro de rede não vaza a URL nem a chave', async () => {
  const { llm } = setup(() => ({ throws: true }));
  await expect(llm._post('gemini', `https://x.test/v1?key=${GEMINI_KEY}`, GEMINI_KEY, {}, {}, 5000)).rejects.toThrow(
    'Não consegui falar com Gemini (erro de rede).',
  );
});

test('modelo que não responde é abandonado no prazo (AbortController)', async () => {
  jest.useFakeTimers();
  try {
    const { llm } = setup(() => ({ hang: true }));
    const p = llm._post('openrouter', 'https://x.test', OR_KEY, {}, {}, 1000);
    const assertion = expect(p).rejects.toThrow('OpenRouter demorou mais de 1s e foi pulado.');
    await jest.advanceTimersByTimeAsync(1001);
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});

test('nomes legíveis', () => {
  expect(normalizeEntry('nvidia/nemotron-3-super-120b-a12b:free')).toBe('openrouter:nvidia/nemotron-3-super-120b-a12b:free');
  expect(normalizeEntry('gemini:gemini-flash-latest')).toBe('gemini:gemini-flash-latest');
  expect(displayName('gemini:gemini-flash-latest')).toBe('Gemini Flash (Google)');
  expect(displayName('openrouter:nvidia/nemotron-3-super-120b-a12b:free')).toBe('Nemotron 3 Super 120B A12B (NVIDIA)');
  expect(humanizeOpenrouter('x/y', 'NVIDIA: Nemotron 3 Super (free)')).toBe('Nemotron 3 Super (NVIDIA)');
  expect(displayName('openrouter:google/gemma-4-31b-it:free')).toBe('Gemma 4 31B (Google)');
});
