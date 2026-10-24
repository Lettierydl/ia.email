// Banco local do app standalone (expo-sqlite). Mesmo esquema de app/store.py
// (+ outbox de app/outbox.py): os CREATE TABLE são cópia; as colunas que lá
// entram por ALTER TABLE (bancos antigos do Mac) aqui já nascem no CREATE, na
// mesma ordem. Versão do esquema em PRAGMA user_version; cada migração roda
// uma vez, dentro de transação.
import * as SQLite from 'expo-sqlite';

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/** O pedaço do SQLiteDatabase do expo-sqlite que o núcleo usa (os testes passam outro). */
export interface SqlDriver {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SqlValue[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(source: string, params: SqlValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params: SqlValue[]): Promise<T | null>;
}

export const DB_NAME = 'ia_email.db';

// ── Migrações ──
// Nunca editar uma migração que já saiu: acrescentar outra no fim.
export const MIGRATIONS: string[] = [
  // v1 — esquema de app/store.py (init) + app/outbox.py (_ensure)
  `
  CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      subject TEXT,
      from_email TEXT,
      from_name TEXT,
      snippet TEXT,
      internal_date INTEGER,
      is_unread INTEGER,
      last_from_me INTEGER,
      is_automatic INTEGER,
      is_marketing INTEGER,
      needs_action_hint INTEGER,
      awaiting_reply INTEGER,
      conferido INTEGER,
      hidden INTEGER,
      hide_as_replied INTEGER,
      last_from_header TEXT,
      labels_json TEXT,
      updated_at TEXT,
      summary TEXT,
      draft TEXT,
      body_text TEXT,
      chat_json TEXT,
      fyi_only INTEGER,
      capture_note TEXT,
      capture_status TEXT,
      chat_anchor_date INTEGER,
      sent_via_app_at INTEGER,
      to_header TEXT,
      cc_header TEXT,
      history_id TEXT
  );
  CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
  );
  CREATE TABLE IF NOT EXISTS blocked_senders (
      email TEXT PRIMARY KEY,
      created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS avatar_cache (
      email TEXT PRIMARY KEY,
      photo_url TEXT,
      resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS aliases (
      alias TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS autopilot_decisions (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      action TEXT,
      confidence REAL,
      reasoning TEXT,
      draft_text TEXT,
      cc TEXT,
      sensitivity_level TEXT,
      decided_at TEXT,
      scheduled_send_at TEXT,
      status TEXT,
      sent_at TEXT,
      error TEXT,
      internal_date_snapshot INTEGER,
      evidence_json TEXT
  );
  CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT,
      thread_id TEXT,
      at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_events_at ON usage_events(at);
  CREATE TABLE IF NOT EXISTS copilot_items (
      thread_id TEXT PRIMARY KEY,
      papel TEXT,
      o_que_aconteceu TEXT,
      opcoes_json TEXT,
      urgencia TEXT,
      bola_json TEXT,
      depende_de_outros INTEGER,
      sem_resposta_desde INTEGER,
      prazo TEXT,
      quem_pediu_json TEXT,
      tarefas_json TEXT,
      needs_context INTEGER,
      o_que_falta TEXT,
      pergunta TEXT,
      status TEXT,
      source TEXT,
      delegado_json TEXT,
      internal_date_snapshot INTEGER,
      analyzed_at TEXT,
      updated_at TEXT,
      msg_count_snapshot INTEGER
  );
  CREATE TABLE IF NOT EXISTS copilot_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      action TEXT,
      payload_json TEXT,
      at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_copilot_actions_at ON copilot_actions(at);
  CREATE TABLE IF NOT EXISTS reply_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      ai_draft TEXT,
      sent_text TEXT,
      edited INTEGER,
      source TEXT,
      created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reply_edits_thread ON reply_edits(thread_id);
  CREATE TABLE IF NOT EXISTS learned_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT,
      thread_id TEXT,
      subject TEXT,
      subject_key TEXT,
      person_email TEXT,
      text TEXT,
      created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS copilot_resumos (
      thread_id TEXT PRIMARY KEY,
      resumo_json TEXT,
      internal_date_snapshot INTEGER,
      msg_count_snapshot INTEGER,
      gerado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS copilot_msg_resumos (
      thread_id TEXT NOT NULL,
      msg_hash TEXT NOT NULL,
      modo TEXT NOT NULL,
      resumo_json TEXT,
      gerado_em TEXT,
      PRIMARY KEY (thread_id, msg_hash, modo)
  );
  CREATE TABLE IF NOT EXISTS copilot_verificacoes (
      thread_id TEXT PRIMARY KEY,
      resultado_json TEXT,
      internal_date_snapshot INTEGER,
      msg_count_snapshot INTEGER,
      gerado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      thread_id TEXT,
      to_addr TEXT,
      cc TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      attachments_json TEXT,
      source TEXT,
      ai_draft TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at REAL,
      result_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      sent_at TEXT,
      reply_to TEXT,
      reply_to_message_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
  CREATE TABLE IF NOT EXISTS historico_acoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      thread_id TEXT,
      thread_ids_json TEXT,
      assunto TEXT,
      acao TEXT NOT NULL,
      detalhe TEXT,
      origem TEXT,
      estado_anterior_json TEXT,
      estado_novo_json TEXT,
      gmail_json TEXT,
      desfazivel INTEGER NOT NULL DEFAULT 1,
      motivo TEXT,
      desfeito_em TEXT,
      refeito_em TEXT,
      grupo_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_historico_thread ON historico_acoes(thread_id);
  `,
  // v2 — só no app: uma linha por mensagem do Gmail (no Mac o corpo da thread
  // inteira fica em threads.body_text; aqui o sync guarda mensagem a mensagem).
  `
  CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      internal_date INTEGER,
      from_email TEXT,
      from_name TEXT,
      to_header TEXT,
      cc_header TEXT,
      subject TEXT,
      snippet TEXT,
      body_text TEXT,
      body_html TEXT,
      labels_json TEXT,
      attachments_json TEXT,
      updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, internal_date);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export async function migrate(db: SqlDriver): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version', []);
  let version = Number(row?.user_version ?? 0);
  while (version < MIGRATIONS.length) {
    const next = version + 1;
    // PRAGMA não aceita parâmetro; `next` é inteiro nosso.
    await db.execAsync(`BEGIN;\n${MIGRATIONS[version]}\nPRAGMA user_version = ${next};\nCOMMIT;`).catch(async (e) => {
      await db.execAsync('ROLLBACK;').catch(() => undefined);
      throw e;
    });
    version = next;
  }
  return version;
}

let opened: Promise<SqlDriver> | null = null;

/** Banco do app (abre e migra uma vez). Testes chamam attachDb() com outro driver. */
export function getDb(): Promise<SqlDriver> {
  if (!opened) {
    opened = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await migrate(db as unknown as SqlDriver);
      return db as unknown as SqlDriver;
    })();
    opened.catch(() => {
      opened = null;
    });
  }
  return opened;
}

export async function attachDb(db: SqlDriver | null): Promise<void> {
  if (db) await migrate(db);
  opened = db ? Promise.resolve(db) : null;
}

const nowIso = () => new Date().toISOString();

// ── meta / ajustes ──
export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]);
}

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string | null }>('SELECT value FROM meta WHERE key=?', [key]);
  return row ? row.value : null;
}

// Só o que o núcleo do app usa por enquanto (store.DEFAULT_SETTINGS tem mais,
// ligados a RAG/piloto automático do Mac).
export const DEFAULT_SETTINGS = {
  // Cadeia de modelos em ordem ("provedor:modelo"); vazio = cadeia padrão.
  llm_models: [] as string[],
  // Deixar a IA "pensar" antes de responder (mais lento). Padrão: desligado.
  llm_reasoning: false,
};
export type Settings = typeof DEFAULT_SETTINGS;

export async function getSettings(): Promise<Settings> {
  const raw = await getMeta('settings_json');
  const merged: Settings = { ...DEFAULT_SETTINGS, llm_models: [] };
  if (!raw) return merged;
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (k in data) (merged as Record<string, unknown>)[k] = data[k];
      }
    }
  } catch {
    // JSON quebrado: volta ao padrão, como o store.py
  }
  return merged;
}

export async function saveSettings(fields: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  for (const k of Object.keys(fields) as (keyof Settings)[]) {
    if (k in DEFAULT_SETTINGS) (current as Record<string, unknown>)[k] = fields[k];
  }
  await setMeta('settings_json', JSON.stringify(current));
  return current;
}

const usageKey = () => `llm_tokens_${new Date().toISOString().slice(0, 10)}`;

export async function addLlmUsage(tokens: number): Promise<void> {
  if (!(tokens > 0)) return;
  const key = usageKey();
  const current = Number((await getMeta(key)) || 0);
  await setMeta(key, String(current + tokens));
}

export async function llmUsageToday(): Promise<number> {
  return Number((await getMeta(usageKey())) || 0);
}

// ── threads ──
const THREAD_FIELDS = [
  'id', 'subject', 'from_email', 'from_name', 'snippet', 'internal_date', 'is_unread', 'last_from_me',
  'is_automatic', 'is_marketing', 'needs_action_hint', 'awaiting_reply', 'conferido', 'hidden',
  'hide_as_replied', 'last_from_header', 'labels_json', 'to_header', 'cc_header', 'history_id', 'updated_at',
] as const;

export type ThreadInput = Partial<Record<Exclude<(typeof THREAD_FIELDS)[number], 'labels_json'>, SqlValue>> & { id: string; labels_json?: SqlValue | string[] };

export async function upsertThread(input: ThreadInput): Promise<void> {
  const row: Record<string, unknown> = { hidden: 0, ...input, updated_at: nowIso() };
  if (Array.isArray(row.labels_json)) row.labels_json = JSON.stringify(row.labels_json);
  const assignments =
    THREAD_FIELDS.filter((f) => f !== 'id' && f !== 'hidden').map((f) => `${f}=excluded.${f}`).join(', ') +
    // mensagem nova (internal_date subiu): o corpo em cache ficou velho
    ', body_text = CASE WHEN COALESCE(excluded.internal_date, 0) > COALESCE(threads.internal_date, 0) ' +
    'THEN NULL ELSE threads.body_text END';
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO threads (${THREAD_FIELDS.join(', ')}) VALUES (${THREAD_FIELDS.map(() => '?').join(', ')}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${assignments}`,
    THREAD_FIELDS.map((f) => (row[f] ?? null) as SqlValue),
  );
}

export async function getThread(id: string): Promise<Row | null> {
  const db = await getDb();
  return db.getFirstAsync<Row>('SELECT * FROM threads WHERE id=?', [id]);
}

export async function listVisible(includeHidden = false): Promise<Row[]> {
  const db = await getDb();
  const where = includeHidden ? '' : ' WHERE hidden=0 AND hide_as_replied=0';
  return db.getAllAsync<Row>(`SELECT * FROM threads${where} ORDER BY internal_date DESC`, []);
}

const AI_FIELDS = new Set([
  'summary', 'draft', 'body_text', 'needs_action_hint', 'chat_json', 'fyi_only', 'capture_note',
  'capture_status', 'chat_anchor_date', 'is_marketing', 'sent_via_app_at',
]);

export async function saveAi(threadId: string, fields: Record<string, SqlValue | undefined>): Promise<void> {
  const keys = Object.keys(fields).filter((k) => AI_FIELDS.has(k) && fields[k] != null);
  if (!keys.length) return;
  const db = await getDb();
  await db.runAsync(`UPDATE threads SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, [
    ...keys.map((k) => fields[k] as SqlValue),
    threadId,
  ]);
}

// ── mensagens (v2) ──
const MESSAGE_FIELDS = [
  'id', 'thread_id', 'internal_date', 'from_email', 'from_name', 'to_header', 'cc_header', 'subject',
  'snippet', 'body_text', 'body_html', 'labels_json', 'attachments_json', 'updated_at',
] as const;

export type MessageInput = Partial<Record<(typeof MESSAGE_FIELDS)[number], SqlValue>> & { id: string; thread_id: string };

export async function upsertMessage(input: MessageInput): Promise<void> {
  const row: Record<string, unknown> = { ...input, updated_at: nowIso() };
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO messages (${MESSAGE_FIELDS.join(', ')}) VALUES (${MESSAGE_FIELDS.map(() => '?').join(', ')}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${MESSAGE_FIELDS.filter((f) => f !== 'id').map((f) => `${f}=excluded.${f}`).join(', ')}`,
    MESSAGE_FIELDS.map((f) => (row[f] ?? null) as SqlValue),
  );
}

export async function listMessages(threadId: string): Promise<Row[]> {
  const db = await getDb();
  return db.getAllAsync<Row>('SELECT * FROM messages WHERE thread_id=? ORDER BY internal_date ASC, id ASC', [threadId]);
}

// ── copiloto ──
export const COPILOT_COLS = [
  'papel', 'o_que_aconteceu', 'opcoes_json', 'urgencia', 'bola_json', 'depende_de_outros',
  'sem_resposta_desde', 'prazo', 'quem_pediu_json', 'tarefas_json', 'needs_context', 'o_que_falta',
  'pergunta', 'status', 'source', 'delegado_json', 'internal_date_snapshot', 'analyzed_at', 'msg_count_snapshot',
] as const;

/** Upsert parcial: só as colunas passadas mudam (status/delegação não somem quando a IA relê). */
export async function saveCopilotItem(threadId: string, fields: Partial<Record<(typeof COPILOT_COLS)[number], SqlValue>>): Promise<void> {
  const allowed = new Set<string>(COPILOT_COLS);
  const data: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(fields)) if (allowed.has(k) && v !== undefined) data[k] = v;
  data.updated_at = nowIso();
  const cols = ['thread_id', ...Object.keys(data)];
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO copilot_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
      `ON CONFLICT(thread_id) DO UPDATE SET ${Object.keys(data).map((c) => `${c}=excluded.${c}`).join(', ')}`,
    [threadId, ...Object.values(data)],
  );
}

export async function getCopilotItem(threadId: string): Promise<Row | null> {
  const db = await getDb();
  return db.getFirstAsync<Row>('SELECT * FROM copilot_items WHERE thread_id=?', [threadId]);
}

export async function listCopilotItems(): Promise<Record<string, Row>> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>('SELECT * FROM copilot_items', []);
  return Object.fromEntries(rows.map((r) => [String(r.thread_id), r]));
}

export async function listCopilotActions(threadId: string, limit = 20): Promise<Row[]> {
  const db = await getDb();
  return db.getAllAsync<Row>('SELECT * FROM copilot_actions WHERE thread_id=? ORDER BY at DESC, id DESC LIMIT ?', [threadId, limit]);
}

/** Threads em que o Leo já agiu pelo copiloto (a ação dele também classifica). */
export async function copilotActedThreadIds(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ thread_id: string }>('SELECT DISTINCT thread_id FROM copilot_actions', []);
  return new Set(rows.map((r) => String(r.thread_id)));
}

/** O que o Leo já fez com outros e-mails dessa pessoa (store.copilot_actions_for_sender). */
export async function copilotActionsForSender(email: string, excludeThreadId: string, limit = 5): Promise<Row[]> {
  const e = (email || '').trim().toLowerCase();
  if (!e) return [];
  const db = await getDb();
  return db.getAllAsync<Row>(
    'SELECT a.*, t.subject FROM copilot_actions a JOIN threads t ON t.id = a.thread_id ' +
      "WHERE t.from_email=? AND a.thread_id != ? AND a.action IN ('assumir','delegar','cobrar','resolver','aplicar') " +
      'ORDER BY a.at DESC LIMIT ?',
    [e, excludeThreadId, limit],
  );
}

export async function listLearnedNotes(): Promise<Row[]> {
  const db = await getDb();
  return db.getAllAsync<Row>('SELECT * FROM learned_notes ORDER BY id DESC', []);
}

export async function addLearnedNote(n: { scope: string; text: string; thread_id?: string; subject?: string; subject_key?: string; person_email?: string }): Promise<Row> {
  const db = await getDb();
  const r = await db.runAsync(
    'INSERT INTO learned_notes(scope, thread_id, subject, subject_key, person_email, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [n.scope, n.thread_id ?? '', n.subject ?? '', n.subject_key ?? '', n.person_email ?? '', n.text, nowIso()],
  );
  return (await db.getFirstAsync<Row>('SELECT * FROM learned_notes WHERE id=?', [r.lastInsertRowId]))!;
}

export async function deleteLearnedNote(id: number): Promise<boolean> {
  const db = await getDb();
  return (await db.runAsync('DELETE FROM learned_notes WHERE id=?', [id])).changes > 0;
}

// ── caches da IA sob demanda (resumo detalhado, resumo por mensagem, Verificar) ──
export async function saveCopilotResumo(threadId: string, resumoJson: string, internalDate: number, msgCount: number): Promise<string> {
  const at = nowIso();
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO copilot_resumos (thread_id, resumo_json, internal_date_snapshot, msg_count_snapshot, gerado_em) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(thread_id) DO UPDATE SET resumo_json=excluded.resumo_json, internal_date_snapshot=excluded.internal_date_snapshot, ' +
      'msg_count_snapshot=excluded.msg_count_snapshot, gerado_em=excluded.gerado_em',
    [threadId, resumoJson, internalDate, msgCount, at],
  );
  return at;
}

export async function getCopilotResumo(threadId: string): Promise<Row | null> {
  const db = await getDb();
  return db.getFirstAsync<Row>('SELECT * FROM copilot_resumos WHERE thread_id=?', [threadId]);
}

export async function saveCopilotMsgResumo(threadId: string, msgHash: string, modo: string, resumoJson: string): Promise<string> {
  const at = nowIso();
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO copilot_msg_resumos (thread_id, msg_hash, modo, resumo_json, gerado_em) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(thread_id, msg_hash, modo) DO UPDATE SET resumo_json=excluded.resumo_json, gerado_em=excluded.gerado_em',
    [threadId, msgHash, modo, resumoJson, at],
  );
  return at;
}

export async function getCopilotMsgResumo(threadId: string, msgHash: string, modo: string): Promise<Row | null> {
  const db = await getDb();
  return db.getFirstAsync<Row>('SELECT * FROM copilot_msg_resumos WHERE thread_id=? AND msg_hash=? AND modo=?', [threadId, msgHash, modo]);
}

export async function saveCopilotVerificacao(threadId: string, resultadoJson: string, internalDate: number, msgCount: number): Promise<string> {
  const at = nowIso();
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO copilot_verificacoes (thread_id, resultado_json, internal_date_snapshot, msg_count_snapshot, gerado_em) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(thread_id) DO UPDATE SET resultado_json=excluded.resultado_json, internal_date_snapshot=excluded.internal_date_snapshot, ' +
      'msg_count_snapshot=excluded.msg_count_snapshot, gerado_em=excluded.gerado_em',
    [threadId, resultadoJson, internalDate, msgCount, at],
  );
  return at;
}

export async function getCopilotVerificacao(threadId: string): Promise<Row | null> {
  const db = await getDb();
  return db.getFirstAsync<Row>('SELECT * FROM copilot_verificacoes WHERE thread_id=?', [threadId]);
}

export async function isBlockedSender(email: string): Promise<boolean> {
  const e = (email || '').trim().toLowerCase();
  if (!e) return false;
  const db = await getDb();
  return !!(await db.getFirstAsync('SELECT 1 AS x FROM blocked_senders WHERE email=?', [e]));
}

/** {id: {history_id, is_unread, visible}} — o que o sync compara com a lista do Gmail. */
export async function threadSyncIndex(): Promise<Record<string, { history_id: string; is_unread: boolean; visible: boolean }>> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>('SELECT id, history_id, is_unread, hidden, hide_as_replied FROM threads', []);
  return Object.fromEntries(
    rows.map((r) => [
      String(r.id),
      { history_id: String(r.history_id ?? ''), is_unread: !!r.is_unread, visible: !r.hidden && !r.hide_as_replied },
    ]),
  );
}

/** Thread que sumiu do Gmail (apagada): sai da lista sem perder o histórico local. */
export async function hideThread(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE threads SET hidden=1 WHERE id=?', [id]);
}

export async function deleteMessagesNotIn(threadId: string, keep: string[]): Promise<void> {
  const db = await getDb();
  const marks = keep.map(() => '?').join(', ');
  await db.runAsync(
    `DELETE FROM messages WHERE thread_id=?${keep.length ? ` AND id NOT IN (${marks})` : ''}`,
    [threadId, ...keep],
  );
}

// ── Fase 2: ações, histórico, apelidos (store.py) ──

/** store.set_thread_fields: desfazer/refazer volta campos de estado, inclusive vazio. */
export async function setThreadFields(threadId: string, fields: Record<string, SqlValue>): Promise<void> {
  const allowed = new Set(['is_unread', 'hidden', 'is_marketing', 'draft', 'chat_json']);
  const keys = Object.keys(fields).filter((k) => allowed.has(k));
  if (!keys.length) return;
  const db = await getDb();
  await db.runAsync(`UPDATE threads SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, [...keys.map((k) => fields[k]), threadId]);
}

export async function markLocalRead(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await getDb();
  await db.runAsync(`UPDATE threads SET is_unread=0 WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
}

/** Rótulos locais da thread depois de um modify no Gmail (o próximo sync confirma). */
export async function changeThreadLabels(threadId: string, add: string[], remove: string[]): Promise<void> {
  const row = await getThread(threadId);
  if (!row) return;
  let labels: string[] = [];
  try {
    const v = JSON.parse(String(row.labels_json || '[]'));
    if (Array.isArray(v)) labels = v.map(String);
  } catch {
    labels = [];
  }
  const out = labels.filter((l) => !remove.includes(l));
  for (const l of add) if (!out.includes(l)) out.push(l);
  const db = await getDb();
  await db.runAsync('UPDATE threads SET labels_json=? WHERE id=?', [JSON.stringify(out), threadId]);
}

export async function logCopilotAction(threadId: string, action: string, payload: Record<string, unknown> = {}): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT INTO copilot_actions(thread_id, action, payload_json, at) VALUES (?, ?, ?, ?)', [
    threadId, action, JSON.stringify(payload), nowIso(),
  ]);
}

export async function logReplyEdit(threadId: string, aiDraft: string, sentText: string, source = 'mail'): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync('INSERT INTO reply_edits(thread_id, ai_draft, sent_text, edited, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      threadId, aiDraft, sentText, Number(aiDraft.trim() !== sentText.trim()), source, nowIso(),
    ]);
  } catch {
    // como no Python: nunca atrapalha o envio (que já saiu)
  }
}

export async function listAliases(): Promise<{ alias: string; name: string; email: string }[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>('SELECT alias, name, email FROM aliases ORDER BY alias', []);
  return rows.map((r) => ({ alias: String(r.alias ?? ''), name: String(r.name ?? ''), email: String(r.email ?? '') }));
}

export async function saveAlias(alias: string, name: string, email: string): Promise<void> {
  const a = (alias || '').trim().toLowerCase();
  if (!a) return;
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO aliases(alias, name, email, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(alias) DO UPDATE SET name=excluded.name, email=excluded.email',
    [a, (name || '').trim(), (email || '').trim().toLowerCase(), nowIso()],
  );
}

/** store.search_senders: remetentes já vistos que batem com o texto. */
export async function searchSenders(query: string, limit = 6): Promise<{ name: string; email: string }[]> {
  const needle = `%${(query || '').trim()}%`;
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT from_name, from_email, MAX(internal_date) AS last_seen, COUNT(*) AS n FROM threads
     WHERE (from_name LIKE ? OR from_email LIKE ?) AND from_email != '' GROUP BY from_email
     ORDER BY n DESC, last_seen DESC LIMIT ?`,
    [needle, needle, limit],
  );
  return rows.map((r) => ({ name: String(r.from_name ?? ''), email: String(r.from_email ?? '') }));
}

// histórico de ações (regras em core/history.ts)
export interface HistRow {
  id: number;
  at: string;
  thread_id: string;
  thread_ids: string[];
  assunto: string;
  acao: string;
  detalhe: string;
  origem: string;
  estado_anterior: Record<string, Record<string, unknown>>;
  estado_novo: Record<string, Record<string, unknown>>;
  /** app: operações de rótulo feitas no Gmail pela ação ({thread_id, add, remove}) */
  gmail: { thread_id: string; add: string[]; remove: string[] }[];
  desfazivel: boolean;
  motivo: string;
  desfeito_em: string | null;
  refeito_em: string | null;
  grupo_id: string | null;
}

function histRow(r: Row): HistRow {
  const j = <T>(v: SqlValue, d: T): T => {
    try {
      return (JSON.parse(String(v ?? 'null')) as T) || d;
    } catch {
      return d;
    }
  };
  return {
    id: Number(r.id), at: String(r.at ?? ''), thread_id: String(r.thread_id ?? ''),
    thread_ids: j<string[]>(r.thread_ids_json, []), assunto: String(r.assunto ?? ''), acao: String(r.acao ?? ''),
    detalhe: String(r.detalhe ?? ''), origem: String(r.origem ?? ''),
    estado_anterior: j(r.estado_anterior_json, {}), estado_novo: j(r.estado_novo_json, {}),
    gmail: j(r.gmail_json, []), desfazivel: !!r.desfazivel, motivo: String(r.motivo ?? ''),
    desfeito_em: r.desfeito_em == null ? null : String(r.desfeito_em), refeito_em: r.refeito_em == null ? null : String(r.refeito_em),
    grupo_id: r.grupo_id == null ? null : String(r.grupo_id),
  };
}

export async function addHistorico(e: {
  acao: string; thread_ids: string[]; assunto?: string; detalhe?: string; origem?: string;
  anterior?: object; novo?: object; gmail?: object[]; desfazivel?: boolean; motivo?: string; grupo_id?: string | null;
}): Promise<HistRow> {
  const db = await getDb();
  const r = await db.runAsync(
    'INSERT INTO historico_acoes(at, thread_id, thread_ids_json, assunto, acao, detalhe, origem, estado_anterior_json, ' +
      'estado_novo_json, gmail_json, desfazivel, motivo, grupo_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      nowIso(), e.thread_ids[0] || '', JSON.stringify(e.thread_ids), e.assunto || '', e.acao, e.detalhe || '', e.origem || '',
      JSON.stringify(e.anterior || {}), JSON.stringify(e.novo || {}), JSON.stringify(e.gmail || []),
      Number(e.desfazivel ?? true), e.motivo || '', e.grupo_id ?? null,
    ],
  );
  return (await getHistorico(r.lastInsertRowId))!;
}

export async function getHistorico(id: number): Promise<HistRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Row>('SELECT * FROM historico_acoes WHERE id=?', [id]);
  return r ? histRow(r) : null;
}

export async function updateHistorico(id: number, fields: Partial<Record<'at' | 'desfeito_em' | 'refeito_em' | 'motivo', SqlValue>>): Promise<void> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  const db = await getDb();
  await db.runAsync(`UPDATE historico_acoes SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, [...keys.map((k) => fields[k] ?? null), id]);
}

export async function listHistorico(opts: { limit?: number; before?: number | null; threadId?: string } = {}): Promise<HistRow[]> {
  let sql = 'SELECT * FROM historico_acoes WHERE 1=1';
  const params: SqlValue[] = [];
  if (opts.before) {
    sql += ' AND id<?';
    params.push(opts.before);
  }
  if (opts.threadId) {
    sql += ' AND thread_id=?';
    params.push(opts.threadId);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(opts.limit ?? 50);
  const db = await getDb();
  return (await db.getAllAsync<Row>(sql, params)).map(histRow);
}

export async function lastHistoricoUndoable(skip: string[] = []): Promise<HistRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Row>(
    `SELECT * FROM historico_acoes WHERE desfazivel=1 AND desfeito_em IS NULL${skip.length ? ` AND acao NOT IN (${skip.map(() => '?').join(', ')})` : ''} ORDER BY id DESC LIMIT 1`,
    skip,
  );
  return r ? histRow(r) : null;
}
