// Cliente Gmail com fetch fake: URLs/parâmetros, paginação, history, 401 com
// token renovado, erros sem vazar token. Nenhuma chamada real.
import { fakeFetch, fakeMailbox, message, thread } from '../__testutils__/fixtures';
import { createGmail, GmailError, threadIdsFromHistory } from '../gmail';

const TOKEN = 'ya29.TOKEN-FALSO-DE-TESTE';

function client(f: ReturnType<typeof fakeFetch>['fn'], getAccessToken = async () => TOKEN, invalidateToken?: (t: string) => Promise<void>) {
  return createGmail({ fetch: f, getAccessToken, invalidateToken, timeoutMs: 2000 });
}

describe('gmail.ts', () => {
  it('threads.list manda q, labelIds, pageToken e o token no cabeçalho', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { threads: [{ id: 'a', historyId: 7 }], nextPageToken: 'p2' } }));
    const page = await client(f.fn).listThreads({ q: 'in:inbox is:unread', labelIds: ['INBOX', 'UNREAD'], pageToken: 'p1', maxResults: 10 });
    expect(page).toEqual({ threads: [{ id: 'a', historyId: '7', snippet: undefined }], nextPageToken: 'p2', resultSizeEstimate: undefined });
    const c = f.calls[0];
    expect(c.method).toBe('GET');
    expect(c.url.pathname).toBe('/gmail/v1/users/me/threads');
    expect(c.url.searchParams.get('q')).toBe('in:inbox is:unread');
    expect(c.url.searchParams.getAll('labelIds')).toEqual(['INBOX', 'UNREAD']);
    expect(c.url.searchParams.get('pageToken')).toBe('p1');
    expect(c.url.searchParams.get('maxResults')).toBe('10');
    expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.url.toString()).not.toContain(TOKEN);
  });

  it('listAllThreads segue o nextPageToken até o limite', async () => {
    const mb = fakeMailbox();
    for (let i = 1; i <= 5; i++) mb.box.threads.set(`t${i}`, thread(`t${i}`, [message(`m${i}`, { text: 'x' })], String(100 + i)));
    const g = client(mb.fetch);
    const all = await g.listAllThreads({ q: 'in:inbox' }, 50);
    expect(all.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(mb.calls.filter((c) => c.url.pathname.endsWith('/threads'))).toHaveLength(3); // páginas de 2
    const few = await g.listAllThreads({ q: 'in:inbox' }, 3);
    expect(few.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('threads.get com format=full, messages.get, labels.list e attachments.get', async () => {
    const f = fakeFetch((u) => {
      if (u.pathname.endsWith('/threads/t%201') || u.pathname.endsWith('/threads/t 1')) return { status: 200, body: { id: 't 1', messages: [] } };
      if (u.pathname.endsWith('/messages/m1')) return { status: 200, body: { id: 'm1' } };
      if (u.pathname.endsWith('/labels')) return { status: 200, body: { labels: [{ id: 'INBOX', name: 'INBOX' }] } };
      if (u.pathname.endsWith('/messages/m1/attachments/A1')) return { status: 200, body: { data: 'aGk', size: 2 } };
      return { status: 404 };
    });
    const g = client(f.fn);
    expect((await g.getThread('t 1')).id).toBe('t 1');
    expect(f.calls[0].url.searchParams.get('format')).toBe('full');
    expect((await g.getMessage('m1')).id).toBe('m1');
    expect(await g.listLabels()).toEqual([{ id: 'INBOX', name: 'INBOX' }]);
    expect(await g.getAttachment('m1', 'A1')).toEqual({ data: 'aGk', size: 2 });
  });

  it('modify: lido / não lido / arquivar mandam os rótulos certos (sem uso automático)', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { id: 't1' } }));
    const g = client(f.fn);
    await g.markRead('t1');
    await g.markUnread('t1');
    await g.archive('t1');
    await g.modifyThread('t1', { addLabelIds: ['STARRED'] });
    expect(f.calls.map((c) => [c.method, c.url.pathname.split('/').slice(-2).join('/'), JSON.parse(c.body!)])).toEqual([
      ['POST', 't1/modify', { addLabelIds: [], removeLabelIds: ['UNREAD'] }],
      ['POST', 't1/modify', { addLabelIds: ['UNREAD'], removeLabelIds: [] }],
      ['POST', 't1/modify', { addLabelIds: [], removeLabelIds: ['INBOX'] }],
      ['POST', 't1/modify', { addLabelIds: ['STARRED'], removeLabelIds: [] }],
    ]);
  });

  it('envio só por sendRawMessage (messages.send com threadId); sem rascunho no Gmail', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { id: 'sent1', threadId: 't1' } }));
    const g = client(f.fn) as unknown as Record<string, unknown>;
    expect(Object.keys(g).filter((k) => /send|draft/i.test(k))).toEqual(['sendRawMessage']);
    const r = await (g as unknown as ReturnType<typeof client>).sendRawMessage('UkFX', 't1');
    expect(r.id).toBe('sent1');
    expect(f.calls[0].method).toBe('POST');
    expect(f.calls[0].url.pathname).toBe('/gmail/v1/users/me/messages/send');
    expect(JSON.parse(f.calls[0].body!)).toEqual({ raw: 'UkFX', threadId: 't1' });
  });

  it('threads.get com metadata manda os cabeçalhos pedidos', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { id: 't1', messages: [] } }));
    await client(f.fn).getThreadMetadata('t1', ['From', 'Message-ID']);
    expect(f.calls[0].url.searchParams.get('format')).toBe('metadata');
    expect(f.calls[0].url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Message-ID']);
  });

  it('history.list pagina e junta tudo; threadIdsFromHistory acha as threads tocadas', async () => {
    const mb = fakeMailbox();
    mb.box.historyId = '230';
    mb.box.history = [
      { id: '201', messagesAdded: [{ message: { id: 'm1', threadId: 'tA', labelIds: ['INBOX'] } }] },
      { id: '202', labelsRemoved: [{ message: { id: 'm2', threadId: 'tB' }, labelIds: ['UNREAD'] }] },
      { id: '203', messagesDeleted: [{ message: { id: 'm3', threadId: 'tC' } }] },
      { id: '204', labelsAdded: [{ message: { id: 'm1', threadId: 'tA' }, labelIds: ['STARRED'] }] },
    ];
    const g = client(mb.fetch);
    const r = await g.listHistoryAll('200', { historyTypes: ['messageAdded', 'labelRemoved'] });
    expect(r.historyId).toBe('230');
    expect(r.history.map((h) => h.id)).toEqual(['201', '202', '203', '204']);
    const hcalls = mb.calls.filter((c) => c.url.pathname.endsWith('/history'));
    expect(hcalls).toHaveLength(2);
    expect(hcalls[0].url.searchParams.getAll('historyTypes')).toEqual(['messageAdded', 'labelRemoved']);
    expect(threadIdsFromHistory(r.history)).toEqual(['tA', 'tB', 'tC']);
  });

  it('history 404 vira GmailError status 404', async () => {
    const mb = fakeMailbox();
    mb.box.minHistoryId = '500';
    await expect(client(mb.fetch).listHistory('10')).rejects.toMatchObject({ name: 'GmailError', status: 404 });
  });

  it('401: descarta o token e tenta uma vez com o novo', async () => {
    let n = 0;
    const tokens = ['velho', 'novo'];
    const invalidated: string[] = [];
    const f = fakeFetch((_u, init) => (init.headers.Authorization === 'Bearer novo' ? { status: 200, body: { labels: [] } } : { status: 401 }));
    const g = client(f.fn, async () => tokens[Math.min(n++, 1)], async (t) => {
      invalidated.push(t);
    });
    expect(await g.listLabels()).toEqual([]);
    expect(invalidated).toEqual(['velho']);
    expect(f.calls).toHaveLength(2);
  });

  it('401 de novo: erro de acesso, sem laço', async () => {
    const f = fakeFetch(() => ({ status: 401 }));
    const err = await client(f.fn).listLabels().catch((e) => e);
    expect(err).toBeInstanceOf(GmailError);
    expect(err.status).toBe(401);
    expect(f.calls).toHaveLength(2);
  });

  it('erro do Gmail não vaza o token e erro de rede vira status 0', async () => {
    const f = fakeFetch(() => ({ status: 403, body: { error: { message: `quota exceeded for ${TOKEN}` } } }));
    const err = await client(f.fn).listLabels().catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('***');
    const down = createGmail({ fetch: async () => { throw new Error(`ECONNREFUSED ${TOKEN}`); }, getAccessToken: async () => TOKEN });
    const e2 = await down.listLabels().catch((e) => e);
    expect(e2).toMatchObject({ status: 0, message: 'Sem conexão com o Gmail.' });
  });
});
