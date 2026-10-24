// Sync com Gmail falso gravando num SQLite real em memória (node:sqlite):
// listagem completa, incremental por historyId, fallback no 404 do history,
// thread apagada, um sync por vez. Nenhum dado real.
import * as db from '../db';
import { createGmail } from '../gmail';
import { createSync, ingestThread, META } from '../sync';
import { fakeMailbox, imgPart, message, nodeDriver, thread } from '../__testutils__/fixtures';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

const ME = 'leo@confrapag.com.br';
let driver: ReturnType<typeof nodeDriver>;

beforeEach(async () => {
  driver = nodeDriver();
  await db.attachDb(driver);
});

function setup() {
  const mb = fakeMailbox();
  const gmail = createGmail({ fetch: mb.fetch, getAccessToken: async () => 'tok' });
  const sync = createSync({ gmail, me: () => ME, now: () => Date.parse('2026-10-22T15:00:00Z') });
  return { mb, sync };
}

const paths = (mb: ReturnType<typeof fakeMailbox>) => mb.calls.map((c) => c.url.pathname.replace('/gmail/v1/users/me', ''));

describe('ingestThread', () => {
  it('grava thread (porte do _ingest_thread), mensagens e o corpo no formato do Mac', async () => {
    const t = thread('t1', [
      message('m1', { text: 'Leo, pode validar até 10/10?', from: 'Ana Souza <ana@x.com>', internalDate: 1000, labels: ['INBOX', 'CATEGORY_PERSONAL'] }),
      message('m2', {
        text: 'Reforçando, preciso validar: [image: print.png]',
        from: 'Ana Souza <ana@x.com>',
        to: 'Bia <bia@x.com>',
        cc: 'Leo <leo@confrapag.com.br>',
        internalDate: 2000,
        labels: ['INBOX', 'CATEGORY_PERSONAL', 'UNREAD'],
        parts: [imgPart('A1', 'print.png', { cid: 'p1' })],
      }),
    ], '555');
    await ingestThread(t, ME);
    const row = (await db.getThread('t1'))!;
    expect(row).toMatchObject({
      subject: 'Roteamento do pix estático',
      from_email: 'ana@x.com',
      from_name: 'Ana Souza',
      internal_date: 2000,
      is_unread: 1,
      last_from_me: 0,
      needs_action_hint: 1,
      to_header: 'Bia <bia@x.com>',
      cc_header: 'Leo <leo@confrapag.com.br>',
      history_id: '555',
      hidden: 0,
    });
    expect(JSON.parse(String(row.labels_json))).toEqual(['CATEGORY_PERSONAL', 'INBOX', 'UNREAD']);
    expect(String(row.body_text)).toContain('De: Ana Souza <ana@x.com>\nData: Thu, 22 Oct 2026 10:44:00 -0300\n\nLeo, pode validar até 10/10?');
    expect(String(row.body_text).split('\n\n----\n\n')).toHaveLength(2);
    const msgs = await db.listMessages('t1');
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2']);
    const att = JSON.parse(String(msgs[1].attachments_json));
    expect(att.files[0]).toMatchObject({ attachment_id: 'A1', in_body: true, is_image: true });
    expect(att.inline[0]).toMatchObject({ token: '[image: print.png]', attachment_id: 'A1' });
  });

  it('remetente bloqueado vira propaganda; mensagem que sumiu do Gmail sai do banco', async () => {
    await driver.raw.exec("INSERT INTO blocked_senders(email, created_at) VALUES('ana@x.com', 'x')");
    await ingestThread(thread('t1', [message('m1', { text: 'a' }), message('m2', { text: 'b' })]), ME);
    expect((await db.getThread('t1'))!.is_marketing).toBe(1);
    await ingestThread(thread('t1', [message('m2', { text: 'b' })]), ME);
    expect((await db.listMessages('t1')).map((m) => m.id)).toEqual(['m2']);
  });
});

describe('createSync', () => {
  it('sem historyId: listagem completa paginada, grava tudo e guarda o historyId do perfil', async () => {
    const { mb, sync } = setup();
    mb.box.historyId = '900';
    for (let i = 1; i <= 3; i++) mb.box.threads.set(`t${i}`, thread(`t${i}`, [message(`m${i}`, { text: `oi ${i}`, internalDate: i * 1000 })], `10${i}`));
    const r = await sync.syncNow();
    expect(r).toMatchObject({ mode: 'full', fetched: 3, historyId: '900', fellBack: false });
    expect((await db.listVisible()).map((t) => t.id)).toEqual(['t3', 't2', 't1']);
    expect(await db.getMeta(META.historyId)).toBe('900');
    expect(paths(mb).filter((p) => p === '/threads').length).toBeGreaterThanOrEqual(3); // paginação (2 por página)
    const st = await sync.status();
    expect(st).toMatchObject({ status: 'online', gmail_primary_unread: 3, last_sync_label: 'agora' });
  });

  it('listagem completa não re-busca thread com o mesmo historyId', async () => {
    const { mb, sync } = setup();
    mb.box.threads.set('t1', thread('t1', [message('m1', { text: 'oi' })], '101'));
    await sync.syncNow({ full: true });
    mb.calls.length = 0;
    const r = await sync.syncNow({ full: true });
    expect(r.fetched).toBe(0);
    expect(paths(mb)).not.toContain('/threads/t1');
  });

  it('incremental: history.list desde o último historyId, re-busca só as threads tocadas', async () => {
    const { mb, sync } = setup();
    mb.box.historyId = '200';
    mb.box.threads.set('t1', thread('t1', [message('m1', { text: 'oi', internalDate: 1000 })], '101'));
    mb.box.threads.set('t2', thread('t2', [message('m2', { text: 'tchau', internalDate: 900 })], '102'));
    await sync.syncNow();
    mb.calls.length = 0;
    // chega mensagem nova na t1 e uma thread nova na caixa (t3); t9 é de fora da caixa
    mb.box.threads.set('t1', thread('t1', [message('m1', { text: 'oi', internalDate: 1000 }), message('m1b', { text: 'novidade', internalDate: 3000 })], '210'));
    mb.box.threads.set('t3', thread('t3', [message('m3', { text: 'nova', internalDate: 2500 })], '211'));
    mb.box.history = [
      { id: '210', messagesAdded: [{ message: { id: 'm1b', threadId: 't1', labelIds: ['INBOX', 'UNREAD'] } }] },
      { id: '211', messagesAdded: [{ message: { id: 'm3', threadId: 't3', labelIds: ['INBOX', 'CATEGORY_PERSONAL'] } }] },
      { id: '212', messagesAdded: [{ message: { id: 'm9', threadId: 't9', labelIds: ['SENT'] } }] },
    ];
    mb.box.historyId = '212';
    const r = await sync.syncNow();
    expect(r).toMatchObject({ mode: 'incremental', fetched: 2, historyId: '212' });
    expect(paths(mb)).toEqual(expect.arrayContaining(['/history', '/threads/t1', '/threads/t3']));
    expect(paths(mb)).not.toContain('/threads/t2');
    expect(paths(mb)).not.toContain('/threads/t9');
    expect(paths(mb)).not.toContain('/profile');
    expect((await db.listMessages('t1')).map((m) => m.id)).toEqual(['m1', 'm1b']);
    expect(String((await db.getThread('t1'))!.body_text)).toContain('novidade');
    expect(await db.getMeta(META.historyId)).toBe('212');
  });

  it('thread nova fora da Principal (só INBOX, sem CATEGORY_PERSONAL) não entra', async () => {
    const { mb, sync } = setup();
    await sync.syncNow();
    mb.box.threads.set('tp', thread('tp', [message('mp', { text: 'promo', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] })], '300'));
    mb.box.history = [{ id: '301', messagesAdded: [{ message: { id: 'mp', threadId: 'tp', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] } }] }];
    mb.box.historyId = '301';
    const r = await sync.syncNow();
    expect(r.fetched).toBe(0);
    expect(await db.getThread('tp')).toBeNull();
  });

  it('history 404 (historyId velho): cai na listagem completa', async () => {
    const { mb, sync } = setup();
    await db.setMeta(META.historyId, '5');
    mb.box.minHistoryId = '50';
    mb.box.historyId = '777';
    mb.box.threads.set('t1', thread('t1', [message('m1', { text: 'oi' })], '101'));
    const r = await sync.syncNow();
    expect(r).toMatchObject({ mode: 'full', fellBack: true, fetched: 1, historyId: '777' });
    expect(paths(mb).slice(0, 2)).toEqual(['/history', '/profile']);
    expect(await db.getMeta(META.historyId)).toBe('777');
  });

  it('thread apagada no Gmail (404 no get) sai da lista', async () => {
    const { mb, sync } = setup();
    mb.box.threads.set('t1', thread('t1', [message('m1', { text: 'oi' })], '101'));
    await sync.syncNow();
    mb.box.threads.delete('t1');
    mb.box.history = [{ id: '150', messagesDeleted: [{ message: { id: 'm1', threadId: 't1' } }] }];
    mb.box.historyId = '150';
    const r = await sync.syncNow();
    expect(r.removed).toBe(1);
    expect(await db.listVisible()).toEqual([]);
    expect((await db.getThread('t1'))!.hidden).toBe(1);
  });

  it('não lido aqui que o Gmail já não lista como não lido é re-buscado (lido no celular)', async () => {
    const { mb, sync } = setup();
    mb.box.threads.set('t1', thread('t1', [message('m1', { text: 'oi', labels: ['INBOX', 'CATEGORY_PERSONAL', 'UNREAD'] })], '101'));
    await sync.syncNow({ full: true });
    expect((await db.getThread('t1'))!.is_unread).toBe(1);
    // arquivada e lida em outro lugar: some da listagem, mas o get ainda responde
    mb.box.threads.set('t1', thread('t1', [message('m1', { text: 'oi', labels: ['CATEGORY_PERSONAL'] })], '101'));
    mb.box.unlisted.add('t1');
    mb.calls.length = 0;
    const r = await sync.syncNow({ full: true });
    expect(paths(mb)).toContain('/threads/t1');
    expect(r.fetched).toBe(1);
    expect((await db.getThread('t1'))!.is_unread).toBe(0);
  });

  it('um sync por vez: chamadas simultâneas recebem o mesmo resultado', async () => {
    const { mb, sync } = setup();
    mb.box.threads.set('t1', thread('t1', [message('m1', { text: 'oi' })], '101'));
    const [a, b] = await Promise.all([sync.syncNow(), sync.syncNow()]);
    expect(a).toBe(b);
    expect(paths(mb).filter((p) => p === '/profile')).toHaveLength(1);
  });

  it('sem conexão: status offline com o motivo; sem login: auth_error', async () => {
    const gmail = createGmail({ fetch: async () => { throw new Error('rede'); }, getAccessToken: async () => 'tok' });
    const sync = createSync({ gmail, me: () => ME });
    await expect(sync.syncNow()).rejects.toMatchObject({ status: 0 });
    expect((await sync.status()).status).toBe('offline');
    const { AuthError } = jest.requireActual('../googleAuth');
    const noAuth = createSync({ gmail: createGmail({ fetch: async () => { throw new Error('x'); }, getAccessToken: async () => { throw new AuthError('signed_out', 'entre'); } }), me: () => ME });
    await expect(noAuth.syncNow()).rejects.toMatchObject({ code: 'signed_out' });
    expect((await noAuth.status()).status).toBe('auth_error');
  });
});
