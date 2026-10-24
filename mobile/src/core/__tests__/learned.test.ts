// Aprender no aparelho: cadastro por escopo (thread/person/general) com as
// mesmas validações de app/learned.py, lista relevante à conversa, remoção e o
// bloco do prompt (notesBlock). SQLite em memória; nenhuma rede.
import * as db from '../db';
import { addNote, deleteNote, forThread, LearnedError, listAll, MAX_TEXT, notesBlock, threadEmails } from '../learned';
import { nodeDriver } from '../__testutils__/fixtures';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('o teste usa attachDb()');
  }),
}));

const ME = 'leo@confrapag.com.br';

beforeEach(async () => {
  await db.attachDb(nodeDriver());
  await db.upsertThread({
    id: 't1', subject: 'Re: Fwd: Roteamento do  Pix', from_email: 'ana@x.com', to_header: ME, cc_header: 'Bruno <bruno@x.com>',
    last_from_header: 'Ana <ana@x.com>', internal_date: 1,
  });
  await db.upsertThread({ id: 't2', subject: 'roteamento do pix', from_email: 'carla@y.com', to_header: ME, internal_date: 2 });
  await db.upsertThread({ id: 't3', subject: 'Outro assunto', from_email: 'carla@y.com', to_header: ME, internal_date: 3 });
});

describe('addNote', () => {
  it('thread: guarda thread_id, assunto e assunto normalizado; person/general sem thread', async () => {
    const a = await addNote('THREAD', '  o pix é do time de pagamentos  ', 't1', 'ignorado@x.com');
    expect(a).toMatchObject({ scope: 'thread', thread_id: 't1', subject: 'Re: Fwd: Roteamento do  Pix', subject_key: 'roteamento do pix', person_email: '', text: 'o pix é do time de pagamentos' });
    expect(a.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const b = await addNote('person', 'Ana prefere resposta curta', 't1', ' ANA@X.com ');
    expect(b).toMatchObject({ scope: 'person', thread_id: '', subject: '', subject_key: '', person_email: 'ana@x.com' });
    const c = await addNote('general', 'assine como Lettiery', 't1', 'x@y.com');
    expect(c).toMatchObject({ scope: 'general', thread_id: '', person_email: '' });
    expect((await listAll()).map((n) => n.id)).toEqual([c.id, b.id, a.id]);
  });

  it('validações com as mensagens do Python', async () => {
    await expect(addNote('outro', 'x')).rejects.toThrow('Escopo desconhecido (use thread, person ou general).');
    await expect(addNote('general', '   ')).rejects.toThrow('Escreva o que a IA deve saber.');
    await expect(addNote('general', 'a'.repeat(MAX_TEXT + 1))).rejects.toThrow(`Texto longo demais (máx. ${MAX_TEXT} caracteres).`);
    await expect(addNote('general', 'a senha: Abc123!xyz do painel')).rejects.toThrow(/parece senha, token ou chave/);
    await expect(addNote('thread', 'x', 'nao-existe')).rejects.toThrow('Conversa não encontrada para o aprendizado.');
    await expect(addNote('person', 'x', 't1', 'sem-arroba')).rejects.toThrow('Informe o e-mail da pessoa.');
    await expect(addNote('general', 'x')).resolves.toBeTruthy();
    await expect(addNote('outro', 'x')).rejects.toBeInstanceOf(LearnedError);
    expect(await listAll()).toHaveLength(1);
  });
});

describe('forThread / deleteNote / notesBlock', () => {
  it('relevantes: geral + pessoas envolvidas + mesmo thread_id ou mesmo assunto; mais antigas primeiro', async () => {
    const g = await addNote('general', 'regra geral');
    const pAna = await addNote('person', 'sobre a Ana', '', 'ana@x.com');
    const pBruno = await addNote('person', 'sobre o Bruno (Cc)', '', 'bruno@x.com');
    const pMe = await addNote('person', 'sobre mim mesmo', '', ME);
    const pCarla = await addNote('person', 'sobre a Carla', '', 'carla@y.com');
    const tSubj = await addNote('thread', 'mesmo assunto', 't2');
    const tOther = await addNote('thread', 'outro assunto', 't3');
    expect(threadEmails(await db.getThread('t1'), ME)).toEqual(['ana@x.com', 'bruno@x.com']);
    expect((await forThread('t1', ME)).map((n) => n.id)).toEqual([g.id, pAna.id, pBruno.id, tSubj.id]);
    expect((await forThread('t3', ME)).map((n) => n.id)).toEqual([g.id, pCarla.id, tOther.id]);
    expect(pMe.id).toBeGreaterThan(0);
  });

  it('remover some da lista e do bloco; remover de novo = false', async () => {
    const g = await addNote('general', 'regra geral');
    const t = await addNote('thread', 'neste assunto vale X', 't1');
    const before = await notesBlock('t1', 'Roteamento do pix', ['ana@x.com']);
    expect(before).toBe(
      'Aprendizados que o Leo registrou (regras e contexto — siga-os quando pertinentes):\n' +
        '- (geral) regra geral\n' +
        '- (neste assunto) neste assunto vale X\n\n',
    );
    expect(await deleteNote(t.id)).toBe(true);
    expect(await deleteNote(t.id)).toBe(false);
    expect(await notesBlock('t1', 'Roteamento do pix', [])).toBe(
      'Aprendizados que o Leo registrou (regras e contexto — siga-os quando pertinentes):\n- (geral) regra geral\n\n',
    );
    expect(await deleteNote(g.id)).toBe(true);
    expect(await notesBlock('t1', 'Roteamento do pix', [])).toBe('');
  });

  it('bloco: geral, pessoas, assunto; dentro do escopo mais novas primeiro; texto em uma linha', async () => {
    await addNote('thread', 'assunto 1', 't1');
    await addNote('person', 'ana\n  com   quebra', '', 'ana@x.com');
    await addNote('general', 'geral antiga');
    await addNote('general', 'geral nova');
    expect(await notesBlock('t1', 'x', ['ana@x.com'])).toBe(
      'Aprendizados que o Leo registrou (regras e contexto — siga-os quando pertinentes):\n' +
        '- (geral) geral nova\n- (geral) geral antiga\n- (sobre ana@x.com) ana com quebra\n- (neste assunto) assunto 1\n\n',
    );
  });
});
