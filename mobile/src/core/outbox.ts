// Fila de envio do aparelho: porte de app/outbox.py + montagem do MIME
// (gmail_client.send_reply/send_new) e messages.send via gmail.ts.
//
// Regras:
// - Só entra aqui o que o Leo CONFIRMOU no ConfirmModal ("Enviar para X?"):
//   enqueue exige { confirmed: true }. Nada é gerado ou enfileirado sozinho.
// - Todo envio espera a janela de desfazer (UNDO_SECONDS) antes de sair;
//   enquanto está na fila (ou falhou), o Leo pode cancelar.
// - Sem rede: fica na fila ("queued") com espera crescente; o sync e a volta
//   ao app chamam flush() de novo. Mesmo texto para a mesma thread/Para não
//   duplica; a trava otimista (queued → sending) impede envio em dobro.
// - Erro "ambíguo" (prazo estourou depois de mandar) NÃO é reenviado:
//   vira "falhou" com aviso para conferir no Gmail.
import * as db from './db';
import type { Row, SqlValue } from './db';
import { GmailError } from './gmail';
import { AuthError } from './googleAuth';
import { headerMap, type GmailThread } from './mime';
import { cleanAddresses, finalRecipients, replyToAddr } from './recipients';

export const QUEUED = 'queued';
export const SENDING = 'sending';
export const SENT = 'sent';
export const FAILED = 'failed';
export const CANCELLED = 'cancelled';
export type OutboxStatus = typeof QUEUED | typeof SENDING | typeof SENT | typeof FAILED | typeof CANCELLED;
export const OPEN_STATUSES = [QUEUED, SENDING, FAILED];
/** O servidor do Mac não tem janela de desfazer; no aparelho todo envio espera 10 s. */
export const UNDO_SECONDS = 10;
export const BACKOFF_BASE = 30;
export const BACKOFF_MAX = 15 * 60;
export const FROM_NAME = "Lettiery D'Lamare";

// ── MIME (RFC 2822 / 2045 / 2047), sem Buffer ──

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    let c = ch.codePointAt(0)!;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToB64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

export const b64url = (bytes: Uint8Array) => bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const wrap76 = (b64: string) => (b64.match(/.{1,76}/g) || ['']).join('\r\n');
const isAscii = (t: string) => /^[\x20-\x7e]*$/.test(t);

/** Cabeçalho com acento → encoded-words =?utf-8?b?...?= (≤ 75 colunas cada). */
export function encodeHeaderValue(text: string): string {
  if (isAscii(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const ch of text) {
    // 45 bytes de UTF-8 → 60 de base64: a palavra fica com 72 colunas
    if (utf8Encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?utf-8?b?${bytesToB64(utf8Encode(w))}?=`).join('\r\n ');
}

/** formataddr(("Nome", email)): aspas só se o nome tiver especiais; acento → RFC 2047. */
export function formatAddr(name: string, email: string): string {
  if (!name) return email;
  if (!isAscii(name)) return `${encodeHeaderValue(name)} <${email}>`;
  return /[\][\\()<>@,:;".]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}" <${email}>` : `${name} <${email}>`;
}

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  /** conteúdo em base64 (padrão) */
  dataB64: string;
}

export interface MimeInput {
  from: { name: string; email: string };
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
  /** testes fixam a fronteira e a data */
  boundary?: string;
  date?: Date;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
export const rfc2822Date = (d: Date) =>
  `${DAYS[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;

const textPart = (body: string) => [
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  wrap76(bytesToB64(utf8Encode(body.replace(/\r?\n/g, '\r\n')))),
];

/** Mensagem RFC 2822 em UTF-8 (CRLF). Texto em base64; anexos em multipart/mixed. */
export function buildMime(m: MimeInput): string {
  const head = [
    'MIME-Version: 1.0',
    `Date: ${rfc2822Date(m.date ?? new Date())}`,
    `From: ${formatAddr(m.from.name, m.from.email)}`,
    `To: ${m.to.join(', ')}`,
  ];
  if (m.cc?.length) head.push(`Cc: ${m.cc.join(', ')}`);
  head.push(`Subject: ${encodeHeaderValue(m.subject)}`);
  if (m.inReplyTo) head.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references) head.push(`References: ${m.references}`);
  if (!m.attachments?.length) return [...head, ...textPart(m.body)].join('\r\n') + '\r\n';
  const boundary = m.boundary ?? `=_iaemail_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const lines = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...textPart(m.body)];
  for (const a of m.attachments) {
    const name = encodeHeaderValue(a.filename.replace(/["\r\n]/g, '_'));
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      wrap76(a.dataB64.replace(/\s+/g, '')),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

// ── fila ──

export interface OutboxItem {
  id: string;
  kind: 'reply' | 'new';
  thread_id: string;
  to_addr: string;
  cc: string;
  subject: string;
  body: string;
  attachments: MimeAttachment[];
  source: string;
  ai_draft: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string;
  next_attempt_at: number;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  reply_to: string;
  reply_to_message_id: string;
  /** ainda dentro da janela de desfazer (ms desde 1970) — 0 se já passou */
  undo_until: number;
}

export interface EnqueueInput {
  kind: 'reply' | 'new';
  body: string;
  thread_id?: string;
  to?: string;
  cc?: string;
  subject?: string;
  source?: string;
  ai_draft?: string;
  attachments?: MimeAttachment[];
  /** Para escolhido no composer (resposta); vazio = padrão do envio */
  reply_to?: string;
  /** mensagem específica da thread sendo respondida (id do Gmail ou Message-ID) */
  reply_to_message_id?: string;
}

export interface OutboxGmail {
  getThreadMetadata(id: string, headers: string[]): Promise<GmailThread>;
  sendRawMessage(raw: string, threadId?: string): Promise<{ id: string; threadId: string }>;
}

export interface OutboxDeps {
  gmail: OutboxGmail;
  me(): string | Promise<string>;
  /** relógio em ms (testes controlam a janela) */
  now?(): number;
  undoSeconds?: number;
  /** agenda o flush ao fim da janela; padrão setTimeout (testes passam no-op) */
  schedule?(fn: () => void, ms: number): void;
  /** pós-envio (melhor esforço): lido, rascunho limpo, histórico, resolvido */
  afterSend?(item: OutboxItem, result: Record<string, unknown>): Promise<void>;
  /** avisa a tela que algo mudou na fila */
  onChange?(): void;
}

export class ConfirmationRequired extends Error {
  constructor() {
    super('Envio sem confirmação explícita: nada foi enfileirado.');
    this.name = 'ConfirmationRequired';
  }
}

function toItem(r: Row, nowMs: number): OutboxItem {
  const j = <T>(v: SqlValue, d: T): T => {
    try {
      return (JSON.parse(String(v ?? 'null')) as T) ?? d;
    } catch {
      return d;
    }
  };
  const attempts = Number(r.attempts || 0);
  const next = Number(r.next_attempt_at || 0);
  const status = String(r.status) as OutboxStatus;
  return {
    id: String(r.id), kind: String(r.kind) as OutboxItem['kind'], thread_id: String(r.thread_id ?? ''), to_addr: String(r.to_addr ?? ''),
    cc: String(r.cc ?? ''), subject: String(r.subject ?? ''), body: String(r.body ?? ''), attachments: j<MimeAttachment[]>(r.attachments_json, []),
    source: String(r.source ?? ''), ai_draft: String(r.ai_draft ?? ''), status, attempts, last_error: String(r.last_error ?? ''),
    next_attempt_at: next, result: j(r.result_json, null), created_at: String(r.created_at ?? ''), updated_at: String(r.updated_at ?? ''),
    sent_at: r.sent_at == null ? null : String(r.sent_at), reply_to: String(r.reply_to ?? ''), reply_to_message_id: String(r.reply_to_message_id ?? ''),
    undo_until: status === QUEUED && attempts === 0 && next * 1000 > nowMs ? next * 1000 : 0,
  };
}

export const backoff = (attempts: number) => Math.min(BACKOFF_BASE * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX);

type ErrKind = 'offline' | 'auth' | 'ambiguous' | 'transient' | 'error';
export function kindOf(e: unknown): ErrKind {
  if (e instanceof AuthError) return 'auth';
  if (e instanceof GmailError) {
    if (e.status === 0) return e.ambiguous ? 'ambiguous' : 'offline';
    if (e.status === 401) return 'auth';
    if (e.status === 429 || e.status >= 500) return 'transient';
  }
  return 'error';
}

const shortErr = (e: unknown) => {
  const t = (e instanceof Error ? e.message : String(e)).trim() || 'erro';
  return t.length <= 200 ? t : t.slice(0, 197) + '…';
};

/** Monta e manda um item pela API do Gmail (o _deliver + send_reply/send_new). */
export async function deliver(item: OutboxItem, gmail: OutboxGmail, me: string, date?: Date): Promise<Record<string, unknown>> {
  const from = { name: FROM_NAME, email: me };
  if (item.kind === 'new') {
    const to = cleanAddresses(item.to_addr);
    if (!to.length) throw new Error('Informe pelo menos um destinatário.');
    const { cc } = finalRecipients(to, cleanAddresses(item.cc), me);
    const subject = item.subject.trim() || '(sem assunto)';
    const raw = b64url(utf8Encode(buildMime({ from, to, cc, subject, body: item.body, attachments: item.attachments, date })));
    const sent = await gmail.sendRawMessage(raw);
    return { id: sent.id, thread_id: sent.threadId, to: to.join(', '), cc: cc.join(', '), subject };
  }
  const toChosen = cleanAddresses(item.reply_to);
  const thread = await gmail.getThreadMetadata(item.thread_id, ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References']);
  const msgs = thread.messages || [];
  if (!msgs.length) throw new Error('Thread vazia.');
  let target = msgs[msgs.length - 1];
  const wanted = item.reply_to_message_id.trim();
  if (wanted) {
    const bare = wanted.replace(/^<|>$/g, '');
    const hit = msgs.find((m) => m.id === wanted || (headerMap(m.payload)['message-id'] || '').trim().replace(/^<|>$/g, '') === bare);
    if (!hit) throw new Error('A mensagem que você quis responder não está mais nesta conversa. Recarregue e escolha de novo.');
    target = hit;
  }
  const h = headerMap(target.payload);
  const to = toChosen.length ? toChosen : [replyToAddr(h, me)].filter(Boolean);
  if (!to.length) throw new Error('Informe pelo menos um destinatário no Para.');
  let subject = h.subject || '(sem assunto)';
  if (!subject.toLowerCase().startsWith('re:')) subject = `Re: ${subject}`;
  const messageId = (h['message-id'] || '').trim();
  const refs = wanted ? (h.references || '').split(/\s+/).filter(Boolean) : [];
  const { cc } = finalRecipients(to, cleanAddresses(item.cc), me);
  const mime = buildMime({
    from, to, cc, subject, body: item.body, attachments: item.attachments, date,
    inReplyTo: messageId || undefined,
    references: messageId ? [...refs.filter((r) => r !== messageId), messageId].join(' ') : undefined,
  });
  const sent = await gmail.sendRawMessage(b64url(utf8Encode(mime)), item.thread_id);
  return { id: sent.id, to: to.join(', '), cc: cc.join(', '), subject, ...(wanted ? { reply_to_message_id: target.id } : {}) };
}

const newId = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

export function createOutbox(deps: OutboxDeps) {
  const now = () => (deps.now ? deps.now() : Date.now());
  const undoMs = (deps.undoSeconds ?? UNDO_SECONDS) * 1000;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  let flushing: Promise<number> | null = null;

  const nowIso = () => new Date(now()).toISOString();

  async function get(id: string): Promise<OutboxItem | null> {
    const d = await db.getDb();
    const r = await d.getFirstAsync<Row>('SELECT * FROM outbox WHERE id=?', [id]);
    return r ? toItem(r, now()) : null;
  }

  async function set(id: string, fields: Record<string, SqlValue>): Promise<void> {
    const d = await db.getDb();
    const all = { ...fields, updated_at: nowIso() };
    await d.runAsync(`UPDATE outbox SET ${Object.keys(all).map((k) => `${k}=?`).join(', ')} WHERE id=?`, [...Object.values(all), id]);
  }

  async function flushUnlocked(opts: { onlyId?: string; force?: boolean }): Promise<number> {
    const d = await db.getDb();
    const t = now();
    // force (sync/volta ao app): ignora a espera de quem já tentou, nunca a janela de desfazer
    const rows = opts.onlyId
      ? await d.getAllAsync<Row>('SELECT * FROM outbox WHERE id=? AND status=? AND (attempts > 0 OR COALESCE(next_attempt_at, 0) <= ?)', [opts.onlyId, QUEUED, t / 1000])
      : await d.getAllAsync<Row>(
          `SELECT * FROM outbox WHERE status=? AND (COALESCE(next_attempt_at, 0) <= ?${opts.force ? ' OR attempts > 0' : ''}) ORDER BY created_at`,
          [QUEUED, t / 1000],
        );
    let sent = 0;
    const me = await deps.me();
    for (const r of rows) {
      const item = toItem(r, t);
      const lock = await d.runAsync('UPDATE outbox SET status=?, attempts=attempts+1, updated_at=? WHERE id=? AND status=?', [SENDING, nowIso(), item.id, QUEUED]);
      if (!lock.changes) continue;
      deps.onChange?.();
      const attempts = item.attempts + 1;
      let result: Record<string, unknown>;
      try {
        result = await deliver(item, deps.gmail, me);
      } catch (e) {
        const kind = kindOf(e);
        if (kind === 'ambiguous') {
          await set(item.id, { status: FAILED, last_error: `A conexão caiu durante o envio: pode ter saído. Confira no Gmail antes de tentar de novo. (${shortErr(e)})` });
          deps.onChange?.();
          break;
        }
        if (kind === 'offline' || kind === 'auth' || kind === 'transient') {
          await set(item.id, { status: QUEUED, last_error: shortErr(e), next_attempt_at: now() / 1000 + backoff(attempts) });
          deps.onChange?.();
          break;
        }
        await set(item.id, { status: FAILED, last_error: shortErr(e) });
        deps.onChange?.();
        continue;
      }
      await set(item.id, { status: SENT, sent_at: nowIso(), last_error: '', result_json: JSON.stringify(result) });
      sent += 1;
      try {
        await deps.afterSend?.({ ...item, status: SENT }, result);
      } catch {
        // o e-mail já saiu: pós-envio é melhor esforço
      }
      deps.onChange?.();
    }
    return sent;
  }

  const outbox = {
    get,

    /**
     * Grava um envio CONFIRMADO. Sem { confirmed: true } não grava nada.
     * Mesmo texto já na fila para a mesma thread/Para não duplica.
     */
    async enqueue(input: EnqueueInput, opts: { confirmed: boolean }): Promise<OutboxItem> {
      if (!opts || opts.confirmed !== true) throw new ConfirmationRequired();
      if (input.kind !== 'reply' && input.kind !== 'new') throw new Error('kind inválido');
      const body = (input.body || '').trim();
      if (!body) throw new Error('Texto vazio.');
      // valida antes de gravar (e-mail inválido → erro para o Leo, nada na fila)
      const replyTo = cleanAddresses(input.reply_to).join(', ');
      cleanAddresses(input.cc);
      const to = replyTo || (input.kind === 'new' ? cleanAddresses(input.to).join(', ') : input.to || '');
      if (input.kind === 'new' && !to) throw new Error('Informe pelo menos um destinatário.');
      if (input.kind === 'reply' && !input.thread_id) throw new Error('Resposta sem thread.');
      const d = await db.getDb();
      const dup = await d.getFirstAsync<Row>(
        "SELECT * FROM outbox WHERE status IN (?, ?) AND kind=? AND COALESCE(thread_id,'')=? AND COALESCE(to_addr,'')=? AND body=?",
        [QUEUED, SENDING, input.kind, input.thread_id || '', to, body],
      );
      if (dup) return toItem(dup, now());
      const id = newId();
      const ts = nowIso();
      await d.runAsync(
        'INSERT INTO outbox(id, kind, thread_id, to_addr, cc, subject, body, attachments_json, source, ai_draft, status, attempts, ' +
          'last_error, next_attempt_at, created_at, updated_at, reply_to, reply_to_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
        [
          id, input.kind, input.thread_id || '', to, input.cc || '', input.subject || '', body, JSON.stringify(input.attachments || []),
          input.source || 'copilot', input.ai_draft || '', QUEUED, '', (now() + undoMs) / 1000, ts, ts, replyTo, input.reply_to_message_id || '',
        ],
      );
      schedule(() => {
        outbox.flush().catch(() => undefined);
      }, undoMs + 50);
      deps.onChange?.();
      return (await get(id))!;
    },

    async list(opts: { threadId?: string; includeDone?: boolean; limit?: number } = {}): Promise<OutboxItem[]> {
      let sql = 'SELECT * FROM outbox WHERE 1=1';
      const params: SqlValue[] = [];
      if (!opts.includeDone) {
        sql += ` AND status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`;
        params.push(...OPEN_STATUSES);
      }
      if (opts.threadId) {
        sql += ' AND thread_id=?';
        params.push(opts.threadId);
      }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(opts.limit ?? 50);
      const d = await db.getDb();
      const t = now();
      return (await d.getAllAsync<Row>(sql, params)).map((r) => toItem(r, t));
    },

    async counts(): Promise<{ queued: number; sending: number; failed: number; pending: number }> {
      const d = await db.getDb();
      const rows = await d.getAllAsync<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status', []);
      const out = { queued: 0, sending: 0, failed: 0, pending: 0 };
      for (const r of rows) if (r.status in out) (out as Record<string, number>)[r.status] = Number(r.n);
      out.pending = out.queued + out.sending;
      return out;
    },

    /** Cancelar: só enquanto está na fila (inclusive na janela de desfazer) ou falhou. */
    async cancel(id: string): Promise<OutboxItem> {
      const d = await db.getDb();
      const r = await d.runAsync('UPDATE outbox SET status=?, updated_at=? WHERE id=? AND status IN (?, ?)', [CANCELLED, nowIso(), id, QUEUED, FAILED]);
      if (!r.changes) {
        const cur = await get(id);
        if (!cur) throw new Error('Item não está na fila.');
        throw new Error('Esse envio já está saindo (ou já saiu) e não pode mais ser cancelado.');
      }
      deps.onChange?.();
      return (await get(id))!;
    },

    /** Pedido explícito do Leo para tentar de novo (falhou ou na fila). */
    async retry(id: string): Promise<OutboxItem> {
      const item = await get(id);
      if (!item) throw new Error('Item não está na fila.');
      if (item.status !== QUEUED && item.status !== FAILED) throw new Error('Esse envio não está aguardando.');
      // conta como tentativa já feita: a janela de desfazer não volta
      await set(id, { status: QUEUED, next_attempt_at: now() / 1000, attempts: Math.max(1, item.attempts) });
      await outbox.flush({ onlyId: id });
      return (await get(id))!;
    },

    /** Ao abrir o app: "sending" = morreu no meio. Pode ter saído: não reenvia sozinho. */
    async recoverInterrupted(): Promise<number> {
      const d = await db.getDb();
      const r = await d.runAsync('UPDATE outbox SET status=?, last_error=?, updated_at=? WHERE status=?', [
        FAILED, 'Envio interrompido (o app fechou no meio). Confira no Gmail se saiu antes de tentar de novo.', nowIso(), SENDING,
      ]);
      return r.changes;
    },

    /**
     * Manda o que já passou da janela/espera. Um flush por vez. Para no
     * primeiro erro de rede (sem conexão não adianta insistir nos outros).
     */
    async flush(opts: { onlyId?: string; force?: boolean } = {}): Promise<number> {
      if (flushing) {
        await flushing.catch(() => 0);
        if (!opts.force && !opts.onlyId) return 0;
      }
      flushing = flushUnlocked(opts);
      try {
        return await flushing;
      } finally {
        flushing = null;
      }
    },
  };
  return outbox;
}

export type Outbox = ReturnType<typeof createOutbox>;

/** Pós-envio de uma resposta (finalize_reply): tudo melhor esforço. */
export async function finalizeReply(
  item: OutboxItem,
  hooks: { markRead?(id: string): Promise<unknown>; refreshThread?(id: string): Promise<unknown>; resolveAfterSend?(id: string, origem: string): Promise<void>; recordSend(id: string, origem: string): Promise<unknown> },
): Promise<void> {
  const id = item.thread_id;
  for (const step of [() => hooks.markRead?.(id), () => hooks.refreshThread?.(id)]) {
    try {
      await step();
    } catch {
      // o e-mail já saiu
    }
  }
  const origem = item.source === 'copilot' ? 'copilot' : 'mail';
  try {
    if (item.ai_draft) await db.logReplyEdit(id, item.ai_draft, item.body, origem);
    const row = await db.getThread(id);
    await db.setThreadFields(id, { draft: '' });
    await db.saveAi(id, { chat_anchor_date: Number(row?.internal_date || 0), sent_via_app_at: Date.now() });
    await hooks.recordSend(id, origem);
    await hooks.resolveAfterSend?.(id, origem);
  } catch {
    // melhor esforço
  }
}
