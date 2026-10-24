// Fonte "local": lê do SQLite do aparelho; sync, leitura da IA, ações,
// rascunho, envio (outbox com janela de desfazer), resumos, Verificar na caixa
// e Aprender rodam aqui.
import * as db from '../core/db';
import { ownText, messages as threadMessages, fmtWhen, getAccount } from '../core/copilot';
import { errorState } from '../core/sync';
import { getGoogleAuth } from '../core/googleAuth';
import * as history from '../core/history';
import * as learned from '../core/learned';
import { actions, assistant, copilot, gmail, outbox, summaries, sync, verify } from '../core/local';
import { getAddresses } from '../core/mime';
import { defaultTargetIndex, replyDefaults, type Headers } from '../core/recipients';
import type { OutboxItem } from '../core/outbox';
import type { ComposeMessage, GmailAttachments, GmailFile, InlinePlaceholder, LearnedNote, OutboxView, Recipients, SyncStatus } from '../types';
import type { DataBackend } from './index';
import { inlineImageUri, openLocalAttachment } from './localFiles';

const fetchAttachment = (mid: string, aid: string) => gmail.getAttachment(mid, aid);

async function signedIn(): Promise<boolean> {
  try {
    return (await getGoogleAuth().state()).kind === 'signed_in';
  } catch {
    return false;
  }
}

/** Anexos da thread a partir do que o sync gravou em messages.attachments_json. */
export async function localAttachments(threadId: string): Promise<GmailAttachments> {
  const rows = await db.listMessages(threadId);
  const files: GmailFile[] = [];
  const inline: Record<string, InlinePlaceholder[]> = {};
  for (const r of rows) {
    let parsed: { files?: GmailFile[]; inline?: InlinePlaceholder[] } = {};
    try {
      parsed = JSON.parse(String(r.attachments_json || '{}'));
    } catch {
      parsed = {};
    }
    files.push(...(parsed.files || []));
    if (parsed.inline?.length) inline[String(r.id)] = parsed.inline;
  }
  return { files, message_ids: rows.map((r) => String(r.id)), inline };
}

const fmtAddr = (name: string, email: string) => (name && name !== email ? `${name} <${email}>` : email);

/** Mensagens da thread (do sync) como cabeçalhos + itens do seletor "Responder a". */
export async function threadHeaders(threadId: string): Promise<{ headers: Headers[]; msgs: ComposeMessage[] }> {
  const me = getAccount();
  const rows = await db.listMessages(threadId);
  if (!rows.length) {
    const t = await db.getThread(threadId);
    if (!t) return { headers: [], msgs: [] };
    return {
      headers: [{ from: String(t.last_from_header || fmtAddr(String(t.from_name || ''), String(t.from_email || ''))), to: String(t.to_header || ''), cc: String(t.cc_header || '') }],
      msgs: [],
    };
  }
  const headers = rows.map((r) => ({ from: fmtAddr(String(r.from_name || ''), String(r.from_email || '')), to: String(r.to_header || ''), cc: String(r.cc_header || '') }));
  const msgs = rows.map((r, idx) => ({
    id: String(r.id), idx, de: String(r.from_name || r.from_email || ''), email: String(r.from_email || ''),
    data: fmtWhen(Number(r.internal_date || 0)), snippet: String(r.snippet || '').slice(0, 140), voce: String(r.from_email || '').toLowerCase() === me,
  }));
  return { headers, msgs };
}

/** Para/Cc padrão como o servidor ("responder a todos" sem o Leo), para a mensagem escolhida. */
export async function localRecipients(threadId: string, targetMessageId?: string): Promise<Recipients> {
  const me = getAccount();
  const { headers, msgs } = await threadHeaders(threadId);
  if (!headers.length) return { to: [], cc: [], reply_to: [], reply_cc: [], participants: [], messages: [] };
  const picked = targetMessageId ? msgs.findIndex((m) => m.id === targetMessageId) : -1;
  const idx = picked >= 0 ? picked : defaultTargetIndex(headers, me);
  const target = headers[idx];
  const parse = (h: string) => getAddresses(h).filter((a) => a.email).map((a) => ({ name: a.name, email: a.email.toLowerCase() }));
  return {
    to: parse(target.to), cc: parse(target.cc), ...replyDefaults(headers, me, idx), messages: msgs, target_id: msgs[idx]?.id,
  };
}

const outboxView = (i: OutboxItem): OutboxView => ({
  id: i.id, kind: i.kind, thread_id: i.thread_id, to: i.to_addr, subject: i.subject, status: i.status,
  last_error: i.last_error, attempts: i.attempts, undo_until: i.undo_until,
});

export const localBackend: DataBackend = {
  async list(all) {
    // abrir o painel já põe a IA para ler o que falta (com chave), sem esperar o ⟳
    await copilot.ensureBatch().catch(() => undefined);
    const [list, st] = await Promise.all([copilot.listItems({ showAll: all }), sync.status()]);
    return { ...list, sync: st };
  },
  status: async () => copilot.status(),
  run: (limit) => copilot.start(limit),
  async syncNow(): Promise<SyncStatus> {
    if (!(await signedIn())) {
      const st = await sync.status();
      return { ...st, status: 'auth_error', last_error: 'Entre com a conta Google em Ajustes → Conta Google.' };
    }
    try {
      const r = await sync.syncNow();
      copilot.ensureBatch().catch(() => undefined);
      // voltou a conexão: o que ficou na fila offline sai agora (janela de desfazer respeitada)
      outbox.flush({ force: true }).catch(() => undefined);
      return { ...(await sync.status()), result: { fetched: r.fetched } };
    } catch (e) {
      return { ...(await sync.status()), status: errorState(e) === 'online' ? 'offline' : errorState(e) };
    }
  },
  detail: (id, refresh) => (refresh ? copilot.analyze(id, { force: true }) : copilot.detail(id)),
  gmailAttachments: localAttachments,
  imageSource: async (_tid, f) => ({ uri: await inlineImageUri(f, fetchAttachment) }),
  openAttachment: (_tid, f) => openLocalAttachment(f, fetchAttachment),
  async appStatus() {
    try {
      const st = await getGoogleAuth().state();
      // gmail.modify já permite messages.send: logado = pode enviar (sempre com confirmação)
      const ok = st.kind === 'signed_in';
      return { account: ok ? st.user.email : '', can_send: ok };
    } catch {
      return { account: '', can_send: false };
    }
  },
  // preferências do painel ainda não existem no aparelho: padrão do servidor
  prefs: async () => ({ show_all: false, show_tasks_card: true, show_facts_card: true }),
  action: (id, action, extra) => actions.act(id, action, extra) as never,
  async aliasSuggest(q) {
    const term = q.trim().toLowerCase();
    const aliases = (await db.listAliases()).filter((a) => a.email && (a.alias.includes(term) || a.name.toLowerCase().includes(term)));
    const out = aliases.map((a) => ({ name: a.name || a.alias, email: a.email }));
    for (const s of await db.searchSenders(q, 6)) if (!out.some((o) => o.email === s.email)) out.push(s);
    return { suggestions: out.slice(0, 8) };
  },
  recipients: (id, targetMessageId) => localRecipients(id, targetMessageId),
  async draft(id, instruction, currentDraft, targetMessageId) {
    let alvo = null;
    if (targetMessageId) {
      const rows = await db.listMessages(id);
      const idx = rows.findIndex((r) => String(r.id) === targetMessageId);
      const row = await db.getThread(id);
      const msgs = threadMessages(String(row?.body_text || ''));
      if (idx >= 0 && idx < msgs.length) {
        const m = msgs[idx];
        alvo = { idx, total: msgs.length, de: m.de || '', data: m.data || '', texto: ownText(m.texto || '') || m.texto || '', message_id: targetMessageId };
      }
    }
    return assistant.draft(id, instruction, { currentDraft: instruction ? currentDraft : '', alvo });
  },
  attachmentsCount: async () => 0,
  async send(id, input, confirm) {
    const row = await db.getThread(id);
    const item = await outbox.enqueue(
      {
        kind: 'reply', thread_id: id, body: input.text, cc: input.cc, to: String(row?.from_email || ''), subject: String(row?.subject || ''),
        source: 'copilot', ai_draft: String(row?.draft || '').trim(), reply_to: input.to.join(', '), reply_to_message_id: input.replyToMessageId || '',
      },
      confirm,
    );
    const secs = Math.max(0, Math.round((item.undo_until - Date.now()) / 1000));
    return { ok: true, queued: true, outbox_id: item.id, undo_until: item.undo_until, to: item.to_addr, cc: input.cc, message: `Sai em ${secs} s — dá para desfazer até lá.` };
  },
  async sendNew(input, confirm) {
    const item = await outbox.enqueue({ kind: 'new', body: input.body, to: input.to, cc: input.cc, subject: input.subject, source: 'copilot' }, confirm);
    return { ok: true, queued: true, outbox_id: item.id, undo_until: item.undo_until, to: item.to_addr, message: 'Na fila de envio.' };
  },
  outbox: async (threadId) => (await outbox.list({ threadId })).map(outboxView),
  async cancelSend(outboxId) {
    await outbox.cancel(outboxId);
  },
  historico: (before) => history.listing({ before }) as never,
  desfazer: (id) => history.undo(id) as never,
  refazer: (id) => history.redo(id) as never,
  desfazerUltimo: () => history.undoLast() as never,
  resumoDetalhado: (id, regerar) => summaries.resumoDetalhado(id, { force: regerar }),
  resumoMensagem: (id, idx, modo, regerar) => summaries.resumoMensagem(id, idx, modo, { force: regerar }),
  resumoMensagemCached: (id, idx, modo) => summaries.resumoMensagem(id, idx, modo, { onlyCached: true }),
  verifyCached: (id) => verify.cached(id),
  verify: (id, regerar) => verify.verificar(id, { force: regerar }),
  learned: async (threadId) => ({ notes: (threadId ? await learned.forThread(threadId, getAccount()) : await learned.listAll()) as LearnedNote[] }),
  learn: async (scope, text, threadId, personEmail) => ({ note: (await learned.addNote(scope, text, threadId, personEmail)) as LearnedNote }),
  async unlearn(noteId) {
    if (!(await learned.deleteNote(noteId))) throw new Error('Aprendizado não encontrado.');
    return { ok: true };
  },
};
