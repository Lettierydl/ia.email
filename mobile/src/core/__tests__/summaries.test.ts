// Resumos sob demanda: prompts, limpeza e cache idênticos a resumo_detalhado /
// resumo_mensagem de app/copilot.py (rodado com o Python do .venv, -I, funções
// extraídas via ast e stubs — sem importar o app); modelos de resumo iguais a
// app/summary_templates.py. IA falsa; SQLite em memória; nenhuma rede.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import * as db from '../db';
import { setAccount } from '../copilot';
import { createSummaries, msgHash } from '../summaries';
import { sha256Hex } from '../sha256';
import * as templates from '../summaryTemplates';
import { nodeDriver } from '../__testutils__/fixtures';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

const ROOT = resolve(__dirname, '../../../..');
const PY = [resolve(ROOT, '.venv/bin/python3'), resolve(ROOT, '.venv/bin/python')].find((p) => existsSync(p));
const itPy = PY ? it : it.skip;

const ME = 'leo@confrapag.com.br';
const BODY =
  'De: Ana Souza <ana@x.com>\nData: Thu, 22 Oct 2026 10:44:00 -0300\n\n' +
  'Leo, o roteamento do pix estático está caindo no adquirente errado desde segunda (EC 123, R$ 9.813,07). Vocês conseguem ajustar até sexta 30/10?\n\n----\n\n' +
  `De: Leo <${ME}>\nData: Thu, 22 Oct 2026 11:00:00 -0300\n\nAna, vou verificar com o time.\n\n` +
  'Em qui., 22 de out. de 2026 às 10:44, Ana Souza <ana@x.com> escreveu:\n> Leo, o roteamento do pix estático está caindo\n\n----\n\n' +
  'De: Bruno Lima <bruno@x.com>\nData: Fri, 23 Oct 2026 09:10:00 -0300\n\n' +
  'Complementando: o EC 123 também reclamou. Precisamos de uma previsão para o cliente — anexo o relatório.xlsx 😀';
const NOTES = 'Aprendizados que o Leo registrou (regras e contexto — siga-os quando pertinentes):\n- (geral) sempre citar o EC\n\n';
const SOURCES = [{ tipo: 'decisao', titulo: 'Você já fez "delegar" em: Pix', texto: 'Em 2026-09-01 você escolheu delegar (douglas@x.com).' + ' x'.repeat(400) }];
const FILES = ['relatorio.xlsx', 'print.png'];

const PY_SCRIPT = `
import __future__, ast, contextlib, hashlib, io, json, re, sys, types
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
    has_key = staticmethod(lambda: data["has_key"])
    @staticmethod
    def complete(prompt, *a, **k):
        prompts.append(prompt)
        r = replies.pop(0)
        if r == "!ERR":
            raise Exception("boom 429 " + "x" * 200)
        return r
secrets_guard = load("secrets_guard", root + "/app/secrets_guard.py")
row = dict(data["row"])
resumos = {}
msg_resumos = {}
class store:
    get_thread = staticmethod(lambda tid: dict(row) if tid == row["id"] else None)
    @staticmethod
    def save_copilot_resumo(tid, js, idate, count):
        resumos[tid] = {"thread_id": tid, "resumo_json": js, "internal_date_snapshot": idate, "msg_count_snapshot": count, "gerado_em": "G"}
    get_copilot_resumo = staticmethod(lambda tid: resumos.get(tid))
    @staticmethod
    def save_copilot_msg_resumo(tid, h, modo, js):
        msg_resumos[(tid, h, modo)] = {"resumo_json": js, "gerado_em": "G", "msg_hash": h}
    get_copilot_msg_resumo = staticmethod(lambda tid, h, modo: msg_resumos.get((tid, h, modo)))
class learned:
    notes_block = staticmethod(lambda *a, **k: data["notes"])
    thread_emails = staticmethod(lambda row: [])

WANT = {"_clip", "_loads", "_parse", "_HEAD_RE", "_messages", "_msg_count", "_QUOTE_START_RE", "_own_text",
        "_RESUMO_LISTAS", "_resumo_prompt", "_clean_resumo", "_resumo_out", "resumo_detalhado",
        "MSG_RESUMO_MODOS", "_MSG_RESUMO_LISTAS", "_msg_resumo_prompt", "_clean_msg_resumo", "_msg_resumo_target",
        "_msg_resumo_out", "resumo_mensagem"}
src = open(root + "/app/copilot.py", encoding="utf-8").read()
tree = ast.parse(src)
nodes = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in WANT)
         or (isinstance(n, ast.Assign) and len(n.targets) == 1 and getattr(n.targets[0], "id", "") in WANT)]
ns = {"re": re, "json": json, "hashlib": hashlib, "store": store, "llm": llm, "learned": learned,
      "secrets_guard": secrets_guard, "__name__": "copilot_stub"}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "copilot.resumos", "exec", flags=__future__.annotations.compiler_flag, dont_inherit=True), ns)
ns["_thread_body"] = lambda r: data["body"]
ns["_thread_files"] = lambda tid: data["files"]
ns["_sources"] = lambda r, body: data["sources"]
results = []
for op in data["ops"]:
    try:
        if op["fn"] == "bump":
            row["internal_date"] = op["internal_date"]
            continue
        if op["fn"] == "detalhado":
            r = ns["resumo_detalhado"](row["id"], force=op.get("force", False))
        else:
            r = ns["resumo_mensagem"](row["id"], op["idx"], op["modo"], force=op.get("force", False), only_cached=op.get("only_cached", False))
        r.pop("gerado_em", None)
        results.append({"ok": r})
    except Exception as exc:
        results.append({"error": str(exc)})
sys.stdout.write(json.dumps({"prompts": prompts, "results": results, "hashes": sorted(k[1] for k in msg_resumos)}))
`;

type Op =
  | { fn: 'bump'; internal_date: number }
  | { fn: 'detalhado'; force?: boolean }
  | { fn: 'msg'; idx: number; modo: 'direto' | 'abrangente'; force?: boolean; only_cached?: boolean };

interface Case {
  replies: string[];
  ops: Op[];
  hasKey?: boolean;
  body?: string;
}

const ROW = {
  id: 't1', subject: 'Re: Roteamento do pix estático', from_email: 'bruno@x.com', from_name: 'Bruno Lima', internal_date: 1_792_000_000_000,
  is_unread: 1, to_header: ME, cc_header: 'ana@x.com', last_from_header: 'Bruno Lima <bruno@x.com>',
};

function python(c: Case) {
  const input = JSON.stringify({
    row: ROW, body: c.body ?? BODY, files: FILES, sources: SOURCES, notes: NOTES, replies: c.replies, ops: c.ops, has_key: c.hasKey ?? true,
  });
  const r = spawnSync(PY!, ['-I', '-c', PY_SCRIPT, ROOT], { input, encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) throw new Error(`python falhou: ${r.stderr}`);
  return JSON.parse(r.stdout) as { prompts: string[]; results: ({ ok: Record<string, unknown> } | { error: string })[]; hashes: string[] };
}

function fakeLlm(replies: string[]) {
  const prompts: string[] = [];
  const queue = [...replies];
  return {
    prompts,
    llm: {
      complete: async (p: string) => {
        prompts.push(p);
        const r = queue.shift() ?? '';
        if (r === '!ERR') throw new Error('boom 429 ' + 'x'.repeat(200));
        return r;
      },
    },
  };
}

async function setupTs(c: Partial<Case> = {}) {
  await db.upsertThread(ROW);
  const fake = fakeLlm(c.replies || []);
  const summaries = createSummaries({
    llm: fake.llm,
    hasKey: async () => c.hasKey ?? true,
    ensureBody: async () => c.body ?? BODY,
    threadFiles: async () => FILES,
    sources: async () => SOURCES,
    notesBlock: async () => NOTES,
  });
  return { summaries, prompts: fake.prompts };
}

async function runTs(c: Case) {
  const { summaries, prompts } = await setupTs(c);
  const results: ({ ok: Record<string, unknown> } | { error: string })[] = [];
  for (const op of c.ops) {
    try {
      if (op.fn === 'bump') {
        await db.upsertThread({ ...ROW, internal_date: op.internal_date });
        continue;
      }
      const r = (
        op.fn === 'detalhado'
          ? await summaries.resumoDetalhado('t1', { force: op.force })
          : await summaries.resumoMensagem('t1', op.idx, op.modo, { force: op.force, onlyCached: op.only_cached })
      ) as unknown as Record<string, unknown>;
      const { gerado_em: _g, ...rest } = r;
      results.push({ ok: JSON.parse(JSON.stringify(rest)) });
    } catch (e) {
      results.push({ error: (e as Error).message });
    }
  }
  return { prompts, results };
}

const DETAIL_JSON =
  'Claro! Segue:\n```json\n' +
  JSON.stringify({
    contexto: '  Ana relata erro no roteamento do pix.  ',
    pontos_principais: ['  roteamento   caindo no adquirente errado ', '', 42, true, null, 'EC 123 reclamou'],
    numeros_dados: ['R$ 9.813,07 — valor citado'],
    pedidos_ao_leo: 'não é lista',
    pedidos_a_outros: [{ nome: 'Bruno', pedido: ' previsão ' }, { nome: 'X' }, 'solto', { pedido: 'sem nome' }],
    prazos: [{ data: '30/10', o_que: 'ajuste' }, { data: '', o_que: '' }],
    decisoes_riscos: [],
    proximos_passos: ['Você: responder'],
  }) +
  '\n```';

const CASES: Record<string, Case> = {
  'detalhado: gera, reabre do cache, mensagem nova invalida, Regerar com IA fora → cache velho com aviso': {
    replies: [DETAIL_JSON, JSON.stringify({ contexto: 'novo' }), '!ERR'],
    ops: [
      { fn: 'detalhado' },
      { fn: 'detalhado' },
      { fn: 'bump', internal_date: 1_792_000_100_000 },
      { fn: 'detalhado' },
      { fn: 'detalhado', force: true },
    ],
  },
  'detalhado: resposta fora do formato sem cache → erro': {
    replies: ['não sei responder'],
    ops: [{ fn: 'detalhado' }],
  },
  'detalhado: sem chave de IA → erro sem chamar a IA': { replies: [], hasKey: false, ops: [{ fn: 'detalhado' }] },
  'detalhado: credencial na conversa → não manda para a IA': {
    replies: [], body: 'De: A <a@x.com>\nData: x\n\nsegue a senha: Abc123!xyz para entrar no painel de produção amanhã cedo', ops: [{ fn: 'detalhado' }],
  },
  'mensagem: direto (corta em 5), cache por hash, abrangente, só cache, Regerar e idx/modo inválidos': {
    replies: [
      JSON.stringify({ principal: '  pedido   de ajuste ', bullets: ['a', 'b', '', 'c', 'd', 'e', 'f'] }),
      JSON.stringify({
        contexto: 'Bruno complementa.', pontos_principais: ['EC 123'], numeros_dados: [], riscos: ['cliente sem previsão'],
        pedidos_por_pessoa: [{ nome: 'Você', pedido: 'dar previsão' }, { nome: 'Ana' }], prazos: [],
      }),
      JSON.stringify({ principal: 'regerado', bullets: ['z'] }),
      JSON.stringify({ principal: 'Leo vai verificar', bullets: [] }),
    ],
    ops: [
      { fn: 'msg', idx: 0, modo: 'abrangente', only_cached: true },
      { fn: 'msg', idx: 0, modo: 'direto' },
      { fn: 'msg', idx: 0, modo: 'direto' },
      { fn: 'msg', idx: 2, modo: 'abrangente' },
      { fn: 'msg', idx: 2, modo: 'abrangente', only_cached: true },
      { fn: 'msg', idx: 0, modo: 'direto', force: true },
      { fn: 'msg', idx: 1, modo: 'direto' },
      { fn: 'msg', idx: 9, modo: 'direto' },
      { fn: 'msg', idx: 0, modo: 'resumao' as never },
    ],
  },
  'mensagem: IA fora e resposta fora do formato': {
    replies: ['!ERR', 'texto solto'],
    ops: [{ fn: 'msg', idx: 0, modo: 'direto' }, { fn: 'msg', idx: 0, modo: 'direto' }],
  },
};

beforeEach(async () => {
  await db.attachDb(nodeDriver());
  setAccount(ME);
});

describe('resumos: prompts, limpeza e cache idênticos ao Python', () => {
  for (const [name, c] of Object.entries(CASES)) {
    itPy(name, async () => {
      const ts = await runTs(c);
      const py = python(c);
      expect(ts.prompts).toEqual(py.prompts);
      expect(ts.results).toEqual(py.results);
    });
  }
});

describe('resumo detalhado (cache local)', () => {
  it('cache hit não chama a IA; mensagem nova marca desatualizado e regera', async () => {
    const { summaries, prompts } = await setupTs({ replies: [JSON.stringify({ contexto: 'um' }), JSON.stringify({ contexto: 'dois' })] });
    const a = await summaries.resumoDetalhado('t1');
    expect(a).toMatchObject({ cached: false, desatualizado: false, resumo: { contexto: 'um', pontos_principais: [] } });
    const b = await summaries.resumoDetalhado('t1');
    expect(b.cached).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Anexos recebidos na thread: relatorio.xlsx, print.png');
    expect(prompts[0]).toContain(NOTES);
    await db.upsertThread({ ...ROW, internal_date: ROW.internal_date + 1 });
    const c = await summaries.resumoDetalhado('t1');
    expect(c).toMatchObject({ cached: false, resumo: { contexto: 'dois' } });
    expect(prompts).toHaveLength(2);
    const row = await db.getCopilotResumo('t1');
    expect(row).toMatchObject({ internal_date_snapshot: ROW.internal_date + 1, msg_count_snapshot: 3 });
  });

  it('nº de mensagens diferente do retrato também invalida', async () => {
    const { summaries, prompts } = await setupTs({ replies: [JSON.stringify({ contexto: 'um' }), JSON.stringify({ contexto: 'dois' })] });
    await summaries.resumoDetalhado('t1');
    await db.saveCopilotResumo('t1', JSON.stringify({ contexto: 'um' }), ROW.internal_date, 2);
    expect((await summaries.resumoDetalhado('t1')).resumo).toMatchObject({ contexto: 'dois' });
    expect(prompts).toHaveLength(2);
  });

  it('force (Regerar) refaz mesmo com cache novo', async () => {
    const { summaries, prompts } = await setupTs({ replies: [JSON.stringify({ contexto: 'um' }), JSON.stringify({ contexto: 'dois' })] });
    await summaries.resumoDetalhado('t1');
    const r = await summaries.resumoDetalhado('t1', { force: true });
    expect(r).toMatchObject({ cached: false, resumo: { contexto: 'dois' } });
    expect(prompts).toHaveLength(2);
  });

  it('IA fora com cache desatualizado: devolve o velho avisado', async () => {
    const { summaries } = await setupTs({ replies: [JSON.stringify({ contexto: 'um' }), '!ERR'] });
    await summaries.resumoDetalhado('t1');
    await db.upsertThread({ ...ROW, internal_date: ROW.internal_date + 5 });
    const r = await summaries.resumoDetalhado('t1');
    expect(r).toMatchObject({ cached: true, desatualizado: true, resumo: { contexto: 'um' } });
    expect(r.aviso).toMatch(/^A IA não respondeu agora \(boom 429/);
  });

  it('thread inexistente', async () => {
    const { summaries } = await setupTs();
    await expect(summaries.resumoDetalhado('nada')).rejects.toThrow('Thread não encontrada.');
  });
});

describe('resumo por mensagem (cache local)', () => {
  it('chave = sha256 do texto (32 hex), igual ao hashlib', () => {
    for (const t of ['', 'abc', 'Olá, mundo — ação 😀\n'.repeat(50), 'x'.repeat(1000)]) {
      expect(sha256Hex(t)).toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
    }
    expect(msgHash('Ana', 'qui', 'oi')).toBe(createHash('sha256').update('Ana\nqui\noi').digest('hex').slice(0, 32));
  });

  it('só cache nunca chama a IA; o texto mudou = outra chave', async () => {
    const { summaries, prompts } = await setupTs({ replies: [JSON.stringify({ principal: 'p', bullets: ['a'] })] });
    expect(await summaries.resumoMensagem('t1', 0, 'direto', { onlyCached: true })).toEqual({ idx: 0, modo: 'direto', resumo: null, gerado_em: '', cached: false });
    expect(prompts).toHaveLength(0);
    await summaries.resumoMensagem('t1', 0, 'direto');
    expect((await summaries.resumoMensagem('t1', 0, 'direto', { onlyCached: true })).resumo).toEqual({ principal: 'p', bullets: ['a'] });
    // o mesmo idx com outro texto (corpo mudou) não reaproveita
    const other = createSummaries({
      llm: fakeLlm([]).llm, hasKey: async () => true, notesBlock: async () => '', sources: async () => [],
      ensureBody: async () => BODY.replace('desde segunda', 'desde terça'),
    });
    expect((await other.resumoMensagem('t1', 0, 'direto', { onlyCached: true })).resumo).toBeNull();
  });

  it('mensagem só com citação não vai para a IA', async () => {
    const { summaries, prompts } = await setupTs({ body: 'De: A <a@x.com>\nData: x\n\nok\n\nEm qui., A escreveu:\n> texto antigo bem longo aqui' });
    await expect(summaries.resumoMensagem('t1', 0, 'direto')).rejects.toThrow('não tem texto próprio');
    expect(prompts).toHaveLength(0);
  });
});

describe('modelos de resumo (summary_templates.py)', () => {
  itPy('build_system / example / json_spec / all_headers / is_default iguais ao Python', () => {
    const settings = [
      {}, { summary_template: 'curto' }, { summary_template: 'pessoa', summary_custom: '  cite valores  ' }, { summary_template: 'acao' },
      { summary_template: 'cronologia' }, { summary_template: 'inexistente' }, { summary_template: null, summary_custom: 'x' },
    ];
    const script = `
import json, sys, types
mod = types.ModuleType("summary_templates")
exec(open(sys.argv[1] + "/app/summary_templates.py", encoding="utf-8").read(), mod.__dict__)
settings = json.load(sys.stdin)
out = {"spec": mod.json_spec(), "headers": mod.all_headers(), "keys": list(mod.TEMPLATES),
       "templates": mod.TEMPLATES,
       "each": [{"system": mod.build_system(s), "example": mod.example(s), "default": mod.is_default(s)} for s in settings]}
sys.stdout.write(json.dumps(out))`;
    const r = spawnSync(PY!, ['-I', '-c', script, ROOT], { input: JSON.stringify(settings), encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) throw new Error(r.stderr);
    const py = JSON.parse(r.stdout);
    expect(templates.jsonSpec()).toBe(py.spec);
    expect(templates.allHeaders()).toEqual(py.headers);
    expect(Object.keys(templates.TEMPLATES)).toEqual(py.keys);
    expect(templates.TEMPLATES).toEqual(py.templates);
    expect(settings.map((s) => ({ system: templates.buildSystem(s), example: templates.example(s), default: templates.isDefault(s) }))).toEqual(py.each);
  });
});
