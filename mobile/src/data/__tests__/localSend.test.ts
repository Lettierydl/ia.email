// Fonte local: destinatários a partir das mensagens do sync (seleção da
// mensagem), envio só com confirmação (vai para a outbox com janela de
// desfazer) e cancelar. Nada sai: os timers são falsos e o item é cancelado.
import * as db from '../../core/db';
import { setAccount } from '../../core/copilot';
import { ingestThread } from '../../core/sync';
import { message, nodeDriver, thread } from '../../core/__testutils__/fixtures';
import { localBackend, localRecipients } from '../local';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

const ME = 'leo@confrapag.com.br';

beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'Date'] });
  await db.attachDb(nodeDriver());
  setAccount(ME);
  await ingestThread(
    thread('t1', [
      message('m1', { from: 'Ana Souza <ana@x.com>', to: ME, cc: 'bia@x.com', text: 'pedido', internalDate: 1 }),
      message('m2', { from: `Leo <${ME}>`, to: 'ana@x.com', text: 'vou ver', internalDate: 2 }),
      message('m3', { from: 'Bruno <bruno@x.com>', to: `${ME}, ana@x.com`, cc: 'carla@x.com', text: 'complemento', internalDate: 3 }),
      message('m4', { from: `Leo <${ME}>`, to: 'bruno@x.com', text: 'ok', internalDate: 4 }),
    ]),
    ME,
  );
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('padrão: responde à última de terceiros, Para/Cc de responder a todos sem o Leo', async () => {
  const r = await localRecipients('t1');
  expect(r.target_id).toBe('m3');
  expect(r.reply_to!.map((a) => a.email)).toEqual(['bruno@x.com']);
  expect(r.reply_cc!.map((a) => a.email)).toEqual(['ana@x.com', 'carla@x.com']);
  expect(r.messages!.map((m) => [m.id, m.voce])).toEqual([['m1', false], ['m2', true], ['m3', false], ['m4', true]]);
});

it('escolher a primeira mensagem recalcula Para/Cc', async () => {
  const r = await localRecipients('t1', 'm1');
  expect(r.target_id).toBe('m1');
  expect(r.reply_to!.map((a) => a.email)).toEqual(['ana@x.com']);
  expect(r.reply_cc!.map((a) => a.email)).toEqual(['bia@x.com']);
});

it('enviar exige confirmação; confirmado vai para a fila com janela de desfazer e pode ser cancelado', async () => {
  await expect(localBackend.send('t1', { text: 'oi', cc: '', to: ['bruno@x.com'] }, {} as never)).rejects.toThrow(/confirmação/);
  expect(await localBackend.outbox('t1')).toEqual([]);
  const r = await localBackend.send('t1', { text: 'Bruno, ok.', cc: 'ana@x.com', to: ['bruno@x.com'], replyToMessageId: 'm3' }, { confirmed: true });
  expect(r.queued).toBe(true);
  expect(r.undo_until).toBeGreaterThan(Date.now());
  const [item] = await localBackend.outbox('t1');
  expect(item).toMatchObject({ id: r.outbox_id, status: 'queued', to: 'bruno@x.com', kind: 'reply' });
  await localBackend.cancelSend(r.outbox_id!);
  expect(await localBackend.outbox('t1')).toEqual([]);
});
