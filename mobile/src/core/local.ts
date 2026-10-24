// Liga as peças do modo standalone: Google (token) → Gmail (fetch do RN) →
// sync (SQLite) → copiloto (IA do aparelho). As telas não importam isto
// direto: passam por src/data/ (fonte "local" ou "servidor").
import { createActions } from './actions';
import { createBackgroundSync } from './background';
import { ai } from './ai';
import { createAssistant } from './assistant';
import * as db from './db';
import { createCopilot, getAccount, setAccount } from './copilot';
import { createGmail, GmailError, type GmailFetch } from './gmail';
import { AuthError, getGoogleAuth } from './googleAuth';
import { secretStatus } from './secrets';
import { recordSend, setHistoryGmail } from './history';
import { createOutbox, finalizeReply } from './outbox';
import { createSummaries } from './summaries';
import { createSync, ingestThread, META as SYNC_META } from './sync';
import { createVerify } from './verify';

export const gmail = createGmail({
  fetch: ((url, init) => fetch(url, init)) as GmailFetch,
  getAccessToken: () => getGoogleAuth().getAccessToken(),
  invalidateToken: (t) => getGoogleAuth().invalidateToken(t),
});

/** Conta logada (o copiloto usa para "só em Cc", "você", etc.); sem login, a padrão. */
async function account(): Promise<string> {
  try {
    const st = await getGoogleAuth().state();
    if (st.kind === 'signed_in' && st.user.email) setAccount(st.user.email);
  } catch {
    // sem módulo nativo / sem config: fica a conta padrão
  }
  return getAccount();
}

export const sync = createSync({ gmail, me: account });

export async function hasAiKey(): Promise<boolean> {
  try {
    const st = await secretStatus();
    return st.gemini || st.openrouter;
  } catch {
    return false;
  }
}

// corpo vem do sync; se ainda não veio (thread antiga), busca a thread inteira agora
async function ensureBody(row: db.Row): Promise<string> {
  const body = String(row.body_text ?? '');
  if (body) return body;
  try {
    const raw = await gmail.getThread(String(row.id), 'full');
    await ingestThread(raw, await account());
    return String((await db.getThread(String(row.id)))?.body_text ?? '');
  } catch (e) {
    // sem conexão/sem login: sobe (o item continua na fila); outro erro: segue sem corpo
    if (e instanceof AuthError || (e instanceof GmailError && (e.status === 0 || e.status === 401))) throw e;
    return '';
  }
}

export const copilot = createCopilot({
  llm: ai,
  hasKey: hasAiKey,
  ensureBody,
});

// ── Fase 2: ações, rascunho, envio ──
setHistoryGmail(gmail);

export const assistant = createAssistant({
  llm: ai,
  hasKey: hasAiKey,
  ensureBody,
});

export const actions = createActions({ copilot, gmail, draft: (id, instruction) => assistant.draft(id, instruction) });

let notify: (() => void) | null = null;
/** A tela da fila (OutboxBanner) assina para atualizar na hora. */
export const onOutboxChange = (fn: (() => void) | null) => {
  notify = fn;
};

export const outbox = createOutbox({
  gmail,
  me: account,
  onChange: () => notify?.(),
  async afterSend(item) {
    if (item.kind === 'reply') {
      await finalizeReply(item, {
        markRead: (id) => gmail.markRead(id),
        refreshThread: async (id) => ingestThread(await gmail.getThread(id, 'full'), await account()),
        resolveAfterSend: (id, origem) => actions.resolveAfterSend(id, origem),
        recordSend: (id, origem) => recordSend(id, origem),
      });
    } else {
      await recordSend('', 'copilot', item.subject);
    }
  },
});

// "sending" de uma sessão anterior: o app fechou no meio do envio
outbox.recoverInterrupted().catch(() => undefined);

// ── Fase 3: resumos, Verificar na caixa ──
/** Nomes dos anexos da thread a partir do que o sync gravou (sem ir ao Gmail). */
async function threadFiles(threadId: string): Promise<string[]> {
  const names: string[] = [];
  for (const r of await db.listMessages(threadId)) {
    try {
      const parsed = JSON.parse(String(r.attachments_json || '{}')) as { files?: { filename?: string }[] };
      for (const f of parsed.files || []) if (f.filename) names.push(f.filename);
    } catch {
      // linha sem anexos legíveis
    }
  }
  return names;
}

export const summaries = createSummaries({ llm: ai, hasKey: hasAiKey, ensureBody, threadFiles });

async function gmailReady(): Promise<boolean> {
  try {
    return (await getGoogleAuth().state()).kind === 'signed_in';
  } catch {
    return false;
  }
}

export const verify = createVerify({
  llm: ai,
  hasKey: hasAiKey,
  // só a busca (messages.list/get metadata): o verificador nunca recebe modify/send
  gmail: { searchMessages: (q, max) => gmail.searchMessages(q, max) },
  gmailReady,
  ensureBody,
  me: getAccount,
});

// ── sync curto em segundo plano (gancho; ver core/background.ts) ──
export const runBackgroundSync = createBackgroundSync({
  signedIn: gmailReady,
  historyId: () => db.getMeta(SYNC_META.historyId),
  syncIncremental: () => sync.syncNow(),
});
