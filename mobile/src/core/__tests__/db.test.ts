// Banco: migração e esquema rodando num SQLite de verdade (node:sqlite, em
// memória) no lugar do expo-sqlite. Nenhum arquivo de data/ é lido.
import { DatabaseSync } from 'node:sqlite';

import * as db from '../db';

type V = db.SqlValue;

function nodeDriver(): db.SqlDriver & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    async execAsync(sql) {
      raw.exec(sql);
    },
    async runAsync(sql, params: V[]) {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, params: V[]) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async getFirstAsync<T>(sql: string, params: V[]) {
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
  };
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

let driver: ReturnType<typeof nodeDriver>;

beforeEach(async () => {
  driver = nodeDriver();
  await db.attachDb(driver);
});

const columns = (table: string) => (driver.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

// Colunas finais de app/store.py (CREATE TABLE + ALTER TABLE, na ordem) e app/outbox.py.
const STORE_SCHEMA: Record<string, string[]> = {
  threads: [
    'id', 'subject', 'from_email', 'from_name', 'snippet', 'internal_date', 'is_unread', 'last_from_me', 'is_automatic',
    'is_marketing', 'needs_action_hint', 'awaiting_reply', 'conferido', 'hidden', 'hide_as_replied', 'last_from_header',
    'labels_json', 'updated_at', 'summary', 'draft', 'body_text', 'chat_json', 'fyi_only', 'capture_note',
    'capture_status', 'chat_anchor_date', 'sent_via_app_at', 'to_header', 'cc_header', 'history_id',
  ],
  meta: ['key', 'value'],
  blocked_senders: ['email', 'created_at'],
  avatar_cache: ['email', 'photo_url', 'resolved_at'],
  aliases: ['alias', 'name', 'email', 'created_at'],
  autopilot_decisions: [
    'id', 'thread_id', 'action', 'confidence', 'reasoning', 'draft_text', 'cc', 'sensitivity_level', 'decided_at',
    'scheduled_send_at', 'status', 'sent_at', 'error', 'internal_date_snapshot', 'evidence_json',
  ],
  usage_events: ['id', 'kind', 'thread_id', 'at'],
  copilot_items: [
    'thread_id', 'papel', 'o_que_aconteceu', 'opcoes_json', 'urgencia', 'bola_json', 'depende_de_outros',
    'sem_resposta_desde', 'prazo', 'quem_pediu_json', 'tarefas_json', 'needs_context', 'o_que_falta', 'pergunta',
    'status', 'source', 'delegado_json', 'internal_date_snapshot', 'analyzed_at', 'updated_at', 'msg_count_snapshot',
  ],
  copilot_actions: ['id', 'thread_id', 'action', 'payload_json', 'at'],
  reply_edits: ['id', 'thread_id', 'ai_draft', 'sent_text', 'edited', 'source', 'created_at'],
  learned_notes: ['id', 'scope', 'thread_id', 'subject', 'subject_key', 'person_email', 'text', 'created_at'],
  copilot_resumos: ['thread_id', 'resumo_json', 'internal_date_snapshot', 'msg_count_snapshot', 'gerado_em'],
  copilot_msg_resumos: ['thread_id', 'msg_hash', 'modo', 'resumo_json', 'gerado_em'],
  copilot_verificacoes: ['thread_id', 'resultado_json', 'internal_date_snapshot', 'msg_count_snapshot', 'gerado_em'],
  outbox: [
    'id', 'kind', 'thread_id', 'to_addr', 'cc', 'subject', 'body', 'attachments_json', 'source', 'ai_draft', 'status',
    'attempts', 'last_error', 'next_attempt_at', 'result_json', 'created_at', 'updated_at', 'sent_at', 'reply_to',
    'reply_to_message_id',
  ],
  historico_acoes: [
    'id', 'at', 'thread_id', 'thread_ids_json', 'assunto', 'acao', 'detalhe', 'origem', 'estado_anterior_json',
    'estado_novo_json', 'gmail_json', 'desfazivel', 'motivo', 'desfeito_em', 'refeito_em', 'grupo_id',
  ],
};

test('migra até a última versão e grava em PRAGMA user_version', () => {
  const v = driver.raw.prepare('PRAGMA user_version').get() as { user_version: number };
  expect(v.user_version).toBe(db.SCHEMA_VERSION);
  expect(db.SCHEMA_VERSION).toBe(2);
});

test('mesmo esquema de app/store.py (tabelas e colunas na ordem)', () => {
  for (const [table, cols] of Object.entries(STORE_SCHEMA)) expect([table, columns(table)]).toEqual([table, cols]);
  const indexes = (driver.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[])
    .map((r) => r.name)
    .sort();
  expect(indexes).toEqual(
    ['idx_copilot_actions_at', 'idx_historico_thread', 'idx_messages_thread', 'idx_outbox_status', 'idx_reply_edits_thread', 'idx_usage_events_at'],
  );
  expect(columns('messages')).toContain('thread_id');
});

test('migrar de novo não faz nada; banco na v1 sobe só a v2', async () => {
  expect(await db.migrate(driver)).toBe(2);
  const old = nodeDriver();
  old.raw.exec(db.MIGRATIONS[0] + '\nPRAGMA user_version = 1;');
  old.raw.prepare("INSERT INTO threads(id, subject) VALUES ('t0', 'antigo')").run();
  expect(await db.migrate(old)).toBe(2);
  expect(old.raw.prepare('SELECT subject FROM threads').get()).toEqual({ subject: 'antigo' });
  expect(old.raw.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name='messages'").get()).toEqual({ ok: 1 });
});

test('migração com erro desfaz tudo (versão não sobe)', async () => {
  const bad = nodeDriver();
  db.MIGRATIONS.push('CREATE TABLE x (a); SELECT * FROM tabela_que_nao_existe;');
  try {
    await expect(db.migrate(bad)).rejects.toThrow();
    expect((bad.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    expect(bad.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='x'").get()).toBeUndefined();
  } finally {
    db.MIGRATIONS.pop();
  }
});

test('ajustes: padrão, mescla e ignora chaves desconhecidas', async () => {
  expect(await db.getSettings()).toEqual({ llm_models: [], llm_reasoning: false });
  await db.saveSettings({ llm_models: ['gemini:gemini-pro-latest'] });
  await db.saveSettings({ llm_reasoning: true, outra: 1 } as never);
  expect(await db.getSettings()).toEqual({ llm_models: ['gemini:gemini-pro-latest'], llm_reasoning: true });
  await db.setMeta('settings_json', '{quebrado');
  expect(await db.getSettings()).toEqual({ llm_models: [], llm_reasoning: false });
});

test('uso de tokens do dia', async () => {
  await db.addLlmUsage(3);
  await db.addLlmUsage(0);
  await db.addLlmUsage(5);
  expect(await db.llmUsageToday()).toBe(8);
});

test('threads: upsert, lista visível e corpo velho limpo quando chega mensagem nova', async () => {
  await db.upsertThread({ id: 't1', subject: 'A', internal_date: 10, hide_as_replied: 0, labels_json: ['INBOX'] });
  await db.upsertThread({ id: 't2', subject: 'B', internal_date: 20, hide_as_replied: 0 });
  await db.saveAi('t1', { body_text: 'corpo', summary: 'resumo', nao_existe: 'x', draft: undefined });
  expect((await db.getThread('t1'))!.labels_json).toBe('["INBOX"]');
  expect((await db.listVisible()).map((t) => t.id)).toEqual(['t2', 't1']);

  await db.upsertThread({ id: 't1', subject: 'A', internal_date: 10, hide_as_replied: 0 });
  expect((await db.getThread('t1'))!.body_text).toBe('corpo');
  await db.upsertThread({ id: 't1', subject: 'A2', internal_date: 30, hide_as_replied: 0 });
  const t1 = (await db.getThread('t1'))!;
  expect(t1.body_text).toBeNull();
  expect(t1.summary).toBe('resumo');
  expect(t1.subject).toBe('A2');

  driver.raw.prepare("UPDATE threads SET hidden=1 WHERE id='t2'").run();
  expect((await db.listVisible()).map((t) => t.id)).toEqual(['t1']);
  expect(await db.listVisible(true)).toHaveLength(2);
});

test('mensagens: upsert e lista em ordem de data', async () => {
  await db.upsertMessage({ id: 'm2', thread_id: 't1', internal_date: 20, body_text: 'segunda' });
  await db.upsertMessage({ id: 'm1', thread_id: 't1', internal_date: 10, body_text: 'primeira' });
  await db.upsertMessage({ id: 'm1', thread_id: 't1', internal_date: 10, body_text: 'primeira (editada)' });
  await db.upsertMessage({ id: 'x', thread_id: 'outra', internal_date: 5 });
  const msgs = await db.listMessages('t1');
  expect(msgs.map((m) => [m.id, m.body_text])).toEqual([
    ['m1', 'primeira (editada)'],
    ['m2', 'segunda'],
  ]);
});

test('copiloto: upsert parcial preserva o que não veio', async () => {
  await db.saveCopilotItem('t1', { papel: 'dono', status: 'aberto' });
  await db.saveCopilotItem('t1', { papel: 'copiado', urgencia: 'alta' });
  const item = (await db.getCopilotItem('t1'))!;
  expect([item.papel, item.status, item.urgencia]).toEqual(['copiado', 'aberto', 'alta']);
  expect(item.updated_at).toBeTruthy();
  expect(Object.keys(await db.listCopilotItems())).toEqual(['t1']);
});
