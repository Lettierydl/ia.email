// Verificar na caixa: prompts, consultas saneadas, vereditos e cache idênticos a
// app/verify.py (rodado com o Python do .venv, -I, com stubs — sem importar o
// app). Gmail falso servido como a REST API (fetch fake): só GET em
// messages.list / messages.get metadata — nenhum modify, send ou rótulo.
// IA falsa; SQLite em memória; nenhuma rede.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import * as db from '../db';
import { setAccount } from '../copilot';
import { createGmail, type GmailFetch } from '../gmail';
import { createVerify, hojeLabel, sanitizeQuery } from '../verify';
import { fakeFetch, nodeDriver } from '../__testutils__/fixtures';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

const ROOT = resolve(__dirname, '../../../..');
const PY = [resolve(ROOT, '.venv/bin/python3'), resolve(ROOT, '.venv/bin/python')].find((p) => existsSync(p));
const itPy = PY ? it : it.skip;

const ME = 'leo@confrapag.com.br';
const HOJE = '24/10/2026 (Saturday)';
const BODY =
  'De: Ana Souza <ana@x.com>\nData: Mon, 05 Oct 2026 10:44:00 -0300\n\n' +
  'Leo, te mandei o link de acesso ao portal no dia 05/10 e o relatório em anexo dia 07/10. Pode confirmar?\n\n----\n\n' +
  'De: Bruno Lima <bruno@x.com>\nData: Fri, 23 Oct 2026 09:10:00 -0300\n\n' +
  'Também encaminhei o boleto para você semana passada.';

const ROW = {
  id: 't1', subject: 'Acesso ao portal', from_email: 'bruno@x.com', from_name: 'Bruno Lima', internal_date: 1_792_000_000_000,
  is_unread: 1, to_header: ME, cc_header: 'ana@x.com', last_from_header: 'Bruno Lima <bruno@x.com>',
};

interface FakeMsg {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  headers: Record<string, string>;
}

const MSGS: Record<string, FakeMsg> = {
  m1: {
    id: 'm1', threadId: 't9', labelIds: ['INBOX'], snippet: 'Segue o link de acesso &amp; instruções', internalDate: '1791000000000',
    headers: { From: 'Ana Souza <ana@x.com>', To: ME, Subject: 'Link de acesso', Date: 'Mon, 05 Oct 2026 10:00:00 -0300' },
  },
  m2: {
    id: 'm2', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], snippet: 'Leo, te mandei o link', internalDate: '1792000000000',
    headers: { From: 'Ana Souza <ana@x.com>', To: ME, Cc: 'bruno@x.com', Subject: 'Acesso ao portal', Date: 'Mon, 05 Oct 2026 10:44:00 -0300' },
  },
  m3: {
    id: 'm3', threadId: 't8', labelIds: ['TRASH'], snippet: 'sua senha: Abc123!xyz temporária', internalDate: '1791500000000',
    headers: { From: 'portal@x.com', To: ME, Subject: 'Credenciais', Date: 'Tue, 06 Oct 2026 08:00:00 -0300' },
  },
  m4: {
    id: 'm4', threadId: 't7', labelIds: ['SENT'], snippet: 'Recebi, obrigado', internalDate: '1791600000000',
    headers: { From: ME, To: 'ana@x.com', Subject: 'Re: relatório', Date: 'Wed, 07 Oct 2026 12:00:00 -0300' },
  },
};

/** q → ids das mensagens (ou "!ERR" = Gmail falha nessa consulta). */
type Search = Record<string, string[] | '!ERR'>;

/** Gmail falso pela REST API: messages.list (q) e messages.get format=metadata. */
function fakeGmail(search: Search) {
  const { fn, calls } = fakeFetch((url) => {
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (path === '/messages') {
      const hit = search[url.searchParams.get('q') || ''] ?? [];
      if (hit === '!ERR') return { status: 503, body: { error: { message: 'Backend Error' } } };
      const max = Number(url.searchParams.get('maxResults') || 100);
      return { status: 200, body: { messages: hit.slice(0, max).map((id) => ({ id, threadId: MSGS[id].threadId })) } };
    }
    const m = /^\/messages\/([^/]+)$/.exec(path);
    if (m && url.searchParams.get('format') === 'metadata') {
      const msg = MSGS[decodeURIComponent(m[1])];
      const wanted = url.searchParams.getAll('metadataHeaders');
      return {
        status: 200,
        body: {
          id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, snippet: msg.snippet, internalDate: msg.internalDate,
          payload: { headers: Object.entries(msg.headers).filter(([k]) => wanted.includes(k)).map(([name, value]) => ({ name, value })) },
        },
      };
    }
    return { status: 404, body: { error: { message: 'Not Found' } } };
  });
  const gmail = createGmail({ fetch: fn as unknown as GmailFetch, getAccessToken: async () => 'tok-fake' });
  return { gmail, calls };
}

const PY_SCRIPT = `
import __future__, ast, json, re, sys, types
root = sys.argv[1]
data = json.load(sys.stdin)

def load(name, path, inject=None):
    src = open(path, encoding="utf-8").read()
    src = re.sub(r"^from \\. import .*$", "", src, flags=re.M)
    mod = types.ModuleType(name)
    if inject:
        mod.__dict__.update(inject)
    exec(compile(src, path, "exec", flags=__future__.annotations.compiler_flag, dont_inherit=True), mod.__dict__)
    return mod

prompts = []
replies = list(data["replies"])
class llm:
    SYSTEM = "S"
    has_key = staticmethod(lambda: True)
    @staticmethod
    def complete(prompt, *a, **k):
        prompts.append(prompt)
        r = replies.pop(0)
        if r == "!ERR":
            raise Exception("boom 429")
        return r
secrets_guard = load("secrets_guard", root + "/app/secrets_guard.py")
row = dict(data["row"])
cache = {}
class store:
    get_thread = staticmethod(lambda tid: dict(row) if tid == row["id"] else None)
    @staticmethod
    def save_copilot_verificacao(tid, js, idate, count):
        cache[tid] = {"resultado_json": js, "internal_date_snapshot": idate, "msg_count_snapshot": count, "gerado_em": "G"}
    get_copilot_verificacao = staticmethod(lambda tid: cache.get(tid))
searched = []
class gmail_client:
    load_credentials = staticmethod(lambda: True)
    @staticmethod
    def search_messages(q, max_results=5):
        searched.append(q)
        ids = data["search"].get(q, [])
        if ids == "!ERR":
            raise Exception("Erro do Gmail (HTTP 503): Backend Error.")
        out = []
        for mid in ids[:max_results]:
            m = data["msgs"][mid]
            h = {k.lower(): v for k, v in m["headers"].items()}
            out.append({"message_id": m["id"], "thread_id": m["threadId"], "assunto": h.get("subject") or "", "de": h.get("from") or "",
                        "para": h.get("to") or "", "cc": h.get("cc") or "", "data": h.get("date") or "",
                        "internal_date": int(m["internalDate"]), "snippet": m["snippet"], "labels": list(m["labelIds"])})
        return out
class config:
    ACCOUNT = "${ME}"

WANT = {"_clip", "_loads", "_parse", "_HEAD_RE", "_messages", "_msg_count"}
tree = ast.parse(open(root + "/app/copilot.py", encoding="utf-8").read())
nodes = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in WANT)
         or (isinstance(n, ast.Assign) and len(n.targets) == 1 and getattr(n.targets[0], "id", "") in WANT)]
copilot = types.ModuleType("copilot")
copilot.__dict__.update({"re": re, "json": json})
exec(compile(ast.Module(body=nodes, type_ignores=[]), "copilot.partes", "exec", flags=__future__.annotations.compiler_flag, dont_inherit=True), copilot.__dict__)
copilot._thread_body = lambda r: data["body"]
verify = load("verify", root + "/app/verify.py", {"config": config, "copilot": copilot, "gmail_client": gmail_client, "llm": llm,
                                                   "secrets_guard": secrets_guard, "store": store})
verify._hoje = lambda: data["hoje"]
results = []
for op in data["ops"]:
    try:
        if op["fn"] == "bump":
            row["internal_date"] = op["internal_date"]
            continue
        r = verify.cached(row["id"]) if op["fn"] == "cached" else verify.verificar(row["id"], force=op.get("force", False))
        r.pop("gerado_em", None)
        results.append({"ok": r})
    except Exception as exc:
        results.append({"error": str(exc)})
queries = [verify.sanitize_query(q) for q in data["queries"]]
sys.stdout.write(json.dumps({"prompts": prompts, "results": results, "searched": searched, "queries": queries}))
`;

type Op = { fn: 'verificar'; force?: boolean } | { fn: 'cached' } | { fn: 'bump'; internal_date: number };
interface Case {
  replies: string[];
  search: Search;
  ops: Op[];
}

function python(c: Case, queries: string[] = []) {
  const input = JSON.stringify({ row: ROW, body: BODY, hoje: HOJE, msgs: MSGS, search: c.search, replies: c.replies, ops: c.ops, queries });
  const r = spawnSync(PY!, ['-I', '-c', PY_SCRIPT, ROOT], { input, encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) throw new Error(`python falhou: ${r.stderr}`);
  return JSON.parse(r.stdout) as { prompts: string[]; results: unknown[]; searched: string[]; queries: string[] };
}

function setup(c: Pick<Case, 'replies' | 'search'>, opts: { hasKey?: boolean; gmailReady?: boolean } = {}) {
  const prompts: string[] = [];
  const queue = [...c.replies];
  const { gmail, calls } = fakeGmail(c.search);
  const searched: string[] = [];
  const verify = createVerify({
    llm: {
      complete: async (p: string) => {
        prompts.push(p);
        const r = queue.shift() ?? '';
        if (r === '!ERR') throw new Error('boom 429');
        return r;
      },
    },
    hasKey: async () => opts.hasKey ?? true,
    gmail: {
      searchMessages: (q, max) => {
        searched.push(q);
        return gmail.searchMessages(q, max);
      },
    },
    gmailReady: async () => opts.gmailReady ?? true,
    ensureBody: async () => BODY,
    me: () => ME,
    now: () => Date.UTC(2026, 9, 24, 15, 0),
  });
  return { verify, prompts, calls, searched };
}

async function runTs(c: Case) {
  await db.upsertThread(ROW);
  const { verify, prompts, calls, searched } = setup(c);
  const results: unknown[] = [];
  for (const op of c.ops) {
    try {
      if (op.fn === 'bump') {
        await db.upsertThread({ ...ROW, internal_date: op.internal_date });
        continue;
      }
      const r = (op.fn === 'cached' ? await verify.cached('t1') : await verify.verificar('t1', { force: op.force })) as unknown as Record<string, unknown>;
      const { gerado_em: _g, ...rest } = r;
      results.push({ ok: JSON.parse(JSON.stringify(rest)) });
    } catch (e) {
      results.push({ error: (e as Error).message });
    }
  }
  return { prompts, results, calls, searched };
}

const EXTRACT = JSON.stringify({
  afirmacoes: [
    {
      texto: '  Você recebeu de Ana o link de acesso   por volta de 05/10 ',
      consultas: [
        'from:ana@x.com after:2026/10/03 before:2026/10/08 in:anywhere',
        'from:ana@x.com after:2026/10/03 before:2026/10/08 in:anywhere',
        'label:importante deliveredto:leo@x.com "link de acesso" OR',
        'acesso link in:anywhere newer_than:14d',
      ],
    },
    { texto: 'Ana mandou o relatório em anexo dia 07/10', consultas: ['from:ana@x.com has:attachment filename:relatorio.pdf after:2026-10-6', 'subject:"Re: relatório!!"'] },
    { texto: '', consultas: ['x'] },
    'não é dict',
    { texto: 'Bruno encaminhou o boleto', consultas: ['{boleto} label:x', 'from:"Bruno Lima" boleto in:sent'] },
    { texto: 'Algo sem busca', consultas: 'não é lista' },
  ],
});

const JUDGE = JSON.stringify({
  avaliacoes: [
    { n: '1', veredito: 'Confirmado', explicacao: 'Ana mandou o link em 05/10.', evidencias: ['[E1]', 'E9'] },
    { n: 1, veredito: 'nao_encontrado', explicacao: 'duplicada (ignorada)' },
    { n: 'dois', veredito: 'não encontrado', explicacao: '' },
    { veredito: 'talvez', evidencias: [] },
  ],
});

const SEARCH: Search = {
  'from:ana@x.com after:2026/10/03 before:2026/10/08 in:anywhere': ['m1', 'm2'],
  '"link de acesso" OR': [],
  '"link de acesso"': ['m1'],
  'acesso link in:anywhere newer_than:14d': ['m1', 'm3', 'm2'],
  'from:ana@x.com has:attachment filename:relatorio.pdf after:2026/10/06': '!ERR',
  'subject:"Re relatório"': ['m4'],
  'boleto': [],
  'from:"Bruno Lima" boleto in:sent': [],
};

const CASES: Record<string, Case> = {
  'extrai → busca saneada (só leitura) → avalia; cache, desatualizado e Regerar': {
    replies: [EXTRACT, JUDGE, EXTRACT, JUDGE, JSON.stringify({ afirmacoes: [] })],
    search: SEARCH,
    ops: [
      { fn: 'cached' },
      { fn: 'verificar' },
      { fn: 'cached' },
      { fn: 'verificar' },
      { fn: 'bump', internal_date: 1_792_000_100_000 },
      { fn: 'cached' },
      { fn: 'verificar' },
      { fn: 'verificar', force: true },
    ],
  },
  'buscas sem resultado: não chama a IA para julgar': {
    replies: [JSON.stringify({ afirmacoes: [{ texto: 'Bruno encaminhou o boleto', consultas: ['boleto'] }] })],
    search: SEARCH,
    ops: [{ fn: 'verificar' }],
  },
  'Gmail falhou em todas as consultas → erro amigável': {
    replies: [JSON.stringify({ afirmacoes: [{ texto: 'x recebeu y', consultas: ['from:ana@x.com has:attachment filename:relatorio.pdf after:2026/10/06'] }] })],
    search: SEARCH,
    ops: [{ fn: 'verificar' }],
  },
  'IA fora do ar / fora do formato': {
    replies: ['!ERR', '{"outra": 1}', EXTRACT, '!ERR'],
    search: SEARCH,
    ops: [{ fn: 'verificar' }, { fn: 'verificar' }, { fn: 'verificar' }],
  },
};

const QUERIES = [
  'from:ana@x.com after:2026/10/03 before:2026/10/08 in:anywhere',
  'FROM:Ana@X.com AFTER:2026-1-3 before:1980/01/01 in:Sent is:STARRED has:pdf has:virus',
  'label:importante deliveredto:x@y.com {a b} (c) "link de acesso" OR OR -"spam total" -foo',
  'subject:"Re: relatório!!" subject:fatura from:"Ana Souza" to:"" cc:"x"',
  'newer_than:14d older_than:2y newer_than:1w filename:Relatório_Final.PDF filename:a/b.pdf',
  'OR a OR palavra, ação. e-mail@x.com bcc:z@x.com -bcc:w@x.com após:hoje',
  'after:2026/13/01 before:2026/02/31 after:2101/01/01',
  'ação '.repeat(80),
  '"" "a" """ -"" "frase com  espaços" - --x',
  'linha\nnova OR\n',
];

beforeEach(async () => {
  await db.attachDb(nodeDriver());
  setAccount(ME);
});

describe('verificador: idêntico ao Python', () => {
  for (const [name, c] of Object.entries(CASES)) {
    itPy(name, async () => {
      const ts = await runTs(c);
      const py = python(c);
      expect(ts.prompts).toEqual(py.prompts);
      expect(ts.results).toEqual(py.results);
      expect(ts.searched).toEqual(py.searched);
    });
  }

  itPy('sanitize_query', () => {
    const py = python({ replies: [], search: {}, ops: [] }, QUERIES);
    expect(QUERIES.map(sanitizeQuery)).toEqual(py.queries);
  });
});

describe('verificador no aparelho', () => {
  it('Gmail só leitura: apenas GET em messages.list/get metadata, sem modify/send/rótulos', async () => {
    const c = CASES['extrai → busca saneada (só leitura) → avalia; cache, desatualizado e Regerar'];
    const ts = await runTs(c);
    expect(ts.calls.length).toBeGreaterThan(0);
    for (const call of ts.calls) {
      expect(call.method).toBe('GET');
      expect(call.url.pathname).toMatch(/^\/gmail\/v1\/users\/me\/messages(\/[^/]+)?$/);
      if (call.url.pathname.endsWith('/messages')) expect(Number(call.url.searchParams.get('maxResults'))).toBeLessThanOrEqual(5);
      else expect(call.url.searchParams.get('format')).toBe('metadata');
      expect(call.body).toBeUndefined();
    }
    expect(ts.calls.some((x) => /modify|send|labels|trash|drafts/.test(x.url.pathname))).toBe(false);
  });

  it('vereditos, evidências e cache', async () => {
    await db.upsertThread(ROW);
    const { verify, prompts } = setup({ replies: [EXTRACT, JUDGE], search: SEARCH });
    expect(await verify.cached('t1')).toEqual({ afirmacoes: null, gerado_em: '', cached: false, desatualizado: false });
    const r = await verify.verificar('t1');
    expect(r.cached).toBe(false);
    const af = r.afirmacoes!;
    expect(af.map((a) => a.veredito)).toEqual(['confirmado', 'inconclusivo', 'nao_encontrado', 'nao_encontrado']);
    // "n": "dois" não é inteiro → vale para a posição dele (3ª); a 2ª fica sem avaliação → inconclusivo (achou algo)
    expect(af[0].texto).toBe('Você recebeu de Ana o link de acesso por volta de 05/10');
    expect(af[0].evidencias?.map((e) => e.assunto)).toEqual(['Link de acesso']);
    expect(af[0].evidencias?.[0]).toMatchObject({
      pasta: 'Caixa de entrada', mesma_thread: false, snippet: 'Segue o link de acesso & instruções',
      gmail_url: 'https://mail.google.com/mail/?authuser=leo%40confrapag.com.br#all/t9',
    });
    expect(JSON.stringify(af)).not.toContain('Abc123');
    expect(prompts[0]).toContain(`Hoje é ${HOJE}.`);
    // reabrir: cache, sem IA
    expect((await verify.verificar('t1')).cached).toBe(true);
    expect((await verify.cached('t1')).desatualizado).toBe(false);
    expect(prompts).toHaveLength(2);
  });

  it('sem chave de IA / sem Gmail / thread inexistente', async () => {
    await db.upsertThread(ROW);
    await expect(setup({ replies: [], search: {} }, { hasKey: false }).verify.verificar('t1')).rejects.toThrow('Sem chave de IA');
    await expect(setup({ replies: [], search: {} }, { gmailReady: false }).verify.verificar('t1')).rejects.toThrow('O Gmail não está conectado');
    await expect(setup({ replies: [], search: {} }).verify.cached('nada')).rejects.toThrow('Thread não encontrada.');
  });

  it('data de hoje no fuso do app, como o strftime do Python', () => {
    expect(hojeLabel(Date.UTC(2026, 9, 24, 15, 0))).toBe(HOJE);
    expect(hojeLabel(Date.UTC(2026, 9, 25, 2, 0))).toBe('24/10/2026 (Saturday)');
    expect(hojeLabel(Date.UTC(2026, 9, 25, 3, 0))).toBe('25/10/2026 (Sunday)');
  });
});
