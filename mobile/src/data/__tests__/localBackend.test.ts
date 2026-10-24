// Fonte "local": anexos e ordem das mensagens vindos do SQLite (o que o sync
// gravou) e sync sem login Google (avisa em vez de quebrar). Sem rede.
import * as db from '../../core/db';
import { setGoogleAuth } from '../../core/googleAuth';
import { ingestThread } from '../../core/sync';
import { imgPart, message, nodeDriver, thread } from '../../core/__testutils__/fixtures';
import { localAttachments, localBackend } from '../local';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

beforeEach(async () => {
  await db.attachDb(nodeDriver());
});
afterEach(() => setGoogleAuth(null));

it('monta o GmailAttachments da thread a partir das mensagens gravadas', async () => {
  await ingestThread(
    thread('t1', [
      message('m1', { text: 'oi', internalDate: 1 }),
      message('m2', { text: 'olha [image: a.png]', internalDate: 2, parts: [imgPart('A1', 'a.png', { cid: 'c1' })] }),
    ]),
    'leo@confrapag.com.br',
  );
  const att = await localAttachments('t1');
  expect(att.message_ids).toEqual(['m1', 'm2']);
  expect(att.files.map((f) => [f.message_id, f.attachment_id, f.in_body])).toEqual([['m2', 'A1', true]]);
  expect(att.inline.m2[0]).toMatchObject({ token: '[image: a.png]', attachment_id: 'A1' });
});

it('sync sem login Google: devolve auth_error com a instrução, sem chamar o Gmail', async () => {
  setGoogleAuth({
    isAvailable: () => false,
    state: async () => ({ kind: 'unavailable', reason: 'requer development build' }),
    signIn: async () => {
      throw new Error('não');
    },
    signOut: async () => undefined,
    getAccessToken: async () => {
      throw new Error('não deveria pedir token');
    },
    invalidateToken: async () => undefined,
  });
  const st = await localBackend.syncNow();
  expect(st.status).toBe('auth_error');
  expect(st.last_error).toContain('Conta Google');
  expect((await localBackend.appStatus()).can_send).toBe(false);
});
