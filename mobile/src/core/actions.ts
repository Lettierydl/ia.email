// Ações do copiloto no aparelho: porte de ACTIONS/act de app/copilot.py.
// Nunca enviam nada: mudam status em copilot_items, registram em
// copilot_actions e no histórico (desfazer). Cobrar/Delegar só PREPARAM o
// texto (rascunho na thread ou e-mail novo); o envio passa pelo composer,
// pelo ConfirmModal e pela outbox.
//
// Diferença consciente do Mac: "Resolver" aqui marca lido E arquiva no Gmail
// (tira UNREAD e INBOX); o desfazer recoloca os dois rótulos.
import * as db from './db';
import type { Row, SqlValue } from './db';
import { fromDb, getAccount, heuristic, messages, originators, persist, type CopilotItem, type Copilot } from './copilot';
import * as history from './history';
import type { GmailOp } from './history';

export const SIGN = "Atenciosamente,\nLettiery D'Lamare";
export const RESOLVE_REMOVE = ['UNREAD', 'INBOX'];

type Dict = Record<string, unknown>;
const s = (v: unknown) => (v == null ? '' : String(v));

export interface ActionsGmail {
  modifyThread(id: string, change: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<unknown>;
}

export interface ActionsDeps {
  copilot: Pick<Copilot, 'detail'>;
  gmail: ActionsGmail | null;
  /** assistant.draft (Aplicar → responder / pedir contexto) */
  draft?(threadId: string, instruction: string): Promise<{ draft?: string }>;
}

export class ActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
  }
}

/** ação do copiloto → (tipo no histórico, detalhe) */
export const HIST_ACAO: Record<string, [string, string]> = {
  assumir: ['acompanhar', ''],
  acompanhar: ['acompanhar', ''],
  aguardar: ['mover', 'Aguardando outras pessoas'],
  so_saber: ['mover', 'Só conhecimento'],
  resolver: ['resolvido', ''],
  reabrir: ['reabrir', ''],
  delegar: ['delegar', ''],
  cobrar: ['cobrar', ''],
  aplicar: ['aplicar', ''],
  tarefa: ['tarefa', ''],
};
const APLICAR_LABEL: Record<string, string> = {
  direcionar: 'Direcionar', estudar_depois_responder: 'Estudar e depois responder',
  pedir_contexto: 'Pedir contexto', responder: 'Responder', aguardar: 'Aguardar',
};

export function firstNameOf(name: string, email: string): string {
  const n = (name || '').trim().replace(/^"+|"+$/g, '');
  if (n && !n.includes('@')) return n.split(/\s+/)[0];
  const local = (email || '').split('@')[0].split('.')[0];
  return local ? local[0].toUpperCase() + local.slice(1).toLowerCase() : '';
}

function loadChat(row: Dict): Dict[] {
  try {
    const v = JSON.parse(s(row.chat_json) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function saveThreadDraft(row: Row, text: string, note: string): Promise<void> {
  const chat = loadChat(row);
  if (note) chat.push({ role: 'ai', text: note, kind: 'answer' });
  chat.push({ role: 'ai', text, kind: 'draft' });
  await db.saveAi(s(row.id), { draft: text, chat_json: JSON.stringify(chat), chat_anchor_date: Number(row.internal_date || 0) });
}

const qs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/** _ensure_item: item só da heurística ganha linha antes de mudar status. */
async function ensureItem(threadId: string): Promise<[Row, CopilotItem]> {
  const row = await db.getThread(threadId);
  if (!row) throw new ActionError('Thread não encontrada.', 404);
  if (!(await db.getCopilotItem(threadId))) await persist(row, heuristic(row, s(row.body_text)), null);
  return [row, fromDb(row, await db.getCopilotItem(threadId))];
}

type Result = Dict & { _gmail?: GmailOp[] };
type Handler = (row: Row, item: CopilotItem, body: Dict, deps: ActionsDeps) => Promise<Result>;

const save = (row: Row, fields: Record<string, SqlValue>) => db.saveCopilotItem(s(row.id), fields);

const assumir: Handler = async (row) => {
  await save(row, { status: 'assumido', bola_json: JSON.stringify({ com: 'leo', email: getAccount(), nome: 'Você' }), depende_de_outros: 0 });
  return {};
};

const cobrar: Handler = async (row, item) => {
  const target = (item.delegado || {}) as Dict;
  const bola = (item.bola?.com === 'outros' ? item.bola : {}) as Dict;
  const email = s(target.para) || s(bola.email);
  const nome = s(target.nome) || s(bola.nome);
  if (!email) throw new ActionError('Não sei de quem cobrar: a bola não está com ninguém identificado.');
  const prazo = item.prazo ? ` até ${item.prazo.slice(8, 10)}/${item.prazo.slice(5, 7)}` : '';
  const text =
    `Olá, ${firstNameOf(nome, email)}.\n\n` +
    `Passando para saber como está "${s(row.subject) || 'este assunto'}". ` +
    `Consegue me dar um retorno${prazo}?\n\n${SIGN}`;
  const mode = s(target.modo) || 'thread';
  let open_url: string;
  let compose: Dict | undefined;
  if (mode === 'novo_silencioso') {
    const subject = `Re: ${s(target.assunto) || s(row.subject)}`;
    open_url = `/compose?${qs({ to: email, subject, draft: text })}`;
    compose = { to: email, subject, body: text };
  } else {
    await saveThreadDraft(row, text, 'Cobrança preparada pelo Copiloto (não foi enviada).');
    const cc = email !== s(row.from_email) ? email : '';
    open_url = `/mail/${s(row.id)}` + (cc ? `?${qs({ cc })}` : '');
  }
  await save(row, { status: 'cobrado', depende_de_outros: 1 });
  return { draft: text, open_url, para: email, ...(compose ? { compose } : {}) };
};

const delegar: Handler = async (row, item, body) => {
  const para = s(body.para).trim().toLowerCase();
  if (!/^[^@\s,]+@[^@\s,]+\.[a-z]{2,}$/.test(para)) throw new ActionError('Informe um e-mail válido para delegar.');
  if (para === getAccount()) throw new ActionError('Delegar para você mesmo é assumir.');
  const modo = s(body.modo) || 'cc_originais';
  if (modo !== 'cc_originais' && modo !== 'novo_silencioso') throw new ActionError('Modo de delegar desconhecido.');
  const nome = s(body.nome).trim();
  const nota = s(body.nota).trim();
  const first = firstNameOf(nome, para);
  const resumo = item.o_que_aconteceu || s(row.subject);
  let payload: Dict;
  if (modo === 'cc_originais') {
    const originais = originators(row).map((a) => a.email).filter((e) => e !== para);
    const text = `${first}, pode assumir este assunto, por favor?` + (nota ? ` ${nota}` : '') + '\n\nDeixo todos em cópia para acompanharem.\n\n' + SIGN;
    await saveThreadDraft(row, text, `Delegação preparada pelo Copiloto para ${para} (não foi enviada).`);
    const cc = [para, ...originais.filter((e) => e !== s(row.from_email))].join(', ');
    payload = { modo, para, nome, cc, draft: text, open_url: `/mail/${s(row.id)}?${qs({ cc })}` };
  } else {
    const assunto = `Pode assumir? ${s(row.subject)}`.trim();
    const text =
      `Olá, ${first}.\n\nChegou para mim o assunto "${s(row.subject)}": ${resumo}\n\n` +
      (nota ? `${nota}\n\n` : '') +
      'Consegue assumir? Prefiro que você trate direto com quem pediu.\n\n' +
      SIGN;
    payload = {
      modo, para, nome, assunto, draft: text,
      open_url: `/compose?${qs({ to: para, subject: assunto, draft: text })}`,
      compose: { to: para, subject: assunto, body: text },
    };
  }
  await save(row, {
    status: 'delegado',
    depende_de_outros: 1,
    bola_json: JSON.stringify({ com: 'outros', email: para, nome }),
    delegado_json: JSON.stringify({ modo, para, nome, assunto: s(payload.assunto) }),
  });
  return payload;
};

const aplicar: Handler = async (row, item, body, deps) => {
  const idx = Number(body.opcao ?? 0);
  const opt = Number.isInteger(idx) ? item.opcoes[idx] : undefined;
  if (!opt) throw new ActionError('Sugestão não encontrada.');
  const acao = opt.acao;
  if (acao === 'direcionar') {
    if (!opt.para) throw new ActionError('A sugestão não diz para quem direcionar: use Delegar.');
    return { ...(await delegar(row, item, { para: opt.para, modo: body.modo || 'cc_originais', nota: body.nota || '' }, deps)), acao };
  }
  if (acao === 'aguardar') {
    await save(row, { status: 'aguardando', depende_de_outros: 1 });
    return { acao };
  }
  if (acao === 'estudar_depois_responder') {
    const t = `Estudar: ${opt.texto}`.trim();
    const tarefas = [...item.tarefas, { texto: t.length <= 140 ? t : t.slice(0, 139).trimEnd() + '…', feita: false }];
    await save(row, { status: 'assumido', tarefas_json: JSON.stringify(tarefas) });
    return { acao };
  }
  if (!deps.draft) throw new ActionError('Rascunho com IA indisponível.');
  const base = opt.evidencias.filter((e) => e.tipo === 'learning_base' || e.tipo === 'decisao').map((e) => e.titulo).join('; ');
  const instruction = acao === 'pedir_contexto' ? `Peça o contexto que falta, de forma curta: ${opt.texto}` : `${opt.texto}` + (base ? ` (base: ${base})` : '');
  const r = await deps.draft(s(row.id), instruction);
  await save(row, { status: 'assumido' });
  return { acao, draft: r.draft || '', open_url: `/mail/${s(row.id)}` };
};

/** Resolver: status + lido local + Gmail sem UNREAD e INBOX. Falha no Gmail não desfaz o local (como no Mac). */
const resolver: Handler = async (row, _item, _body, deps) => {
  const id = s(row.id);
  await save(row, { status: 'resolvido' });
  await db.markLocalRead([id]);
  if (!deps.gmail) return { gmail_ok: false };
  try {
    await deps.gmail.modifyThread(id, { removeLabelIds: RESOLVE_REMOVE });
    await db.changeThreadLabels(id, [], RESOLVE_REMOVE);
    return { gmail_ok: true, _gmail: [{ thread_id: id, add: [], remove: RESOLVE_REMOVE }] };
  } catch {
    return { gmail_ok: false };
  }
};

const reabrir: Handler = async (row) => {
  await save(row, { status: 'aberto' });
  return {};
};

const aguardar: Handler = async (row) => {
  await save(row, { status: 'aguardando', depende_de_outros: 1 });
  return {};
};

const soSaber: Handler = async (row) => {
  await save(row, { status: 'aberto', papel: 'fyi', depende_de_outros: 0, bola_json: JSON.stringify({ com: 'ninguem', email: '', nome: '' }) });
  return {};
};

const tarefa: Handler = async (row, item, body) => {
  const idx = Number(body.index);
  if (!Number.isInteger(idx) || !item.tarefas[idx]) throw new ActionError('Tarefa não encontrada.');
  item.tarefas[idx].feita = body.feita === undefined ? true : !!body.feita;
  await save(row, { tarefas_json: JSON.stringify(item.tarefas) });
  return {};
};

export const ACTIONS: Record<string, Handler> = {
  assumir, acompanhar: assumir, cobrar, delegar, aplicar, resolver, reabrir, aguardar, so_saber: soSaber, tarefa,
};

export interface ActResult {
  ok: boolean;
  action: string;
  item: Awaited<ReturnType<Copilot['detail']>>;
  historico: history.HistPublic | null;
  para?: string;
  modo?: string;
  cc?: string;
  draft?: string;
  open_url?: string;
  acao?: string;
  gmail_ok?: boolean;
  /** e-mail novo preparado (delegar silencioso / cobrar): só sai pelo composer */
  compose?: { to: string; subject: string; body: string };
}

export function createActions(deps: ActionsDeps) {
  return {
    /** copilot.act: aplica, registra em copilot_actions e no histórico. */
    async act(threadId: string, action: string, body: Dict = {}): Promise<ActResult> {
      const handler = ACTIONS[action];
      if (!handler) throw new ActionError('Ação desconhecida.');
      const [row, item] = await ensureItem(threadId);
      const before = await history.take([threadId]);
      const result = await handler(row, item, body, deps);
      const gmail = result._gmail || [];
      delete result._gmail;
      const log = Object.fromEntries(Object.entries(result).filter(([k]) => ['para', 'modo', 'acao'].includes(k)));
      await db.logCopilotAction(threadId, action, log);
      let [acao, detalhe] = HIST_ACAO[action] ?? [action, ''];
      if (action === 'delegar') detalhe = s(result.para);
      else if (action === 'aplicar') detalhe = APLICAR_LABEL[s(result.acao)] || '';
      else if (action === 'tarefa') detalhe = body.feita === undefined || body.feita ? 'Tarefa concluída' : 'Tarefa reaberta';
      const entry = await history.record(acao, before, { origem: 'copilot', detalhe, gmail });
      return { ...result, ok: true, action, item: await deps.copilot.detail(threadId), historico: entry } as ActResult;
    },

    /** copilot.resolve_after_send: envio real confirmado = resolvido (sem mexer de novo no Gmail). */
    async resolveAfterSend(threadId: string, origem = 'copilot'): Promise<void> {
      try {
        const [row] = await ensureItem(threadId);
        const stored = (await db.getCopilotItem(threadId)) || {};
        const snap: Record<string, SqlValue> = { internal_date_snapshot: Number(row.internal_date || 0) };
        if (s(row.body_text)) snap.msg_count_snapshot = messages(s(row.body_text)).length;
        if (s(stored.status) === 'resolvido') {
          await db.saveCopilotItem(threadId, snap);
          return;
        }
        const before = await history.take([threadId]);
        await db.saveCopilotItem(threadId, { status: 'resolvido', ...snap });
        await db.markLocalRead([threadId]);
        await history.record('resolvido', before, { origem, detalhe: 'após o envio' });
        await db.logCopilotAction(threadId, 'resolver', { from_send: true });
      } catch {
        // melhor esforço: o e-mail já saiu
      }
    },
  };
}

export type Actions = ReturnType<typeof createActions>;
