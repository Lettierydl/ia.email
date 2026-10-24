// A cadeia de IA do app: llm.ts ligado ao fetch do RN, às chaves do Keychain
// e ao banco local (ajustes, uso de tokens, último modelo usado).
import { addLlmUsage, getSettings, setMeta } from './db';
import { createLlm, FetchLike } from './llm';
import { getSecret } from './secrets';

export const ai = createLlm({
  fetch: ((url, init) => fetch(url, init)) as FetchLike,
  getKey: getSecret,
  getSettings,
  addUsage: addLlmUsage,
  saveLastUsed: (data) => setMeta('llm_last_used', JSON.stringify(data)),
});

/** Chamada curta para o botão "Testar IA": diz qual modelo respondeu. */
export async function testAi(): Promise<{ name: string; seconds: number; text: string; skipped: { name: string; reason: string }[] }> {
  const r = await ai.completeDetailed('Responda apenas com a palavra: ok', {
    system: 'Você é um teste de conexão. Responda só "ok".',
    timeoutMs: 20_000,
  });
  return { name: r.name, seconds: r.seconds, text: r.text.slice(0, 80), skipped: r.skipped };
}
