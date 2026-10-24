// Copiloto no aparelho — porte do núcleo de app/copilot.py: leitura por regra
// (heuristic), prompt e parse da IA (MESMO texto do Python, conferido no teste),
// validação das opções/evidências, regras "só em cópia" e "pedido a outra
// pessoa", estado da conversa, abas do kanban, lista/detalhe e a fila local
// (concorrência 2) que grava em copilot_items. Nada aqui envia e-mail nem
// mexe no Gmail.
//
// Não portado (depende do Mac): RAG/cérebro em _sources (só as decisões
// anteriores do banco entram como fonte) e a cópia da análise na Learning Base.
import * as db from './db';
import type { Row, SqlValue } from './db';
import { GmailError } from './gmail';
import { AuthError } from './googleAuth';
import { notesBlock, threadEmails } from './learned';
import { getAddresses } from './mime';
import { runPool } from './pool';
import { looksLikeSecret } from './secretsGuard';
import type { Bola, Conversa, CopilotList, Item, ItemDetail, Job, Opcao, Papel, Pessoa, ResumoContexto, Status, TabKey, Tarefa, Urgencia } from '../types';

export const PAPEIS = ['so_copia', 'mencionado_opiniao', 'demanda', 'fyi', 'pode_ignorar'] as const;
export const OPCOES = ['direcionar', 'estudar_depois_responder', 'pedir_contexto', 'responder', 'aguardar'] as const;
export const URGENCIAS = ['alta', 'media', 'baixa', 'neutra'] as const;
export const STATUS = ['aberto', 'assumido', 'delegado', 'cobrado', 'aguardando', 'resolvido'] as const;
// Quadro: só o que ainda pede atenção (resolvidos/lidos viram histórico à parte).
export const TABS = [
  { key: 'precisa_de_voce', title: 'Precisa de você' },
  { key: 'bola_com_outros', title: 'Aguardando outras pessoas' },
  { key: 'so_conhecimento', title: 'Só conhecimento' },
] as const;
export const HISTORY = [
  { key: 'resolvido', title: 'Resolvidos' },
  { key: 'lidos', title: 'Marcados como lido' },
] as const;
export const FILA = { key: 'analisando', title: 'Analisando' } as const;

const KNOWLEDGE = new Set(['so_copia', 'fyi', 'pode_ignorar']);
const PRECEDENT = new Set(['learning_base', 'decisao']);
const URG_ORDER: Record<string, number> = { alta: 0, media: 1, baixa: 2, neutra: 3 };
const MIN_QUOTE = 8;
const MAX_OPTIONS = 3;
export const DEFAULT_LIMIT = 12;
export const LIST_LIMIT = 200;
export const SEARCH_EXTRA = 60;
export const RETRY_AFTER_MS = 600_000;
export const CONCURRENCY = 2;
// Lida "por regra" de propósito também é final até chegar mensagem nova.
const FINAL = new Set(['llm', 'regra']);

// ── conta e relógio (o app troca pela conta logada; os testes, pelo relógio) ──
let ME = 'leo@confrapag.com.br';
let clock: () => number = () => Date.now();
export const setAccount = (email: string) => {
  if (email && email.includes('@')) ME = email.trim().toLowerCase();
};
export const getAccount = () => ME;
export const setClock = (fn: (() => number) | null) => {
  clock = fn ?? (() => Date.now());
};

// Fuso do app: America/Fortaleza (UTC-3, sem horário de verão).
const TZ_OFFSET_MS = -3 * 3600_000;
const tzDate = (ms: number) => new Date(ms + TZ_OFFSET_MS); // ler com getUTC*
const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
function todayParts(): { y: number; m: number; d: number } {
  const t = tzDate(clock());
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const addDays = (p: { y: number; m: number; d: number }, n: number) => {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * 86400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

// ── utilidades ──
type Dict = Record<string, unknown>;
const s = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => Number(v || 0) || 0;

/** Verdade no sentido do Python (lista/dict vazios são falsos). */
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return !!v;
}

// \b do Python é Unicode: aqui, fronteira com letras acentuadas também.
const WC = 'A-Za-z0-9_\\u00C0-\\u024F';
const B = `(?<![${WC}])`;
const E = `(?![${WC}])`;

export function addresses(header: string | null | undefined): { name: string; email: string }[] {
  return getAddresses(header || '').filter((a) => a.email).map((a) => ({ name: a.name, email: a.email.trim().toLowerCase() }));
}

export function norm(text: string): string {
  return (text || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export function clip(text: string, n: number): string {
  const t = (text || '').split(/\s+/).filter(Boolean).join(' ');
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…';
}

function loads<T>(raw: SqlValue | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(String(raw));
    if (Array.isArray(fallback)) return (Array.isArray(v) ? v : fallback) as T;
    return (v && typeof v === 'object' && !Array.isArray(v) ? v : fallback) as T;
  } catch {
    return fallback;
  }
}

/** Python str[-n:] / str[:n] por ponto de código (emoji conta 1, como lá). */
const tail = (text: string, n: number) => {
  const cps = Array.from(text);
  return cps.length <= n ? text : cps.slice(-n).join('');
};
const head = (text: string, n: number) => {
  const cps = Array.from(text);
  return cps.length <= n ? text : cps.slice(0, n).join('');
};

export function fold(text: string): string {
  return (text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function lastMessage(body: string): string {
  const blocks = (body || '').split('\n\n----\n\n').filter((b) => b.trim());
  // sem as linhas De:/Data: -- o e-mail do próprio Leo ali contaria como "citaram o Leo"
  return blocks.length ? blocks[blocks.length - 1].replace(/^(De|Data):.*$/gm, '').trim() : '';
}

const PRAZO_RE = new RegExp(`${B}(?:at[eé]|prazo[:\\s]+|para)\\s*(?:o dia\\s*)?(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?`, 'i');
const URGENTE_RE = new RegExp(`${B}urgente${E}|${B}hoje${E}|${B}ainda hoje${E}|${B}asap${E}`, 'i');
export const PEDIDO_RE = new RegExp(
  `\\?|${B}pode(ria)?s?${E}|${B}consegue${E}|${B}por favor${E}|${B}preciso${E}|${B}favor${E}|${B}validar${E}|${B}aprovar${E}`,
  'i',
);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MENTION_RE = new RegExp(`${B}(leo|lettiery)${E}`, 'i');

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(2000, m - 1, d));
  const leapOk = !(m === 2 && d === 29) || (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0));
  return t.getUTCMonth() === m - 1 && leapOk;
}

export function prazoFromText(text: string, today = todayParts()): string {
  const m = PRAZO_RE.exec(text || '');
  if (!m) return '';
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3];
  const y = year ? Number(year) + (year.length === 2 ? 2000 : 0) : today.y;
  if (!validDate(y, month, day)) return '';
  let found = isoDay(y, month, day);
  const limit = addDays(today, -60);
  if (!year && found < isoDay(limit.y, limit.m, limit.d)) {
    if (!validDate(y + 1, month, day)) return '';
    found = isoDay(y + 1, month, day);
  }
  return found;
}

export const mentionsMe = (text: string) => MENTION_RE.test(text || '');

/** O Leo está só em Cc (não no Para) e não foi ele quem escreveu por último. */
export function onlyCc(row: Dict): boolean {
  const to = new Set(addresses(s(row.to_header)).map((a) => a.email));
  const cc = new Set(addresses(s(row.cc_header)).map((a) => a.email));
  return cc.has(ME) && !to.has(ME) && !truthy(row.last_from_me);
}

const SENTENCE_RE = /(?<=[.!?])\s+|\n+/;
const LEO_VOCATIVE_RE = /^\s*(?:oi|ol[aá]|bom dia|boa tarde|boa noite)?[\s,]*(leo|lettiery)\s*[,!:]/i;

/** Pedido dirigido ao Leo, explícito (no texto da própria pessoa, sem o histórico citado). */
export function asksMe(text: string): boolean {
  const own = ownText(text);
  if (LEO_VOCATIVE_RE.test(own) && PEDIDO_RE.test(own)) return true;
  return own.split(SENTENCE_RE).some((x) => mentionsMe(x) && PEDIDO_RE.test(x));
}

// Palavras que abrem frase com vírgula mas não são gente ("Prezados, ...", "Então, pode...?")
const NOT_A_NAME = new Set([
  'oi', 'ola', 'prezado', 'prezados', 'prezada', 'prezadas', 'caro', 'caros', 'cara', 'caras', 'pessoal',
  'senhores', 'senhoras', 'time', 'equipe', 'galera', 'gente', 'todos', 'todas', 'amigos', 'bom', 'boa',
  'obrigado', 'obrigada', 'grato', 'grata', 'segue', 'seguem', 'conforme', 'favor', 'ok', 'certo', 'perfeito',
  'beleza', 'entao', 'sim', 'nao', 'agora', 'hoje', 'ontem', 'amanha', 'tambem', 'porem', 'contudo', 'alem',
  'enfim', 'desculpe', 'desculpa', 'atenciosamente', 'abracos', 'abs', 'att', 'lembrando', 'importante',
  'urgente', 'pois', 'assim', 'depois', 'antes', 'ainda', 'logo', 'aqui', 'dessa', 'desta', 'nesse', 'neste',
]);

// (?i:oi|olá|bom dia|...) do Python: só a saudação ignora caixa; o nome precisa de maiúscula.
const ci = (w: string) =>
  [...w].map((c) => (c === ' ' ? ' ' : c === 'á' ? '[AaÁá]' : `[${c.toUpperCase()}${c.toLowerCase()}]`)).join('');
const VOCATIVE_RE = new RegExp(
  `^\\s*(?:${ci('oi')}|${ci('ol')}[AaÁá]|${ci('bom dia')}|${ci('boa tarde')}|${ci('boa noite')})?[\\s,]*([A-ZÀ-Ý][a-zà-ÿ]{2,})\\s*[,!:]`,
);

/** O texto abre chamando outra pessoa pelo nome ("Douglas, pode...?"). */
export function vocativeOther(text: string, authorFirst = ''): boolean {
  const voc = VOCATIVE_RE.exec(text || '');
  if (!voc) return false;
  const name = fold(voc[1]);
  return !NOT_A_NAME.has(name) && name !== 'leo' && name !== 'lettiery' && name !== fold(authorFirst);
}

/** "voce" (pede ao Leo pelo nome), "outros" (pede só a outra pessoa) ou "". */
export function askTarget(row: Dict, body: string): '' | 'voce' | 'outros' {
  const msgs = messages(body);
  let text = '';
  let author: { nome: string; email: string };
  if (msgs.length) {
    const conv = conversa(msgs, participants(row));
    const sol = conv?.solicitante;
    if (!conv || conv.status !== 'aguardando' || !sol || sol.voce) return '';
    author = { nome: sol.nome, email: sol.email };
    for (const m of msgs) {
      if (who(m.de).email === sol.email && msgTs(m.data) === sol.em) {
        text = ownText(m.texto);
        break;
      }
    }
  } else {
    text = ownText(s(row.snippet));
    author = { nome: s(row.from_name), email: s(row.from_email).toLowerCase() };
  }
  if (!text || !PEDIDO_RE.test(text)) return '';
  if (asksMe(text)) return 'voce';
  if (vocativeOther(text, firstName(author.nome, author.email))) return 'outros';
  // nome só citado no meio da frase: com o Leo único no Para, o pedido segue sendo dele
  const to = new Set(addresses(s(row.to_header)).map((a) => a.email));
  if (to.size === 1 && to.has(ME)) return '';
  const names = new Set(
    participants(row)
      .filter((a) => a.email !== ME && a.email !== author.email)
      .map((a) => fold(firstName(a.name, a.email)))
      .filter((n) => n.length >= 3 && !NOT_A_NAME.has(n)),
  );
  for (const sent of text.split(SENTENCE_RE)) {
    const folded = fold(sent);
    if (PEDIDO_RE.test(sent) && [...names].some((n) => new RegExp(`${B}${escapeRe(n)}${E}`).test(folded))) return 'outros';
  }
  return '';
}

export function shortName(name: string, email: string): string {
  const n = (name || '').trim().replace(/^"+|"+$/g, '');
  if (n && !n.includes('@')) return n.split(/\s+/).slice(0, 2).join(' ');
  return (email || '').split('@')[0] || 'Alguém';
}

export function firstName(name: string, email: string): string {
  const n = (name || '').trim().replace(/^"+|"+$/g, '');
  if (n && !n.includes('@')) return n.split(/\s+/)[0];
  const local = (email || '').split('@')[0].split('.')[0];
  return local ? local[0].toUpperCase() + local.slice(1).toLowerCase() : '';
}

const ddmmOf = (prazo: string) => `${prazo.slice(8, 10)}/${prazo.slice(5, 7)}`;

/** Uma linha dita com as palavras do painel (só segura o lugar até a IA ler). */
export function ruleSummary(row: Dict, papel: string, prazo: string, bola: { nome?: string; email?: string }): string {
  const w = shortName(s(row.from_name), s(row.from_email));
  let line: string;
  if (truthy(row.last_from_me)) {
    const other = bola.email ? shortName(bola.nome || '', bola.email || '') : 'retorno';
    line = `Você foi o último a escrever; aguardando ${other}.`;
  } else if (truthy(row.is_marketing)) line = `Divulgação de ${w}.`;
  else if (truthy(row.is_automatic)) line = `Aviso automático de ${w}.`;
  else if (papel === 'demanda') line = `${w} pede algo a você.`;
  else if (papel === 'mencionado_opiniao') line = `${w} citou você na conversa.`;
  else if (papel === 'so_copia') line = `${w} escreveu; você está só em cópia.`;
  else line = `${w} mandou um informativo.`;
  if (prazo) line = line.replace(/\.+$/, '') + ` (prazo ${ddmmOf(prazo)}).`;
  return line;
}

export interface CopilotItem {
  papel: Papel;
  o_que_aconteceu: string;
  opcoes: Opcao[];
  urgencia: Urgencia;
  bola: Bola;
  depende_de_outros: boolean;
  sem_resposta_desde: number | null;
  prazo: string;
  quem_pediu: Pessoa & { voce?: boolean };
  tarefas: Tarefa[];
  needs_context: boolean;
  o_que_falta: string;
  pergunta: string;
  status: Status;
  source: 'llm' | 'heuristica' | 'regra';
  delegado?: Item['delegado'];
  analyzed_at?: string | null;
  conversa?: Conversa | null;
}

const NO_BALL = (): Bola => ({ com: 'ninguem', email: '', nome: '' });

// ── leitura sem IA (sempre disponível) ──
export function heuristic(row: Dict, body = ''): CopilotItem {
  const to = addresses(s(row.to_header)).map((a) => a.email);
  const cc = addresses(s(row.cc_header)).map((a) => a.email);
  const last = lastMessage(body) || s(row.snippet);
  const blob = `${s(row.subject)}\n${last}`;
  const today = todayParts();

  let papel: Papel;
  if (truthy(row.is_marketing) || truthy(row.is_automatic)) papel = 'pode_ignorar';
  else if (truthy(row.last_from_me)) papel = 'demanda';
  else if (cc.includes(ME) && !to.includes(ME)) {
    // só copiado: nunca vira demanda; no máximo "pedem sua opinião", e só com pedido ao Leo pelo nome
    papel = asksMe(last) ? 'mencionado_opiniao' : 'so_copia';
  } else if (askTarget(row, body) === 'outros') {
    // "Douglas, pode enviar o prazo?": o pedido é de outra pessoa, mesmo com o Leo no Para
    papel = 'fyi';
  } else if (truthy(row.needs_action_hint) || (to.includes(ME) && PEDIDO_RE.test(blob))) papel = 'demanda';
  else if (mentionsMe(last) && to.length > 1) papel = 'mencionado_opiniao';
  else if (truthy(row.fyi_only)) papel = 'fyi';
  else if (!to.length && PEDIDO_RE.test(blob)) papel = 'demanda';
  else papel = 'fyi';

  const prazo = prazoFromText(blob, today);
  const amanha = addDays(today, 1);
  let urgencia: Urgencia;
  if (KNOWLEDGE.has(papel)) urgencia = 'neutra';
  else if (URGENTE_RE.test(blob) || (prazo && prazo <= isoDay(amanha.y, amanha.m, amanha.d))) urgencia = 'alta';
  else if (papel === 'demanda') urgencia = 'media';
  else urgencia = 'baixa';

  let bola: Bola;
  if (truthy(row.last_from_me)) {
    const others = addresses(s(row.to_header)).filter((a) => a.email !== ME);
    const w = others[0] || { name: '', email: '' };
    bola = { com: 'outros', email: w.email, nome: w.name };
  } else if (papel === 'demanda' || papel === 'mencionado_opiniao') bola = { com: 'leo', email: ME, nome: 'Você' };
  else bola = NO_BALL();

  const sender = s(row.from_email).toLowerCase();
  const quem = sender && sender !== ME ? { nome: s(row.from_name), email: sender } : { nome: '', email: '' };
  return {
    papel,
    o_que_aconteceu: ruleSummary(row, papel, prazo, bola),
    opcoes: [],
    urgencia,
    bola,
    depende_de_outros: bola.com === 'outros',
    sem_resposta_desde: bola.com !== 'ninguem' ? num(row.internal_date) : null,
    prazo,
    quem_pediu: quem,
    tarefas: [],
    needs_context: false,
    o_que_falta: '',
    pergunta: '',
    status: 'aberto',
    source: 'heuristica',
  };
}

// ── leitura com IA ──
export interface Source {
  tipo: string;
  titulo: string;
  texto: string;
}

/** Trechos numerados que o modelo pode citar. No aparelho: só as decisões anteriores (sem RAG do Mac). */
export async function sources(row: Dict): Promise<Source[]> {
  const out: Source[] = [];
  for (const a of await db.copilotActionsForSender(s(row.from_email), s(row.id))) {
    const payload = loads<Dict>(a.payload_json, {});
    const detail = s(payload.para) || s(payload.acao) || '';
    out.push({
      tipo: 'decisao',
      titulo: `Você já fez "${s(a.action)}" em: ${s(a.subject) || '(sem assunto)'}`,
      texto: `Em ${s(a.at).slice(0, 10)} você escolheu ${s(a.action)}` + (detail ? ` (${detail})` : '') + '.',
    });
  }
  return out;
}

/** list(...) do Python dentro de f-string: ['a', 'b']. */
const pyList = (xs: readonly string[]) => `[${xs.map((x) => `'${x}'`).join(', ')}]`;

/**
 * Prompt do copiloto — cópia literal de app/copilot.py::_prompt. O bloco de
 * aprendizados (learned.notes_block) entra já pronto em `notes`.
 */
export function buildPrompt(row: Dict, body: string, srcs: Source[], base: CopilotItem, notes: string): string {
  const numbered =
    srcs.map((x, i) => `[${i + 1}] (${x.tipo}) ${x.titulo}\n${head(x.texto, 800)}`).join('\n\n') || '(nenhum trecho encontrado)';
  return (
    'Você é o COPILOTO de e-mails do Leo (leo@confrapag.com.br). Leia a thread e responda SÓ com JSON.\n' +
    'Campos:\n' +
    `- "papel_leo": um de ${pyList(PAPEIS)}. so_copia = Leo só copiado sem pedido a ele; ` +
    'mencionado_opiniao = citam o Leo ou pedem a opinião dele; demanda = pedem algo que o Leo precisa fazer/decidir; ' +
    'fyi = informativo; pode_ignorar = ruído.\n' +
    '  Para/Cc importam: se o Leo está SÓ em Cc (não no Para), o papel é so_copia -- NUNCA demanda. ' +
    'Só use mencionado_opiniao nesse caso se alguém pedir algo AO LEO pelo nome, e cite esse trecho como evidência; ' +
    'pedido feito a outra pessoa da conversa não conta.\n' +
    '  Alvo do pedido: pedido a X ≠ demanda do Leo. Se o pedido em aberto é dirigido a outra pessoa ' +
    '(ex.: "Douglas, pode enviar o prazo?"), NÃO é demanda nem mencionado_opiniao, mesmo com o Leo no Para: ' +
    'use fyi (ou so_copia se ele está só em Cc). Só é demanda se o pedido for AO Leo (pelo nome) ou, sem ' +
    'ninguém nomeado, se o Leo for o destinatário natural no Para.\n' +
    '- "o_que_aconteceu": UMA linha humana (máx. 140 caracteres) sobre o estado atual da conversa, ' +
    'com suas palavras (resuma; não copie o texto do e-mail).\n' +
    `- "urgencia": um de ${pyList(URGENCIAS)} (alta só com prazo real ou impacto claro).\n` +
    '- "bola": "leo" | "outros" | "ninguem" -- com quem está o próximo passo; "bola_email": e-mail de quem está com a bola.\n' +
    '- "depende_de_outros": true|false. "prazo": "AAAA-MM-DD" só se estiver escrito no e-mail, senão "".\n' +
    '- "quem_pediu": {"nome": "...", "email": "..."}. "tarefas": lista curta de passos concretos (pode ser vazia).\n' +
    `- "o_que_eu_faria": 1 a 3 opções, cada uma {"acao": um de ${pyList(OPCOES)}, "texto": "frase curta", ` +
    '"para": "e-mail (só em direcionar)", "confianca": 0.0-1.0, "evidencias": [...]}.\n' +
    '  Cada evidência é {"tipo": "mensagem", "citacao": "trecho COPIADO LITERALMENTE da thread"} ou ' +
    '{"tipo": "fonte", "n": número do trecho, "porque": "por que serve"}.\n' +
    '  Opção sem evidência será descartada. "responder" exige pelo menos uma fonte do cérebro ou decisão anterior ' +
    '(precedente); sem precedente, prefira pedir_contexto, estudar_depois_responder ou direcionar.\n' +
    '  Se o papel for demanda ou mencionado_opiniao, traga ao menos uma opção concreta -- uma citação literal ' +
    'do pedido na thread já serve de evidência.\n' +
    '- "o_que_falta" e "pergunta": se faltar contexto, o que falta e uma pergunta curta ao Leo (trate por "você").\n' +
    'NUNCA invente fato, nome, valor ou data.\n\n' +
    `${notes}` +
    `Leitura por regra (pode corrigir): papel=${base.papel}, bola=${base.bola.com}.\n` +
    `Para: ${s(row.to_header) || '?'}\nCc: ${s(row.cc_header) || '-'}\n` +
    (onlyCc(row) ? 'O Leo está SÓ em Cc nesta conversa.\n' : '') +
    (askTarget(row, body) === 'outros' ? 'O pedido em aberto é dirigido a OUTRA pessoa, não ao Leo.\n' : '') +
    '\n' +
    `Trechos disponíveis:\n${numbered}\n\n` +
    `Assunto: ${s(row.subject)}\n\nThread:\n${tail(body, 12000)}`
  );
}

/** Primeiro {...} da resposta (guloso, como o re.DOTALL do Python); {} se não for JSON objeto. */
export function parse(raw: string): Dict {
  const m = /\{[\s\S]*\}/.exec(raw || '');
  if (!m) return {};
  try {
    const data = JSON.parse(m[0]);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

/** Só passa evidência verificável: citação que existe na thread ou trecho que foi entregue ao modelo. */
export function evidence(items: unknown, body: string, srcs: Source[]): Opcao['evidencias'] {
  const out: Opcao['evidencias'] = [];
  const normBody = norm(body);
  const seen = new Set<string>();
  for (const ev of Array.isArray(items) ? items : []) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
    const e = ev as Dict;
    const tipo = s(e.tipo).trim().toLowerCase();
    if (tipo === 'mensagem') {
      const quote = s(e.citacao).split(/\s+/).filter(Boolean).join(' ').replace(/^[ "'“”]+|[ "'“”]+$/g, '');
      const key = `m:${norm(quote)}`;
      if (quote.length < MIN_QUOTE || !normBody.includes(norm(quote)) || seen.has(key)) continue;
      seen.add(key);
      out.push({ tipo: 'mensagem', titulo: 'Na própria thread', trecho: clip(quote, 240), porque: s(e.porque).trim() });
    } else if (tipo === 'fonte' || tipo === 'learning_base' || tipo === 'decisao') {
      const n = toInt(e.n);
      if (n == null || n < 1 || n > srcs.length || seen.has(`f:${n}`)) continue;
      seen.add(`f:${n}`);
      const src = srcs[n - 1];
      out.push({ tipo: src.tipo, titulo: src.titulo, trecho: clip(src.texto, 240), porque: s(e.porque).trim() });
    }
  }
  return out;
}

export function options(rawOpts: unknown, body: string, srcs: Source[]): Opcao[] {
  const out: Opcao[] = [];
  for (const opt of Array.isArray(rawOpts) ? rawOpts : []) {
    if (!opt || typeof opt !== 'object' || Array.isArray(opt)) continue;
    const o = opt as Dict;
    const acao = s(o.acao).trim().toLowerCase();
    if (!(OPCOES as readonly string[]).includes(acao)) continue;
    const evid = evidence(o.evidencias, body, srcs);
    if (!evid.length) continue;
    if (acao === 'responder' && !evid.some((e) => PRECEDENT.has(e.tipo))) continue;
    let conf = Number(o.confianca || 0);
    if (!Number.isFinite(conf)) conf = 0;
    conf = Math.max(0, Math.min(1, conf));
    const para = s(o.para).trim().toLowerCase();
    out.push({
      acao: acao as Opcao['acao'],
      texto: clip(s(o.texto), 220),
      para: para.includes('@') ? para : '',
      confianca: Math.round(conf * 100) / 100,
      evidencias: evid,
    });
  }
  out.sort((a, b) => b.confianca - a.confianca);
  return out.slice(0, MAX_OPTIONS);
}

/** A IA trouxe como evidência uma citação literal que pede algo ao Leo pelo nome. */
export function quotedAsk(item: CopilotItem): boolean {
  return (item.opcoes || []).some((o) =>
    (o.evidencias || []).some((e) => e.tipo === 'mensagem' && mentionsMe(e.trecho || '') && PEDIDO_RE.test(e.trecho || '')),
  );
}

/** Regra do Leo: só em Cc nunca vira demanda; no máximo "pedem sua opinião" com pedido ao Leo pelo nome. */
export function capOnlyCc(item: CopilotItem, row: Dict, body: string): CopilotItem {
  if (!onlyCc(row) || (item.papel !== 'demanda' && item.papel !== 'mencionado_opiniao')) return item;
  if (quotedAsk(item) || asksMe(lastMessage(body) || s(row.snippet))) {
    item.papel = 'mencionado_opiniao';
    return item;
  }
  Object.assign(item, { papel: 'so_copia', bola: NO_BALL(), depende_de_outros: false, sem_resposta_desde: null, needs_context: false });
  if (item.urgencia === 'alta') item.urgencia = 'baixa';
  return item;
}

/** Pedido a X ≠ demanda do Leo: sai de Precisa de você mesmo com o Leo no Para. */
export function capAskOthers(item: CopilotItem, row: Dict, body: string): CopilotItem {
  if (truthy(row.last_from_me) || (item.papel !== 'demanda' && item.papel !== 'mencionado_opiniao')) return item;
  if (quotedAsk(item) || askTarget(row, body) !== 'outros') return item;
  const bola = item.bola || NO_BALL();
  const keep = bola.com === 'outros' && !!bola.email && bola.email !== ME;
  Object.assign(item, {
    papel: onlyCc(row) ? 'so_copia' : 'fyi',
    bola: keep ? { ...bola } : NO_BALL(),
    depende_de_outros: keep,
    sem_resposta_desde: keep ? item.sem_resposta_desde : null,
    needs_context: false,
  });
  if (item.urgencia === 'alta') item.urgencia = 'baixa';
  return item;
}

/** Resposta do modelo → item validado, completando com a leitura por regra onde o modelo falhar. */
export function interpret(row: Dict, body: string, parsed: Dict, srcs: Source[]): CopilotItem {
  const base = heuristic(row, body);
  const item: CopilotItem = { ...base };
  const papel = s(parsed.papel_leo).trim().toLowerCase();
  item.papel = (PAPEIS as readonly string[]).includes(papel) ? (papel as Papel) : base.papel;
  const line = truthy(parsed.o_que_aconteceu) ? clip(s(parsed.o_que_aconteceu).split(/\r\n|\r|\n/)[0] || '', 160) : '';
  item.o_que_aconteceu = line || base.o_que_aconteceu;
  const urg = s(parsed.urgencia).trim().toLowerCase();
  item.urgencia = (URGENCIAS as readonly string[]).includes(urg) ? (urg as Urgencia) : base.urgencia;
  if (KNOWLEDGE.has(item.papel) && item.urgencia === 'alta') item.urgencia = 'baixa';

  const bola = s(parsed.bola).trim().toLowerCase();
  if (truthy(row.last_from_me)) item.bola = base.bola;
  else if (bola === 'leo') item.bola = { com: 'leo', email: ME, nome: 'Você' };
  else if (bola === 'outros') {
    const email = s(parsed.bola_email).trim().toLowerCase();
    const known: Record<string, string> = {};
    for (const a of addresses(`${s(row.to_header)},${s(row.cc_header)},${s(row.last_from_header)}`)) known[a.email] = a.name;
    item.bola = { com: 'outros', email: email in known ? email : '', nome: known[email] ?? '' };
  } else if (bola === 'ninguem') item.bola = NO_BALL();
  item.depende_de_outros = truthy(parsed.depende_de_outros) || item.bola.com === 'outros';
  item.sem_resposta_desde = item.bola.com !== 'ninguem' ? num(row.internal_date) : null;

  const prazo = s(parsed.prazo).trim();
  item.prazo = ISO_RE.test(prazo) ? prazo : base.prazo;
  const quem = parsed.quem_pediu && typeof parsed.quem_pediu === 'object' && !Array.isArray(parsed.quem_pediu) ? (parsed.quem_pediu as Dict) : {};
  if (truthy(quem.email) && s(quem.email).includes('@')) item.quem_pediu = { nome: s(quem.nome), email: s(quem.email).trim().toLowerCase() };
  const tarefas = Array.isArray(parsed.tarefas) ? parsed.tarefas : [];
  item.tarefas = tarefas
    .map((t) => (typeof t === 'string' ? t : JSON.stringify(t)))
    .filter((t) => t.trim())
    .map((t) => ({ texto: clip(t, 140), feita: false }))
    .slice(0, 5);

  item.opcoes = options(parsed.o_que_eu_faria, body, srcs);
  capOnlyCc(item, row, body);
  capAskOthers(item, row, body);
  item.needs_context = !item.opcoes.length && (item.papel === 'demanda' || item.papel === 'mencionado_opiniao');
  item.o_que_falta = clip(s(parsed.o_que_falta), 300);
  item.pergunta = clip(s(parsed.pergunta), 200);
  if (item.needs_context && !item.o_que_falta) {
    item.o_que_falta = 'Não encontrei no e-mail, no cérebro ou nas suas decisões anteriores base para sugerir um caminho.';
  }
  item.source = 'llm';
  return item;
}

// ── mensagens da thread e estado da conversa ──
export interface Msg {
  de: string;
  data: string;
  texto: string;
}

const HEAD_RE = /^(De|Data):[ \t]*(.*)$/gm;

/** Thread mensagem a mensagem (blocos "De:/Data:" separados por ----). */
export function messages(body: string): Msg[] {
  const out: Msg[] = [];
  for (const block of (body || '').split('\n\n----\n\n').filter((b) => b.trim())) {
    const h: Record<string, string> = {};
    for (const m of block.slice(0, 600).matchAll(new RegExp(HEAD_RE.source, 'gm'))) h[m[1]] = m[2].trim();
    const count = Object.keys(h).length;
    let text: string;
    if (count) {
      let n = 0;
      text = block.replace(new RegExp(HEAD_RE.source, 'gm'), (x) => (n++ < count ? '' : x)).trim();
    } else text = block.trim();
    out.push({ de: h.De ?? '', data: h.Data ?? '', texto: text });
  }
  return out;
}

const QUOTE_START_RE = /\n>? ?(?:Em [\s\S]{0,160}?escreveu:|On [\s\S]{0,160}?wrote:)/;

/** Só o que a pessoa escreveu: sem o histórico citado nem linhas com ">". */
export function ownText(text: string): string {
  const t = text || '';
  const m = QUOTE_START_RE.exec('\n' + t);
  const cut = m ? t.slice(0, Math.max(0, m.index - 1)) : t;
  return cut
    .split(/\r\n|\r|\n/)
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n')
    .trim();
}

export function who(header: string): { nome: string; email: string } {
  const found = addresses(header);
  if (found.length) return { nome: shortName(found[0].name, found[0].email), email: found[0].email };
  return { nome: (header || '').trim() || 'Alguém', email: '' };
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ZONES: Record<string, number> = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };

/** Data da mensagem em ms (RFC 2822 do cabeçalho ou ISO); sem fuso = America/Fortaleza. */
export function msgTs(raw: string): number | null {
  const r = (raw || '').trim();
  if (!r) return null;
  const rfc = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?/.exec(r);
  if (rfc) {
    const mon = MONTHS[rfc[2].toLowerCase()];
    if (mon) {
      let y = Number(rfc[3]);
      if (rfc[3].length === 2) y += y > 68 ? 1900 : 2000;
      const zone = rfc[7];
      let offMin: number | null = null;
      if (zone && /^[+-]\d{4}$/.test(zone)) {
        const sign = zone[0] === '-' ? -1 : 1;
        offMin = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
      } else if (zone && zone.toUpperCase() in ZONES) offMin = ZONES[zone.toUpperCase()];
      const utc = Date.UTC(y, mon - 1, Number(rfc[1]), Number(rfc[4]), Number(rfc[5]), Number(rfc[6] || 0));
      return utc - (offMin ?? TZ_OFFSET_MS / 60000) * 60000;
    }
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(r);
  if (iso) {
    const [y, mo, d, hh, mi, ss] = [1, 2, 3, 4, 5, 6].map((i) => Number(iso[i] || 0));
    if (!validDate(y, mo, d) || hh > 23 || mi > 59 || ss > 59) return null;
    const ms = iso[7] ? Math.floor(Number(`0.${iso[7]}`) * 1000) : 0;
    let offMin = TZ_OFFSET_MS / 60000;
    if (iso[8]) {
      if (iso[8] === 'Z') offMin = 0;
      else {
        const z = iso[8].replace(':', '');
        offMin = (z[0] === '-' ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5)));
      }
    }
    return Date.UTC(y, mo - 1, d, hh, mi, ss, ms) - offMin * 60000;
  }
  return null;
}

/** dd/mm HH:MM no fuso do app; só dd/mm quando a hora é 00:00. */
export function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return '';
  const t = tzDate(ms);
  const dm = `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)}`;
  return t.getUTCHours() === 0 && t.getUTCMinutes() === 0 ? dm : `${dm} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

export function participants(row: Dict): { name: string; email: string }[] {
  return addresses(`${s(row.to_header)},${s(row.cc_header)},${s(row.last_from_header)}`);
}

interface ConvMsg {
  nome: string;
  email: string;
  voce: boolean;
  ts: number | null;
  texto: string;
}

/** Quem pediu, se já responderam, quem falou por último — das mensagens reais (porte de conversa()). */
export function conversa(mensagens: Msg[], participantes: { name?: string; email?: string }[] = []): Conversa | null {
  const msgs: ConvMsg[] = (mensagens || []).map((m) => {
    const w = who(m.de || '');
    return { ...w, voce: w.email === ME, ts: msgTs(m.data || ''), texto: ownText(m.texto || '') };
  });
  if (!msgs.length) return null;
  const firsts = new Map<string, string>();
  for (const p of [...msgs.map((m) => ({ nome: m.nome, email: m.email })), ...participantes.map((a) => ({ nome: a.name || '', email: a.email || '' }))]) {
    if (p.email && !firsts.has(p.email)) {
      const fn = fold(firstName(p.nome, p.email));
      if (fn.length >= 3) firsts.set(p.email, fn);
    }
  }

  const para = (m: ConvMsg): Set<string> | null => {
    const text = fold(m.texto);
    const out = new Set<string>();
    for (const [e, fn] of firsts) if (e !== m.email && new RegExp(`${B}${escapeRe(fn)}${E}`).test(text)) out.add(e);
    if (!m.voce && mentionsMe(m.texto)) out.add(ME);
    const voc = VOCATIVE_RE.exec(m.texto);
    if (!out.size && voc && !NOT_A_NAME.has(fold(voc[1])) && fold(voc[1]) !== fold(firstName(m.nome, m.email))) out.add('~' + fold(voc[1]));
    return out.size ? out : null;
  };

  type Pedido = { autor: ConvMsg; para: Set<string> | null; ultimo: ConvMsg };
  const responde = (m: ConvMsg, pedido: Pedido) => {
    if (m.email === pedido.autor.email) return false;
    const alvo = pedido.para;
    return alvo === null || alvo.has(m.email) || alvo.has('~' + fold(firstName(m.nome, m.email)));
  };

  let aberto: Pedido | null = null;
  let resposta: { pedido: Pedido; msg: ConvMsg } | null = null;
  for (const m of msgs) {
    if (aberto !== null) {
      if (responde(m, aberto)) {
        resposta = { pedido: aberto, msg: m };
        aberto = null;
        if (m.texto.includes('?')) {
          // respondeu perguntando de volta: pedido novo dele
          aberto = { autor: m, para: para(m), ultimo: m };
          resposta = null;
        }
      } else aberto.ultimo = m; // reforço do solicitante ou terceiro no meio
      continue;
    }
    const pede = PEDIDO_RE.test(m.texto);
    if (pede && (resposta === null || m.texto.includes('?'))) {
      aberto = { autor: m, para: para(m), ultimo: m };
      resposta = null;
    } else if (resposta !== null && m.email !== resposta.pedido.autor.email) {
      resposta.msg = m; // mais alguém respondeu depois: vale o último
    }
  }

  const pessoa = (m: ConvMsg) => ({ nome: m.voce ? 'Você' : m.nome, email: m.email, voce: m.voce, em: m.ts, quando: fmtWhen(m.ts) });
  const out: Conversa & { pedido_em: number | null; para: string[] } = {
    status: 'sem_pedido',
    solicitante: null,
    pedido_em: null,
    para: [],
    respondido: null,
    aguardando_desde: null,
    ultimo: pessoa(msgs[msgs.length - 1]),
    total: msgs.length,
    rotulo_ultimo: '',
    rotulo_resposta: '',
  };
  const realTargets = (p: Set<string> | null) => [...(p || [])].filter((e) => !e.startsWith('~')).sort();
  if (aberto !== null) {
    const a: ConvMsg = (aberto as Pedido).autor;
    Object.assign(out, {
      status: 'aguardando',
      solicitante: pessoa(a),
      pedido_em: a.ts,
      aguardando_desde: (aberto as Pedido).ultimo.ts || a.ts,
      para: realTargets((aberto as Pedido).para),
    });
  } else if (resposta !== null) {
    const r = resposta as { pedido: Pedido; msg: ConvMsg };
    Object.assign(out, { status: 'respondido', solicitante: pessoa(r.pedido.autor), pedido_em: r.pedido.autor.ts, respondido: pessoa(r.msg), para: realTargets(r.pedido.para) });
  }
  const u = out.ultimo;
  out.rotulo_ultimo = u.nome + (u.quando ? ` · ${u.quando}` : '');
  if (out.status === 'respondido' && out.respondido) {
    const r = out.respondido;
    out.rotulo_resposta = `Respondido por ${r.voce ? 'você' : r.nome}` + (r.quando ? ` · ${r.quando}` : '');
  } else if (out.status === 'aguardando') {
    const since = fmtWhen(out.aguardando_desde);
    out.rotulo_resposta = 'Sem resposta' + (since ? ` desde ${since}` : '');
  } else out.rotulo_resposta = '';
  return out;
}

export function applyConversa(item: CopilotItem, conv: Conversa | null): CopilotItem {
  item.conversa = conv;
  if (!conv) return item;
  const sol = conv.solicitante;
  if (sol && sol.email) item.quem_pediu = { nome: sol.nome, email: sol.email, voce: sol.voce };
  if (conv.status === 'respondido') item.sem_resposta_desde = null;
  else if (conv.status === 'aguardando') item.sem_resposta_desde = conv.aguardando_desde || item.sem_resposta_desde;
  else if (item.sem_resposta_desde && conv.ultimo.em) item.sem_resposta_desde = conv.ultimo.em;
  return item;
}

/** Contexto da conversa para o card de sugestão (sem IA). */
export function resumoContexto(item: { o_que_aconteceu?: string }, mensagens: Msg[]): ResumoContexto {
  const out: ResumoContexto = { o_que_aconteceu: item.o_que_aconteceu || '', total_mensagens: mensagens.length, abertura: null, sua_resposta: null, ultima: null };
  if (!mensagens.length) return out;
  const view = (m: Msg, n: number) => ({ ...who(m.de || ''), data: m.data || '', trecho: clip(ownText(m.texto || ''), n) });
  const first = mensagens[0];
  out.abertura = view(first, 280);
  const mine = mensagens.slice(1).filter((m) => who(m.de || '').email === ME);
  if (who(first.de || '').email === ME) out.abertura.voce = true;
  if (mine.length) out.sua_resposta = view(mine[mine.length - 1], 240);
  if (mensagens.length > 1) {
    const last = view(mensagens[mensagens.length - 1], 240);
    out.ultima = { ...last, voce: last.email === ME };
  }
  return out;
}

export function originators(row: Dict): { name: string; email: string }[] {
  const seen = new Set<string>();
  const out: { name: string; email: string }[] = [];
  for (const a of addresses(`${s(row.last_from_header)},${s(row.to_header)},${s(row.cc_header)}`)) {
    if (a.email !== ME && !seen.has(a.email)) {
      seen.add(a.email);
      out.push(a);
    }
  }
  if (!out.length && row.from_email && row.from_email !== ME) out.push({ name: s(row.from_name), email: s(row.from_email) });
  return out;
}

// ── frescor da leitura ──
const msgCount = (body: string | null | undefined) => messages(body || '').length;

/** A única novidade desde a leitura é mensagem do próprio Leo (não reabre). */
export function onlyMineSince(row: Dict, snapshot: number, body?: string | null): boolean {
  if (!truthy(row.last_from_me)) return false;
  for (const m of messages(body != null ? body : s(row.body_text))) {
    const ts = msgTs(m.data || '');
    if (ts && ts > snapshot && who(m.de || '').email !== ME) return false;
  }
  return true;
}

export function moved(row: Dict, prev: Dict | null | undefined, body?: string | null): boolean {
  if (!prev) return false;
  const snapshot = num(prev.internal_date_snapshot);
  return num(row.internal_date) > snapshot && !onlyMineSince(row, snapshot, body);
}

export function countChanged(row: Dict, prev: Dict | null | undefined): boolean {
  const snap = num(prev?.msg_count_snapshot);
  const body = s(row.body_text);
  if (!(snap && body)) return false;
  const msgs = messages(body);
  if (msgs.length > snap && msgs.slice(snap).every((m) => who(m.de || '').email === ME)) return false;
  return msgs.length !== snap;
}

export function fresh(row: Dict, prev: Dict | null | undefined): boolean {
  return !!prev && FINAL.has(s(prev.source)) && !moved(row, prev) && !countChanged(row, prev);
}

export function tabFor(item: { status: string; bola: { com?: string }; papel: string }): TabKey {
  if (item.status === 'resolvido') return 'resolvido';
  if (['delegado', 'cobrado', 'aguardando'].includes(item.status) || item.bola?.com === 'outros') return 'bola_com_outros';
  if (KNOWLEDGE.has(item.papel) && item.status !== 'assumido') return 'so_conhecimento';
  return 'precisa_de_voce';
}

export function historyKey(item: { status?: string; is_unread?: boolean; no_copiloto?: boolean; pendente?: boolean }): '' | 'resolvido' | 'lidos' {
  if (item.status === 'resolvido') return 'resolvido';
  if (!item.is_unread && item.no_copiloto && !item.pendente) return 'lidos';
  return '';
}

export function classified(item: CopilotItem, acted = false): boolean {
  return FINAL.has(item.source) || item.status !== 'aberto' || acted;
}

/** Grava a leitura (porte de _persist): status/delegação não somem quando a IA relê. */
export async function persist(row: Dict, item: CopilotItem, prev: Dict | null, body?: string | null): Promise<void> {
  const mv = moved(row, prev, body);
  const keepStatus = !!prev && !mv && (STATUS as readonly string[]).includes(s(prev.status));
  const done = new Set(loads<Tarefa[]>((prev?.tarefas_json as SqlValue) ?? null, []).filter((t) => t?.feita).map((t) => t.texto));
  for (const t of item.tarefas) t.feita = done.has(t.texto);
  const fields: Record<string, SqlValue> = {
    papel: item.papel,
    o_que_aconteceu: item.o_que_aconteceu,
    opcoes_json: JSON.stringify(item.opcoes),
    urgencia: item.urgencia,
    depende_de_outros: Number(item.depende_de_outros),
    sem_resposta_desde: item.sem_resposta_desde,
    prazo: item.prazo,
    quem_pediu_json: JSON.stringify(item.quem_pediu),
    tarefas_json: JSON.stringify(item.tarefas),
    needs_context: Number(item.needs_context),
    o_que_falta: item.o_que_falta,
    pergunta: item.pergunta,
    source: item.source,
    internal_date_snapshot: num(row.internal_date),
    analyzed_at: new Date(clock()).toISOString(),
  };
  if (body) fields.msg_count_snapshot = msgCount(body);
  if (!keepStatus) Object.assign(fields, { status: 'aberto', delegado_json: null, bola_json: JSON.stringify(item.bola) });
  else if (prev!.status === 'aberto') fields.bola_json = JSON.stringify(item.bola);
  else if (['delegado', 'cobrado', 'aguardando'].includes(s(prev!.status))) fields.depende_de_outros = 1;
  await db.saveCopilotItem(s(row.id), fields);
}

// ── apresentação ──
export function fromDb(row: Dict, stored: Dict | null | undefined): CopilotItem {
  if (!stored) return heuristic(row, s(row.body_text));
  let d = stored;
  if (s(d.source) !== 'llm') {
    // leitura por regra antiga guardava o snippet cru: mostra a linha da regra
    const bola = loads<Bola>(d.bola_json as SqlValue, NO_BALL());
    d = { ...d, o_que_aconteceu: ruleSummary(row, s(d.papel) || 'fyi', s(d.prazo), bola) };
  }
  return {
    papel: (s(d.papel) || 'fyi') as Papel,
    o_que_aconteceu: s(d.o_que_aconteceu),
    opcoes: loads<Opcao[]>(d.opcoes_json as SqlValue, []),
    urgencia: (s(d.urgencia) || 'neutra') as Urgencia,
    bola: loads<Bola>(d.bola_json as SqlValue, NO_BALL()),
    depende_de_outros: truthy(d.depende_de_outros),
    sem_resposta_desde: d.sem_resposta_desde == null ? null : num(d.sem_resposta_desde),
    prazo: s(d.prazo),
    quem_pediu: loads<Pessoa>(d.quem_pediu_json as SqlValue, { nome: '', email: '' }),
    tarefas: loads<Tarefa[]>(d.tarefas_json as SqlValue, []),
    needs_context: truthy(d.needs_context),
    o_que_falta: s(d.o_que_falta),
    pergunta: s(d.pergunta),
    status: (s(d.status) || 'aberto') as Status,
    source: (s(d.source) || 'heuristica') as CopilotItem['source'],
    delegado: loads<Item['delegado']>(d.delegado_json as SqlValue, {}),
    analyzed_at: d.analyzed_at == null ? null : s(d.analyzed_at),
  };
}

/** Leitura antiga que pôs em demanda um só-Cc ou pedido a outra pessoa: corrige no banco (só item "aberto"). */
export async function healPapel(row: Dict, stored: Row | null | undefined): Promise<Row | null | undefined> {
  if (!stored || (s(stored.status) || 'aberto') !== 'aberto' || !['demanda', 'mencionado_opiniao'].includes(s(stored.papel))) return stored;
  if (truthy(row.last_from_me)) return stored;
  const body = s(row.body_text);
  const item = capAskOthers(capOnlyCc(fromDb(row, stored), row, body), row, body);
  if (item.papel === stored.papel) return stored;
  await db.saveCopilotItem(s(row.id), {
    papel: item.papel,
    bola_json: JSON.stringify(item.bola),
    depende_de_outros: Number(item.depende_de_outros),
    sem_resposta_desde: item.sem_resposta_desde,
    needs_context: Number(item.needs_context),
    urgencia: item.urgencia,
  });
  return (await db.getCopilotItem(s(row.id))) || stored;
}

export function sortKey(a: Item, b: Item): number {
  const ua = URG_ORDER[a.urgencia] ?? 9;
  const ub = URG_ORDER[b.urgencia] ?? 9;
  if (ua !== ub) return ua - ub;
  const pa = a.prazo || '9999';
  const pb = b.prazo || '9999';
  if (pa !== pb) return pa < pb ? -1 : 1;
  return (b.internal_date || 0) - (a.internal_date || 0);
}

const searchTerms = (q?: string | null) => fold((q || '').split(/\s+/).filter(Boolean).join(' ')).split(' ').filter(Boolean);

function matchesSearch(row: Dict, item: { o_que_aconteceu?: string }, terms: string[]): boolean {
  const hay = fold(
    [row.subject, row.from_name, row.from_email, row.last_from_header, row.snippet, item.o_que_aconteceu, s(row.body_text).slice(0, 6000)]
      .map((x) => s(x))
      .join(' '),
  );
  return terms.every((t) => hay.includes(t));
}

export function greeting(nowMs = clock()): string {
  const h = tzDate(nowMs).getUTCHours();
  return h >= 5 && h < 12 ? 'Bom dia, Leo' : h >= 12 && h < 18 ? 'Boa tarde, Leo' : 'Boa noite, Leo';
}

// ── instância: IA, fila e leitura ──
export interface CopilotDeps {
  /** a cadeia de IA (core/ai.ts) — só complete é usado */
  llm: { complete(user: string, opts?: { system?: string; timeoutMs?: number }): Promise<string> };
  hasKey(): Promise<boolean>;
  /** corpo da thread no formato do Mac; o padrão é o body_text que o sync grava */
  ensureBody?(row: Row): Promise<string>;
  concurrency?: number;
}

export function createCopilot(deps: CopilotDeps) {
  const failed = new Map<string, number>();
  const tried = new Map<string, number>();
  const concurrency = deps.concurrency ?? CONCURRENCY;
  const job: Job & { current_ids: string[]; cancel?: boolean } = {
    running: false, done: 0, total: 0, current: '', current_id: '', current_ids: [], pending: [], errors: 0, finished_at: null,
  };

  const ensureBody = async (row: Row) => (deps.ensureBody ? deps.ensureBody(row) : s(row.body_text));

  async function present(row: Row, stored: Row | null | undefined, acted: boolean, ai: boolean): Promise<Item> {
    const healed = await healPapel(row, stored);
    const item = fromDb(row, healed);
    applyConversa(item, conversa(messages(s(row.body_text)), participants(row)));
    item.delegado ??= {};
    item.analyzed_at ??= null;
    const pendente = ai && !classified(item, acted);
    const id = s(row.id);
    return {
      thread_id: id,
      subject: s(row.subject) || '(sem assunto)',
      from_name: s(row.from_name) || s(row.from_email),
      from_email: s(row.from_email),
      internal_date: num(row.internal_date),
      is_unread: truthy(row.is_unread),
      no_copiloto: !!healed,
      analisado: item.source === 'llm',
      lido_por_regra: item.source === 'regra',
      desatualizado: !!healed && (moved(row, healed) || countChanged(row, healed)),
      tab: pendente ? FILA.key : tabFor(item),
      pendente,
      falhou: pendente && failed.has(id),
      has_draft: !!s(row.draft).trim(),
      ...item,
      delegado: item.delegado ?? {},
      analyzed_at: item.analyzed_at ?? null,
    } as Item;
  }

  async function detail(threadId: string): Promise<ItemDetail> {
    const row = await db.getThread(threadId);
    if (!row) throw new Error('Thread não encontrada.');
    const actions = await db.listCopilotActions(threadId, 20);
    const item = (await present(row, await db.getCopilotItem(threadId), actions.length > 0, await deps.hasKey())) as ItemDetail & CopilotItem;
    let body = s(row.body_text);
    try {
      body = await ensureBody(row);
    } catch {
      // sem conexão: o que houver em cache
    }
    const msgs = messages(body);
    item.thread_text = body;
    item.mensagens = msgs;
    applyConversa(item, conversa(msgs, participants(row)));
    item.resumo_contexto = resumoContexto(item, msgs);
    item.originarios = originators(row);
    item.historico = actions.map((a) => ({ acao: s(a.action), at: s(a.at), ...loads<Dict>(a.payload_json, {}) }));
    item.draft = s(row.draft);
    return item;
  }

  async function analyze(threadId: string, opts: { force?: boolean } = {}): Promise<ItemDetail> {
    const row = await db.getThread(threadId);
    if (!row) throw new Error('Thread não está no radar.');
    const prev = await db.getCopilotItem(threadId);
    if (!opts.force && fresh(row, prev)) return detail(threadId);
    const body = await ensureBody(row);
    const base = heuristic(row, body);
    const hasKey = await deps.hasKey();
    let item: CopilotItem;
    if (truthy(row.is_marketing) || truthy(row.is_automatic)) item = { ...base, source: 'regra' };
    else if (!hasKey) item = base;
    else if (looksLikeSecret(`${s(row.subject)}\n${body}`)) {
      item = {
        ...base,
        needs_context: base.papel === 'demanda' || base.papel === 'mencionado_opiniao',
        source: 'regra',
        o_que_falta: 'O e-mail traz senha ou credencial: não mandei para a IA. Veja com calma.',
      };
    } else if (body.replace(/^(De|Data):.*$/gm, '').replace(/\s+/g, '').length < 25) {
      item = { ...base, source: 'regra', o_que_falta: 'Não consegui ler o texto (vazio, só imagem ou anexo).' };
    } else {
      const srcs = await sources(row);
      const notes = await notesBlock(s(row.id), s(row.subject), threadEmails(row, ME));
      let parsed: Dict;
      try {
        parsed = parse(await deps.llm.complete(buildPrompt(row, body, srcs, base, notes)));
      } catch (e) {
        failed.set(threadId, clock());
        throw e;
      }
      item = Object.keys(parsed).length ? interpret(row, body, parsed, srcs) : base;
    }
    if (item.source === 'heuristica' && hasKey) failed.set(threadId, clock());
    else failed.delete(threadId);
    await persist(row, item, prev, body);
    return detail(threadId);
  }

  /** Threads sem leitura ou com mensagem nova desde a última (não lidas primeiro). */
  async function candidates(limit = DEFAULT_LIMIT, force = false): Promise<string[]> {
    const items = await db.listCopilotItems();
    const rows = (await db.listVisible()).slice(0, LIST_LIMIT);
    rows.sort((a, b) => Number(!truthy(a.is_unread)) - Number(!truthy(b.is_unread)));
    const out: string[] = [];
    for (const row of rows) {
      if (!force && fresh(row, items[s(row.id)])) continue;
      out.push(s(row.id));
      if (out.length >= limit) break;
    }
    return out;
  }

  const status = (): Job => ({ ...job, pending: [...(job.pending || [])], current_ids: [...job.current_ids] } as Job);

  // Erro de conexão/acesso ao Gmail no meio do lote: pausa sem marcar falha.
  const isOffline = (e: unknown) => e instanceof AuthError || (e instanceof GmailError && (e.status === 0 || e.status === 401));

  let runner: Promise<void> | null = null;

  function launch(ids: string[]): void {
    delete job.paused;
    Object.assign(job, { running: ids.length > 0, done: 0, total: ids.length, current: '', current_id: '', current_ids: [], pending: [...ids], errors: 0, cancel: false, finished_at: ids.length ? null : new Date(clock()).toISOString() });
    if (!ids.length) return;
    runner = (async () => {
      await runPool(
        ids,
        concurrency,
        async (threadId) => {
          const row = await db.getThread(threadId);
          job.current = s(row?.subject);
          job.current_id = threadId;
          job.current_ids.push(threadId);
          tried.set(threadId, clock());
          let err = 0;
          try {
            // o Leo pode ter aberto (e lido) este item enquanto o lote andava
            if (!(row && fresh(row, await db.getCopilotItem(threadId)))) await analyze(threadId);
          } catch (e) {
            if (isOffline(e)) {
              failed.delete(threadId);
              tried.delete(threadId);
              job.paused = 'offline';
              job.cancel = true;
            } else {
              err = 1;
              failed.set(threadId, clock());
            }
          }
          job.done += 1;
          job.errors += err;
          job.pending = (job.pending || []).filter((x) => x !== threadId);
          job.current_ids = job.current_ids.filter((x) => x !== threadId);
          if (job.current_id === threadId) job.current_id = job.current_ids[job.current_ids.length - 1] || '';
        },
        () => !!job.cancel,
      );
      Object.assign(job, { running: false, current: '', current_id: '', current_ids: [], pending: [], finished_at: new Date(clock()).toISOString() });
      runner = null;
    })();
  }

  return {
    analyze,
    detail,
    candidates,
    present,
    status,
    /** espera o lote em andamento terminar (testes e pull-to-refresh) */
    idle: async () => {
      while (runner) await runner;
    },
    /** ⟳ "pedir leitura": começa um lote (até 40) se nenhum estiver rodando. */
    async start(limit = DEFAULT_LIMIT, force = false): Promise<Job> {
      limit = Math.max(1, Math.min(Math.trunc(limit), 40));
      if (!job.running) launch(await candidates(limit, force));
      return status();
    },
    /** Ao abrir o painel/depois do sync: com chave de IA, lê o que falta em segundo plano. */
    async ensureBatch(limit = DEFAULT_LIMIT): Promise<Job> {
      if (!(await deps.hasKey())) return status();
      if (!job.running) {
        const t = clock();
        const ids = (await candidates(limit * 3)).filter((id) => t - (tried.get(id) ?? 0) > RETRY_AFTER_MS).slice(0, limit);
        if (ids.length) launch(ids);
      }
      return status();
    },
    cancel() {
      job.cancel = true;
    },
    failed,

    /** /api/copilot local: abas, fila "Analisando", cartões Hoje/Esperando, histórico. */
    async listItems(opts: { showAll?: boolean; q?: string } = {}): Promise<CopilotList & { q: string }> {
      const terms = searchTerms(opts.q);
      const showAll = terms.length ? true : !!opts.showAll;
      const stored = await db.listCopilotItems();
      const acted = await db.copilotActedThreadIds();
      const ai = await deps.hasKey();
      const rows = (await db.listVisible()).slice(0, LIST_LIMIT);
      let items: Item[] = [];
      for (const row of rows) items.push(await present(row, stored[s(row.id)], acted.has(s(row.id)), ai));
      const seen = new Set(items.map((i) => i.thread_id));
      // resolvidos/delegados podem ter saído da caixa visível: continuam na aba deles
      for (const [tid, d] of Object.entries(stored)) {
        if (!seen.has(tid) && (terms.length || ['resolvido', 'delegado', 'cobrado', 'aguardando'].includes(s(d.status)))) {
          const row = await db.getThread(tid);
          if (row) {
            items.push(await present(row, d, acted.has(tid), ai));
            seen.add(tid);
          }
        }
      }
      if (terms.length) {
        const byId = Object.fromEntries(rows.map((r) => [s(r.id), r]));
        const kept: Item[] = [];
        for (const i of items) {
          const row = byId[i.thread_id] || (await db.getThread(i.thread_id)) || {};
          if (matchesSearch(row, i, terms)) kept.push(i);
        }
        items = kept;
        let extra = 0;
        for (const row of await db.listVisible(true)) {
          if (extra >= SEARCH_EXTRA || seen.has(s(row.id)) || !matchesSearch(row, {}, terms)) continue;
          items.push(await present(row, stored[s(row.id)], acted.has(s(row.id)), ai));
          extra += 1;
        }
      }
      const total = items.length;
      const historico = HISTORY.map((h) => ({ ...h, count: items.filter((i) => historyKey(i) === h.key).length }));
      if (!showAll) items = items.filter((i) => i.is_unread && i.tab !== 'resolvido');
      items.sort(sortKey);
      const tabs = TABS.map((t) => ({ ...t, count: items.filter((i) => i.tab === t.key).length }));
      const fila = items.filter((i) => i.pendente);
      const nowMs = clock();
      const td = todayParts();
      const today = isoDay(td.y, td.m, td.d);
      const startMs = Date.UTC(td.y, td.m - 1, td.d) - TZ_OFFSET_MS;
      const hoje = items.filter(
        (i) => i.tab === 'precisa_de_voce' && (i.urgencia === 'alta' || (i.prazo && i.prazo <= today) || i.internal_date >= startMs),
      );
      return {
        saudacao: greeting(nowMs),
        data: `${pad(td.d)}/${pad(td.m)}`,
        cards: { hoje: hoje.length, esperando_outros: tabs[1].count },
        tabs: tabs as CopilotList['tabs'],
        historico: historico as CopilotList['historico'],
        fila: { ...FILA, count: fila.length, falhas: fila.filter((i) => i.falhou).length, ativa: ai },
        items,
        show_all: showAll,
        q: (opts.q || '').split(/\s+/).filter(Boolean).join(' '),
        total,
        job: status(),
        llm: ai,
      };
    },
  };
}

export type Copilot = ReturnType<typeof createCopilot>;
