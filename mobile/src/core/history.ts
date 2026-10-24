// Histórico de ações do Leo + Desfazer/Refazer: porte de app/history.py.
//
// Cada ação (resolver, acompanhar, delegar, enviar...) vira uma linha em
// historico_acoes com o retrato só dos campos que mudaram, por thread.
// Desfazer = voltar cada campo ao anterior só onde o valor atual ainda é o que
// a ação deixou ("compare-and-set"); se nada puder voltar, erro 409.
//
// Gmail: diferente do Mac (que só revertia UNREAD), aqui a ação guarda as
// operações de rótulo que fez ({thread_id, add, remove} em gmail_json) e o
// desfazer aplica o inverso (ex.: Resolver tirou UNREAD+INBOX → desfazer
// recoloca os dois). Gmail vai primeiro; se falhar, nada muda localmente e o
// que já foi ao Gmail volta (melhor esforço).
import * as db from './db';
import type { HistRow, SqlValue } from './db';

export const ITEM_FIELDS = ['status', 'papel', 'depende_de_outros', 'bola_json', 'delegado_json', 'tarefas_json'] as const;
export const THREAD_FIELDS = ['is_unread', 'hidden', 'is_marketing', 'draft', 'chat_json'] as const;
const INT_FIELDS = new Set(['thread.is_unread', 'thread.hidden', 'thread.is_marketing']);

export const LABELS: Record<string, string> = {
  marcar_lido: 'Marcado como lido',
  resolvido: 'Resolvido',
  resolver_coluna: 'Resolvidos em lote',
  reabrir: 'Reaberto',
  acompanhar: 'Você acompanha',
  mover: 'Movido',
  delegar: 'Delegado',
  cobrar: 'Cobrança preparada',
  aplicar: 'Sugestão aplicada',
  tarefa: 'Tarefa',
  enviar: 'E-mail enviado',
  salvar_rascunho: 'Rascunho salvo',
  ocultar: 'Ocultado',
  mostrar: 'Voltou a aparecer',
  nao_interessado: 'Não tenho interesse',
};
export const SKIP_ULTIMO = ['salvar_rascunho'];
export const NAO_ENVIO = 'E-mail já enviado: não dá para desfazer.';

export class HistoryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HistoryError';
    this.status = status;
  }
}

export type Snapshot = Record<string, unknown>;
export type GmailOp = { thread_id: string; add: string[]; remove: string[] };

/** O pedaço do gmail.ts que o desfazer usa. */
export interface HistoryGmail {
  modifyThread(id: string, change: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<unknown>;
}

let gmailRef: HistoryGmail | null = null;
/** O runtime (core/local.ts) liga o Gmail; os testes passam um falso. */
export const setHistoryGmail = (g: HistoryGmail | null) => {
  gmailRef = g;
};

const nowIso = () => new Date().toISOString();

function normField(key: string, value: unknown): unknown {
  if (INT_FIELDS.has(key)) return Number(value || 0);
  if (key === 'remetente_bloqueado') return !!value;
  return value != null ? value : key.startsWith('thread.') ? '' : null;
}

export async function snapshot(threadId: string): Promise<Snapshot | null> {
  const row = await db.getThread(threadId);
  if (!row) return null;
  const item = (await db.getCopilotItem(threadId)) || {};
  const snap: Snapshot = {};
  for (const k of THREAD_FIELDS) snap[`thread.${k}`] = normField(`thread.${k}`, row[k]);
  for (const k of ITEM_FIELDS) snap[`item.${k}`] = (item as Record<string, unknown>)[k] ?? null;
  snap.remetente_bloqueado = await db.isBlockedSender(String(row.from_email || ''));
  return snap;
}

function diff(before: Snapshot, after: Snapshot): [Snapshot, Snapshot] {
  const keys = Object.keys(after).filter((k) => before[k] !== after[k]);
  return [Object.fromEntries(keys.map((k) => [k, before[k]])), Object.fromEntries(keys.map((k) => [k, after[k]]))];
}

async function subjectOf(ids: string[]): Promise<string> {
  const row = ids.length ? await db.getThread(ids[0]) : null;
  const subject = String(row?.subject || '') || '(sem assunto)';
  return ids.length > 1 ? `${ids.length} e-mails · ${subject} e outros` : subject;
}

export interface HistPublic {
  id: number; at: string; thread_id: string; thread_ids: string[]; n: number; assunto: string; acao: string;
  rotulo: string; detalhe: string; origem: string; desfazivel: boolean; motivo: string; desfeito: boolean;
  desfeito_em: string | null; refeito_em: string | null; grupo_id: string | null;
  estado: 'nao_reversivel' | 'desfeito' | 'ativo';
}

export function publicEntry(entry: HistRow | null): HistPublic | null {
  if (!entry) return null;
  const { acao } = entry;
  const detalhe = entry.detalhe || '';
  let rotulo = LABELS[acao] ?? acao;
  if (acao === 'mover' && detalhe) rotulo = `Movido para ${detalhe}`;
  else if (acao === 'tarefa' && detalhe) rotulo = detalhe;
  else if (acao === 'resolvido' && detalhe) rotulo = `Resolvido ${detalhe}`;
  else if (acao === 'delegar' && detalhe) rotulo = `Delegado para ${detalhe}`;
  else if (acao === 'resolver_coluna' && detalhe) rotulo = `Resolvidos em lote · ${detalhe}`;
  const ids = entry.thread_ids.length ? entry.thread_ids : entry.thread_id ? [entry.thread_id] : [];
  const desfeito = !!entry.desfeito_em;
  return {
    id: entry.id, at: entry.at, thread_id: entry.thread_id || '', thread_ids: ids, n: ids.length, assunto: entry.assunto || '',
    acao, rotulo, detalhe, origem: entry.origem || '', desfazivel: entry.desfazivel, motivo: entry.motivo || '', desfeito,
    desfeito_em: entry.desfeito_em, refeito_em: entry.refeito_em, grupo_id: entry.grupo_id,
    estado: !entry.desfazivel ? 'nao_reversivel' : desfeito ? 'desfeito' : 'ativo',
  };
}

export async function take(threadIds: string[]): Promise<Record<string, Snapshot | null>> {
  const out: Record<string, Snapshot | null> = {};
  for (const tid of threadIds) {
    try {
      out[tid] = await snapshot(tid);
    } catch {
      out[tid] = null;
    }
  }
  return out;
}

/** Grava a ação com o retrato depois dela. Melhor esforço: nunca derruba a ação. */
export async function record(
  acao: string,
  before: Record<string, Snapshot | null>,
  opts: { origem?: string; detalhe?: string; gmail?: GmailOp[]; desfazivel?: boolean; motivo?: string; assunto?: string } = {},
): Promise<HistPublic | null> {
  try {
    const ids = Object.keys(before);
    const anterior: Record<string, Snapshot> = {};
    const novo: Record<string, Snapshot> = {};
    for (const tid of ids) {
      const prev = before[tid];
      const after = await snapshot(tid);
      if (!prev || !after) continue;
      const [a, n] = diff(prev, after);
      if (Object.keys(n).length) {
        anterior[tid] = a;
        novo[tid] = n;
      }
    }
    let desfazivel = opts.desfazivel ?? true;
    let motivo = opts.motivo || '';
    if (desfazivel && !Object.keys(novo).length) {
      desfazivel = false;
      motivo = motivo || 'Nada mudou: não há o que desfazer.';
    }
    const gmail = (opts.gmail || []).filter((g) => novo[g.thread_id]);
    const entry = await db.addHistorico({
      acao, thread_ids: ids, assunto: opts.assunto || (await subjectOf(ids)), detalhe: opts.detalhe || '', origem: opts.origem || '',
      anterior, novo, gmail, desfazivel, motivo, grupo_id: ids.length > 1 ? `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : null,
    });
    return publicEntry(entry);
  } catch {
    return null;
  }
}

/** Envio: entra no histórico, mas não desfaz (o e-mail já saiu). */
export async function recordSend(threadId: string, origem = '', assunto = ''): Promise<HistPublic | null> {
  try {
    const entry = await db.addHistorico({
      acao: 'enviar', thread_ids: threadId ? [threadId] : [], assunto: assunto || (threadId ? await subjectOf([threadId]) : '(sem assunto)'),
      origem, desfazivel: false, motivo: 'E-mail já enviado',
    });
    return publicEntry(entry);
  } catch {
    return null;
  }
}

// ── desfazer / refazer ──

async function plan(entry: HistRow, src: HistRow['estado_novo'], dst: HistRow['estado_novo']): Promise<[Record<string, Snapshot>, string[]]> {
  const out: Record<string, Snapshot> = {};
  const conflitos: string[] = [];
  for (const tid of entry.thread_ids) {
    const d = dst[tid] || {};
    const s = src[tid] || {};
    if (!Object.keys(d).length) continue;
    const cur = await snapshot(tid);
    if (!cur) {
      conflitos.push(`${tid}:thread`);
      continue;
    }
    for (const [key, value] of Object.entries(d)) {
      if (cur[key] === value) continue;
      if (cur[key] === s[key]) (out[tid] ??= {})[key] = value;
      else conflitos.push(`${tid}:${key}`);
    }
  }
  return [out, conflitos];
}

const short = (e: unknown) => {
  const t = (e instanceof Error ? e.message : String(e)).trim() || 'erro';
  return t.length <= 120 ? t : t.slice(0, 117) + '…';
};

/** Rótulos no Gmail antes do local; falhou no meio: volta as que já foram e levanta. */
async function runGmail(ops: GmailOp[], undo: boolean): Promise<void> {
  if (!ops.length) return;
  if (!gmailRef) throw new HistoryError(502, 'Gmail indisponível: entre com a conta Google em Ajustes. Nada foi alterado.');
  const done: GmailOp[] = [];
  const apply = (op: GmailOp, inverse: boolean) =>
    gmailRef!.modifyThread(op.thread_id, inverse ? { addLabelIds: op.remove, removeLabelIds: op.add } : { addLabelIds: op.add, removeLabelIds: op.remove });
  try {
    for (const op of ops) {
      await apply(op, undo);
      done.push(op);
    }
  } catch (e) {
    for (const op of done) await apply(op, !undo).catch(() => undefined);
    throw new HistoryError(502, `Não consegui mexer no Gmail (${short(e)}). Nada foi alterado; tente de novo daqui a pouco.`);
  }
  for (const op of ops) {
    await (undo ? db.changeThreadLabels(op.thread_id, op.remove, op.add) : db.changeThreadLabels(op.thread_id, op.add, op.remove));
  }
}

async function applyLocal(tid: string, fields: Snapshot): Promise<void> {
  const thread: Record<string, SqlValue> = {};
  const item: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith('thread.')) thread[k.slice(7)] = v as SqlValue;
    else if (k.startsWith('item.')) item[k.slice(5)] = v as SqlValue;
  }
  if (Object.keys(thread).length) await db.setThreadFields(tid, thread);
  if (Object.keys(item).length) await db.saveCopilotItem(tid, item);
}

async function applyEntry(entry: HistRow, undo: boolean) {
  const [src, dst] = undo ? [entry.estado_novo, entry.estado_anterior] : [entry.estado_anterior, entry.estado_novo];
  const [p, conflitos] = await plan(entry, src, dst);
  if (!Object.keys(p).length && conflitos.length) {
    throw new HistoryError(
      409,
      'Esse e-mail mudou depois dessa ação (chegou mensagem nova ou houve outra ação); ' + (undo ? 'não há o que desfazer.' : 'não há o que refazer.'),
    );
  }
  const ops = (entry.gmail || []).filter((g) => p[g.thread_id]);
  await runGmail(ops, undo);
  for (const [tid, fields] of Object.entries(p)) await applyLocal(tid, fields);
  return { aplicados: Object.values(p).reduce((n, f) => n + Object.keys(f).length, 0), conflitos: conflitos.length, gmail: ops.map((o) => o.thread_id) };
}

async function getEntry(id: number): Promise<HistRow> {
  const e = await db.getHistorico(id);
  if (!e) throw new HistoryError(404, 'Ação não encontrada no histórico.');
  return e;
}

export async function undo(id: number) {
  const entry = await getEntry(id);
  if (!entry.desfazivel) throw new HistoryError(409, entry.acao === 'enviar' ? NAO_ENVIO : entry.motivo || 'Essa ação não pode ser desfeita.');
  if (entry.desfeito_em) throw new HistoryError(409, 'Essa ação já foi desfeita.');
  const res = await applyEntry(entry, true);
  await db.updateHistorico(id, { desfeito_em: nowIso() });
  return { ok: true, ...res, entry: publicEntry(await db.getHistorico(id))! };
}

export async function redo(id: number) {
  const entry = await getEntry(id);
  if (!entry.desfeito_em) throw new HistoryError(409, 'Essa ação não está desfeita.');
  const res = await applyEntry(entry, false);
  await db.updateHistorico(id, { desfeito_em: null, refeito_em: nowIso() });
  return { ok: true, ...res, entry: publicEntry(await db.getHistorico(id))! };
}

export async function undoLast() {
  const entry = await db.lastHistoricoUndoable(SKIP_ULTIMO);
  if (!entry) throw new HistoryError(404, 'Nada para desfazer.');
  return undo(entry.id);
}

export async function listing(opts: { limit?: number; before?: number | null } = {}) {
  const limit = Math.max(1, Math.min(Math.trunc(opts.limit || 50), 200));
  const rows = await db.listHistorico({ limit: limit + 1, before: opts.before });
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { items: page.map((r) => publicEntry(r)!), proximo: more && page.length ? page[page.length - 1].id : null };
}
