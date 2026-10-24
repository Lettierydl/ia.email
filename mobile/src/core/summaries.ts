// Resumos sob demanda no aparelho — porte de resumo_detalhado / resumo_mensagem
// de app/copilot.py: mesmos prompts e mesma limpeza da resposta (o teste
// compara com o Python), cache no SQLite com as mesmas tabelas e a mesma regra
// de "desatualizado" (mensagem nova invalida o resumo da thread; o da mensagem
// é por hash do texto). Credencial no texto não vai para a IA.
//
// Diferença do Mac: os "trechos de contexto" são só as decisões anteriores do
// banco (sem RAG/cérebro), e os anexos vêm do que o sync gravou.
import * as db from './db';
import type { Row, SqlValue } from './db';
import { clip, getAccount, messages, ownText, parse, sources as copilotSources, type Source } from './copilot';
import { notesBlock as learnedNotesBlock, threadEmails } from './learned';
import { looksLikeSecret } from './secretsGuard';
import { sha256Hex } from './sha256';
import type { ModoResumoMsg, ResumoDetalhado, ResumoMensagem } from '../types';

type Dict = Record<string, unknown>;
const s = (v: unknown) => (v == null ? '' : String(v));

export const RESUMO_LISTAS = ['pontos_principais', 'numeros_dados', 'pedidos_ao_leo', 'decisoes_riscos', 'anexos_mencionados', 'proximos_passos'] as const;
export const MSG_RESUMO_MODOS = ['direto', 'abrangente'] as const;
const MSG_RESUMO_LISTAS = ['pontos_principais', 'numeros_dados', 'riscos'] as const;

/** Python str[-n:] / str[:n] por ponto de código. */
const tail = (text: string, n: number) => {
  const cps = Array.from(text);
  return cps.length <= n ? text : cps.slice(-n).join('');
};
const head = (text: string, n: number) => {
  const cps = Array.from(text);
  return cps.length <= n ? text : cps.slice(0, n).join('');
};

/** str(v) do Python para o que vem do JSON da IA. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}
const words = (t: string) => t.split(/\s+/).filter(Boolean).join(' ');
/** `value or ""` do Python (0, "", [], {} e None caem no padrão). */
const orEmpty = (v: unknown): string => {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return '';
  if (Array.isArray(v) && !v.length) return '';
  if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length) return '';
  return pyStr(v);
};

function loads(raw: SqlValue | undefined): Dict {
  if (!raw) return {};
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const isDict = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => pyStr(v).trim()).map((v) => words(pyStr(v))) : [];
}

function pairs(value: unknown, a: string, b: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const v of Array.isArray(value) ? value : []) {
    if (isDict(v) && orEmpty(v[b]).trim()) out.push({ [a]: orEmpty(v[a]).trim(), [b]: pyStr(v[b]).trim() });
  }
  return out;
}

/** Texto útil da thread (sem as linhas De:/Data:) — o mesmo critério do Python. */
const readableLen = (body: string) => body.replace(/^(De|Data):.*$/gm, '').replace(/\s+/g, '').length;

// ── resumo detalhado ──
/** Cópia literal de copilot._resumo_prompt; `notes` é o learned.notes_block já pronto. */
export function resumoPrompt(row: Dict, body: string, files: string[], srcs: Source[], notes: string): string {
  const numbered = srcs.map((x, i) => `[${i + 1}] (${x.tipo}) ${x.titulo}\n${head(x.texto, 600)}`).join('\n\n') || '(nenhum)';
  return (
    'Faça um RESUMO DETALHADO desta thread de e-mail para o Leo (leo@confrapag.com.br). ' +
    'Responda SÓ com JSON, em português do Brasil, tratando o Leo por "você".\n' +
    'Campos (lista vazia quando não houver):\n' +
    '- "contexto": 1 parágrafo (3-6 frases) explicando do que se trata, quem está envolvido e em que pé está.\n' +
    '- "pontos_principais": lista de frases curtas com o essencial da conversa, em ordem.\n' +
    '- "numeros_dados": lista de "número/valor/código — o que é" (valores, quantidades, IDs, percentuais citados).\n' +
    '- "pedidos_ao_leo": o que pediram ao Leo e ainda está em aberto.\n' +
    '- "pedidos_a_outros": [{"nome": "...", "pedido": "..."}] pedidos feitos a outras pessoas.\n' +
    '- "prazos": [{"data": "como está escrito ou dd/mm", "o_que": "..."}] só datas escritas na thread.\n' +
    '- "decisoes_riscos": decisões tomadas, pendências, riscos ou divergências.\n' +
    '- "anexos_mencionados": anexos citados ou recebidos e para que servem.\n' +
    '- "proximos_passos": próximos passos concretos (de quem e o quê).\n' +
    'NUNCA invente fato, nome, valor ou data: só o que está na thread. Os trechos de contexto servem só para ' +
    'entender siglas e histórico; não os trate como parte da conversa.\n\n' +
    `${notes}` +
    `Para: ${s(row.to_header) || '?'}\nCc: ${s(row.cc_header) || '-'}\n` +
    `Anexos recebidos na thread: ${files.length ? files.join(', ') : '(nenhum listado)'}\n\n` +
    `Contexto (cérebro/histórico):\n${numbered}\n\n` +
    `Assunto: ${s(row.subject)}\n\nThread:\n${tail(body, 24000)}`
  );
}

export function cleanResumo(data: Dict): Record<string, unknown> {
  const out: Record<string, unknown> = { contexto: orEmpty(data.contexto).trim() };
  for (const k of RESUMO_LISTAS) out[k] = texts(data[k]);
  out.pedidos_a_outros = pairs(data.pedidos_a_outros, 'nome', 'pedido');
  out.prazos = pairs(data.prazos, 'data', 'o_que');
  return out;
}

function resumoOut(cached: Row, opts: { fromCache: boolean; stale?: boolean; aviso?: string }): ResumoDetalhado {
  const out: ResumoDetalhado = {
    resumo: loads(cached.resumo_json) as ResumoDetalhado['resumo'],
    gerado_em: s(cached.gerado_em),
    cached: opts.fromCache,
    desatualizado: !!opts.stale,
  };
  if (opts.aviso) out.aviso = opts.aviso;
  return out;
}

// ── resumo de uma mensagem ──
/** Cópia literal de copilot._msg_resumo_prompt. */
export function msgResumoPrompt(row: Dict, msg: { de?: string; data?: string }, own: string, idx: number, total: number, modo: string, notes: string): string {
  const formato =
    modo === 'direto'
      ? 'Campos:\n' +
        '- "principal": 1 frase com o pedido ou a decisão principal desta mensagem ("" se não houver).\n' +
        '- "bullets": 3 a 5 frases curtas com o essencial, em ordem.\n'
      : 'Campos (lista vazia quando não houver):\n' +
        '- "contexto": 1-3 frases: do que se trata esta mensagem e em que ponto da conversa ela entra.\n' +
        '- "pontos_principais": lista de frases curtas com o essencial, em ordem.\n' +
        '- "numeros_dados": lista de "número/valor/código — o que é".\n' +
        '- "pedidos_por_pessoa": [{"nome": "...", "pedido": "..."}] quem precisa fazer o quê (use "Você" para o Leo).\n' +
        '- "prazos": [{"data": "como está escrito ou dd/mm", "o_que": "..."}] só datas escritas na mensagem.\n' +
        '- "riscos": riscos, pendências, divergências ou alertas.\n';
  return (
    `Resuma SÓ esta mensagem (${idx + 1} de ${total} da thread) para o Leo (leo@confrapag.com.br). ` +
    'Responda SÓ com JSON, em português do Brasil, tratando o Leo por "você".\n' +
    `${formato}` +
    'NUNCA invente fato, nome, valor ou data: só o que está na mensagem abaixo. ' +
    'O histórico citado de e-mails anteriores foi removido de propósito; não suponha o que ele dizia.\n\n' +
    `${notes}` +
    `Assunto da thread: ${s(row.subject)}\n` +
    `De: ${msg.de || '?'}\nData: ${msg.data || '?'}\n` +
    `Destinatários da thread: Para: ${s(row.to_header) || '?'} · Cc: ${s(row.cc_header) || '-'}\n\n` +
    `Mensagem:\n${tail(own, 16000)}`
  );
}

export function cleanMsgResumo(data: Dict, modo: string): Record<string, unknown> {
  if (modo === 'direto') return { principal: words(orEmpty(data.principal)), bullets: texts(data.bullets).slice(0, 5) };
  const out: Record<string, unknown> = { contexto: orEmpty(data.contexto).trim() };
  for (const k of MSG_RESUMO_LISTAS) out[k] = texts(data[k]);
  out.pedidos_por_pessoa = pairs(data.pedidos_por_pessoa, 'nome', 'pedido');
  out.prazos = pairs(data.prazos, 'data', 'o_que');
  return out;
}

/** Chave do cache do resumo por mensagem (hashlib.sha256(...).hexdigest()[:32]). */
export const msgHash = (de: string, data: string, own: string) => sha256Hex(`${de}\n${data}\n${own}`).slice(0, 32);

export interface SummariesDeps {
  llm: { complete(user: string, opts?: { system?: string; timeoutMs?: number }): Promise<string> };
  hasKey(): Promise<boolean>;
  /** corpo da thread no formato do Mac (o sync grava; sem ele busca no Gmail) */
  ensureBody?(row: Row): Promise<string>;
  /** nomes dos anexos recebidos na thread (sem Gmail: lista vazia) */
  threadFiles?(threadId: string): Promise<string[]>;
  sources?(row: Row): Promise<Source[]>;
  notesBlock?(threadId: string, subject: string, emails: string[]): Promise<string>;
}

export function createSummaries(deps: SummariesDeps) {
  async function body(row: Row): Promise<string> {
    try {
      return deps.ensureBody ? await deps.ensureBody(row) : s(row.body_text);
    } catch {
      return s(row.body_text);
    }
  }
  const notes = (row: Row) => (deps.notesBlock ?? learnedNotesBlock)(s(row.id), s(row.subject), threadEmails(row, getAccount()));
  async function files(threadId: string): Promise<string[]> {
    try {
      return deps.threadFiles ? await deps.threadFiles(threadId) : [];
    } catch {
      return [];
    }
  }

  async function msgTarget(threadId: string, idx: number, modo: string) {
    if (!(MSG_RESUMO_MODOS as readonly string[]).includes(modo)) throw new Error('Modo de resumo inválido: use direto ou abrangente.');
    const row = await db.getThread(threadId);
    if (!row) throw new Error('Thread não encontrada.');
    const msgs = messages(await body(row));
    if (!(idx >= 0 && idx < msgs.length)) throw new Error('Mensagem não encontrada nesta thread.');
    const msg = msgs[idx];
    const own = ownText(msg.texto || '');
    return { row, msg, own, total: msgs.length, digest: msgHash(msg.de, msg.data, own) };
  }

  const msgOut = (cached: Row, idx: number, modo: ModoResumoMsg, fromCache: boolean): ResumoMensagem => ({
    idx, modo, resumo: loads(cached.resumo_json) as ResumoMensagem['resumo'], gerado_em: s(cached.gerado_em), cached: fromCache,
  });

  return {
    /**
     * Resumo maior da thread, gerado só quando o Leo pede. Em cache com o
     * retrato da thread (internal_date + nº de mensagens): reabrir não chama a
     * IA; mensagem nova invalida; force (Regerar) refaz. Se a IA falhar e houver
     * cache, devolve o velho com aviso.
     */
    async resumoDetalhado(threadId: string, opts: { force?: boolean } = {}): Promise<ResumoDetalhado> {
      const row = await db.getThread(threadId);
      if (!row) throw new Error('Thread não encontrada.');
      const text = await body(row);
      const count = messages(text).length;
      const cached = await db.getCopilotResumo(threadId);
      const stale =
        !!cached &&
        (Number(row.internal_date || 0) > Number(cached.internal_date_snapshot || 0) ||
          (!!Number(cached.msg_count_snapshot || 0) && count !== Number(cached.msg_count_snapshot)));
      if (cached && !opts.force && !stale) return resumoOut(cached, { fromCache: true });

      let problem = '';
      let parsed: Dict = {};
      if (!(await deps.hasKey())) problem = 'Sem chave de IA configurada: não dá para gerar o resumo detalhado. Configure em Configurações.';
      else if (looksLikeSecret(`${s(row.subject)}\n${text}`)) problem = 'A conversa traz senha ou credencial: não mandei para a IA. Leia a conversa completa com calma.';
      else if (readableLen(text) < 25) problem = 'Não consegui ler o texto da conversa (vazio, só imagem ou anexo).';
      if (!problem) {
        try {
          const prompt = resumoPrompt(row, text, await files(threadId), await (deps.sources ?? copilotSources)(row), await notes(row));
          parsed = parse(await deps.llm.complete(prompt, { timeoutMs: 90_000 }));
        } catch (e) {
          parsed = {};
          problem = `A IA não respondeu agora (${clip(e instanceof Error ? e.message : String(e), 120)}). Tente de novo em instantes.`;
        }
        if (!problem && !Object.keys(parsed).length) problem = 'A IA respondeu fora do formato. Tente Regerar.';
      }
      if (problem) {
        // melhor um resumo velho (avisado) do que nada
        if (cached) return resumoOut(cached, { fromCache: true, stale, aviso: problem });
        throw new Error(problem);
      }
      await db.saveCopilotResumo(threadId, JSON.stringify(cleanResumo(parsed)), Number(row.internal_date || 0), count);
      return resumoOut((await db.getCopilotResumo(threadId))!, { fromCache: false });
    },

    /**
     * Resumo de UMA mensagem (só o texto dela, sem o histórico citado), modo
     * direto ou abrangente. Cache por thread + hash do texto + modo; force
     * refaz; onlyCached só consulta (nunca chama a IA).
     */
    async resumoMensagem(threadId: string, idx: number, modo: ModoResumoMsg, opts: { force?: boolean; onlyCached?: boolean } = {}): Promise<ResumoMensagem> {
      const { row, msg, own, total, digest } = await msgTarget(threadId, idx, modo);
      const cached = await db.getCopilotMsgResumo(threadId, digest, modo);
      if (cached && !opts.force) return msgOut(cached, idx, modo, true);
      if (opts.onlyCached) return { idx, modo, resumo: null, gerado_em: '', cached: false };
      if (!(await deps.hasKey())) throw new Error('Sem chave de IA configurada: não dá para resumir. Configure em Configurações.');
      if (looksLikeSecret(`${s(row.subject)}\n${own}`)) throw new Error('Esta mensagem traz senha ou credencial: não mandei para a IA. Leia a mensagem com calma.');
      if (own.replace(/\s+/g, '').length < 15) throw new Error('Esta mensagem não tem texto próprio para resumir (vazia, só citação, imagem ou anexo).');
      let parsed: Dict;
      try {
        parsed = parse(await deps.llm.complete(msgResumoPrompt(row, msg, own, idx, total, modo, await notes(row)), { timeoutMs: 60_000 }));
      } catch (e) {
        throw new Error(`A IA não respondeu agora (${clip(e instanceof Error ? e.message : String(e), 120)}). Tente de novo em instantes.`);
      }
      if (!Object.keys(parsed).length) throw new Error('A IA respondeu fora do formato. Tente Regerar.');
      await db.saveCopilotMsgResumo(threadId, digest, modo, JSON.stringify(cleanMsgResumo(parsed, modo)));
      return msgOut((await db.getCopilotMsgResumo(threadId, digest, modo))!, idx, modo, false);
    },
  };
}

export type Summaries = ReturnType<typeof createSummaries>;
