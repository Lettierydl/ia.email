// Copiloto: prompt idêntico ao do Python, regras "só em cópia" / "pedido a
// outra pessoa" (casos de tests/test_copilot.py), análise com IA falsa
// gravando em copilot_items, lista/abas e a fila com concorrência 2.
// SQLite real em memória; nenhuma IA ou Gmail de verdade.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as db from '../db';
import * as cp from '../copilot';
import { AuthError } from '../googleAuth';
import { nodeDriver } from '../__testutils__/fixtures';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

const ROOT = resolve(__dirname, '../../../..');
const COPILOT_PY = resolve(ROOT, 'app/copilot.py');
const PY = [resolve(ROOT, '.venv/bin/python3'), resolve(ROOT, '.venv/bin/python')].find((p) => existsSync(p));

const ME = 'leo@confrapag.com.br';
const BODY =
  'De: Ana Souza <ana@x.com>\nData: 2026-10-01\n\n' +
  'Leo, você pode validar o roteamento do pix estático até 10/10? Precisamos fechar com o EC.';
const CC_BODY =
  'De: Ana <ana@x.com>\nData: x\n\n' +
  'Bia, pode verificar as pendências do boleto até amanhã? Leo segue em cópia para acompanhar.';
const CC_RULE = 'Se eu fui só copiado não deveria tá na classificação da coluna de precisa de você. E sim apenas cópia.';

let driver: ReturnType<typeof nodeDriver>;

beforeEach(async () => {
  driver = nodeDriver();
  await db.attachDb(driver);
  cp.setAccount(ME);
  cp.setClock(() => Date.parse('2026-10-01T12:00:00-03:00'));
});
afterAll(() => cp.setClock(null));

async function mkThread(
  tid = 't1',
  o: { to?: string; cc?: string; body?: string; last_from_me?: number; marketing?: number; date?: number; sender?: string; hint?: number; unread?: number } = {},
) {
  const sender = o.sender ?? 'ana@x.com';
  await db.upsertThread({
    id: tid, subject: 'Roteamento do pix estático', from_email: sender, from_name: 'Ana Souza',
    snippet: 'Leo, você pode validar o roteamento?', internal_date: o.date ?? 10, is_unread: o.unread ?? 1,
    last_from_me: o.last_from_me ?? 0, is_automatic: 0, is_marketing: o.marketing ?? 0, needs_action_hint: o.hint ?? 0,
    awaiting_reply: 0, conferido: 1, hidden: 0, hide_as_replied: 0,
    last_from_header: `Ana Souza <${sender}>`, labels_json: [], to_header: o.to ?? ME, cc_header: o.cc ?? '',
  });
  await db.saveAi(tid, { body_text: o.body ?? BODY });
  return (await db.getThread(tid))!;
}

function fakeLlm(payload: object | string = {}) {
  const prompts: string[] = [];
  return {
    prompts,
    llm: {
      complete: jest.fn(async (user: string) => {
        prompts.push(user);
        return typeof payload === 'string' ? payload : `Claro:\n${JSON.stringify(payload)}\n`;
      }),
    },
  };
}

const open = (it: cp.CopilotItem) => ({ ...it, status: 'aberto' as const });

// ── prompt: o MESMO texto do Python ──
/** Partes literais das strings de _prompt no fonte Python (f-strings cortadas nos {campos}). */
function pythonPromptLiterals(): string[] {
  const src = readFileSync(COPILOT_PY, 'utf8');
  const start = src.indexOf('def _prompt(');
  const end = src.indexOf('\ndef ', start + 10);
  const body = src.slice(start, end);
  const out: string[] = [];
  const re = /(f?)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    let lit = m[2].slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    if (m[1]) {
      lit = lit.replace(/\{\{/g, '\u0001').replace(/\}\}/g, '\u0002');
      for (const piece of lit.split(/\{[^{}]*\}/)) out.push(piece.replace(/\u0001/g, '{').replace(/\u0002/g, '}'));
    } else out.push(lit);
  }
  return out.filter((x) => x.trim().length >= 3);
}

const PY_SCRIPT = `
import ast, json, sys
src = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(src)
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_prompt")
ns = {}
for n in tree.body:
    if isinstance(n, ast.Assign) and len(n.targets) == 1 and getattr(n.targets[0], "id", "") in ("PAPEIS", "OPCOES", "URGENCIAS"):
        ns[n.targets[0].id] = ast.literal_eval(n.value)
data = json.load(sys.stdin)
class learned:
    notes_block = staticmethod(lambda *a, **k: data["notes"])
    thread_emails = staticmethod(lambda row: [])
ns.update(learned=learned, _only_cc=lambda row: data["only_cc"], _ask_target=lambda row, body: data["ask_target"])
exec(compile(ast.Module(body=[fn], type_ignores=[]), "copilot._prompt", "exec"), ns)
sys.stdout.write(json.dumps(ns["_prompt"](data["row"], data["body"], data["sources"], data["base"])))
`;

/** Roda SÓ a função _prompt de app/copilot.py (sem importar o app) com as mesmas entradas. */
function pythonPrompt(row: Record<string, unknown>, body: string, sources: cp.Source[], base: cp.CopilotItem, notes: string): string {
  const input = JSON.stringify({ row, body, sources, base, notes, only_cc: cp.onlyCc(row), ask_target: cp.askTarget(row, body) });
  const r = spawnSync(PY!, ['-I', '-c', PY_SCRIPT, COPILOT_PY], { input, encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) throw new Error(`python falhou: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('prompt do copiloto', () => {
  it('toda parte literal do _prompt do Python aparece no prompt do app', async () => {
    const row = await mkThread('t1', { to: 'bia@x.com', cc: ME, body: CC_BODY });
    const prompt = cp.buildPrompt(row, CC_BODY, [], cp.heuristic(row, CC_BODY), '');
    const lits = pythonPromptLiterals();
    expect(lits.length).toBeGreaterThan(30);
    for (const lit of lits) expect(prompt).toContain(lit);
  });

  const exact = PY ? it : it.skip;
  exact('é idêntico ao do Python, caractere a caractere (só em Cc + aprendizados + fontes)', async () => {
    const row = await mkThread('t1', { to: 'bia@x.com', cc: ME, body: CC_BODY });
    const sources: cp.Source[] = [
      { tipo: 'decisao', titulo: 'Você já fez "delegar" em: Boleto MT', texto: 'Em 2026-09-01 você escolheu delegar (bia@x.com).' },
      { tipo: 'decisao', titulo: 'Outra', texto: 'y'.repeat(900) },
    ];
    const notes = `Aprendizados que o Leo registrou (regras e contexto — siga-os quando pertinentes):\n- (geral) ${CC_RULE}\n\n`;
    const base = cp.heuristic(row, CC_BODY);
    expect(cp.onlyCc(row)).toBe(true);
    expect(cp.buildPrompt(row, CC_BODY, sources, base, notes)).toBe(pythonPrompt(row, CC_BODY, sources, base, notes));
  });

  exact('é idêntico ao do Python (pedido a outra pessoa, sem fontes, thread longa cortada em 12000)', async () => {
    const long =
      'De: Ana <ana@x.com>\nData: 2026-09-30\n\n' + 'histórico 🙂 '.repeat(1500) +
      '\n\n----\n\nDe: Ana <ana@x.com>\nData: 2026-10-01\n\nDouglas, pode enviar o prazo?';
    const row = await mkThread('t1', { to: `Douglas Lima <douglas@x.com>, Leo <${ME}>`, body: long });
    const base = cp.heuristic(row, long);
    expect(cp.askTarget(row, long)).toBe('outros');
    expect(cp.buildPrompt(row, long, [], base, '')).toBe(pythonPrompt(row, long, [], base, ''));
  });

  exact('é idêntico ao do Python (Para/Cc vazios)', async () => {
    const row = await mkThread('t1', { to: '', cc: '' });
    const base = cp.heuristic(row, BODY);
    expect(cp.buildPrompt(row, BODY, [], base, '')).toBe(pythonPrompt(row, BODY, [], base, ''));
  });
});

// ── papel do Leo (tests/test_copilot.py) ──
describe('regras por heurística', () => {
  it('só em Cc é so_copia', async () => {
    const row = await mkThread('t1', { to: 'bia@x.com', cc: ME, body: 'De: Ana <ana@x.com>\nData: x\n\nBia, segue a ata da reunião de ontem.' });
    expect(cp.heuristic(row, String(row.body_text)).papel).toBe('so_copia');
  });

  it('em Cc mas citado pelo nome é opinião', async () => {
    const row = await mkThread('t1', { to: 'bia@x.com', cc: ME, body: 'De: Ana <ana@x.com>\nData: x\n\nBia, e o Leo, o que acha disso?' });
    expect(cp.heuristic(row, String(row.body_text)).papel).toBe('mencionado_opiniao');
  });

  it('pedido direto é demanda, com prazo e bola com o Leo', async () => {
    const row = await mkThread();
    const item = cp.heuristic(row, String(row.body_text));
    expect(item.papel).toBe('demanda');
    expect(item.bola.com).toBe('leo');
    expect(item.prazo.endsWith('-10-10')).toBe(true);
    expect(item.quem_pediu.email).toBe('ana@x.com');
  });

  it('propaganda é pode_ignorar e neutra', async () => {
    const row = await mkThread('t1', { marketing: 1 });
    const item = cp.heuristic(row, String(row.body_text));
    expect([item.papel, item.urgencia]).toEqual(['pode_ignorar', 'neutra']);
    expect(cp.tabFor(open(item))).toBe('so_conhecimento');
  });

  it('última mensagem do Leo: bola com os outros', async () => {
    const row = await mkThread('t1', { last_from_me: 1, to: 'Bia <bia@x.com>', sender: ME });
    const item = cp.heuristic(row, String(row.body_text));
    expect(item.bola).toEqual({ com: 'outros', email: 'bia@x.com', nome: 'Bia' });
    expect(cp.tabFor(open(item))).toBe('bola_com_outros');
  });
});

describe('só em Cc nunca vai para "Precisa de você"', () => {
  it('pedido a outra pessoa com o Leo em Cc é so_copia', async () => {
    const row = await mkThread('t1', { to: 'bia@x.com', cc: ME, body: CC_BODY });
    const item = cp.heuristic(row, CC_BODY);
    expect(item.papel).toBe('so_copia');
    expect(cp.tabFor(open(item))).toBe('so_conhecimento');
  });

  it('histórico citado que menciona o Leo não é pedido', async () => {
    const body = 'De: Ana <ana@x.com>\nData: x\n\nBia, consegue revisar?\n\nEm 01/10/2026, Carlos escreveu:\n> Leo, pode aprovar o layout?';
    const row = await mkThread('t1', { to: 'bia@x.com', cc: ME, body });
    expect(cp.heuristic(row, body).papel).toBe('so_copia');
  });

  it('a IA não promove só-Cc a demanda', async () => {
    const row = await mkThread('t1', { to: 'bia@x.com', cc: ME, body: CC_BODY });
    const parsed = {
      papel_leo: 'demanda', urgencia: 'alta', bola: 'leo',
      o_que_eu_faria: [{ acao: 'pedir_contexto', confianca: 0.8, evidencias: [{ tipo: 'mensagem', citacao: 'pode verificar as pendências do boleto' }] }],
    };
    const item = cp.interpret(row, CC_BODY, parsed, []);
    expect(item.papel).toBe('so_copia');
    expect(item.bola.com).toBe('ninguem');
    expect(item.urgencia).not.toBe('alta');
    expect(cp.tabFor(open(item))).toBe('so_conhecimento');
  });

  it('só em Cc com pedido explícito ao Leo vira no máximo opinião', async () => {
    const body = 'De: Ana <ana@x.com>\nData: x\n\nBia, segue o boleto. Leo, você pode validar o layout?';
    const row = await mkThread('t1', { to: 'bia@x.com', cc: ME, body });
    expect(cp.interpret(row, body, { papel_leo: 'demanda', bola: 'leo' }, []).papel).toBe('mencionado_opiniao');
  });

  it('direto para o Leo com pedido continua em Precisa de você', async () => {
    const row = await mkThread();
    const item = cp.interpret(row, String(row.body_text), { papel_leo: 'demanda', bola: 'leo' }, []);
    expect(item.papel).toBe('demanda');
    expect(cp.tabFor(open(item))).toBe('precisa_de_voce');
  });
});

describe('pedido a outra pessoa não é demanda do Leo', () => {
  const DOUG = 'De: Ana <ana@x.com>\nData: x\n\nDouglas, pode enviar o prazo da migração?';

  it('Douglas no Para e Leo em Cc: fora de Precisa de você', async () => {
    const row = await mkThread('t1', { to: 'Douglas Lima <douglas@x.com>', cc: ME, body: DOUG });
    expect(cp.tabFor(open(cp.heuristic(row, DOUG)))).not.toBe('precisa_de_voce');
  });

  it('Douglas e Leo no Para: não é demanda; a IA insistindo é rebaixada', async () => {
    const row = await mkThread('t1', { to: `Douglas Lima <douglas@x.com>, Leo <${ME}>`, body: DOUG });
    expect(cp.askTarget(row, DOUG)).toBe('outros');
    const h = cp.heuristic(row, DOUG);
    expect(['demanda', 'mencionado_opiniao']).not.toContain(h.papel);
    expect(cp.tabFor(open(h))).not.toBe('precisa_de_voce');
    let item = cp.interpret(row, DOUG, { papel_leo: 'demanda', urgencia: 'alta', bola: 'outros', bola_email: 'douglas@x.com' }, []);
    expect(item.papel).toBe('fyi');
    expect(item.urgencia).not.toBe('alta');
    expect(cp.tabFor(open(item))).toBe('bola_com_outros');
    item = cp.interpret(row, DOUG, { papel_leo: 'demanda', bola: 'leo' }, []);
    expect(cp.tabFor(open(item))).toBe('so_conhecimento');
  });

  it('"Oi Douglas, ..." mesmo com o Leo único no Para', async () => {
    const body = 'De: Ana <ana@x.com>\nData: x\n\nOi Douglas, pode enviar o prazo?';
    const row = await mkThread('t1', { to: ME, body });
    expect(cp.tabFor(open(cp.interpret(row, body, { papel_leo: 'demanda', bola: 'leo' }, [])))).not.toBe('precisa_de_voce');
  });

  it('pedido ao Leo pelo nome é demanda', async () => {
    const body = 'De: Ana <ana@x.com>\nData: x\n\nLeo, pode revisar o contrato?';
    const row = await mkThread('t1', { to: `Douglas Lima <douglas@x.com>, Leo <${ME}>`, body });
    expect(cp.askTarget(row, body)).toBe('voce');
    const item = cp.interpret(row, body, { papel_leo: 'demanda', bola: 'leo' }, []);
    expect(item.papel).toBe('demanda');
    expect(cp.tabFor(open(item))).toBe('precisa_de_voce');
    expect(['demanda', 'mencionado_opiniao']).toContain(cp.heuristic(row, body).papel);
  });

  it('pedido genérico com o Leo único destinatário é demanda', async () => {
    const body = 'De: Ana <ana@x.com>\nData: x\n\nPrezados, podem enviar o relatório de conciliação até 10/10?';
    const row = await mkThread('t1', { to: ME, body });
    expect(cp.askTarget(row, body)).toBe('');
    const item = cp.heuristic(row, body);
    expect(item.papel).toBe('demanda');
    expect(cp.tabFor(open(item))).toBe('precisa_de_voce');
  });
});

describe('parse e validação da resposta da IA', () => {
  it('pega o JSON do meio do texto; lixo vira {}', () => {
    expect(cp.parse('ok {"papel_leo": "fyi", "x": {"y": 1}} fim')).toEqual({ papel_leo: 'fyi', x: { y: 1 } });
    expect(cp.parse('sem json')).toEqual({});
    expect(cp.parse('{quebrado')).toEqual({});
    expect(cp.parse('[1, 2]')).toEqual({});
  });

  it('evidência inventada some; "responder" sem precedente some; ordena por confiança (máx. 3)', () => {
    const body = BODY;
    const srcs: cp.Source[] = [{ tipo: 'decisao', titulo: 'Antes', texto: 'Você delegou para a Bia.' }];
    const opts = cp.options(
      [
        { acao: 'responder', confianca: 0.9, evidencias: [{ tipo: 'mensagem', citacao: 'validar o roteamento do pix' }] },
        { acao: 'responder', confianca: 0.7, evidencias: [{ tipo: 'fonte', n: 1, porque: 'já fez' }] },
        { acao: 'direcionar', confianca: '0.95', para: 'BIA@x.com', evidencias: [{ tipo: 'mensagem', citacao: '"Precisamos fechar com o EC."' }] },
        { acao: 'aguardar', confianca: 0.5, evidencias: [{ tipo: 'mensagem', citacao: 'frase que não existe na thread' }] },
        { acao: 'pedir_contexto', confianca: 2, evidencias: [{ tipo: 'fonte', n: 9 }, { tipo: 'mensagem', citacao: 'Leo, você pode validar' }] },
        { acao: 'inventada', confianca: 1, evidencias: [{ tipo: 'fonte', n: 1 }] },
      ],
      body,
      srcs,
    );
    expect(opts.map((o) => [o.acao, o.confianca, o.para])).toEqual([
      ['pedir_contexto', 1, ''],
      ['direcionar', 0.95, 'bia@x.com'],
      ['responder', 0.7, ''],
    ]);
    expect(opts[1].evidencias[0].trecho).toBe('Precisamos fechar com o EC.');
    expect(opts[2].evidencias[0]).toMatchObject({ tipo: 'decisao', titulo: 'Antes' });
  });

  it('interpret: demanda sem opção pede contexto; prazo ISO da IA vale; bola com quem está na thread', async () => {
    const row = await mkThread('t1', { to: `Leo <${ME}>`, cc: 'Bia <bia@x.com>' });
    const item = cp.interpret(row, BODY, { papel_leo: 'demanda', prazo: '2026-10-09', bola: 'outros', bola_email: 'bia@x.com', tarefas: ['a', ' ', 'b'] }, []);
    expect(item.needs_context).toBe(true);
    expect(item.o_que_falta).toContain('Não encontrei no e-mail');
    expect(item.prazo).toBe('2026-10-09');
    expect(item.bola).toEqual({ com: 'outros', email: 'bia@x.com', nome: 'Bia' });
    expect(item.tarefas).toEqual([{ texto: 'a', feita: false }, { texto: 'b', feita: false }]);
    expect(item.source).toBe('llm');
    const strangers = cp.interpret(row, BODY, { bola: 'outros', bola_email: 'estranho@z.com' }, []);
    expect(strangers.bola).toEqual({ com: 'outros', email: '', nome: '' });
  });
});

describe('conversa (quem pediu / respondido)', () => {
  it('pedido respondido pela pessoa citada; depois pedido novo ao Leo fica aguardando', () => {
    const msgs = cp.messages(
      'De: Ana <ana@x.com>\nData: Thu, 01 Oct 2026 09:00:00 -0300\n\nBia, pode enviar o relatório?' +
        '\n\n----\n\nDe: Bia <bia@x.com>\nData: Thu, 01 Oct 2026 10:30:00 -0300\n\nSegue em anexo.' +
        '\n\n----\n\nDe: Ana <ana@x.com>\nData: Thu, 01 Oct 2026 11:00:00 -0300\n\nObrigada. Leo, consegue aprovar hoje?',
    );
    const conv = cp.conversa(msgs, [{ name: 'Bia', email: 'bia@x.com' }])!;
    expect(conv.status).toBe('aguardando');
    expect(conv.solicitante).toMatchObject({ nome: 'Ana', email: 'ana@x.com', quando: '01/10 11:00' });
    expect(conv.rotulo_resposta).toBe('Sem resposta desde 01/10 11:00');
    expect(conv.rotulo_ultimo).toBe('Ana · 01/10 11:00');
  });

  it('resposta do Leo fecha o pedido; datas ISO sem fuso são do fuso do app', () => {
    const msgs = cp.messages('De: Ana <ana@x.com>\nData: 2026-10-01\n\nLeo, pode validar?\n\n----\n\nDe: Leo <leo@confrapag.com.br>\nData: 2026-10-01T15:20:00\n\nValidado.');
    const conv = cp.conversa(msgs)!;
    expect(conv.status).toBe('respondido');
    expect(conv.rotulo_resposta).toBe('Respondido por você · 01/10 15:20');
    expect(cp.msgTs('2026-10-01')).toBe(Date.parse('2026-10-01T00:00:00-03:00'));
    expect(cp.msgTs('Thu, 1 Oct 2026 10:00:00 +0000')).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(cp.msgTs('x')).toBeNull();
  });

  it('own_text corta o histórico citado e linhas com ">"', () => {
    expect(cp.ownText('Oi, tudo certo.\n\nEm 01/10/2026, Carlos escreveu:\n> Leo, pode aprovar?')).toBe('Oi, tudo certo.');
    expect(cp.ownText('a\n> citado\nb')).toBe('a\nb');
  });
});

// ── análise gravando no banco ──
describe('analyze', () => {
  it('lê com a IA e grava em copilot_items; prompt traz a regra do só-Cc e os aprendizados', async () => {
    await mkThread('t1', { to: 'bia@x.com', cc: ME, body: CC_BODY });
    driver.raw.prepare('INSERT INTO learned_notes(scope, thread_id, subject, subject_key, person_email, text, created_at) VALUES(?,?,?,?,?,?,?)')
      .run('general', '', '', '', '', CC_RULE, 'x');
    driver.raw.prepare('INSERT INTO learned_notes(scope, thread_id, subject, subject_key, person_email, text, created_at) VALUES(?,?,?,?,?,?,?)')
      .run('thread', 't1', '', '', '', CC_RULE, 'x');
    const f = fakeLlm({ papel_leo: 'demanda', bola: 'leo' });
    const c = cp.createCopilot({ llm: f.llm, hasKey: async () => true });
    const out = await c.analyze('t1', { force: true });
    expect(f.prompts[0]).toContain('SÓ em Cc');
    expect(f.prompts[0]).toContain('NUNCA demanda');
    expect(f.prompts[0]).toContain(`(geral) ${CC_RULE}`);
    expect(f.prompts[0]).toContain(`(neste assunto) ${CC_RULE}`);
    expect(out.papel).toBe('so_copia');
    expect(out.tab).toBe('so_conhecimento');
    const saved = (await db.getCopilotItem('t1'))!;
    expect(saved).toMatchObject({ papel: 'so_copia', source: 'llm', status: 'aberto', internal_date_snapshot: 10, msg_count_snapshot: 1 });
  });

  it('prompt diz que o pedido é a OUTRA pessoa e o item sai de Precisa de você', async () => {
    const body = 'De: Ana <ana@x.com>\nData: x\n\nDouglas, pode enviar o prazo?';
    await mkThread('t1', { to: `Douglas Lima <douglas@x.com>, Leo <${ME}>`, body });
    const f = fakeLlm({ papel_leo: 'demanda', bola: 'leo' });
    const out = await cp.createCopilot({ llm: f.llm, hasKey: async () => true }).analyze('t1', { force: true });
    expect(f.prompts[0]).toContain('pedido a X ≠ demanda do Leo');
    expect(f.prompts[0]).toContain('dirigido a OUTRA pessoa');
    expect(out.tab).not.toBe('precisa_de_voce');
  });

  it('sem IA para: propaganda, credencial no texto, corpo ilegível; sem chave fica a heurística', async () => {
    const f = fakeLlm({ papel_leo: 'demanda' });
    const c = cp.createCopilot({ llm: f.llm, hasKey: async () => true });
    await mkThread('mk', { marketing: 1 });
    await mkThread('sec', { body: 'De: Ana <ana@x.com>\nData: x\n\nLeo, segue o acesso: senha: Abc12345 pode validar?' });
    await mkThread('vazio', { body: 'De: Ana <ana@x.com>\nData: x\n\n[image: x.png]' });
    expect((await c.analyze('mk')).source).toBe('regra');
    const sec = await c.analyze('sec');
    expect([sec.source, sec.o_que_falta]).toEqual(['regra', 'O e-mail traz senha ou credencial: não mandei para a IA. Veja com calma.']);
    expect((await c.analyze('vazio')).o_que_falta).toBe('Não consegui ler o texto (vazio, só imagem ou anexo).');
    expect(f.llm.complete).not.toHaveBeenCalled();
    await mkThread('semchave');
    const nk = await cp.createCopilot({ llm: f.llm, hasKey: async () => false }).analyze('semchave');
    expect(nk.source).toBe('heuristica');
    expect(f.llm.complete).not.toHaveBeenCalled();
  });

  it('leitura fresca não chama a IA de novo; mensagem nova de outra pessoa sim', async () => {
    await mkThread('t1');
    const f = fakeLlm({ papel_leo: 'demanda', bola: 'leo' });
    const c = cp.createCopilot({ llm: f.llm, hasKey: async () => true });
    await c.analyze('t1');
    await c.analyze('t1');
    expect(f.llm.complete).toHaveBeenCalledTimes(1);
    await mkThread('t1', { date: 20, body: BODY + '\n\n----\n\nDe: Bia <bia@x.com>\nData: 2026-10-02\n\nE aí?' });
    await c.analyze('t1');
    expect(f.llm.complete).toHaveBeenCalledTimes(2);
  });

  it('status do Leo não some quando a IA relê sem novidade', async () => {
    const row = await mkThread('t1');
    await db.saveCopilotItem('t1', { status: 'delegado', source: 'heuristica', internal_date_snapshot: Number(row.internal_date), delegado_json: '{"para":"bia@x.com"}' });
    const c = cp.createCopilot({ llm: fakeLlm({ papel_leo: 'demanda', bola: 'leo' }).llm, hasKey: async () => true });
    await c.analyze('t1', { force: true });
    expect(await db.getCopilotItem('t1')).toMatchObject({ status: 'delegado', depende_de_outros: 1, delegado_json: '{"para":"bia@x.com"}' });
  });

  it('erro da IA: sobe o erro e marca falha (fila mostra "falhou")', async () => {
    await mkThread('t1');
    const c = cp.createCopilot({ llm: { complete: async () => { throw new Error('Nenhum modelo respondeu.'); } }, hasKey: async () => true });
    await expect(c.analyze('t1')).rejects.toThrow('Nenhum modelo respondeu.');
    const list = await c.listItems({ showAll: true });
    expect(list.items[0]).toMatchObject({ tab: 'analisando', pendente: true, falhou: true });
    expect(list.fila).toMatchObject({ count: 1, falhas: 1, ativa: true });
  });
});

describe('lista (abas, cura de leitura antiga)', () => {
  it('leitura antiga de só-Cc em demanda é corrigida no banco', async () => {
    const row = await mkThread('t1', { to: 'bia@x.com', cc: ME, body: CC_BODY });
    await db.saveCopilotItem('t1', {
      papel: 'demanda', status: 'aberto', source: 'llm', urgencia: 'alta', internal_date_snapshot: Number(row.internal_date),
      bola_json: JSON.stringify({ com: 'leo', email: ME, nome: 'Você' }), opcoes_json: '[]',
    });
    const c = cp.createCopilot({ llm: fakeLlm().llm, hasKey: async () => true });
    const it = (await c.listItems({ showAll: true })).items.find((i) => i.thread_id === 't1')!;
    expect([it.papel, it.tab]).toEqual(['so_copia', 'so_conhecimento']);
    expect((await db.getCopilotItem('t1'))!.papel).toBe('so_copia');
  });

  it('se o Leo assumiu, vale a decisão dele', async () => {
    await mkThread('t1', { to: 'bia@x.com', cc: ME, body: CC_BODY });
    await db.saveCopilotItem('t1', { papel: 'demanda', status: 'assumido', source: 'llm', bola_json: JSON.stringify({ com: 'leo', email: ME, nome: 'Você' }) });
    const it = (await cp.createCopilot({ llm: fakeLlm().llm, hasKey: async () => true }).listItems({ showAll: true })).items[0];
    expect([it.papel, it.tab]).toEqual(['demanda', 'precisa_de_voce']);
  });

  it('pedido antigo a outra pessoa em demanda é corrigido para fyi', async () => {
    const body = 'De: Ana <ana@x.com>\nData: x\n\nDouglas, pode enviar o prazo?';
    const row = await mkThread('t1', { to: `Douglas Lima <douglas@x.com>, Leo <${ME}>`, body });
    await db.saveCopilotItem('t1', {
      papel: 'demanda', status: 'aberto', source: 'llm', urgencia: 'alta', internal_date_snapshot: Number(row.internal_date),
      bola_json: JSON.stringify({ com: 'leo', email: ME, nome: 'Você' }), opcoes_json: '[]',
    });
    const it = (await cp.createCopilot({ llm: fakeLlm().llm, hasKey: async () => true }).listItems({ showAll: true })).items[0];
    expect([it.papel, it.tab]).toEqual(['fyi', 'so_conhecimento']);
    expect((await db.getCopilotItem('t1'))!.papel).toBe('fyi');
  });

  it('sem chave de IA: colunas pela regra; com chave: o que não foi lido vai para "Analisando"', async () => {
    await mkThread('t1');
    const semIa = await cp.createCopilot({ llm: fakeLlm().llm, hasKey: async () => false }).listItems();
    expect(semIa.items[0].tab).toBe('precisa_de_voce');
    expect(semIa.tabs.map((t) => [t.key, t.count])).toEqual([['precisa_de_voce', 1], ['bola_com_outros', 0], ['so_conhecimento', 0]]);
    expect(semIa.saudacao).toBe('Boa tarde, Leo'); // 12:00 em Fortaleza
    expect(semIa.data).toBe('01/10');
    const comIa = await cp.createCopilot({ llm: fakeLlm().llm, hasKey: async () => true }).listItems();
    expect(comIa.items[0].tab).toBe('analisando');
    expect(comIa.fila?.count).toBe(1);
  });

  it('só não lidos por padrão; busca olha tudo e ignora acento', async () => {
    await mkThread('t1');
    await mkThread('t2', { unread: 0, date: 20 });
    const c = cp.createCopilot({ llm: fakeLlm().llm, hasKey: async () => false });
    expect((await c.listItems()).items.map((i) => i.thread_id)).toEqual(['t1']);
    expect((await c.listItems({ showAll: true })).items).toHaveLength(2);
    expect((await c.listItems({ q: 'pix estatico' })).items).toHaveLength(2);
    expect((await c.listItems({ q: 'nada-a-ver' })).items).toHaveLength(0);
  });
});

// ── fila local ──
describe('fila da IA (concorrência 2)', () => {
  it('lê tudo com no máximo 2 leituras ao mesmo tempo e grava cada resultado', async () => {
    for (let i = 1; i <= 5; i++) await mkThread(`t${i}`, { date: i });
    let inFlight = 0;
    let max = 0;
    const llm = {
      complete: jest.fn(async () => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return JSON.stringify({ papel_leo: 'demanda', bola: 'leo', o_que_aconteceu: 'Ana pede validação.' });
      }),
    };
    const c = cp.createCopilot({ llm, hasKey: async () => true });
    const j = await c.ensureBatch();
    expect(j).toMatchObject({ running: true, total: 5 });
    await c.idle();
    expect(max).toBe(2);
    expect(llm.complete).toHaveBeenCalledTimes(5);
    expect(c.status()).toMatchObject({ running: false, done: 5, errors: 0 });
    const items = await db.listCopilotItems();
    expect(Object.values(items).map((r) => r.source)).toEqual(['llm', 'llm', 'llm', 'llm', 'llm']);
    // tudo fresco: novo lote não tem o que ler
    expect((await c.start()).total).toBe(0);
  });

  it('sem chave de IA o lote automático nem começa', async () => {
    await mkThread('t1');
    const f = fakeLlm();
    const c = cp.createCopilot({ llm: f.llm, hasKey: async () => false });
    expect((await c.ensureBatch()).running).toBe(false);
    expect(f.llm.complete).not.toHaveBeenCalled();
  });

  it('erro numa thread conta como erro e não para o lote; quem falhou não volta antes de 10 min', async () => {
    await mkThread('t1', { date: 1 });
    await mkThread('t2', { date: 2 });
    let n = 0;
    const llm = {
      complete: jest.fn(async () => {
        n += 1;
        if (n === 1) throw new Error('falhou');
        return '{"papel_leo":"fyi"}';
      }),
    };
    const c = cp.createCopilot({ llm, hasKey: async () => true, concurrency: 1 });
    await c.ensureBatch();
    await c.idle();
    expect(c.status()).toMatchObject({ done: 2, errors: 1 });
    expect((await c.ensureBatch()).running).toBe(false);
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  it('sem conexão/sem login no meio do lote: pausa ("offline") sem marcar falha', async () => {
    for (let i = 1; i <= 4; i++) await mkThread(`t${i}`, { date: i });
    const f = fakeLlm({ papel_leo: 'fyi' });
    const c = cp.createCopilot({
      llm: f.llm,
      hasKey: async () => true,
      concurrency: 1,
      ensureBody: async () => {
        throw new AuthError('signed_out', 'entre');
      },
    });
    await c.start(10);
    await c.idle();
    expect(c.status()).toMatchObject({ paused: 'offline', errors: 0, done: 1, running: false });
    expect(c.failed.size).toBe(0);
    expect(f.llm.complete).not.toHaveBeenCalled();
  });
});
