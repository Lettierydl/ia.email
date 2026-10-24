// Sync do Gmail para o SQLite do aparelho. Roda ao abrir/voltar ao app
// (AppState active) e no pull-to-refresh; em segundo plano só o incremental
// curto (gancho em core/background.ts, depende de lib + dev build).
//
// Incremental: history.list desde o último historyId (barato). Sem historyId
// salvo, ou com 404 do history (historyId velho demais), cai na listagem
// completa do refresh() do Python: Principal recentes + não lidos, re-busca só
// o que mudou de historyId e o que estava não lido aqui mas o Gmail já não
// lista como não lido. Cada thread vem inteira (format=full) e vira linha em
// threads + uma linha por mensagem em messages + body_text no formato do Mac.
import { AuthError } from './googleAuth';
import * as db from './db';
import { classify, parseEmail } from './classifier';
import { GmailError, threadIdsFromHistory, type Gmail, type HistoryRecord } from './gmail';
import { getAddresses, headerMap, messageBodyText, parseAddr, threadAttachments, threadText, type GmailThread } from './mime';
import { runPool } from './pool';

export const REFRESH_RECENT = 50;
export const REFRESH_UNREAD = 300;
export const PRIMARY_QUERY = 'in:inbox category:primary';
export const HISTORY_TYPES = ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'];
const MAX_HTML = 200_000;

export const META = {
  historyId: 'gmail_history_id',
  lastSyncAt: 'last_sync_at',
  counts: 'gmail_counts',
  lastError: 'last_sync_error',
} as const;

export type SyncGmail = Pick<Gmail, 'listAllThreads' | 'getThread' | 'listHistoryAll' | 'getProfile' | 'getLabel'>;

export interface SyncDeps {
  gmail: SyncGmail;
  /** conta logada (minúsculas) */
  me(): Promise<string> | string;
  now?(): number;
  concurrency?: number;
}

export interface SyncResult {
  mode: 'incremental' | 'full';
  fetched: number;
  skipped: number;
  removed: number;
  historyId: string;
  /** o history estava velho (404) e caiu na listagem completa */
  fellBack: boolean;
}

export type SyncState = 'online' | 'offline' | 'auth_error';

/** Mesmo formato do SyncStatus do servidor (a Home mostra igual). */
export interface LocalSyncStatus {
  status: SyncState;
  last_sync_at: string | null;
  last_sync_label: string;
  minutes_since_sync: number | null;
  last_error: string;
  gmail_primary_unread: number | null;
  result?: { fetched?: number };
}

export function errorState(e: unknown): SyncState {
  if (e instanceof AuthError) return 'auth_error';
  if (e instanceof GmailError) return e.status === 401 ? 'auth_error' : e.status === 0 ? 'offline' : 'online';
  return 'online';
}

const inPrimary = (labels: Set<string>) => labels.has('INBOX') && labels.has('CATEGORY_PERSONAL');

/** Grava uma thread (format=full) no banco: porte do _ingest_thread + mensagens + corpo. */
export async function ingestThread(raw: GmailThread, me: string): Promise<boolean> {
  const messages = raw.messages || [];
  if (!messages.length) return false;
  const last = messages[messages.length - 1];
  const first = messages[0];
  const lastHeaders = headerMap(last.payload);
  const firstHeaders = headerMap(first.payload);
  const subject = lastHeaders.subject || firstHeaders.subject || '(sem assunto)';
  const fromHeader = lastHeaders.from || firstHeaders.from || '';
  const { name, email } = parseAddr(fromHeader);
  // UNREAD pode estar só na mensagem nova, não no wrapper da thread
  const allLabels: string[] = [];
  for (const m of messages) allLabels.push(...(m.labelIds || []));
  const snippet = last.snippet || raw.snippet || '';
  const internal = Number(last.internalDate || first.internalDate || 0);
  const result = classify({ label_ids: allLabels, last_from_header: fromHeader, subject, snippet, me });
  const senderEmail = parseEmail(fromHeader) || email.toLowerCase();
  const forcedMarketing = result.is_marketing || (await db.isBlockedSender(senderEmail));
  await db.upsertThread({
    id: raw.id,
    subject,
    from_email: senderEmail,
    from_name: name || email,
    snippet,
    internal_date: internal,
    is_unread: Number(result.is_unread),
    last_from_me: Number(result.last_from_me),
    is_automatic: Number(result.is_automatic),
    is_marketing: Number(forcedMarketing),
    needs_action_hint: Number(result.needs_action_hint),
    awaiting_reply: Number(result.awaiting_reply),
    conferido: 1,
    hide_as_replied: Number(result.hide_as_replied),
    last_from_header: fromHeader,
    labels_json: [...new Set(allLabels)].sort(),
    to_header: lastHeaders.to || '',
    cc_header: lastHeaders.cc || '',
    history_id: String(raw.historyId || ''),
  });

  const att = threadAttachments(raw);
  for (const m of messages) {
    const h = headerMap(m.payload);
    const from = getAddresses(h.from)[0] || { name: '', email: '' };
    const { text, html } = messageBodyText(m.payload);
    await db.upsertMessage({
      id: m.id,
      thread_id: raw.id,
      internal_date: Number(m.internalDate || 0),
      from_email: from.email.toLowerCase(),
      from_name: from.name || from.email,
      to_header: h.to || '',
      cc_header: h.cc || '',
      subject: h.subject || '',
      snippet: m.snippet || '',
      body_text: text,
      body_html: html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html,
      labels_json: JSON.stringify(m.labelIds || []),
      attachments_json: JSON.stringify({
        files: att.files.filter((f) => f.message_id === m.id),
        inline: att.inline[m.id] || [],
      }),
    });
  }
  await db.deleteMessagesNotIn(raw.id, messages.map((m) => m.id));
  // o corpo no formato do Mac (De:/Data: + texto, blocos com ----): é o que o copiloto lê
  await db.saveAi(raw.id, { body_text: threadText(raw) });
  return true;
}

export function createSync(deps: SyncDeps) {
  const now = deps.now ?? (() => Date.now());
  const concurrency = deps.concurrency ?? 3;
  let running: Promise<SyncResult> | null = null;

  /** Busca e grava cada thread; 404 = sumiu do Gmail (sai da lista). */
  async function fetchAll(ids: string[], me: string, onlyPrimaryIfNew: Set<string> = new Set()): Promise<{ fetched: number; removed: number; skipped: number }> {
    let fetched = 0;
    let removed = 0;
    let skipped = 0;
    const { errors } = await runPool(ids, concurrency, async (id) => {
      let raw: GmailThread;
      try {
        raw = await deps.gmail.getThread(id, 'full');
      } catch (e) {
        if (e instanceof GmailError && e.status === 404) {
          await db.hideThread(id);
          removed += 1;
          return;
        }
        throw e;
      }
      if (onlyPrimaryIfNew.has(id)) {
        const labels = new Set((raw.messages || []).flatMap((m) => m.labelIds || []));
        if (!inPrimary(labels)) {
          skipped += 1;
          return;
        }
      }
      if (await ingestThread(raw, me)) fetched += 1;
    });
    // erro de conexão/acesso derruba o sync inteiro (o resto viria igual)
    const fatal = errors.find((x) => errorState(x.error) !== 'online');
    if (fatal) throw fatal.error;
    if (errors.length) throw errors[0].error;
    return { fetched, removed, skipped };
  }

  async function saveCounts(): Promise<void> {
    try {
      const label = await deps.gmail.getLabel('CATEGORY_PERSONAL');
      await db.setMeta(META.counts, JSON.stringify({ primary_unread: Number(label.threadsUnread ?? 0), at: new Date(now()).toISOString() }));
    } catch {
      // contador é enfeite: falha aqui não derruba o sync
    }
  }

  async function full(me: string, fellBack: boolean): Promise<SyncResult> {
    // historyId ANTES da listagem: o que mudar durante a listagem entra no próximo incremental
    const profile = await deps.gmail.getProfile();
    const recent = await deps.gmail.listAllThreads({ q: PRIMARY_QUERY }, REFRESH_RECENT);
    const unread = await deps.gmail.listAllThreads({ q: `${PRIMARY_QUERY} is:unread` }, REFRESH_UNREAD);
    const unreadSet = new Set(unread.map((t) => t.id));
    const index = await db.threadSyncIndex();
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const item of [...unread, ...recent]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const known = index[item.id];
      if (known && known.history_id && known.history_id === item.historyId) continue;
      ordered.push(item.id);
    }
    // não lido aqui que o Gmail não lista mais como não lido: re-busca para limpar
    for (const [id, known] of Object.entries(index)) {
      if (known.is_unread && known.visible && !unreadSet.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    const r = await fetchAll(ordered, me);
    const historyId = String(profile.historyId || '');
    if (historyId) await db.setMeta(META.historyId, historyId);
    return { mode: 'full', fetched: r.fetched, removed: r.removed, skipped: seen.size - ordered.length, historyId, fellBack };
  }

  async function incremental(me: string, start: string): Promise<SyncResult> {
    let history: HistoryRecord[];
    let historyId: string;
    try {
      ({ history, historyId } = await deps.gmail.listHistoryAll(start, { historyTypes: HISTORY_TYPES }));
    } catch (e) {
      if (e instanceof GmailError && e.status === 404) return full(me, true);
      throw e;
    }
    const index = await db.threadSyncIndex();
    // thread conhecida: sempre re-busca; nova: só se algo entrou na caixa de entrada
    const enteredInbox = new Set<string>();
    for (const h of history) {
      for (const x of h.messagesAdded || []) if ((x.message.labelIds || []).includes('INBOX')) enteredInbox.add(x.message.threadId);
      for (const x of h.labelsAdded || []) if ((x.labelIds || []).includes('INBOX')) enteredInbox.add(x.message.threadId);
    }
    const touched = threadIdsFromHistory(history);
    const ids = touched.filter((id) => id in index || enteredInbox.has(id));
    const fresh = new Set(ids.filter((id) => !(id in index)));
    const r = await fetchAll(ids, me, fresh);
    if (historyId) await db.setMeta(META.historyId, historyId);
    return { mode: 'incremental', fetched: r.fetched, removed: r.removed, skipped: touched.length - ids.length + r.skipped, historyId, fellBack: false };
  }

  async function run(opts: { full?: boolean }): Promise<SyncResult> {
    const me = String(await deps.me()).trim().toLowerCase();
    try {
      const start = opts.full ? '' : (await db.getMeta(META.historyId)) || '';
      const result = start ? await incremental(me, start) : await full(me, false);
      await saveCounts();
      await db.setMeta(META.lastSyncAt, new Date(now()).toISOString());
      await db.setMeta(META.lastError, '');
      return result;
    } catch (e) {
      await db.setMeta(META.lastError, JSON.stringify({ state: errorState(e), message: e instanceof Error ? e.message : String(e) })).catch(() => undefined);
      throw e;
    }
  }

  return {
    /** Um sync por vez: chamadas durante um sync em andamento recebem o mesmo resultado. */
    syncNow(opts: { full?: boolean } = {}): Promise<SyncResult> {
      if (!running) {
        running = run(opts).finally(() => {
          running = null;
        });
      }
      return running;
    },
    isRunning: () => !!running,
    async status(): Promise<LocalSyncStatus> {
      const [at, err, counts] = await Promise.all([db.getMeta(META.lastSyncAt), db.getMeta(META.lastError), db.getMeta(META.counts)]);
      let lastError = '';
      let state: SyncState = 'online';
      try {
        const e = err ? JSON.parse(err) : null;
        if (e) {
          state = e.state || 'online';
          lastError = String(e.message || '');
        }
      } catch {
        // meta quebrada: ignora
      }
      let unread: number | null = null;
      try {
        unread = counts ? Number(JSON.parse(counts).primary_unread ?? null) : null;
      } catch {
        unread = null;
      }
      const minutes = at ? Math.max(0, Math.round((now() - Date.parse(at)) / 60000)) : null;
      return {
        status: state,
        last_sync_at: at || null,
        last_sync_label: at ? fmtLabel(at, now()) : '',
        minutes_since_sync: minutes,
        last_error: lastError,
        gmail_primary_unread: unread,
      };
    },
  };
}

export type Sync = ReturnType<typeof createSync>;

/** "agora", "há 5 min", "às 14:32" (fuso do app, UTC-3). */
export function fmtLabel(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.round((nowMs - t) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const d = new Date(t - 3 * 3600_000);
  return `às ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
