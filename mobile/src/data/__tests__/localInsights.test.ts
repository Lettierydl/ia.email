// Fonte "local" (smoke): resumos, Verificar na caixa e Aprender passam pelo
// núcleo do aparelho (SQLite), não pelo api.ts do servidor. Sem chave de IA e
// sem login: nada sai para a rede. Também o gancho do sync em segundo plano.
import * as db from '../../core/db';
import { BACKGROUND_TASK, createBackgroundSync, MIN_INTERVAL_MINUTES, registerBackgroundSync } from '../../core/background';
import { setGoogleAuth } from '../../core/googleAuth';
import { runBackgroundSync } from '../../core/local';
import { msgHash } from '../../core/summaries';
import { nodeDriver } from '../../core/__testutils__/fixtures';
import { createDataLayer, serverBackend } from '../index';
import { localBackend } from '../local';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined) },
}));
// sem chaves de IA no "Keychain"
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
// o servidor nunca pode ser chamado na fonte local
jest.mock('../../api', () => {
  const fail = () => {
    throw new Error('chamou o servidor');
  };
  return {
    api: new Proxy({}, { get: () => fail }),
    imageSource: fail,
    inlineImageUrl: fail,
    openAttachment: fail,
  };
});

const BODY =
  'De: Ana Souza <ana@x.com>\nData: Thu, 22 Oct 2026 10:44:00 -0300\n\nLeo, consegue ajustar o roteamento até sexta?\n\n----\n\n' +
  'De: Bruno <bruno@x.com>\nData: Fri, 23 Oct 2026 09:10:00 -0300\n\nO EC 123 também reclamou.';

const data = createDataLayer({ local: () => localBackend, servidor: () => serverBackend }, () => 'local');

beforeEach(async () => {
  await db.attachDb(nodeDriver());
  await db.upsertThread({ id: 't1', subject: 'Roteamento', from_email: 'ana@x.com', to_header: 'leo@confrapag.com.br', internal_date: 10 });
  await db.saveAi('t1', { body_text: BODY });
  setGoogleAuth({
    isAvailable: () => false,
    state: async () => ({ kind: 'unavailable', reason: 'teste' }),
    signIn: async () => {
      throw new Error('não');
    },
    signOut: async () => undefined,
    getAccessToken: async () => {
      throw new Error('não deveria pedir token');
    },
    invalidateToken: async () => undefined,
  });
});
afterEach(() => setGoogleAuth(null));

it('Aprender: adicionar, listar (relevantes à thread) e remover no SQLite', async () => {
  const { note } = await data.learn('person', 'Ana prefere resposta curta', 't1', 'ana@x.com');
  await data.learn('person', 'Carla não tem a ver', 't1', 'carla@y.com');
  expect((await data.learned('t1')).notes.map((n) => n.text)).toEqual(['Ana prefere resposta curta']);
  expect((await data.learned('')).notes).toHaveLength(2);
  await expect(data.learn('person', 'x', 't1', 'sem-arroba')).rejects.toThrow('Informe o e-mail da pessoa.');
  expect(await data.unlearn(note.id)).toEqual({ ok: true });
  await expect(data.unlearn(note.id)).rejects.toThrow('Aprendizado não encontrado.');
  expect((await data.learned('t1')).notes).toEqual([]);
});

it('resumos: só cache não chama IA; sem chave avisa; cache gravado volta sem IA', async () => {
  expect((await data.resumoMensagemCached('t1', 0, 'direto')).resumo).toBeNull();
  await expect(data.resumoMensagem('t1', 0, 'direto')).rejects.toThrow('Sem chave de IA configurada');
  await expect(data.resumoDetalhado('t1')).rejects.toThrow('Sem chave de IA configurada');
  await db.saveCopilotResumo('t1', JSON.stringify({ contexto: 'do cache' }), 10, 2);
  expect(await data.resumoDetalhado('t1')).toMatchObject({ cached: true, desatualizado: false, resumo: { contexto: 'do cache' } });
  await db.saveCopilotMsgResumo('t1', msgHash('Ana Souza <ana@x.com>', 'Thu, 22 Oct 2026 10:44:00 -0300', 'Leo, consegue ajustar o roteamento até sexta?'), 'direto', '{"principal":"p","bullets":[]}');
  expect((await data.resumoMensagem('t1', 0, 'direto')).resumo).toEqual({ principal: 'p', bullets: [] });
});

it('Verificar: cache vazio = null; sem chave não chama nada', async () => {
  expect(await data.verifyCached('t1')).toEqual({ afirmacoes: null, gerado_em: '', cached: false, desatualizado: false });
  await expect(data.verify('t1')).rejects.toThrow('Sem chave de IA configurada');
  await db.saveCopilotVerificacao('t1', JSON.stringify({ afirmacoes: [{ texto: 'x', veredito: 'confirmado' }], aviso: '' }), 5, 2);
  expect(await data.verifyCached('t1')).toMatchObject({ cached: true, desatualizado: true, afirmacoes: [{ texto: 'x' }] });
});

describe('sync em segundo plano (gancho)', () => {
  it('só sync curto: sem login ou sem historyId não roda; erro não vaza', async () => {
    const sync = jest.fn(async () => ({}));
    const run = (signed: boolean, hid: string | null) => createBackgroundSync({ signedIn: async () => signed, historyId: async () => hid, syncIncremental: sync })();
    expect(await run(false, '100')).toBe('skipped');
    expect(await run(true, null)).toBe('skipped');
    expect(sync).not.toHaveBeenCalled();
    expect(await run(true, '100')).toBe('ok');
    expect(sync).toHaveBeenCalledTimes(1);
    const failing = createBackgroundSync({ signedIn: async () => true, historyId: async () => '1', syncIncremental: async () => Promise.reject(new Error('offline')) });
    expect(await failing()).toBe('failed');
  });

  it('registro: sem a lib (adaptador) fica indisponível; com adaptador registra a tarefa', async () => {
    expect(await registerBackgroundSync()).toBe('indisponivel');
    const register = jest.fn(async () => undefined);
    expect(await registerBackgroundSync({ register })).toBe('registrado');
    expect(register).toHaveBeenCalledWith(BACKGROUND_TASK, MIN_INTERVAL_MINUTES);
    expect(await registerBackgroundSync({ register: async () => Promise.reject(new Error('Expo Go')) })).toBe('erro');
  });

  it('runBackgroundSync do aparelho: sem login, não toca no Gmail', async () => {
    await db.setMeta('gmail_history_id', '100');
    expect(await runBackgroundSync()).toBe('skipped');
  });
});
