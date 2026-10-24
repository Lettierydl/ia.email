// Rascunho com IA no aparelho: porte do draft() de app/assistant.py.
// Os textos do prompt são cópia literal (um teste compara com o Python,
// caractere a caractere): pedido do Leo x texto do e-mail em blocos
// rotulados, conversa anterior, alvo (responder a uma mensagem específica),
// "usar meu texto (só corrigir)" com o fixpt, e a guarda de vazamento
// (draftGuard): se o rascunho copiou o pedido ou colou pontos sem responder,
// UMA nova tentativa com "CORREÇÃO OBRIGATÓRIA"; se persistir, volta com
// alerta_copia para a tela destacar.
//
// No aparelho não há RAG/cérebro nem pasta de anexos do Mac: esses blocos
// saem vazios (igual ao Mac com rag_enabled e sem resultado).
import * as db from './db';
import type { Row } from './db';
import { getAccount } from './copilot';
import * as guard from './draftGuard';
import * as fixpt from './fixpt';
import { notesBlock, threadEmails } from './learned';

type Dict = Record<string, unknown>;
const s = (v: unknown) => (v == null ? '' : String(v));

export const STYLE_PRESETS: Record<string, string> = {
  formal: 'Tom formal: frases completas, sem gírias, tratamento respeitoso, evite contrações informais.',
  neutro: 'Tom neutro e direto (padrão já usado hoje).',
  direto: 'Tom direto e mais informal: frases curtas, vai direto ao ponto.',
};

export interface ChatMsg {
  role: string;
  text: string;
  kind?: string;
  placeholder?: boolean;
  keep_text?: boolean;
  cc_resolution?: CcResolution[];
  alvo?: AlvoRef;
}
export interface CcResolution {
  query: string;
  status: 'resolved' | 'ambiguous' | 'not_found';
  candidates: { name: string; email: string }[];
}
export interface Alvo {
  idx?: number;
  total?: number;
  de?: string;
  data?: string;
  texto?: string;
  message_id?: string;
}
export type AlvoRef = Partial<Pick<Alvo, 'idx' | 'de' | 'data' | 'message_id'>>;

export interface DraftOut {
  id: string;
  draft: string;
  chat: ChatMsg[];
  summary: string;
  unchanged?: boolean;
  alvo?: AlvoRef | null;
  alerta_copia?: { mensagem: string; trechos: string[] };
  keep_text?: boolean;
  original?: string;
  corrigido?: boolean;
  aviso?: string;
}

// ── utilidades (por ponto de código, como o str do Python) ──
const cpLen = (t: string) => Array.from(t).length;
const cpSlice = (t: string, a: number, b?: number) => Array.from(t).slice(a, b).join('');

export function clipText(text: string, n: number): string {
  const t = (text || '').trim();
  return cpLen(t) <= n ? t : cpSlice(t, 0, n - 1).trimEnd() + '…';
}

export function loadChat(row: Dict | null | undefined): ChatMsg[] {
  const raw = row ? row.chat_json : null;
  if (!raw) return [];
  try {
    const data = JSON.parse(String(raw));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Corta pelo INÍCIO (mensagens mais antigas), não pelo fim. */
export function recentBody(body: string, maxChars = 20000): string {
  if (cpLen(body) <= maxChars) return body;
  let tail = cpSlice(body, -maxChars);
  const sep = '\n\n----\n\n';
  const idx = tail.indexOf(sep);
  if (idx !== -1) tail = tail.slice(idx + sep.length);
  return '[...thread truncada, mensagens mais antigas omitidas...]\n\n' + tail;
}

const MSG_HEAD_RE = () => /^De:\s*(.+?)\s*$\n^Data:\s*(.+?)\s*$/gm;
const LEO_ADDR_RE = /leo@confrapag\.com\.br/i;

export function threadOutline(body: string): string {
  const heads = [...(body || '').matchAll(MSG_HEAD_RE())].map((m) => [m[1], m[2]] as const);
  if (heads.length < 2) return '';
  const lines: string[] = [];
  let lastOther: [number, string] | null = null;
  heads.forEach(([who, when], k) => {
    const i = k + 1;
    const mine = LEO_ADDR_RE.test(who);
    lines.push(`${i}. ${mine ? 'Leo (já enviada)' : who} — ${when}`);
    if (!mine) lastOther = [i, who];
  });
  let out = 'Mensagens da thread, da mais antiga para a mais recente:\n' + lines.join('\n') + '\n';
  if (lastOther) {
    const [n, who] = lastOther as [number, string];
    out +=
      `O rascunho responde à mensagem mais recente de outra pessoa (nº ${n}, de ` +
      `${who}): cumprimente e responda a ESSA pessoa e ao que ELA perguntou. As ` +
      'anteriores são só histórico: o que o Leo já respondeu nelas não se repete, e perguntas ' +
      'antigas já respondidas por ele não entram de novo.\n';
  }
  return out + '\n';
}

export function styleInstructions(settings: Dict): string {
  const preset = STYLE_PRESETS[s(settings.style_preset) || 'neutro'] ?? STYLE_PRESETS.neutro;
  const custom = s(settings.style_custom).trim();
  return custom ? `${preset}\nInstrução extra de estilo do Leo: ${custom}` : preset;
}

export function aliasGlossary(aliases: { alias: string; name: string; email: string }[]): string {
  const groups = new Map<string, { name: string; email: string; aliases: string[] }>();
  for (const a of aliases) {
    if (!(a.name || a.email)) continue;
    const key = (a.email || '').toLowerCase() || a.alias;
    let g = groups.get(key);
    if (!g) {
      g = { name: a.name || a.alias, email: a.email || '', aliases: [] };
      groups.set(key, g);
    }
    g.aliases.push(a.alias);
  }
  const lines: string[] = [];
  for (const g of groups.values()) {
    const names = g.aliases.map((x) => `"${x}"`).join(' ou ');
    const target = g.email ? `${g.name} <${g.email}>` : g.name;
    lines.push(`- ${names} = ${target}`);
  }
  if (!lines.length) return '';
  return 'Apelidos que o Leo usa pra se referir a pessoas (resolva assim quando aparecer na instrução):\n' + lines.join('\n');
}

/** _draft_extra_context sem RAG/base de conhecimento do Mac: estilo + apelidos. */
export function draftExtraContext(settings: Dict, glossary: string): string {
  const blocks = [`Estilo de escrita pedido:\n${styleInstructions(settings)}`];
  if (glossary) blocks.push(glossary);
  return blocks.join('\n\n') + '\n\n';
}

export function parseDraftResponse(raw: string): [string, string, string[]] {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (m) {
    try {
      const data = JSON.parse(m[0]);
      if (data && typeof data === 'object') {
        const kind = data.kind;
        const text = (data.text ? String(data.text) : '').trim();
        const cc = Array.isArray(data.cc_names) ? data.cc_names.map((n: unknown) => s(n).trim()).filter(Boolean) : [];
        if ((kind === 'draft' || kind === 'answer') && text) return [kind, text, cc];
      }
    } catch {
      // cai no texto cru
    }
  }
  return ['draft', raw.trim(), []];
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

export function pendingCcQuery(chat: ChatMsg[]): string | null {
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (msg.role === 'ai' && msg.cc_resolution?.length) {
      const pending = msg.cc_resolution.filter((r) => r.status === 'not_found' || r.status === 'ambiguous');
      return pending.length === 1 ? pending[0].query : null;
    }
  }
  return null;
}

export async function resolveCcNames(names: string[]): Promise<CcResolution[]> {
  if (!names.length) return [];
  const aliases = new Map((await db.listAliases()).map((a) => [a.alias.toLowerCase(), a]));
  const out: CcResolution[] = [];
  for (const raw of names) {
    const name = (raw || '').trim();
    if (!name) continue;
    const hit = aliases.get(name.toLowerCase());
    if (hit && hit.email) {
      out.push({ query: name, status: 'resolved', candidates: [{ name: hit.name || name, email: hit.email }] });
      continue;
    }
    const cands = await db.searchSenders(name, 5);
    if (cands.length === 1) out.push({ query: name, status: 'resolved', candidates: cands });
    else if (cands.length > 1) out.push({ query: name, status: 'ambiguous', candidates: cands });
    else out.push({ query: name, status: 'not_found', candidates: [] });
  }
  return out;
}

export const sameText = (a: string, b: string) => (a || '').split(/\s+/).filter(Boolean).join(' ') === (b || '').split(/\s+/).filter(Boolean).join(' ');

/** A conversa já ocorrida sobre ESTE e-mail, mais recente por último. */
export function chatContext(chat: ChatMsg[], maxChars = 16000, previous = ''): string {
  const msgs = chat.filter((m) => !m.placeholder && (m.text || '').trim());
  const drafts = msgs.map((m, i) => [m, i] as const).filter(([m]) => m.role !== 'user' && m.kind !== 'answer').map(([, i]) => i);
  const lines: [string, string, boolean][] = [];
  let nDraft = 0;
  msgs.forEach((msg, i) => {
    const text = msg.text.trim();
    if (msg.role === 'user') lines.push(['Leo', text, true]);
    else if (msg.kind === 'answer') lines.push(['IA (resposta)', clipText(text, 1500), false]);
    else {
      nDraft += 1;
      const body = previous && sameText(text, previous) ? '(igual ao RASCUNHO ANTERIOR, abaixo)' : clipText(text, i === drafts[drafts.length - 1] ? 1200 : 400);
      lines.push([`IA (rascunho ${nDraft})`, body, false]);
    }
  });
  const total = () => lines.reduce((n, x) => n + cpLen(x[1]), 0);
  for (const line of lines) {
    if (total() <= maxChars) break;
    if (line !== lines[lines.length - 1]) line[1] = clipText(line[1], line[2] ? 300 : 120);
  }
  return lines.map(([who, text], k) => `[turno ${k + 1}] ${who}: ${text}`).join('\n');
}

/** O pedido ATUAL do Leo, separado e rotulado. Devolve [bloco, trechos citados do e-mail]. */
export function requestBlock(instruction: string, comment: string, body: string, previous: string): [string, string[]] {
  const parsed = guard.parseInstruction(instruction);
  const cites = parsed.citacoes.map((c) => ({ ...c, _pos: 0 }));
  for (const c of cites) {
    const srcs = c.fonte === 'rascunho' ? [previous, body] : [body, previous];
    c.trecho = guard.expandQuote(c.trecho, srcs);
    const pos = c.fonte === 'email' ? guard.locate(c.trecho, body) : -1;
    c._pos = pos >= 0 ? pos : 10 ** 9;
  }
  const ordered = [...cites].sort((a, b) => Number(a.fonte !== 'email') - Number(b.fonte !== 'email') || a._pos - b._pos || a.n - b.n);
  const lines = [
    '<<<PEDIDO_DO_LEO (instruções e comentários dele PARA VOCÊ -- NADA daqui vai literal para o e-mail)',
    `Instrução do Leo: ${parsed.livre || (cites.length ? '(só os comentários abaixo)' : '(gerar a partir do contexto)')}`,
  ];
  if (comment) lines.push(`Ajuste pedido: ${comment}`);
  if (cites.length) {
    lines.push('Comentários do Leo sobre trechos (na ordem em que os trechos aparecem no e-mail):');
    for (const c of ordered) {
      const where = c.fonte === 'rascunho' ? 'Sobre o trecho do rascunho' : 'Trecho citado do e-mail recebido';
      lines.push(`[${c.n}] ${where} (texto do e-mail, completo):\n«${c.trecho}»`);
      lines.push(`    Intenção do Leo para esse ponto: ${c.comentario || '(sem comentário: responda esse ponto com base na thread)'}`);
      lines.push('    -> no e-mail: a resposta do Leo a ESTE ponto, escrita com base nessa intenção ' + '(não repita o trecho citado nem copie a intenção)');
    }
    const nums = ordered.map((c) => `[${c.n}]`).join(', ');
    lines.push(`O e-mail precisa responder CADA um destes pontos: ${nums}. Ponto sem resposta é erro.`);
    lines.push(
      'Antes de "text", preencha no JSON "pontos": [{"n": 1, "resposta": "..."}, ...] -- para cada ' +
        'ponto, a(s) frase(s) do e-mail com a resposta do Leo, já na voz dele para o destinatário ' +
        '(nem o trecho citado, nem a intenção copiada). Depois monte "text" com essas respostas, ' +
        'na ordem dos pontos do e-mail original, mais saudação e despedida.',
    );
  }
  lines.push('PEDIDO_DO_LEO>>>');
  return [lines.join('\n') + '\n\n', cites.filter((c) => c.fonte === 'email').map((c) => c.trecho)];
}

export function alvoBlock(alvo: Alvo | null | undefined): string {
  if (!alvo) return '';
  const total = alvo.total || 0;
  const pos = total ? `mensagem ${(alvo.idx ?? 0) + 1} de ${total}` : 'uma mensagem da thread';
  return (
    `Você está respondendo a ESTA mensagem (${pos}), não necessariamente à última:\n` +
    `De: ${alvo.de || '?'}\nData: ${alvo.data || '?'}\n` +
    `<<<\n${cpSlice((alvo.texto || '').trim(), 0, 6000)}\n>>>\n` +
    'Responda a quem escreveu ESTA mensagem e sobre o que ela diz (saudação para essa pessoa). ' +
    'O resto da thread (abaixo) é só contexto: não responda às outras mensagens.\n\n'
  );
}

export function alvoRef(alvo: Alvo | null | undefined): AlvoRef | null {
  if (!alvo) return null;
  const out: AlvoRef = {};
  for (const k of ['idx', 'de', 'data', 'message_id'] as const) {
    const v = alvo[k];
    if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export interface DraftPromptInput {
  instruction: string;
  quotes: string[];
  extraContext: string;
  learnedBlock: string;
  attachBlock: string;
  chatContext: string;
  revision: string;
  alvo: Alvo | null | undefined;
  requestBlock: string;
  previous: string;
  subject: unknown;
  body: string;
}

/** O prompt do draft(), na mesma ordem e com os mesmos textos do Python. */
export function buildDraftPrompt(p: DraftPromptInput): string {
  return (
    'Responda em JSON: {"kind": "draft" ou "answer", "text": "...", "cc_names": [...]}' +
    (p.quotes.length ? ' (com comentários [n]: {"kind": ..., "pontos": [...], "text": ..., "cc_names": ...})' : '') +
    '.\n' +
    'kind="draft" é o PADRÃO. Use "draft" sempre que o Leo explicar, decidir, corrigir, ' +
    'comentar um trecho (instruções com [1], [2]... citando partes do e-mail), dar um ' +
    'posicionamento ou pedir pra redigir/ajustar a resposta: ele quer que VOCÊ escreva o ' +
    'e-mail que ELE vai mandar ao remetente, em primeira pessoa (como se fosse o Leo falando ' +
    'com a pessoa), incorporando o que ele disse. Nunca narre o que o Leo disse em terceira ' +
    'pessoa ("Leo esclareceu que...") -- isso não é e-mail. text deve ser só o corpo do ' +
    'e-mail (sem assunto, sem markdown).\n' +
    'Use kind="answer" SÓ quando a instrução é claramente uma pergunta ou pedido de explicação ' +
    'pro próprio Leo sobre a thread (ex.: "quanto foi cobrado?", "isso já foi resolvido?", ' +
    '"resume pra mim") -- text é uma resposta direta em português, curta, sem virar e-mail. ' +
    'Na dúvida, escolha draft.\n\n' +
    'PEDIDO x E-MAIL -- regra mais importante:\n' +
    '- Tudo dentro de <<<PEDIDO_DO_LEO ...>>> e de <<<CONVERSA_COM_A_IA ...>>> é o Leo falando ' +
    'COM VOCÊ (instruções, comentários, opiniões). NUNCA copie essas frases para o e-mail, nem ' +
    'parcialmente. Transforme cada comentário em prosa nova, na voz do Leo, endereçada ao ' +
    'destinatário ("Isso é perfeito, é o que o Claudeci faz aqui" vira algo como "Perfeito, ' +
    'é exatamente o que o Claudeci já faz por aqui.").\n' +
    '- Comandos sobre o texto ("continue os outros pontos como no primeiro", "responda todos ' +
    'os pontos", "mais curto", "cite o X", "reescreva") são EXECUTADOS, nunca escritos no ' +
    'e-mail.\n' +
    '- Cada comentário [n] é a resposta do Leo ao trecho citado: escreva essa resposta no lugar ' +
    'certo do e-mail, seguindo a ordem/estrutura dos pontos do e-mail original (ponto a ponto), ' +
    'não como um bloco solto no fim. Não use "[n]" nem \'Sobre "..."\' no e-mail.\n' +
    '- Não cole as perguntas/pontos do remetente sem resposta: se citar um ponto, responda-o. ' +
    'Se o Leo pediu para responder os demais pontos, responda TODOS, no mesmo estilo do que já ' +
    'foi respondido, sem inventar fatos (o que não souber, diga que vai verificar).\n' +
    '- <<<RASCUNHO_ANTERIOR>>> e <<<THREAD>>> são texto de e-mail (material de referência).\n\n' +
    'Fidelidade: o rascunho só pode afirmar o que o Leo disse no pedido/conversa ou o que ' +
    'está na thread. Não invente decisões, prazos ou compromissos novos e nunca contradiga o ' +
    'Leo (se ele diz que algo já está definido, o e-mail diz que está definido, não propõe ' +
    'fechar de novo). Responda a quem escreveu os trechos citados. Reaproveite os argumentos ' +
    'do próprio Leo (inclusive "já fechamos isso" ou "já rediscutimos"), de forma cordial, e ' +
    'NÃO acrescente parágrafos que ele não pediu (próximos passos, "precisamos alinhar", etc.).\n' +
    '"Sobre o trecho do rascunho" cita o RASCUNHO_ANTERIOR, não o e-mail recebido: o Leo pede ' +
    'para mudar AQUELE trecho conforme o comentário. Parta do rascunho anterior, aplique a ' +
    'mudança nesse trecho e mantenha o resto como está.\n' +
    'cc_names: se a instrução pedir pra adicionar, copiar, incluir ou envolver alguém no ' +
    'e-mail (Cc), liste cada nome/apelido mencionado como uma string nesse array (pode ser ' +
    'mais de um nome). NÃO invente e-mail, NÃO escreva e-mail nesse campo, só o nome como o ' +
    'Leo escreveu. Não inclua o próprio Leo. Array vazio se ninguém foi pedido pra ser ' +
    'adicionado.\n\n' +
    `${p.extraContext}` +
    `${p.learnedBlock}` +
    `${p.attachBlock}` +
    (p.chatContext
      ? '<<<CONVERSA_COM_A_IA (todos os turnos anteriores sobre ESTE e-mail; o que o Leo já ' +
        'explicou ou decidiu aqui vale para o pedido atual, e o pedido atual tem prioridade se ' +
        'houver conflito. Se o Leo corrigiu ou contrariou algo que você (IA) respondeu antes, ' +
        'vale o que o Leo disse: NÃO repita nem ofereça como alternativa a sua resposta antiga)\n' +
        p.chatContext +
        '\nCONVERSA_COM_A_IA>>>\n\n'
      : '') +
    p.revision +
    alvoBlock(p.alvo) +
    p.requestBlock +
    `<<<RASCUNHO_ANTERIOR (texto de e-mail)\nRascunho anterior:\n${p.previous || '(nenhum)'}\nRASCUNHO_ANTERIOR>>>\n\n` +
    `<<<THREAD (texto de e-mail)\nAssunto: ${pyStr(p.subject)}\n\n${threadOutline(p.body)}Thread:\n${recentBody(p.body)}\nTHREAD>>>`
  );
}

/** f"{x}" do Python: None vira "None". */
const pyStr = (v: unknown) => (v === null || v === undefined ? 'None' : String(v));

export const REVISION =
  'REVISÃO: o Leo já tem o Rascunho anterior (abaixo) e a instrução mais recente pede para ' +
  'MUDÁ-LO. Parta dele, aplique exatamente o que foi pedido (acrescentar uma pergunta, ' +
  'encurtar, citar algo, mudar o tom, responder os outros pontos...) e devolva o e-mail ' +
  'inteiro já revisado. Devolver o mesmo texto sem a mudança pedida é erro.\n';

export const unchangedRetry = (instruction: string) =>
  '\n\nATENÇÃO: sua resposta anterior devolveu o Rascunho anterior sem ' + `nenhuma mudança. Aplique agora o pedido do Leo: ${instruction}`;

/** O texto "CORREÇÃO OBRIGATÓRIA" da segunda tentativa (igual ao _guard_leaks). */
export function correctionText(leaks: string[], pasted: string[]): string {
  let fix = '\n\nCORREÇÃO OBRIGATÓRIA -- o seu rascunho anterior tem problemas:\n';
  if (leaks.length) {
    fix += 'Colou no e-mail frases que são instruções/comentários do Leo para você (ou comandos de meta):\n' + leaks.map((t) => `- ${t}`).join('\n') + '\n';
  }
  if (pasted.length) {
    fix +=
      'Repetiu pontos do remetente sem responder (o Leo comentou esses pontos; escreva a resposta ' +
      'dele a cada um, sem repetir o trecho):\n' +
      pasted.map((t) => `- ${t}`).join('\n') +
      '\n';
  }
  fix +=
    'Reescreva o e-mail inteiro: execute os comandos (não os escreva), transforme cada comentário em ' +
    'resposta própria, na voz do Leo, ao ponto correspondente do e-mail, e não deixe ponto do ' +
    'remetente colado sem resposta.';
  return fix;
}

export interface AssistantDeps {
  llm: { complete(user: string, opts?: { system?: string; timeoutMs?: number }): Promise<string> };
  hasKey(): Promise<boolean>;
  /** corpo da thread no formato do Mac (o sync grava; sem ele, busca no Gmail) */
  ensureBody(row: Row): Promise<string>;
  /** ajustes de estilo (style_preset/style_custom); padrão: neutro */
  settings?(): Promise<Dict>;
  /** bloco do "Aprender" (padrão: learned.notesBlock do banco local) */
  notesBlock?(threadId: string, subject: string, emails: string[]): Promise<string>;
}

export function createAssistant(deps: AssistantDeps) {
  const locks = new Map<string, Promise<unknown>>();
  const complete = (prompt: string) => deps.llm.complete(prompt);

  /** _guard_leaks: refaz UMA vez com a correção; se ainda falhar, devolve com alerta. */
  async function guardLeaks(prompt: string, kind: string, text: string, ccNames: string[], instruction: string, chat: ChatMsg[], body: string, quotes: string[]) {
    const earlier = chat
      .map((m, i) => [m, i] as const)
      .filter(([m, i]) => m.role === 'user' && !(i + 1 < chat.length && chat[i + 1].keep_text))
      .map(([m]) => m.text || '');
    const segments = guard.requestSegments(instruction, earlier);
    const check = (t: string): [string[], string[]] => [guard.findLeaks(t, segments, body), guard.findPastedQuotes(t, quotes)];
    const alerta = (leaks: string[], pasted: string[]) => ({
      mensagem: leaks.length ? guard.ALERTA_COPIA : guard.ALERTA_COLADO,
      trechos: [...leaks, ...pasted.filter((p) => !leaks.includes(p))],
    });
    const [leaks, pasted] = check(text);
    if (!(leaks.length || pasted.length)) return { kind, text, ccNames, alerta: null };
    const [kind2, text2, cc2] = parseDraftResponse(await complete(prompt + correctionText(leaks, pasted)));
    if (kind2 !== 'draft' || !text2.trim()) return { kind, text, ccNames, alerta: alerta(leaks, pasted) };
    const [leaks2, pasted2] = check(text2);
    return { kind: kind2, text: text2, ccNames: cc2.length ? cc2 : ccNames, alerta: leaks2.length || pasted2.length ? alerta(leaks2, pasted2) : null };
  }

  async function draftKeepText(threadId: string, row: Row, chat: ChatMsg[], instruction: string, own: string, currentDraft: string, alvo: Alvo | null | undefined): Promise<DraftOut> {
    const previous = (currentDraft || '').trim() || s(row.draft);
    let fixed = own;
    let aviso = '';
    try {
      fixed = (await fixpt.fix(own, { complete, hasKey: deps.hasKey })).text.trim();
    } catch (e) {
      if (e instanceof fixpt.FixRejected) aviso = e.message;
      else aviso = `${e instanceof Error ? e.message : String(e)} Usei seu texto sem correção.`;
    }
    const text = fixpt.withSignature(fixed, previous);
    const original = fixpt.withSignature(own, previous);
    const ref = alvoRef(alvo);
    if (instruction) chat.push({ role: 'user', text: instruction, ...(ref ? { alvo: ref } : {}) });
    const aiMsg: ChatMsg = { role: 'ai', text, kind: 'draft', keep_text: true };
    if (ref) aiMsg.alvo = ref;
    chat.push(aiMsg);
    await db.saveAi(threadId, { chat_json: JSON.stringify(chat), chat_anchor_date: Number(row.internal_date || 0), draft: text });
    return {
      id: threadId, draft: text, chat, summary: s(row.summary), unchanged: false, alvo: ref, keep_text: true,
      original, corrigido: fixed !== own.trim(), aviso,
    };
  }

  async function draftUnlocked(threadId: string, instruction: string, comment: string, currentDraft: string, alvo: Alvo | null | undefined, keepText: boolean): Promise<DraftOut> {
    const row = (await db.getThread(threadId)) || ({} as Row);
    const chat = loadChat(row);

    const own = fixpt.keepTextRequest(instruction) ?? (keepText ? (instruction || '').trim() || null : null);
    if (own) return draftKeepText(threadId, row, chat, instruction, own, currentDraft, alvo);

    // "o email é fulano@x.com" respondendo a um Cc pendente: resolve sem IA e salva o apelido
    const emailMatch = EMAIL_RE.exec(instruction || '');
    const pendingQuery = emailMatch ? pendingCcQuery(chat) : null;
    if (emailMatch && pendingQuery) {
      const email = emailMatch[0].toLowerCase();
      await db.saveAlias(pendingQuery, pendingQuery, email);
      if (instruction) chat.push({ role: 'user', text: instruction });
      chat.push({
        role: 'ai',
        text: `Beleza, salvei "${pendingQuery}" = ${email} como apelido -- da próxima vez ` + 'resolvo direto. Vou copiar esse e-mail nessa resposta.',
        kind: 'answer',
        cc_resolution: [{ query: pendingQuery, status: 'resolved', candidates: [{ name: pendingQuery, email }] }],
      });
      await db.saveAi(threadId, { chat_json: JSON.stringify(chat), chat_anchor_date: Number(row.internal_date || 0) });
      return { id: threadId, draft: s(row.draft), chat, summary: s(row.summary) };
    }

    if (!row.id) throw new Error('Thread não está no radar. Atualize a lista.');
    const body = await deps.ensureBody(row);
    const previous = (currentDraft || '').trim() || s(row.draft);
    if (!(await deps.hasKey())) throw new Error('Falta chave de LLM (Claude/Gemini/OpenRouter) para gerar rascunho.');
    const chatCtx = chatContext(chat, 16000, previous);
    const [reqBlock, quotes] = requestBlock(instruction, comment, body, previous);
    const settings = deps.settings ? await deps.settings() : {};
    const extraContext = draftExtraContext(settings, aliasGlossary(await db.listAliases()));
    const learnedBlock = await (deps.notesBlock ?? notesBlock)(threadId, s(row.subject), threadEmails(row, getAccount()));
    const revision = instruction && previous.trim() ? REVISION : '';
    const prompt = buildDraftPrompt({
      instruction, quotes, extraContext, learnedBlock, attachBlock: '', chatContext: chatCtx, revision, alvo,
      requestBlock: reqBlock, previous, subject: row.subject, body,
    });
    let [kind, text, ccNames] = parseDraftResponse(await complete(prompt));
    let unchanged = !!revision && kind === 'draft' && sameText(text, previous);
    if (unchanged) {
      [kind, text, ccNames] = parseDraftResponse(await complete(prompt + unchangedRetry(instruction)));
      unchanged = kind === 'draft' && sameText(text, previous);
    }
    let alerta: DraftOut['alerta_copia'] | null = null;
    if (kind === 'draft') ({ kind, text, ccNames, alerta } = await guardLeaks(prompt, kind, text, ccNames, instruction, chat, body, quotes));
    const ccResolution = await resolveCcNames(ccNames);

    const ref = alvoRef(alvo);
    if (instruction) chat.push({ role: 'user', text: instruction, ...(ref ? { alvo: ref } : {}) });
    const aiMsg: ChatMsg = { role: 'ai', text, kind };
    if (ccResolution.length) aiMsg.cc_resolution = ccResolution;
    if (ref) aiMsg.alvo = ref;
    chat.push(aiMsg);
    const save: Record<string, string | number> = { chat_json: JSON.stringify(chat), chat_anchor_date: Number(row.internal_date || 0) };
    if (kind === 'draft') save.draft = text;
    await db.saveAi(threadId, save);
    return {
      id: threadId,
      draft: kind === 'draft' ? text : s(row.draft),
      chat,
      summary: s(row.summary),
      unchanged,
      alvo: ref,
      ...(alerta ? { alerta_copia: alerta } : {}),
    };
  }

  return {
    /**
     * draft(): currentDraft = texto da caixa (vira "Rascunho anterior");
     * alvo = mensagem específica sendo respondida; keepText = "usar meu texto".
     * Um rascunho por thread de cada vez (o _lock_for do Python).
     */
    async draft(threadId: string, instruction = '', opts: { comment?: string; currentDraft?: string; alvo?: Alvo | null; keepText?: boolean } = {}): Promise<DraftOut> {
      const prev = locks.get(threadId) ?? Promise.resolve();
      const run = prev.catch(() => undefined).then(() => draftUnlocked(threadId, instruction, opts.comment || '', opts.currentDraft || '', opts.alvo, !!opts.keepText));
      locks.set(threadId, run);
      try {
        return await run;
      } finally {
        if (locks.get(threadId) === run) locks.delete(threadId);
      }
    },
    /** "Corrigir português" do texto inteiro (fixpt.fix). */
    fixPortuguese: (text: string) => fixpt.fix(text, { complete, hasKey: deps.hasKey }),
  };
}

export type Assistant = ReturnType<typeof createAssistant>;
