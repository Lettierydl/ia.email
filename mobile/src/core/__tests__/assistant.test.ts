// Rascunho com IA: prompts idênticos ao draft() de app/assistant.py (rodado
// com o Python do .venv, -I, funções extraídas via ast e stubs — sem importar
// o app), retry do draftGuard (UMA vez, depois alerta), "usar meu texto" com
// o fixpt. IA falsa; SQLite em memória; nenhuma rede.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import * as db from '../db';
import { createAssistant, type Alvo } from '../assistant';
import { setAccount } from '../copilot';
import * as fixpt from '../fixpt';
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
  'Leo, o roteamento do pix estático está caindo no adquirente errado desde segunda. Vocês conseguem ajustar até sexta?\n\n----\n\n' +
  `De: Leo <${ME}>\nData: Thu, 22 Oct 2026 11:00:00 -0300\n\nAna, vou verificar com o time.\n\n----\n\n` +
  'De: Bruno Lima <bruno@x.com>\nData: Fri, 23 Oct 2026 09:10:00 -0300\n\n' +
  'Complementando: o EC 123 também reclamou. Precisamos de uma previsão para o cliente.';

const PY_SCRIPT = `
import __future__, ast, contextlib, io, json, re, sys, types
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
    has_key = staticmethod(lambda: True)
    @staticmethod
    def complete(prompt, *a, **k):
        prompts.append(prompt)
        return replies.pop(0)
secrets_guard = load("secrets_guard", root + "/app/secrets_guard.py")
draft_guard = load("draft_guard", root + "/app/draft_guard.py")
fixpt = load("fixpt", root + "/app/fixpt.py", {"llm": llm, "secrets_guard": secrets_guard})
saved = {}
class store:
    get_thread = staticmethod(lambda tid: dict(data["row"]))
    save_ai = staticmethod(lambda tid, **kw: saved.update(kw))
    log_event = staticmethod(lambda *a, **k: None)
    get_settings = staticmethod(lambda: {"rag_enabled": False})
    list_aliases = staticmethod(lambda: data["aliases"])
    save_alias = staticmethod(lambda **k: None)
    search_senders = staticmethod(lambda q, limit=6: [])
class learned:
    notes_block = staticmethod(lambda *a, **k: data["notes"])
    thread_emails = staticmethod(lambda row: [])
class attachments:
    extract_context = staticmethod(lambda tid: "")

WANT = {"STYLE_PRESETS", "_MSG_HEAD_RE", "_LEO_ADDR_RE", "_EMAIL_RE", "_load_chat", "_recent_body", "_thread_outline",
        "_style_instructions", "_alias_glossary", "_draft_extra_context", "_parse_draft_response", "_pending_cc_query",
        "_resolve_cc_names", "_clip", "_chat_context", "_request_block", "_same_text", "_alvo_block", "_alvo_ref",
        "draft", "_guard_leaks", "_draft_keep_text"}
src = open(root + "/app/assistant.py", encoding="utf-8").read()
tree = ast.parse(src)
nodes = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in WANT)
         or (isinstance(n, ast.Assign) and len(n.targets) == 1 and getattr(n.targets[0], "id", "") in WANT)]
ns = {"re": re, "json": json, "store": store, "llm": llm, "learned": learned, "attachments": attachments,
      "draft_guard": draft_guard, "fixpt": fixpt, "__name__": "assistant_stub"}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "assistant.draft", "exec", flags=__future__.annotations.compiler_flag, dont_inherit=True), ns)
ns["_ensure_body"] = lambda tid: data["body"]
ns["_lock_for"] = lambda tid: contextlib.nullcontext()
out = io.StringIO()
with contextlib.redirect_stdout(out):
    result = ns["draft"](data["row"]["id"], data["instruction"], data["comment"], data["current_draft"], data["alvo"], data["keep_text"])
sys.stdout.write(json.dumps({"prompts": prompts, "result": result, "saved_draft": saved.get("draft")}))
`;

interface Case {
  instruction: string;
  replies: string[];
  comment?: string;
  currentDraft?: string;
  alvo?: Alvo | null;
  keepText?: boolean;
  notes?: string;
  aliases?: { alias: string; name: string; email: string }[];
  row?: { draft?: string; chat?: unknown[] };
}

function python(row: unknown, c: Case) {
  const input = JSON.stringify({
    row, body: BODY, instruction: c.instruction, comment: c.comment || '', current_draft: c.currentDraft || '', alvo: c.alvo ?? null,
    keep_text: !!c.keepText, replies: c.replies, notes: c.notes || '', aliases: c.aliases || [],
  });
  const r = spawnSync(PY!, ['-I', '-c', PY_SCRIPT, ROOT], { input, encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) throw new Error(`python falhou: ${r.stderr}`);
  return JSON.parse(r.stdout) as { prompts: string[]; result: Record<string, unknown>; saved_draft: string | null };
}

async function setup(c: Case) {
  await db.upsertThread({
    id: 't1', subject: 'Roteamento do pix estático', from_email: 'bruno@x.com', from_name: 'Bruno Lima', internal_date: 1_792_000_000_000,
    is_unread: 1, last_from_me: 0, to_header: ME, cc_header: 'ana@x.com', last_from_header: 'Bruno Lima <bruno@x.com>',
  });
  await db.saveAi('t1', { body_text: BODY, draft: c.row?.draft, chat_json: c.row?.chat ? JSON.stringify(c.row.chat) : undefined });
  for (const a of c.aliases || []) await db.saveAlias(a.alias, a.name, a.email);
  const prompts: string[] = [];
  const replies = [...c.replies];
  const assistant = createAssistant({
    llm: { complete: async (p: string) => { prompts.push(p); return replies.shift() ?? ''; } },
    hasKey: async () => true,
    ensureBody: async () => BODY,
    notesBlock: async () => c.notes || '',
  });
  return { assistant, prompts, row: await db.getThread('t1') };
}

async function runTs(c: Case) {
  const { assistant, prompts, row } = await setup(c);
  const result = await assistant.draft('t1', c.instruction, { comment: c.comment, currentDraft: c.currentDraft, alvo: c.alvo, keepText: c.keepText });
  return { prompts, result: JSON.parse(JSON.stringify(result)), row, saved: (await db.getThread('t1'))?.draft };
}

const draftJson = (text: string, kind = 'draft') => JSON.stringify({ kind, text, cc_names: [] });
const LEAK_INSTR = 'isso é um absurdo porque o time de infraestrutura já tinha avisado sobre esse problema na reunião de terça passada';

const CASES: Record<string, Case> = {
  'comentário [n] sobre trecho do e-mail, sem rascunho anterior': {
    instruction: '[1] Sobre "o roteamento do pix estático está caindo no adquirente errado": já corrigimos ontem\nresponda também o Bruno',
    replies: [draftJson('Olá, Ana e Bruno.\n\nO ajuste no roteamento foi feito ontem.\n\nAtenciosamente,\nLeo')],
    notes: 'Aprendizados do Leo:\n- sempre citar o EC\n\n',
  },
  'revisão que volta igual → tenta de novo com ATENÇÃO; com apelidos e conversa': {
    instruction: 'mais curto',
    row: {
      draft: 'Olá, Bruno.\n\nEstamos verificando o roteamento e voltamos com previsão.\n\nAbraço,\nLeo',
      chat: [{ role: 'user', text: 'responda ao Bruno' }, { role: 'ai', text: 'Olá, Bruno.\n\nEstamos verificando o roteamento e voltamos com previsão.\n\nAbraço,\nLeo', kind: 'draft' }],
    },
    replies: [
      draftJson('Olá, Bruno.\n\nEstamos verificando o roteamento e voltamos com previsão.\n\nAbraço,\nLeo'),
      draftJson('Bruno, previsão até sexta.\n\nAbraço,\nLeo'),
    ],
    aliases: [{ alias: 'bruninho', name: 'Bruno Lima', email: 'bruno@x.com' }, { alias: 'bruno', name: 'Bruno Lima', email: 'bruno@x.com' }],
  },
  'rascunho copiou o pedido → CORREÇÃO OBRIGATÓRIA uma vez → persiste → alerta': {
    instruction: LEAK_INSTR,
    replies: [draftJson(`Olá, Ana.\n\n${LEAK_INSTR}.\n\nAtenciosamente,\nLeo`), draftJson(`Olá, Ana.\n\nEu ${LEAK_INSTR}.\n\nAtenciosamente,\nLeo`)],
  },
  'responder a uma mensagem específica (alvo)': {
    instruction: 'agradeça e diga que vou verificar',
    alvo: { idx: 0, total: 3, de: 'Ana Souza <ana@x.com>', data: 'Thu, 22 Oct 2026 10:44:00 -0300', texto: 'Leo, o roteamento do pix estático está caindo.', message_id: 'm1' },
    replies: [draftJson('Olá, Ana.\n\nObrigado, vou verificar.\n\nAtenciosamente,\nLeo')],
  },
  'usar meu texto (só corrigir) mantém a assinatura do rascunho': {
    instruction: 'escreva da mesma forma: oi ana, ja corrigimos o roteamento ontem',
    row: { draft: 'Olá, Ana.\n\nTexto antigo.\n\nAbraço,\nLeo' },
    replies: ['oi Ana, já corrigimos o roteamento ontem'],
  },
  'pergunta para a IA (kind=answer) não troca o rascunho': {
    instruction: 'quanto tempo o Bruno está esperando?',
    row: { draft: 'Rascunho atual.' },
    replies: [draftJson('Desde sexta de manhã.', 'answer')],
  },
};

beforeEach(async () => {
  await db.attachDb(nodeDriver());
  setAccount(ME);
});

describe('draft(): prompts e resultado idênticos ao Python', () => {
  for (const [name, c] of Object.entries(CASES)) {
    itPy(name, async () => {
      const ts = await runTs(c);
      const py = python(ts.row, c);
      expect(ts.prompts).toEqual(py.prompts);
      expect(ts.result).toEqual(py.result);
      expect(ts.saved ?? null).toEqual(py.saved_draft ?? (c.row?.draft ?? null));
    });
  }
});

describe('draftGuard no draft()', () => {
  it('rascunho limpo: uma chamada só, sem alerta', async () => {
    const { prompts, result } = await runTs(CASES['responder a uma mensagem específica (alvo)']);
    expect(prompts).toHaveLength(1);
    expect(result.alerta_copia).toBeUndefined();
  });

  it('copiou o pedido: UMA nova tentativa com CORREÇÃO OBRIGATÓRIA; se persistir, volta com alerta', async () => {
    const { prompts, result } = await runTs(CASES['rascunho copiou o pedido → CORREÇÃO OBRIGATÓRIA uma vez → persiste → alerta']);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('CORREÇÃO OBRIGATÓRIA');
    expect(prompts[1].startsWith(prompts[0])).toBe(true);
    expect(prompts[1]).toContain('CORREÇÃO OBRIGATÓRIA -- o seu rascunho anterior tem problemas:');
    expect(result.alerta_copia.mensagem).toMatch(/copiado parte do seu pedido/);
    expect(result.alerta_copia.trechos.length).toBeGreaterThan(0);
    expect(result.draft).toContain('Eu isso é um absurdo');
  });

  it('a nova tentativa corrigiu: sem alerta, fica o texto novo', async () => {
    const { prompts, result } = await runTs({
      instruction: LEAK_INSTR,
      replies: [draftJson(`Olá, Ana.\n\n${LEAK_INSTR}.\n\nLeo`), draftJson('Olá, Ana.\n\nO roteamento foi ajustado ontem; seguimos de olho.\n\nLeo')],
    });
    expect(prompts).toHaveLength(2);
    expect(result.alerta_copia).toBeUndefined();
    expect(result.draft).toContain('ajustado ontem');
  });

  it('sem chave de IA: erro claro, sem chamar a IA', async () => {
    const { prompts } = await setup({ instruction: 'x', replies: [] });
    const a = createAssistant({ llm: { complete: async (p) => { prompts.push(p); return ''; } }, hasKey: async () => false, ensureBody: async () => BODY });
    await expect(a.draft('t1', 'responda')).rejects.toThrow(/Falta chave de LLM/);
    expect(prompts).toHaveLength(0);
  });
});

describe('fixpt', () => {
  it('rejeita reescrita e aceita só correção', async () => {
    expect(() => fixpt.check('vou verificar com o time amanha', 'Prezados, informamos que o time fará a verificação.')).toThrow(fixpt.FixRejected);
    expect(() => fixpt.check('vou verificar com o time amanha', 'Vou verificar com o time amanhã.')).not.toThrow();
    const r = await fixpt.fix('nao sei', { complete: async () => '"Não sei"', hasKey: async () => true });
    expect(r).toEqual({ text: 'Não sei', changed: true });
  });

  it('keepTextRequest e assinatura', () => {
    expect(fixpt.keepTextRequest('escreva da mesma forma: "oi ana"')).toBe('oi ana');
    expect(fixpt.keepTextRequest('escreva isso de forma mais formal: oi')).toBeNull();
    expect(fixpt.withSignature('oi', 'Olá.\n\nTexto.\n\nAbraço,\nLeo')).toBe('oi\n\nAbraço,\nLeo');
  });
});
