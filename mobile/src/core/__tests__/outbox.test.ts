// Outbox: MIME (cabeçalhos, assunto com acento em RFC 2047, In-Reply-To/
// References, threadId), só envia com confirmação, janela de desfazer,
// cancelar, fila offline e reenvio sem duplicar. Gmail falso (fetch fake
// servindo a REST API); nenhum e-mail sai de verdade.
import * as db from '../db';
import { createGmail, type GmailFetch } from '../gmail';
import {
  buildMime, ConfirmationRequired, createOutbox, encodeHeaderValue, formatAddr, SENT, QUEUED, FAILED, CANCELLED, UNDO_SECONDS,
} from '../outbox';
import { nodeDriver } from '../__testutils__/fixtures';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

const ME = 'leo@confrapag.com.br';
const T0 = Date.parse('2026-10-24T12:00:00Z');

const hdrs = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
const THREAD = {
  id: 't1',
  messages: [
    { id: 'm1', threadId: 't1', payload: { headers: hdrs({ From: 'Ana Souza <ana@x.com>', To: ME, Subject: 'Roteamento do pix estático', 'Message-ID': '<m1@x.com>' }) } },
    { id: 'm2', threadId: 't1', payload: { headers: hdrs({ From: `Leo <${ME}>`, To: 'ana@x.com', Subject: 'Re: Roteamento do pix estático', 'Message-ID': '<m2@confrapag>', References: '<m1@x.com>' }) } },
    {
      id: 'm3', threadId: 't1',
      payload: { headers: hdrs({ From: 'Bruno <bruno@x.com>', To: `${ME}, ana@x.com`, Cc: 'bia@x.com', Subject: 'Re: Roteamento do pix estático', 'Message-ID': '<m3@x.com>', References: '<m1@x.com> <m2@confrapag>' }) },
    },
  ],
};

/** Gmail falso: threads.get (metadata) e messages.send; `offline` derruba a rede. */
function fakeGmailApi() {
  const st = { offline: false, sendStatus: 200, sent: [] as { raw: string; threadId?: string }[], calls: [] as string[] };
  const fetch: GmailFetch = async (url, init) => {
    const u = new URL(url);
    st.calls.push(`${init.method} ${u.pathname}`);
    if (st.offline) throw new TypeError('Network request failed');
    const path = u.pathname.replace('/gmail/v1/users/me', '');
    let status = 200;
    let body: unknown = {};
    if (path === '/threads/t1') body = THREAD;
    else if (path === '/messages/send') {
      status = st.sendStatus;
      if (status < 400) {
        st.sent.push(JSON.parse(init.body!));
        body = { id: `sent${st.sent.length}`, threadId: 't1' };
      } else body = { error: { message: 'Backend Error' } };
    } else status = 404;
    const text = JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text };
  };
  return { st, gmail: createGmail({ fetch, getAccessToken: async () => 'tok-falso', timeoutMs: 2000 }) };
}

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
const headerOf = (mime: string, name: string) => {
  const head = mime.split('\r\n\r\n')[0].replace(/\r\n /g, ' ');
  return head.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();
};
const decodeWords = (v: string) =>
  v.split(' ').map((w) => (/^=\?utf-8\?b\?(.*)\?=$/.test(w) ? Buffer.from(/^=\?utf-8\?b\?(.*)\?=$/.exec(w)![1], 'base64').toString('utf8') : w)).join('');
const bodyOf = (mime: string) => Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

let clock = T0;
let scheduled: number[] = [];

async function setup() {
  await db.attachDb(nodeDriver());
  const api = fakeGmailApi();
  const after: string[] = [];
  const outbox = createOutbox({
    gmail: api.gmail,
    me: () => ME,
    now: () => clock,
    schedule: (_fn, ms) => scheduled.push(ms),
    afterSend: async (item) => {
      after.push(item.id);
    },
  });
  return { ...api, outbox, after };
}

beforeEach(() => {
  clock = T0;
  scheduled = [];
});

describe('MIME', () => {
  it('cabeçalhos RFC 2822, assunto com acento em RFC 2047, corpo UTF-8 em base64 e CRLF', () => {
    const mime = buildMime({
      from: { name: "Lettiery D'Lamare", email: ME }, to: ['ana@x.com'], cc: ['bia@x.com'], subject: 'Re: Roteamento do pix estático — ação',
      body: 'Olá, Ana.\nJá corrigimos. ✅', inReplyTo: '<m1@x.com>', references: '<m1@x.com>', date: new Date(T0),
    });
    expect(mime).toContain('\r\n');
    expect(mime.replace(/\r\n/g, '')).not.toMatch(/\n/);
    expect(headerOf(mime, 'MIME-Version')).toBe('1.0');
    expect(headerOf(mime, 'Date')).toBe('Sat, 24 Oct 2026 12:00:00 +0000');
    expect(headerOf(mime, 'From')).toBe(`Lettiery D'Lamare <${ME}>`);
    expect(headerOf(mime, 'To')).toBe('ana@x.com');
    expect(headerOf(mime, 'Cc')).toBe('bia@x.com');
    expect(headerOf(mime, 'In-Reply-To')).toBe('<m1@x.com>');
    expect(headerOf(mime, 'References')).toBe('<m1@x.com>');
    expect(headerOf(mime, 'Content-Type')).toBe('text/plain; charset="utf-8"');
    expect(headerOf(mime, 'Content-Transfer-Encoding')).toBe('base64');
    const subj = headerOf(mime, 'Subject')!;
    expect(subj).toMatch(/^=\?utf-8\?b\?/);
    // decodifica as encoded-words e volta ao texto original
    const back = subj.split(' ').map((w) => Buffer.from(/^=\?utf-8\?b\?(.*)\?=$/.exec(w)![1], 'base64').toString('utf8')).join('');
    expect(back).toBe('Re: Roteamento do pix estático — ação');
    expect(bodyOf(mime)).toBe('Olá, Ana.\r\nJá corrigimos. ✅');
    for (const line of mime.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });

  it('encoded-words com no máximo 75 colunas; ASCII fica como está; nome com especiais vai entre aspas', () => {
    const long = encodeHeaderValue('Ação '.repeat(30));
    for (const w of long.split('\r\n ')) expect(w.length).toBeLessThanOrEqual(75);
    expect(encodeHeaderValue('Pix ok')).toBe('Pix ok');
    expect(formatAddr('Souza, Ana', 'ana@x.com')).toBe('"Souza, Ana" <ana@x.com>');
    expect(formatAddr('José', 'jose@x.com')).toMatch(/^=\?utf-8\?b\?.+\?= <jose@x\.com>$/);
  });

  it('anexo simples vira multipart/mixed', () => {
    const mime = buildMime({
      from: { name: 'Leo', email: ME }, to: ['a@x.com'], subject: 'x', body: 'oi', boundary: 'BB', date: new Date(T0),
      attachments: [{ filename: 'nota.txt', mimeType: 'text/plain', dataB64: Buffer.from('conteúdo').toString('base64') }],
    });
    expect(headerOf(mime, 'Content-Type')).toBe('multipart/mixed; boundary="BB"');
    expect(mime).toContain('--BB\r\nContent-Type: text/plain; charset="utf-8"');
    expect(mime).toContain('Content-Disposition: attachment; filename="nota.txt"');
    expect(mime.trimEnd().endsWith('--BB--')).toBe(true);
  });
});

describe('outbox', () => {
  it('sem confirmação explícita: não grava nem chama o Gmail', async () => {
    const { outbox, st } = await setup();
    await expect(outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'oi' }, { confirmed: false } as never)).rejects.toBeInstanceOf(ConfirmationRequired);
    await expect(outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'oi' }, undefined as never)).rejects.toBeInstanceOf(ConfirmationRequired);
    expect(await outbox.list({ includeDone: true })).toEqual([]);
    expect(st.calls).toEqual([]);
  });

  it('janela de desfazer: nada sai antes de 10 s; depois sai com threadId, In-Reply-To/References da última e Para/Cc', async () => {
    const { outbox, st, after } = await setup();
    const item = await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'Bruno, previsão até sexta.', cc: 'bia@x.com, ana@x.com', to: 'bruno@x.com' }, { confirmed: true });
    expect(item.status).toBe(QUEUED);
    expect(item.undo_until).toBe(T0 + UNDO_SECONDS * 1000);
    expect(scheduled).toEqual([UNDO_SECONDS * 1000 + 50]);
    clock = T0 + 9_000;
    expect(await outbox.flush()).toBe(0);
    expect(await outbox.flush({ force: true })).toBe(0); // nem o sync fura a janela
    expect(st.calls).toEqual([]);
    clock = T0 + 10_001;
    expect(await outbox.flush()).toBe(1);
    expect(st.sent).toHaveLength(1);
    expect(st.sent[0].threadId).toBe('t1');
    const mime = decode(st.sent[0].raw);
    expect(headerOf(mime, 'To')).toBe('bruno@x.com');
    expect(headerOf(mime, 'Cc')).toBe('bia@x.com, ana@x.com');
    expect(headerOf(mime, 'In-Reply-To')).toBe('<m3@x.com>');
    expect(headerOf(mime, 'References')).toBe('<m3@x.com>');
    expect(bodyOf(mime)).toBe('Bruno, previsão até sexta.');
    const done = (await outbox.get(item.id))!;
    expect(done.status).toBe(SENT);
    expect(done.result).toMatchObject({ id: 'sent1', to: 'bruno@x.com' });
    expect(after).toEqual([item.id]);
    // de novo: não reenvia
    clock += 60_000;
    expect(await outbox.flush({ force: true })).toBe(0);
    expect(st.sent).toHaveLength(1);
  });

  it('resposta a uma mensagem do meio: Para escolhido e References com a cadeia dela', async () => {
    const { outbox, st } = await setup();
    await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'Ana, ok.', reply_to: 'Ana <ANA@x.com>', reply_to_message_id: 'm2' }, { confirmed: true });
    clock += 11_000;
    await outbox.flush();
    const mime = decode(st.sent[0].raw);
    expect(headerOf(mime, 'To')).toBe('ana@x.com');
    expect(headerOf(mime, 'In-Reply-To')).toBe('<m2@confrapag>');
    expect(headerOf(mime, 'References')).toBe('<m1@x.com> <m2@confrapag>');
    // já começava com "Re:": não ganha outro
    expect(decodeWords(headerOf(mime, 'Subject')!)).toBe('Re: Roteamento do pix estático');
  });

  it('cancelar dentro da janela: nunca sai; depois de enviado não cancela', async () => {
    const { outbox, st } = await setup();
    const a = await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'primeiro' }, { confirmed: true });
    const c = await outbox.cancel(a.id);
    expect(c.status).toBe(CANCELLED);
    clock += 60_000;
    expect(await outbox.flush({ force: true })).toBe(0);
    expect(st.sent).toEqual([]);
    const b = await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'segundo' }, { confirmed: true });
    clock += 11_000;
    await outbox.flush();
    await expect(outbox.cancel(b.id)).rejects.toThrow('já está saindo (ou já saiu)');
  });

  it('mesmo texto para a mesma thread/Para não duplica (duplo toque)', async () => {
    const { outbox, st } = await setup();
    const a = await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'igual', to: 'bruno@x.com' }, { confirmed: true });
    const b = await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: ' igual ', to: 'bruno@x.com' }, { confirmed: true });
    expect(b.id).toBe(a.id);
    expect(await outbox.list()).toHaveLength(1);
    clock += 11_000;
    await Promise.all([outbox.flush(), outbox.flush(), outbox.flush({ force: true })]);
    expect(st.sent).toHaveLength(1);
  });

  it('sem rede: fica na fila com espera; o sync (force) reenvia quando volta, uma vez só', async () => {
    const { outbox, st } = await setup();
    const a = await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'offline' }, { confirmed: true });
    st.offline = true;
    clock += 11_000;
    expect(await outbox.flush()).toBe(0);
    let cur = (await outbox.get(a.id))!;
    expect(cur.status).toBe(QUEUED);
    expect(cur.attempts).toBe(1);
    expect(cur.last_error).toBe('Sem conexão com o Gmail.');
    expect(cur.undo_until).toBe(0);
    expect((await outbox.counts()).pending).toBe(1);
    // ainda na espera crescente: o flush normal não tenta
    st.offline = false;
    st.calls.length = 0;
    expect(await outbox.flush()).toBe(0);
    expect(st.calls).toEqual([]);
    // volta ao app / sync: força
    expect(await outbox.flush({ force: true })).toBe(1);
    cur = (await outbox.get(a.id))!;
    expect(cur.status).toBe(SENT);
    expect(cur.attempts).toBe(2);
    expect(st.sent).toHaveLength(1);
    expect(await outbox.flush({ force: true })).toBe(0);
    expect(st.sent).toHaveLength(1);
  });

  it('erro definitivo vira "falhou" (pode cancelar ou tentar de novo); 5xx fica na fila', async () => {
    const { outbox, st } = await setup();
    const a = await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'x', reply_to: 'não-é-email' } as never, { confirmed: true }).catch((e) => e);
    expect(a).toBeInstanceOf(Error); // e-mail inválido: nem entra na fila
    st.sendStatus = 503;
    const b = await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'y' }, { confirmed: true });
    clock += 11_000;
    await outbox.flush();
    expect((await outbox.get(b.id))!.status).toBe(QUEUED);
    st.sendStatus = 400;
    await outbox.flush({ force: true });
    expect((await outbox.get(b.id))!.status).toBe(FAILED);
    st.sendStatus = 200;
    const r = await outbox.retry(b.id);
    expect(r.status).toBe(SENT);
  });

  it('app fechou no meio do envio: vira falhou (não reenvia sozinho)', async () => {
    const { outbox } = await setup();
    const a = await outbox.enqueue({ kind: 'reply', thread_id: 't1', body: 'z' }, { confirmed: true });
    const d = await db.getDb();
    await d.runAsync("UPDATE outbox SET status='sending' WHERE id=?", [a.id]);
    expect(await outbox.recoverInterrupted()).toBe(1);
    expect((await outbox.get(a.id))!.status).toBe(FAILED);
  });

  it('e-mail novo: sem threadId nem In-Reply-To', async () => {
    const { outbox, st } = await setup();
    await outbox.enqueue({ kind: 'new', to: 'carla@x.com', subject: 'Pode assumir? Pix', body: 'Olá, Carla.' }, { confirmed: true });
    clock += 11_000;
    await outbox.flush();
    expect(st.sent[0].threadId).toBeUndefined();
    const mime = decode(st.sent[0].raw);
    expect(headerOf(mime, 'To')).toBe('carla@x.com');
    expect(headerOf(mime, 'Subject')).toBe('Pode assumir? Pix');
    expect(headerOf(mime, 'In-Reply-To')).toBeUndefined();
  });
});
