// Ações locais (assumir, delegar, resolver...) + histórico/desfazer: status em
// copilot_items, registro em copilot_actions, e os rótulos certos no Gmail
// (Resolver tira UNREAD+INBOX; desfazer recoloca). Gmail falso; sem rede.
import * as db from '../db';
import { createActions, RESOLVE_REMOVE } from '../actions';
import { setAccount, createCopilot } from '../copilot';
import * as history from '../history';
import { nodeDriver } from '../__testutils__/fixtures';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

const ME = 'leo@confrapag.com.br';
const BODY = 'De: Ana Souza <ana@x.com>\nData: 2026-10-01\n\nLeo, você pode validar o roteamento do pix estático até 10/10?';

function fakeGmail() {
  const calls: { id: string; add: string[]; remove: string[] }[] = [];
  const g = {
    calls,
    fail: false,
    async modifyThread(id: string, change: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
      if (g.fail) throw new Error('Sem conexão com o Gmail.');
      calls.push({ id, add: change.addLabelIds || [], remove: change.removeLabelIds || [] });
      return {};
    },
  };
  return g;
}

async function setup() {
  await db.attachDb(nodeDriver());
  setAccount(ME);
  await db.upsertThread({
    id: 't1', subject: 'Pix estático', from_email: 'ana@x.com', from_name: 'Ana Souza', internal_date: 1000, is_unread: 1, last_from_me: 0,
    to_header: ME, cc_header: 'Bia <bia@x.com>', last_from_header: 'Ana Souza <ana@x.com>', labels_json: ['INBOX', 'UNREAD'],
  });
  await db.saveAi('t1', { body_text: BODY });
  const gmail = fakeGmail();
  history.setHistoryGmail(gmail);
  const copilot = createCopilot({ llm: { complete: async () => '{}' }, hasKey: async () => false });
  const draft = jest.fn(async () => ({ draft: 'rascunho da IA' }));
  return { gmail, actions: createActions({ copilot, gmail, draft }), draft };
}

const labels = async () => JSON.parse(String((await db.getThread('t1'))!.labels_json));
const status = async () => String((await db.getCopilotItem('t1'))?.status);

afterEach(() => history.setHistoryGmail(null));

describe('ações locais', () => {
  it('assumir: status, bola com você, registro e histórico desfazível', async () => {
    const { actions } = await setup();
    const r = await actions.act('t1', 'assumir');
    expect(r.ok).toBe(true);
    expect(await status()).toBe('assumido');
    expect(JSON.parse(String((await db.getCopilotItem('t1'))!.bola_json))).toEqual({ com: 'leo', email: ME, nome: 'Você' });
    expect((await db.listCopilotActions('t1')).map((a) => a.action)).toEqual(['assumir']);
    expect(r.historico).toMatchObject({ acao: 'acompanhar', rotulo: 'Você acompanha', desfazivel: true });
    expect(r.item.status).toBe('assumido');
  });

  it('resolver: modify tira UNREAD e INBOX; desfazer recoloca os dois e volta o status', async () => {
    const { actions, gmail } = await setup();
    const r = await actions.act('t1', 'resolver');
    expect(gmail.calls).toEqual([{ id: 't1', add: [], remove: RESOLVE_REMOVE }]);
    expect(RESOLVE_REMOVE).toEqual(['UNREAD', 'INBOX']);
    expect(await status()).toBe('resolvido');
    expect((await db.getThread('t1'))!.is_unread).toBe(0);
    expect(await labels()).toEqual([]);
    const id = r.historico!.id;
    const u = await history.undo(id);
    expect(u.gmail).toEqual(['t1']);
    expect(gmail.calls[1]).toEqual({ id: 't1', add: ['UNREAD', 'INBOX'], remove: [] });
    expect(await status()).not.toBe('resolvido');
    expect((await db.getThread('t1'))!.is_unread).toBe(1);
    expect((await labels()).sort()).toEqual(['INBOX', 'UNREAD']);
    // refazer manda de novo ao Gmail
    await history.redo(id);
    expect(gmail.calls[2]).toEqual({ id: 't1', add: [], remove: ['UNREAD', 'INBOX'] });
    expect(await status()).toBe('resolvido');
  });

  it('desfazer com o Gmail fora do ar: nada muda localmente', async () => {
    const { actions, gmail } = await setup();
    const r = await actions.act('t1', 'resolver');
    gmail.fail = true;
    await expect(history.undo(r.historico!.id)).rejects.toMatchObject({ status: 502 });
    expect(await status()).toBe('resolvido');
    expect((await db.getHistorico(r.historico!.id))!.desfeito_em).toBeNull();
  });

  it('resolver sem Gmail: resolve local, histórico sem operação no Gmail', async () => {
    const { actions, gmail } = await setup();
    gmail.fail = true;
    const r = await actions.act('t1', 'resolver');
    expect(r.gmail_ok).toBe(false);
    expect(await status()).toBe('resolvido');
    expect((await db.getHistorico(r.historico!.id))!.gmail).toEqual([]);
  });

  it('desfazer não atropela o que mudou depois (409)', async () => {
    const { actions } = await setup();
    const r = await actions.act('t1', 'assumir');
    await db.saveCopilotItem('t1', { status: 'aguardando' });
    await expect(history.undo(r.historico!.id)).rejects.toMatchObject({ status: 409 });
  });

  it('delegar às claras: rascunho na thread com Cc dos originais; nada é enviado; desfazer limpa', async () => {
    const { actions, gmail } = await setup();
    const r = await actions.act('t1', 'delegar', { para: 'Carla@X.com', nome: 'Carla Dias', nota: 'Prazo é sexta.', modo: 'cc_originais' });
    expect(r.para).toBe('carla@x.com');
    expect(r.draft).toBe("Carla, pode assumir este assunto, por favor? Prazo é sexta.\n\nDeixo todos em cópia para acompanharem.\n\nAtenciosamente,\nLettiery D'Lamare");
    expect(r.cc).toBe('carla@x.com, bia@x.com');
    expect(r.open_url).toBe('/mail/t1?cc=carla%40x.com%2C%20bia%40x.com');
    expect(gmail.calls).toEqual([]);
    const item = (await db.getCopilotItem('t1'))!;
    expect(item.status).toBe('delegado');
    expect(JSON.parse(String(item.delegado_json))).toEqual({ modo: 'cc_originais', para: 'carla@x.com', nome: 'Carla Dias', assunto: '' });
    expect((await db.getThread('t1'))!.draft).toBe(r.draft);
    expect(r.historico).toMatchObject({ rotulo: 'Delegado para carla@x.com' });
    await history.undo(r.historico!.id);
    expect((await db.getThread('t1'))!.draft).toBe('');
  });

  it('delegar silencioso: devolve o e-mail novo para o composer (compose), sem enviar', async () => {
    const { actions } = await setup();
    const r = await actions.act('t1', 'delegar', { para: 'carla@x.com', modo: 'novo_silencioso' });
    expect(r.compose).toEqual({ to: 'carla@x.com', subject: 'Pode assumir? Pix estático', body: r.draft });
    expect(String(r.draft)).toContain('Chegou para mim o assunto "Pix estático"');
  });

  it('delegar valida e-mail e recusa você mesmo', async () => {
    const { actions } = await setup();
    await expect(actions.act('t1', 'delegar', { para: 'nada' })).rejects.toThrow('Informe um e-mail válido para delegar.');
    await expect(actions.act('t1', 'delegar', { para: ME })).rejects.toThrow('Delegar para você mesmo é assumir.');
    expect(await db.listCopilotActions('t1')).toEqual([]);
  });

  it('ação desconhecida e histórico listado', async () => {
    const { actions } = await setup();
    await expect(actions.act('t1', 'explodir')).rejects.toThrow('Ação desconhecida.');
    await actions.act('t1', 'assumir');
    await actions.act('t1', 'resolver');
    const list = await history.listing();
    expect(list.items.map((i) => i.acao)).toEqual(['resolvido', 'acompanhar']);
    const last = await history.undoLast();
    expect(last.entry.acao).toBe('resolvido');
  });

  it('resolveAfterSend: resolvido + lido local, sem mexer no Gmail', async () => {
    const { actions, gmail } = await setup();
    await actions.resolveAfterSend('t1');
    expect(await status()).toBe('resolvido');
    expect((await db.getThread('t1'))!.is_unread).toBe(0);
    expect(gmail.calls).toEqual([]);
    expect((await db.listCopilotActions('t1'))[0].action).toBe('resolver');
  });
});
