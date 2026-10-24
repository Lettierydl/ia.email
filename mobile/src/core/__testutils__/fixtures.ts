// Só para testes: SQLite em memória (node:sqlite) no lugar do expo-sqlite,
// Gmail falso (fetch fake que responde como a REST API) e fixtures
// sintéticas. Nenhum dado real, nenhuma chamada de rede.
import { DatabaseSync } from 'node:sqlite';

import type { SqlDriver, SqlValue } from '../db';
import type { GmailMessage, GmailPart, GmailThread } from '../mime';

export function nodeDriver(): SqlDriver & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    async execAsync(sql) {
      raw.exec(sql);
    },
    async runAsync(sql, params: SqlValue[]) {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, params: SqlValue[]) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async getFirstAsync<T>(sql: string, params: SqlValue[]) {
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
  };
}

export const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function textPart(text: string, mime = 'text/plain'): GmailPart {
  return { mimeType: `${mime}; charset=UTF-8`, body: { data: b64url(text), size: text.length } };
}

export function imgPart(attId: string, filename: string, opts: { cid?: string; disposition?: string; mime?: string } = {}): GmailPart {
  const mime = opts.mime ?? 'image/png';
  const disposition = opts.disposition ?? 'inline';
  const headers = [{ name: 'Content-Type', value: `${mime}; name="${filename}"` }];
  if (opts.cid) headers.push({ name: 'Content-ID', value: `<${opts.cid}>` });
  if (disposition) headers.push({ name: 'Content-Disposition', value: `${disposition}; filename="${filename}"` });
  return { mimeType: mime, filename, headers, body: { attachmentId: attId, size: 1234 } };
}

export function message(
  id: string,
  opts: {
    threadId?: string;
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    date?: string;
    internalDate?: number;
    labels?: string[];
    text?: string;
    html?: string;
    parts?: GmailPart[];
    snippet?: string;
  } = {},
): GmailMessage {
  const headers = [
    { name: 'From', value: opts.from ?? 'Ana Souza <ana@x.com>' },
    { name: 'To', value: opts.to ?? 'Leo <leo@confrapag.com.br>' },
    { name: 'Subject', value: opts.subject ?? 'Roteamento do pix estático' },
    { name: 'Date', value: opts.date ?? 'Thu, 22 Oct 2026 10:44:00 -0300' },
  ];
  if (opts.cc) headers.push({ name: 'Cc', value: opts.cc });
  const alt: GmailPart[] = [];
  if (opts.text !== undefined) alt.push(textPart(opts.text));
  if (opts.html !== undefined) alt.push(textPart(opts.html, 'text/html'));
  return {
    id,
    threadId: opts.threadId ?? 't1',
    internalDate: String(opts.internalDate ?? 1_792_000_000_000),
    labelIds: opts.labels ?? ['INBOX', 'CATEGORY_PERSONAL', 'UNREAD'],
    snippet: opts.snippet ?? (opts.text || '').slice(0, 80),
    payload: {
      mimeType: 'multipart/related',
      headers,
      parts: [{ mimeType: 'multipart/alternative', parts: alt }, ...(opts.parts ?? [])],
    },
  };
}

export function thread(id: string, msgs: GmailMessage[], historyId = '100'): GmailThread {
  return { id, historyId, messages: msgs.map((m) => ({ ...m, threadId: id })) };
}

type Handler = (url: URL, init: { method: string; headers: Record<string, string>; body?: string }) => { status: number; body?: unknown };

/** fetch fake: registra as chamadas e responde pelo handler. */
export function fakeFetch(handler: Handler) {
  const calls: { method: string; url: URL; headers: Record<string, string>; body?: string }[] = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: u, headers: init.headers, body: init.body });
    const r = handler(u, init);
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      ok: r.status < 400,
      status: r.status,
      json: async () => JSON.parse(text || '{}'),
      text: async () => text,
    };
  };
  return { fn, calls };
}

/**
 * Caixa falsa com threads em memória, servida como a REST API do Gmail:
 * profile, threads.list (q com is:unread, paginação), threads.get, labels.get,
 * history.list (com 404 se o startHistoryId for menor que `minHistoryId`).
 */
export function fakeMailbox() {
  const box = {
    threads: new Map<string, GmailThread>(),
    historyId: '100',
    minHistoryId: '0',
    history: [] as { id: string; [k: string]: unknown }[],
    pageSize: 2,
    /** existem (threads.get responde) mas não aparecem na listagem (ex.: arquivadas) */
    unlisted: new Set<string>(),
  };
  const unread = (t: GmailThread) => (t.messages || []).some((m) => (m.labelIds || []).includes('UNREAD'));
  const handler: Handler = (url) => {
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (path === '/profile') return { status: 200, body: { emailAddress: 'leo@confrapag.com.br', historyId: box.historyId } };
    if (path === '/labels/CATEGORY_PERSONAL') {
      return { status: 200, body: { id: 'CATEGORY_PERSONAL', name: 'CATEGORY_PERSONAL', threadsUnread: [...box.threads.values()].filter(unread).length } };
    }
    if (path === '/threads') {
      const q = url.searchParams.get('q') || '';
      let list = [...box.threads.values()].filter((t) => !box.unlisted.has(t.id));
      if (q.includes('is:unread')) list = list.filter(unread);
      const start = Number(url.searchParams.get('pageToken') || 0);
      const size = Math.min(box.pageSize, Number(url.searchParams.get('maxResults') || 100));
      const page = list.slice(start, start + size);
      return {
        status: 200,
        body: {
          threads: page.map((t) => ({ id: t.id, historyId: t.historyId })),
          nextPageToken: start + size < list.length ? String(start + size) : undefined,
        },
      };
    }
    const tm = /^\/threads\/([^/]+)$/.exec(path);
    if (tm) {
      const t = box.threads.get(decodeURIComponent(tm[1]));
      return t ? { status: 200, body: t } : { status: 404, body: { error: { message: 'Not Found' } } };
    }
    if (path === '/history') {
      const start = url.searchParams.get('startHistoryId') || '0';
      if (Number(start) < Number(box.minHistoryId)) return { status: 404, body: { error: { message: 'Requested entity was not found.' } } };
      const items = box.history.filter((h) => Number(h.id) > Number(start));
      const from = Number(url.searchParams.get('pageToken') || 0);
      const page = items.slice(from, from + box.pageSize);
      return {
        status: 200,
        body: { history: page, historyId: box.historyId, nextPageToken: from + box.pageSize < items.length ? String(from + box.pageSize) : undefined },
      };
    }
    return { status: 404, body: { error: { message: 'rota falsa desconhecida' } } };
  };
  const f = fakeFetch(handler);
  return { box, fetch: f.fn, calls: f.calls };
}
