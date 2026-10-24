// Troca de fonte de dados: local (padrão) ↔ servidor, salva no aparelho.
/* eslint-disable @typescript-eslint/no-require-imports */
import type { DataBackend } from '../index';

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      mockStore.set(k, v);
    }),
  },
}));
// o servidor não é chamado nestes testes: api.ts falso
jest.mock('../../api', () => ({
  api: {},
  imageSource: (uri: string) => ({ uri }),
  inlineImageUrl: () => 'http://servidor/img',
  openAttachment: jest.fn(),
}));

function fakeBackend(name: string): DataBackend & { calls: string[] } {
  const calls: string[] = [];
  const rec = <T,>(k: string, v: T) => async () => {
    calls.push(k);
    return v;
  };
  return {
    calls,
    list: (async (all: boolean) => {
      calls.push(`list:${all}`);
      return { saudacao: name } as never;
    }) as DataBackend['list'],
    status: rec('status', { running: false } as never),
    run: rec('run', { running: true } as never),
    syncNow: rec('syncNow', { status: 'online' } as never),
    detail: (async (id: string, refresh: boolean) => {
      calls.push(`detail:${id}:${refresh}`);
      return { thread_id: id, subject: name } as never;
    }) as DataBackend['detail'],
    gmailAttachments: rec('gmailAttachments', { files: [], message_ids: [], inline: {} }),
    imageSource: rec('imageSource', { uri: `${name}://img` }),
    openAttachment: rec('openAttachment', undefined),
    appStatus: rec('appStatus', { account: name, can_send: false }),
    prefs: rec('prefs', {}),
    action: rec('action', {} as never),
    aliasSuggest: rec('aliasSuggest', { suggestions: [] }),
    recipients: rec('recipients', { to: [], cc: [] }),
    draft: rec('draft', { draft: '' }),
    attachmentsCount: rec('attachmentsCount', 0),
    send: rec('send', { ok: true }),
    sendNew: rec('sendNew', { ok: true }),
    outbox: rec('outbox', []),
    cancelSend: rec('cancelSend', undefined),
    historico: rec('historico', { items: [], proximo: null }),
    desfazer: rec('desfazer', {} as never),
    refazer: rec('refazer', {} as never),
    desfazerUltimo: rec('desfazerUltimo', {} as never),
    resumoDetalhado: rec('resumoDetalhado', { resumo: { contexto: name } } as never),
    resumoMensagem: rec('resumoMensagem', {} as never),
    resumoMensagemCached: rec('resumoMensagemCached', { resumo: null } as never),
    verifyCached: rec('verifyCached', { afirmacoes: null } as never),
    verify: rec('verify', { afirmacoes: [] } as never),
    learned: rec('learned', { notes: [] }),
    learn: rec('learn', {} as never),
    unlearn: rec('unlearn', { ok: true }),
  };
}

beforeEach(() => {
  mockStore.clear();
  jest.resetModules();
});

describe('fonte de dados', () => {
  it('padrão é local; a escolha fica salva e avisa quem escuta', async () => {
    const src = require('../source') as typeof import('../source');
    expect(await src.loadDataSource()).toBe('local');
    const seen: string[] = [];
    const off = src.onDataSourceChange((s) => seen.push(s));
    await src.setDataSource('servidor');
    expect(src.getDataSource()).toBe('servidor');
    expect(mockStore.get('cp_data_source')).toBe('servidor');
    off();
    await src.setDataSource('local');
    expect(seen).toEqual(['servidor']);
    // valor estranho salvo volta ao padrão
    mockStore.set('cp_data_source', 'ftp');
    expect(await src.loadDataSource()).toBe('local');
    mockStore.set('cp_data_source', 'servidor');
    expect(await src.loadDataSource()).toBe('servidor');
  });

  it('a camada de dados chama o backend da fonte atual, na hora de cada chamada', async () => {
    const { createDataLayer } = require('../index') as typeof import('../index');
    const local = fakeBackend('local');
    const servidor = fakeBackend('servidor');
    let cur: 'local' | 'servidor' = 'local';
    const data = createDataLayer({ local: () => local, servidor: () => servidor }, () => cur);
    expect(data.isLocal()).toBe(true);
    expect((await data.list()).saudacao).toBe('local');
    expect((await data.detail('t1')).subject).toBe('local');
    cur = 'servidor';
    expect(data.isLocal()).toBe(false);
    expect((await data.list(true)).saudacao).toBe('servidor');
    expect((await data.imageSource('t1', {} as never)).uri).toBe('servidor://img');
    await data.syncNow();
    await data.run();
    expect(local.calls).toEqual(['list:false', 'detail:t1:false']);
    expect(servidor.calls).toEqual(['list:true', 'imageSource', 'syncNow', 'run']);
  });

  it('resumos, Verificar e Aprender seguem a fonte atual (nada direto no api)', async () => {
    const { createDataLayer } = require('../index') as typeof import('../index');
    const local = fakeBackend('local');
    const servidor = fakeBackend('servidor');
    let cur: 'local' | 'servidor' = 'local';
    const data = createDataLayer({ local: () => local, servidor: () => servidor }, () => cur);
    expect((await data.resumoDetalhado('t1')).resumo).toEqual({ contexto: 'local' });
    await data.resumoMensagem('t1', 0, 'direto');
    await data.resumoMensagemCached('t1', 0, 'direto');
    await data.verifyCached('t1');
    await data.verify('t1', true);
    await data.learned('t1');
    await data.learn('general', 'x', 't1');
    await data.unlearn(1);
    cur = 'servidor';
    expect((await data.resumoDetalhado('t1')).resumo).toEqual({ contexto: 'servidor' });
    expect(local.calls).toEqual(['resumoDetalhado', 'resumoMensagem', 'resumoMensagemCached', 'verifyCached', 'verify', 'learned', 'learn', 'unlearn']);
    expect(servidor.calls).toEqual(['resumoDetalhado']);
  });

  it('o data padrão segue o setDataSource; no modo servidor o núcleo local nem é carregado', async () => {
    const localLoaded = jest.fn();
    jest.doMock('../local', () => {
      localLoaded();
      return { localBackend: fakeBackend('local') };
    });
    const src = require('../source') as typeof import('../source');
    const { data, serverBackend } = require('../index') as typeof import('../index');
    await src.setDataSource('servidor');
    const spy = jest.spyOn(serverBackend, 'appStatus').mockResolvedValue({ account: 'mac', can_send: true });
    expect((await data.appStatus()).account).toBe('mac');
    expect(localLoaded).not.toHaveBeenCalled();
    await src.setDataSource('local');
    expect((await data.appStatus()).account).toBe('local');
    expect(localLoaded).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
