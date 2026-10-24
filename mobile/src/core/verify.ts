// "Verificar na caixa" no aparelho — porte de app/verify.py (mesmos prompts,
// mesma limpeza das consultas e dos vereditos; o teste compara com o Python):
//
// 1. A IA lê a thread e tira as AFIRMAÇÕES verificáveis sobre a caixa do Leo,
//    cada uma com consultas de busca do Gmail sugeridas.
// 2. As consultas são saneadas (só operadores conhecidos) e rodam SÓ LEITURA
//    (gmail.searchMessages: messages.list + get format=metadata).
// 3. A IA avalia cada afirmação com as evidências: Confirmado / Não encontrado /
//    Inconclusivo + explicação curta citando os e-mails.
//
// Cache por thread (copilot_verificacoes) com o retrato da thread: mensagem
// nova invalida; Regerar refaz. Nunca envia, marca, arquiva nem rotula nada.
import * as db from './db';
import type { Row, SqlValue } from './db';
import { clip, messages, parse } from './copilot';
import type { SearchHit } from './gmail';
import { unescapeHtml } from './mime';
import { looksLikeSecret } from './secretsGuard';
import type { VerifyResult } from '../types';

export const MAX_AFIRMACOES = 6;
export const MAX_CONSULTAS = 3;
export const MAX_RESULTADOS = 5;
export const MAX_QUERY_LEN = 220;

export const VEREDITOS = ['confirmado', 'nao_encontrado', 'inconclusivo'] as const;
export const VEREDITO_LABEL: Record<string, string> = { confirmado: 'Confirmado', nao_encontrado: 'Não encontrado', inconclusivo: 'Inconclusivo' };

const SECRET_SNIPPET = '[trecho omitido: parece ter senha ou credencial]';

type Dict = Record<string, unknown>;
const s = (v: unknown) => (v == null ? '' : String(v));
const cps = (t: string) => Array.from(t);
const words = (t: string) => t.split(/\s+/).filter(Boolean).join(' ');

// ── consulta saneada: só operadores conhecidos, valores no formato esperado ──
// \w do Python (Unicode): letras, números e _.
const W = '\\p{L}\\p{N}_';
const ADDR_VALUE = new RegExp(`^[${W}.+@-]{2,80}$`, 'u');
const DATE_VALUE = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/;
const OPS: Record<string, RegExp | null> = {
  from: ADDR_VALUE,
  to: ADDR_VALUE,
  cc: ADDR_VALUE,
  bcc: ADDR_VALUE,
  subject: null, // texto (palavra ou "frase")
  after: DATE_VALUE,
  before: DATE_VALUE,
  newer_than: /^\d{1,4}[dmy]$/,
  older_than: /^\d{1,4}[dmy]$/,
  has: /^(attachment|drive|document|spreadsheet|presentation|pdf)$/,
  in: /^(anywhere|sent|inbox|spam|trash)$/,
  filename: new RegExp(`^[${W}.-]{1,80}$`, 'u'),
  is: /^(read|unread|starred|important)$/,
};
const TOKEN_RE = new RegExp(`-?[${W}]+:"[^"]*"|-?"[^"]*"|\\S+`, 'gu');
const WORD_KEEP = new RegExp(`[^${W}@.+-]`, 'gu');
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function cleanPhrase(text: string): string {
  return cps(words((text || '').replace(WORD_KEEP, ' '))).slice(0, 80).join('');
}

/** str.strip(chars) do Python. */
function stripChars(t: string, chars: string): string {
  let a = 0;
  let b = t.length;
  while (a < b && chars.includes(t[a])) a++;
  while (b > a && chars.includes(t[b - 1])) b--;
  return t.slice(a, b);
}

/**
 * Query do Gmail só com o que a gente conhece. Operador desconhecido (label:,
 * deliveredto:, {}, ( ), etc.) é descartado; valor fora do formato também.
 * Palavras soltas perdem pontuação estranha. "" se não sobrou nada.
 */
export function sanitizeQuery(q: string): string {
  const out: string[] = [];
  for (const raw of (q || '').replace(/\n/g, ' ').match(TOKEN_RE) || []) {
    const neg = raw.startsWith('-') && raw.length > 1;
    const tok = neg ? raw.slice(1) : raw;
    const minus = neg ? '-' : '';
    if (tok === 'OR') {
      if (out.length && out[out.length - 1] !== 'OR') out.push('OR');
      continue;
    }
    const colon = tok.indexOf(':');
    const opRaw = colon >= 0 ? tok.slice(0, colon) : '';
    if (colon >= 0 && /^[A-Za-z_]+$/.test(opRaw)) {
      const op = opRaw.toLowerCase();
      if (!(op in OPS)) continue;
      let value = tok.slice(colon + 1).trim();
      const quoted = value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"';
      if (quoted) value = value.slice(1, -1);
      if (op === 'subject' || (quoted && ['from', 'to', 'cc', 'bcc'].includes(op))) {
        // from:"Ana Souza"
        value = cleanPhrase(value);
        if (!value) continue;
        value = value.includes(' ') ? `"${value}"` : value;
      } else {
        if (op !== 'filename') value = value.toLowerCase();
        const m = OPS[op]!.exec(value);
        if (!m) continue;
        if (op === 'after' || op === 'before') {
          const [y, mo, d] = [m[1], m[2], m[3]].map(Number);
          if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) continue;
          value = `${pad(y, 4)}/${pad(mo)}/${pad(d)}`;
        }
      }
      out.push(`${minus}${op}:${value}`);
      continue;
    }
    if (tok.startsWith('"')) {
      const phrase = cleanPhrase(stripChars(tok, '"'));
      if (phrase) out.push(phrase.includes(' ') ? `${minus}"${phrase}"` : `${minus}${phrase}`);
      continue;
    }
    for (const w of cleanPhrase(tok).split(/\s+/).filter(Boolean)) if (cps(w).length >= 2) out.push(`${minus}${w}`);
  }
  while (out.length && out[0] === 'OR') out.shift();
  while (out.length && out[out.length - 1] === 'OR') out.pop();
  let query = out.join(' ');
  if (cps(query).length > MAX_QUERY_LEN) {
    const cut = cps(query).slice(0, MAX_QUERY_LEN).join('');
    const sp = cut.lastIndexOf(' ');
    query = sp >= 0 ? cut.slice(0, sp) : cut;
  }
  return query.trim();
}

// ── links ──
export function gmailUrl(threadId: string, me: string): string {
  const authuser = me ? `?authuser=${encodeURIComponent(me)}` : '';
  return `https://mail.google.com/mail/${authuser}#all/${encodeURIComponent(threadId || '')}`;
}

// ── prompts (cópia literal de verify.py) ──
export function extractPrompt(row: Dict, body: string, hoje: string): string {
  return (
    'Você vai ajudar o Leo (leo@confrapag.com.br) a CONFERIR na caixa de e-mail dele o que este e-mail afirma.\n' +
    `Hoje é ${hoje}. Leia a thread inteira, com foco na ÚLTIMA mensagem escrita por outra pessoa (não o Leo).\n` +
    'Liste as AFIRMAÇÕES verificáveis sobre a caixa do Leo ou sobre eventos de e-mail: que o Leo recebeu algo ' +
    '(link de acesso, convite, anexo, boleto, relatório) de alguém por volta de uma data, que algo foi enviado a ele, ' +
    'que ele já respondeu/enviou algo, que um e-mail foi encaminhado, etc. Ignore opiniões, pedidos e fatos que não ' +
    'deixam rastro na caixa de e-mail.\n' +
    `No máximo ${MAX_AFIRMACOES} afirmações, cada uma com até ${MAX_CONSULTAS} consultas de busca do Gmail, da mais ` +
    'específica para a mais ampla. Operadores permitidos: from:, to:, cc:, subject:, palavras ou "frase", ' +
    'after:AAAA/MM/DD, before:AAAA/MM/DD, newer_than:Nd, has:attachment, filename:, in:anywhere (inclui arquivados, ' +
    'spam e lixeira), in:sent (o que o Leo enviou), OR. Use janelas de data folgadas (alguns dias antes e depois). ' +
    'Prefira e-mails e domínios que aparecem na thread.\n' +
    'Responda SÓ com JSON, em português do Brasil, tratando o Leo por "você":\n' +
    '{"afirmacoes": [{"texto": "Você recebeu de X um e-mail com o link de acesso por volta de 05/10", ' +
    '"consultas": ["from:x@empresa.com after:2026/10/03 before:2026/10/08 in:anywhere", "acesso link in:anywhere newer_than:14d"]}]}\n' +
    'Sem afirmações verificáveis: {"afirmacoes": []}. NUNCA invente nome, e-mail ou data que não estão na thread.\n\n' +
    `Assunto: ${s(row.subject)}\n` +
    `Para: ${s(row.to_header) || '?'} · Cc: ${s(row.cc_header) || '-'}\n\n` +
    `Thread (mensagens separadas por ----, a última por último):\n${cps(body).slice(-14000).join('')}`
  );
}

export interface Evidence {
  message_id: string;
  thread_id: string;
  assunto: string;
  de: string;
  para: string;
  data: string;
  snippet: string;
  labels: string[];
  mesma_thread: boolean;
  gmail_url: string;
  app_url: string;
}

interface Consulta {
  q: string;
  resultados: string[];
  erro?: string;
}
interface Afirmacao {
  texto: string;
  consultas: string[];
}
interface Buscada {
  texto: string;
  consultas: Consulta[];
}

function evidenceLine(key: string, ev: Evidence): string {
  const where = ev.mesma_thread ? 'mesma conversa deste e-mail' : 'outra conversa';
  const pasta = (ev.labels || []).filter((l) => ['SENT', 'INBOX', 'SPAM', 'TRASH', 'DRAFT'].includes(l)).join(', ') || 'arquivado';
  return (
    `[${key}] De: ${ev.de || '?'} | Para: ${ev.para || '?'} | Data: ${ev.data || '?'} | ` +
    `Assunto: ${ev.assunto} | Pasta: ${pasta} | ${where}\n    Trecho: ${ev.snippet}`
  );
}

export function judgePrompt(row: Dict, afirmacoes: Buscada[], evidencias: Record<string, Evidence>, hoje: string): string {
  const blocks = afirmacoes.map((af, i) => {
    const lines = [`Afirmação ${i + 1}: ${af.texto}`];
    for (const c of af.consultas) {
      lines.push(`  Consulta: ${c.q} -> ${c.resultados.length} resultado(s)${c.erro ? ' (erro: ' + c.erro + ')' : ''}`);
      for (const key of c.resultados) lines.push('  ' + evidenceLine(key, evidencias[key]));
    }
    return lines.join('\n');
  });
  return (
    'Você está conferindo, com buscas na caixa de e-mail do Leo (leo@confrapag.com.br), o que um e-mail afirma.\n' +
    `Hoje é ${hoje}. Assunto do e-mail conferido: ${s(row.subject)}\n` +
    'Para cada afirmação, decida com base SÓ nas evidências listadas (resultados das buscas):\n' +
    '- "confirmado": há e-mail que sustenta a afirmação (remetente/assunto/data/trecho batem).\n' +
    '- "nao_encontrado": as buscas não acharam nada que sustente.\n' +
    '- "inconclusivo": achou algo parecido, mas não dá para afirmar (data, remetente ou conteúdo não batem bem).\n' +
    'Mensagens da "mesma conversa deste e-mail" escritas por quem fez a afirmação NÃO a confirmam sozinhas ' +
    '(é o próprio e-mail se citando); respostas do Leo nessa conversa contam.\n' +
    'Explicação curta (1-2 frases), em português do Brasil, tratando o Leo por "você", citando datas e remetentes. ' +
    'Em "evidencias" liste as chaves ([E1], [E2]…) dos e-mails que sustentam ou mais se aproximam.\n' +
    'Responda SÓ com JSON: ' +
    '{"avaliacoes": [{"n": 1, "veredito": "confirmado", "explicacao": "...", "evidencias": ["E1"]}]}\n\n' +
    blocks.join('\n\n')
  );
}

// ── data de "hoje" como o Python: strftime("%d/%m/%Y (%A)") no fuso do app (locale C) ──
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function hojeLabel(nowMs: number): string {
  const t = new Date(nowMs - 3 * 3600_000); // America/Fortaleza (UTC-3, sem horário de verão)
  return `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCFullYear(), 4)} (${WEEKDAYS[t.getUTCDay()]})`;
}

export function pasta(labels: string[]): string {
  const set = new Set(labels || []);
  for (const [label, name] of [['TRASH', 'Lixeira'], ['SPAM', 'Spam'], ['SENT', 'Enviados'], ['INBOX', 'Caixa de entrada'], ['DRAFT', 'Rascunhos']]) {
    if (set.has(label)) return name;
  }
  return 'Arquivado';
}

/** int(x) do Python para o "n" da avaliação (null = ValueError/TypeError). */
function pyInt(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}
const pyTruthy = (v: unknown) => !(v == null || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length));
const pyStr = (v: unknown) => (v == null ? 'None' : v === true ? 'True' : v === false ? 'False' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v));
const orEmpty = (v: unknown) => (pyTruthy(v) ? pyStr(v) : '');
const isDict = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);

function loads(raw: SqlValue | undefined): Dict {
  if (!raw) return {};
  try {
    const v = JSON.parse(String(raw));
    return isDict(v) ? v : {};
  } catch {
    return {};
  }
}

export interface VerifyDeps {
  llm: { complete(user: string, opts?: { system?: string; timeoutMs?: number }): Promise<string> };
  hasKey(): Promise<boolean>;
  /** só a busca: o verificador nunca recebe modify/send */
  gmail: { searchMessages(q: string, maxResults?: number): Promise<SearchHit[]> };
  /** Gmail conectado (logado)? */
  gmailReady(): Promise<boolean>;
  ensureBody?(row: Row): Promise<string>;
  /** conta logada (link do Gmail com authuser) */
  me(): string;
  now?(): number;
}

export function createVerify(deps: VerifyDeps) {
  const hoje = () => hojeLabel(deps.now ? deps.now() : Date.now());
  const errMsg = (e: unknown) => clip(e instanceof Error ? e.message : String(e), 120);

  async function body(row: Row): Promise<string> {
    try {
      return deps.ensureBody ? await deps.ensureBody(row) : s(row.body_text);
    } catch {
      return s(row.body_text);
    }
  }

  async function extract(row: Row, text: string): Promise<Afirmacao[]> {
    let data: Dict;
    try {
      data = parse(await deps.llm.complete(extractPrompt(row, text, hoje()), { timeoutMs: 90_000 }));
    } catch (e) {
      throw new Error(`A IA não respondeu agora (${errMsg(e)}). Tente de novo em instantes.`);
    }
    if (!Array.isArray(data.afirmacoes)) throw new Error('A IA respondeu fora do formato. Tente Regerar.');
    const out: Afirmacao[] = [];
    for (const af of data.afirmacoes) {
      if (!isDict(af)) continue;
      const texto = words(orEmpty(af.texto));
      if (!texto) continue;
      const consultas: string[] = [];
      for (const q of Array.isArray(af.consultas) ? af.consultas : []) {
        const clean = sanitizeQuery(pyStr(q));
        if (clean && !consultas.includes(clean)) consultas.push(clean);
        if (consultas.length >= MAX_CONSULTAS) break;
      }
      out.push({ texto: clip(texto, 300), consultas });
      if (out.length >= MAX_AFIRMACOES) break;
    }
    return out;
  }

  async function evidenceFrom(hit: SearchHit, threadId: string): Promise<Evidence> {
    let snippet = unescapeHtml(words(s(hit.snippet)));
    let assunto = s(hit.assunto);
    if (looksLikeSecret(snippet)) snippet = SECRET_SNIPPET;
    if (looksLikeSecret(assunto)) assunto = '[assunto omitido]';
    const tid = s(hit.thread_id);
    return {
      message_id: s(hit.message_id),
      thread_id: tid,
      assunto,
      de: s(hit.de),
      para: s(hit.para),
      data: s(hit.data),
      snippet: clip(snippet, 300),
      labels: [...(hit.labels || [])],
      mesma_thread: tid === threadId,
      gmail_url: tid ? gmailUrl(tid, deps.me()) : '',
      app_url: tid && (await db.getThread(tid)) ? `/copilot/${tid}` : '',
    };
  }

  /** Roda as consultas (uma vez cada); a mesma mensagem achada por duas consultas = mesma chave. */
  async function search(threadId: string, afirmacoes: Afirmacao[]): Promise<{ buscadas: Buscada[]; evidencias: Record<string, Evidence> }> {
    const evidencias: Record<string, Evidence> = {};
    const byMsg = new Map<string, string>();
    const ran = new Map<string, [string[], string]>();
    let errors = 0;
    let total = 0;
    const buscadas: Buscada[] = [];
    for (const af of afirmacoes) {
      const consultas: Consulta[] = [];
      for (const q of af.consultas) {
        total += 1;
        if (!ran.has(q)) {
          try {
            const hits = await deps.gmail.searchMessages(q, MAX_RESULTADOS);
            const keys: string[] = [];
            for (const hit of hits) {
              const mid = s(hit.message_id);
              if (!byMsg.has(mid)) {
                const key = `E${Object.keys(evidencias).length + 1}`;
                byMsg.set(mid, key);
                evidencias[key] = await evidenceFrom(hit, threadId);
              }
              keys.push(byMsg.get(mid)!);
            }
            ran.set(q, [keys, '']);
          } catch (e) {
            errors += 1;
            ran.set(q, [[], errMsg(e)]);
          }
        }
        const [keys, err] = ran.get(q)!;
        const item: Consulta = { q, resultados: keys };
        if (err) item.erro = err;
        consultas.push(item);
      }
      buscadas.push({ texto: af.texto, consultas });
    }
    if (total && errors === ran.size) throw new Error('Não consegui buscar na sua caixa agora (o Gmail não respondeu). Tente de novo em instantes.');
    return { buscadas, evidencias };
  }

  async function judge(row: Row, afirmacoes: Buscada[], evidencias: Record<string, Evidence>) {
    const avaliacoes = new Map<number, Dict>();
    if (afirmacoes.some((af) => af.consultas.some((c) => c.resultados.length))) {
      let data: Dict;
      try {
        data = parse(await deps.llm.complete(judgePrompt(row, afirmacoes, evidencias, hoje()), { timeoutMs: 90_000 }));
      } catch (e) {
        throw new Error(`A IA não respondeu agora (${errMsg(e)}). Tente de novo em instantes.`);
      }
      (Array.isArray(data.avaliacoes) ? data.avaliacoes : []).forEach((av: unknown, i: number) => {
        if (!isDict(av)) return;
        const raw = pyTruthy(av.n) ? av.n : i + 1;
        const parsedN = pyInt(raw);
        const n = parsedN === null ? i : parsedN - 1;
        if (!avaliacoes.has(n)) avaliacoes.set(n, av);
      });
    }
    return afirmacoes.map((af, i) => {
      const found: string[] = [];
      for (const c of af.consultas) for (const key of c.resultados) if (!found.includes(key)) found.push(key);
      const av = avaliacoes.get(i) || {};
      let veredito = orEmpty(av.veredito).trim().toLowerCase().replace(/ã/g, 'a').replace(/ /g, '_');
      if (!(VEREDITOS as readonly string[]).includes(veredito)) veredito = found.length ? 'inconclusivo' : 'nao_encontrado';
      let explicacao = words(orEmpty(av.explicacao));
      if (!explicacao) {
        if (!af.consultas.length) explicacao = 'Não deu para montar uma busca para esta afirmação.';
        else if (!found.length) explicacao = 'As buscas na sua caixa não acharam nenhum e-mail sobre isso.';
        else explicacao = 'Achei e-mails parecidos, mas a IA não conseguiu concluir.';
      }
      const citadas = (Array.isArray(av.evidencias) ? av.evidencias : []).map((k) => stripChars(pyStr(k), '[] '));
      // só vale chave que a busca desta afirmação achou de verdade
      let keys = citadas.filter((k) => found.includes(k));
      if (!keys.length && veredito !== 'nao_encontrado') keys = found.slice(0, 3);
      return {
        texto: af.texto,
        veredito,
        veredito_label: VEREDITO_LABEL[veredito],
        explicacao: clip(explicacao, 400),
        consultas: af.consultas.map((c) => ({ q: c.q, resultados: c.resultados.length, ...(c.erro ? { erro: c.erro } : {}) })),
        evidencias: keys.map((k) => {
          const { labels, ...rest } = evidencias[k];
          return { ...rest, pasta: pasta(labels) };
        }),
        encontrados: found.length,
      };
    });
  }

  const out = (hit: Row, fromCache: boolean, stale = false): VerifyResult => {
    const data = loads(hit.resultado_json);
    return {
      afirmacoes: (pyTruthy(data.afirmacoes) ? data.afirmacoes : []) as VerifyResult['afirmacoes'],
      aviso: orEmpty(data.aviso),
      gerado_em: s(hit.gerado_em),
      cached: fromCache,
      desatualizado: stale,
    };
  };

  const isStale = (row: Row, hit: Row, count: number | null) =>
    Number(row.internal_date || 0) > Number(hit.internal_date_snapshot || 0) ||
    (count !== null && !!Number(hit.msg_count_snapshot || 0) && count !== Number(hit.msg_count_snapshot));

  return {
    sanitizeQuery,
    /** Só o cache (nunca chama IA nem Gmail). afirmacoes=null quando não há. */
    async cached(threadId: string): Promise<VerifyResult> {
      const row = await db.getThread(threadId);
      if (!row) throw new Error('Thread não encontrada.');
      const hit = await db.getCopilotVerificacao(threadId);
      if (!hit) return { afirmacoes: null, gerado_em: '', cached: false, desatualizado: false };
      return out(hit, true, isStale(row, hit, null));
    },

    /** Extrai → busca (só leitura) → avalia. Usa o cache se a thread não mudou e não é Regerar. */
    async verificar(threadId: string, opts: { force?: boolean } = {}): Promise<VerifyResult> {
      const row = await db.getThread(threadId);
      if (!row) throw new Error('Thread não encontrada.');
      const text = await body(row);
      const count = messages(text).length;
      const hit = await db.getCopilotVerificacao(threadId);
      if (hit && !opts.force && !isStale(row, hit, count)) return out(hit, true);

      if (!(await deps.hasKey())) throw new Error('Sem chave de IA configurada: o verificador precisa da IA para ler o e-mail. Configure em Configurações.');
      if (!(await deps.gmailReady())) throw new Error('O Gmail não está conectado: o verificador precisa ler a sua caixa (só leitura). Conecte em Configurações.');
      if (looksLikeSecret(`${s(row.subject)}\n${text}`)) throw new Error('A conversa traz senha ou credencial: não mandei para a IA. Confira a caixa manualmente.');
      if (text.replace(/^(De|Data):.*$/gm, '').replace(/\s+/g, '').length < 25) throw new Error('Não consegui ler o texto da conversa (vazio, só imagem ou anexo).');

      const afirmacoes = await extract(row, text);
      let resultado: unknown[] = [];
      let aviso = '';
      if (afirmacoes.length) {
        const { buscadas, evidencias } = await search(threadId, afirmacoes);
        resultado = await judge(row, buscadas, evidencias);
      } else aviso = 'Não achei neste e-mail nenhuma afirmação que dê para conferir na sua caixa.';
      await db.saveCopilotVerificacao(threadId, JSON.stringify({ afirmacoes: resultado, aviso }), Number(row.internal_date || 0), count);
      return out((await db.getCopilotVerificacao(threadId))!, false);
    },
  };
}

export type Verify = ReturnType<typeof createVerify>;
