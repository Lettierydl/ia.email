// Cliente REST da Gmail API via fetch (injetável), porte do lado de leitura de
// app/gmail_client.py: listar/ler threads e mensagens, rótulos, anexos,
// history (sync incremental), busca só leitura (Verificar na caixa), modify
// (rótulos, lido, arquivar) e messages.send. O envio só é chamado pela outbox (core/outbox.ts), depois da
// confirmação explícita do Leo; nada aqui envia sozinho. Sem rascunhos no Gmail.
//
// O token vem de quem cria o cliente (googleAuth.getAccessToken); num 401 o
// cliente descarta o token e tenta uma vez de novo. Token nunca entra em
// mensagem de erro.
import { headerMap, type GmailMessage, type GmailThread } from './mime';

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type GmailFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GmailDeps {
  fetch: GmailFetch;
  getAccessToken(): Promise<string>;
  invalidateToken?(token: string): Promise<void>;
  timeoutMs?: number;
}

export class GmailError extends Error {
  status: number;
  /** a conexão caiu/estourou o prazo DEPOIS de mandar o pedido: pode ter chegado */
  ambiguous: boolean;
  constructor(message: string, status = 0, ambiguous = false) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

export interface ThreadRef {
  id: string;
  historyId: string;
  snippet?: string;
}

export interface ThreadListPage {
  threads: ThreadRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface ListOpts {
  q?: string;
  labelIds?: string[];
  pageToken?: string;
  maxResults?: number;
  includeSpamTrash?: boolean;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messagesUnread?: number;
  threadsUnread?: number;
}

/** Resultado da busca (search_messages do Python): só cabeçalhos e trecho. */
export interface SearchHit {
  message_id: string;
  thread_id: string;
  assunto: string;
  de: string;
  para: string;
  cc: string;
  data: string;
  internal_date: number;
  snippet: string;
  labels: string[];
}

export interface HistoryRecord {
  id: string;
  messages?: { id: string; threadId: string }[];
  messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
  messagesDeleted?: { message: { id: string; threadId: string } }[];
  labelsAdded?: { message: { id: string; threadId: string }; labelIds: string[] }[];
  labelsRemoved?: { message: { id: string; threadId: string }; labelIds: string[] }[];
}

export interface HistoryPage {
  history: HistoryRecord[];
  historyId: string;
  nextPageToken?: string;
}

const enc = encodeURIComponent;

function query(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue;
    if (Array.isArray(v)) for (const x of v) parts.push(`${enc(k)}=${enc(x)}`);
    else parts.push(`${enc(k)}=${enc(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Mensagem curta para a tela (sem token, sem URL). */
function describe(status: number, reason: string): string {
  if (status === 401) return 'O acesso ao Gmail expirou: entre de novo em Ajustes → Conta Google.';
  if (status === 403) return `O Gmail recusou a chamada (sem permissão ou cota): ${reason}`.trim();
  if (status === 404) return 'Não encontrado no Gmail.';
  if (status === 429) return 'Gmail pediu para esperar (limite de chamadas). Tente de novo em instantes.';
  return `Erro do Gmail (HTTP ${status})${reason ? `: ${reason}` : ''}.`;
}

export function createGmail(deps: GmailDeps) {
  const timeoutMs = deps.timeoutMs ?? 30_000;

  async function call<T>(method: string, path: string, body?: object, retried = false): Promise<T> {
    const token = await deps.getAccessToken();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Awaited<ReturnType<GmailFetch>>;
    try {
      res = await deps.fetch(`${GMAIL_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch {
      // prazo estourado = o pedido pode ter chegado ao Gmail (no envio, isso importa)
      throw new GmailError(ctrl.signal.aborted ? 'A conexão com o Gmail estourou o prazo.' : 'Sem conexão com o Gmail.', 0, ctrl.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && !retried) {
      await deps.invalidateToken?.(token);
      return call<T>(method, path, body, true);
    }
    if (res.status >= 400) {
      let reason = '';
      try {
        const raw = await res.text();
        try {
          const err = (JSON.parse(raw) as { error?: { message?: string } })?.error;
          reason = String(err?.message ?? '');
        } catch {
          reason = raw.slice(0, 160);
        }
      } catch {
        reason = '';
      }
      reason = reason.split(token).join('***').slice(0, 200);
      throw new GmailError(describe(res.status, reason), res.status);
    }
    if (res.status === 204) return {} as T;
    return (await res.json().catch(() => ({}))) as T;
  }

  const gmail = {
    /** threads.list — uma página. */
    async listThreads(opts: ListOpts = {}): Promise<ThreadListPage> {
      const r = await call<{ threads?: { id: string; historyId?: string; snippet?: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(
        'GET',
        `/threads${query({
          q: opts.q,
          labelIds: opts.labelIds,
          pageToken: opts.pageToken,
          maxResults: Math.min(500, opts.maxResults ?? 100),
          includeSpamTrash: opts.includeSpamTrash,
        })}`,
      );
      return {
        threads: (r.threads || []).map((t) => ({ id: t.id, historyId: String(t.historyId || ''), snippet: t.snippet })),
        nextPageToken: r.nextPageToken || undefined,
        resultSizeEstimate: r.resultSizeEstimate,
      };
    },

    /** Pagina threads.list até `max` itens (o _list_threads do Python). */
    async listAllThreads(opts: Omit<ListOpts, 'pageToken' | 'maxResults'>, max: number): Promise<ThreadRef[]> {
      const out: ThreadRef[] = [];
      let pageToken: string | undefined;
      while (out.length < max) {
        const page = await gmail.listThreads({ ...opts, pageToken, maxResults: Math.min(100, max - out.length) });
        out.push(...page.threads);
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      return out.slice(0, max);
    },

    /** threads.get (format=full por padrão). */
    getThread(id: string, format: 'full' | 'metadata' | 'minimal' = 'full'): Promise<GmailThread> {
      return call<GmailThread>('GET', `/threads/${enc(id)}${query({ format })}`);
    },

    /** threads.get format=metadata só com os cabeçalhos pedidos (envio/destinatários). */
    getThreadMetadata(id: string, headers: string[]): Promise<GmailThread> {
      return call<GmailThread>('GET', `/threads/${enc(id)}${query({ format: 'metadata', metadataHeaders: headers })}`);
    },

    getMessage(id: string, format: 'full' | 'metadata' | 'minimal' | 'raw' = 'full'): Promise<GmailMessage> {
      return call<GmailMessage>('GET', `/messages/${enc(id)}${query({ format })}`);
    },

    async listLabels(): Promise<GmailLabel[]> {
      return (await call<{ labels?: GmailLabel[] }>('GET', '/labels')).labels || [];
    },

    getLabel(id: string): Promise<GmailLabel> {
      return call<GmailLabel>('GET', `/labels/${enc(id)}`);
    },

    /** users.getProfile — o historyId atual da caixa (ponto de partida do sync incremental). */
    getProfile(): Promise<{ emailAddress: string; historyId: string; messagesTotal?: number; threadsTotal?: number }> {
      return call('GET', '/profile');
    },

    /** threads.modify (ações: resolver/desfazer). O sync não chama. */
    modifyThread(id: string, change: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<GmailThread> {
      return call<GmailThread>('POST', `/threads/${enc(id)}/modify`, {
        addLabelIds: change.addLabelIds || [],
        removeLabelIds: change.removeLabelIds || [],
      });
    },

    markRead: (id: string) => gmail.modifyThread(id, { removeLabelIds: ['UNREAD'] }),
    markUnread: (id: string) => gmail.modifyThread(id, { addLabelIds: ['UNREAD'] }),
    archive: (id: string) => gmail.modifyThread(id, { removeLabelIds: ['INBOX'] }),

    /**
     * messages.send com o MIME já montado (base64url). Só a outbox chama, e só
     * com item confirmado pelo Leo. threadId = resposta na mesma conversa.
     */
    sendRawMessage(raw: string, threadId?: string): Promise<{ id: string; threadId: string; labelIds?: string[] }> {
      return call('POST', '/messages/send', threadId ? { raw, threadId } : { raw });
    },

    /**
     * Busca na caixa (Verificar na caixa). SÓ LEITURA: messages.list com q +
     * messages.get format=metadata — porte de gmail_client.search_messages.
     * A query já vem saneada (verify.sanitizeQuery).
     */
    async searchMessages(q: string, maxResults = 5): Promise<SearchHit[]> {
      const max = Math.max(1, Math.min(Math.trunc(maxResults), 10));
      const listed = await call<{ messages?: { id: string; threadId?: string }[] }>('GET', `/messages${query({ q, maxResults: max })}`);
      const out: SearchHit[] = [];
      for (const item of (listed.messages || []).slice(0, maxResults)) {
        const raw = await call<GmailMessage>(
          'GET',
          `/messages/${enc(item.id)}${query({ format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] })}`,
        );
        const h = headerMap(raw.payload);
        out.push({
          message_id: raw.id || item.id,
          thread_id: raw.threadId || item.threadId || '',
          assunto: h.subject || '',
          de: h.from || '',
          para: h.to || '',
          cc: h.cc || '',
          data: h.date || '',
          internal_date: Number(raw.internalDate || 0),
          snippet: raw.snippet || '',
          labels: [...(raw.labelIds || [])],
        });
      }
      return out;
    },

    /** attachments.get — devolve o base64url do Gmail. */
    async getAttachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }> {
      const r = await call<{ data?: string; size?: number }>('GET', `/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`);
      return { data: r.data || '', size: r.size || 0 };
    },

    /** history.list — uma página. 404 = startHistoryId velho demais (o sync cai na listagem completa). */
    async listHistory(startHistoryId: string, opts: { pageToken?: string; labelId?: string; historyTypes?: string[]; maxResults?: number } = {}): Promise<HistoryPage> {
      const r = await call<{ history?: HistoryRecord[]; historyId?: string; nextPageToken?: string }>(
        'GET',
        `/history${query({
          startHistoryId,
          pageToken: opts.pageToken,
          labelId: opts.labelId,
          historyTypes: opts.historyTypes,
          maxResults: opts.maxResults ?? 500,
        })}`,
      );
      return { history: r.history || [], historyId: String(r.historyId || ''), nextPageToken: r.nextPageToken || undefined };
    },

    /** Todas as páginas do history a partir de startHistoryId. */
    async listHistoryAll(startHistoryId: string, opts: { labelId?: string; historyTypes?: string[] } = {}): Promise<{ history: HistoryRecord[]; historyId: string }> {
      const history: HistoryRecord[] = [];
      let pageToken: string | undefined;
      let historyId = '';
      for (let guard = 0; guard < 50; guard++) {
        const page = await gmail.listHistory(startHistoryId, { ...opts, pageToken });
        history.push(...page.history);
        historyId = page.historyId || historyId;
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      return { history, historyId };
    },
  };
  return gmail;
}

export type Gmail = ReturnType<typeof createGmail>;

/** Threads tocadas por um conjunto de registros do history. */
export function threadIdsFromHistory(history: HistoryRecord[]): string[] {
  const seen = new Set<string>();
  const add = (m?: { threadId?: string }) => {
    if (m?.threadId) seen.add(m.threadId);
  };
  for (const h of history) {
    for (const m of h.messages || []) add(m);
    for (const x of h.messagesAdded || []) add(x.message);
    for (const x of h.messagesDeleted || []) add(x.message);
    for (const x of h.labelsAdded || []) add(x.message);
    for (const x of h.labelsRemoved || []) add(x.message);
  }
  return [...seen];
}
