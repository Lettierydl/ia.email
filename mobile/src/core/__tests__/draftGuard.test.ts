// Casos portados de tests/test_draft_leaks.py (só os do draft_guard; os que
// passam pelo assistant.draft/endpoint entram na Fase 2).
import { expandQuote, findLeaks, findPastedQuotes, norm, parseInstruction, ratio, requestSegments } from '../draftGuard';

const KENNEDY =
  'De: Kennedy <kennedy@weqi.com.br>\nData: 2026-10-14\n\n' +
  'Oi Leo, tudo bem?\n\n' +
  'Seguem os pontos que levantamos:\n\n' +
  '1 - Escopo do time:\n' +
  '- Atividades mensais do PCI: Revisões de documentação, testes de segmentação, revisão de regras de firewall ' +
  'e acompanhamento das evidências para o QSA.\n' +
  '- Atividades de devops: Evolução do ambiente pensando em Finops e custo dentro da AWS, com revisão mensal ' +
  'das reservas.\n' +
  '- Atividades de Secops: Controle e gestão de acesso ao ambiente CDE. - Governança de chaves e rotação de ' +
  'segredos.\n\n' +
  '2 - Concorrência de demandas: Caso tenhamos incidências simultâneas no Pulse e na WEQI, como priorizamos ' +
  'o atendimento?\n\n' +
  'Abs,\nKennedy';

const PEDIDO =
  '[1] Sobre "- Atividades mensais do PCI: Revisões de documentação, testes de segmentação, r…": ' +
  'Essas atividades são feitas todos os meses? Ou foi feita durante o processo de PSI?\n' +
  '[2] Sobre "- Atividades de devops: Evolução do ambiente pensando em Finops e custo dentro d…": ' +
  'Isso é perfeito, exatamente o que o Claudeci faz aqui.\n' +
  '[3] Sobre "- Atividades de Secops: Controle e gestão de acesso ao ambiente CDE. - Governanç…": ' +
  'Isso também o Claudeci faz aqui todo mês. E na verdade muita coisa ele já automatizou.\n' +
  '[4] Sobre "2 - Concorrência de demandas: Caso tenhamos incidências simultâneas no Pulse e n…": ' +
  'Sobre a concorrência concordo com você é um gargalo, mas que devemos priorizar a WEQI.\n\n' +
  'Continue a resposta dos outros pontos da forma como você fez no primeiro ponto.';

const TURNO_1 = 'Pergunte sobre o primeiro ponto se as atividades do PCI são mensais';

const RUIM =
  'Oi Kennedy, tudo bem?\n\nAs atividades do PCI são feitas todos os meses ou foram durante o PSI?\n\n' +
  'Sobre a concorrência concordo com você é um gargalo, mas que devemos priorizar a WEQI.\n\n' +
  'Continue a resposta dos outros pontos da forma como você fez no primeiro ponto.\n\nAbs,\nLeo';
const BOM =
  'Oi Kennedy, tudo bem?\n\nObrigado pelos pontos. Sobre as atividades do PCI: elas são feitas todos os ' +
  'meses ou foram feitas durante o processo de PSI?\n\n' +
  'Quanto ao devops, perfeito: é exatamente o trabalho que o Claudeci já conduz por aqui.\n\n' +
  'Em Secops vale o mesmo: o Claudeci cuida disso mensalmente e boa parte já está automatizada.\n\n' +
  'Sobre a concorrência de demandas, concordo que pode virar um gargalo; nesse cenário, a WEQI tem ' +
  'prioridade.\n\nAbs,\nLeo';

// saída real (gemini) antes do reforço: [2] e [3] voltaram como o texto da Kennedy, sem resposta
const COLADO =
  'Oi Kennedy, tudo bem?\n\nObrigado pelos pontos. Sobre as atividades do PCI: elas são feitas todos os ' +
  'meses ou foram feitas durante o processo de PSI?\n\n' +
  '- Atividades de devops: evolução do ambiente pensando em Finops e custo dentro da AWS, com revisão mensal ' +
  'das reservas.\n' +
  '- Atividades de Secops: controle e gestão de acesso ao ambiente CDE - governança de chaves e rotação de ' +
  'segredos.\n\n' +
  'Sobre a concorrência de demandas: caso tenhamos incidências simultâneas no Pulse e na WEQI, priorizamos o ' +
  'atendimento da WEQI.\n\nAbs,\nLeo';

test('conteúdo reformulado não dispara', () => {
  const segs = requestSegments(PEDIDO, [TURNO_1]);
  expect(findLeaks(BOM, segs, KENNEDY)).toEqual([]);
});

test('comentário copiado e frase de meta são apontados (texto exato do rascunho)', () => {
  const leaks = findLeaks(RUIM, requestSegments(PEDIDO, [TURNO_1]), KENNEDY);
  expect(leaks).toContain('Continue a resposta dos outros pontos da forma como você fez no primeiro ponto.');
  expect(leaks.some((t) => t.includes('devemos priorizar a WEQI'))).toBe(true);
  expect(leaks.every((t) => RUIM.includes(t))).toBe(true);
});

test('conteúdo ditado e texto entre aspas não são cópia', () => {
  const segs = requestSegments(
    'diga que vamos enviar o relatório completo até sexta-feira à tarde sem falta. ' +
      'Use a frase "seguimos à disposição para qualquer dúvida sobre o contrato assinado"',
  );
  const draft =
    'Oi Ana,\n\nVamos enviar o relatório completo até sexta-feira à tarde sem falta.\n\n' +
    'Seguimos à disposição para qualquer dúvida sobre o contrato assinado.\n\nAbs';
  expect(findLeaks(draft, segs)).toEqual([]);
});

test('texto que já está na thread não é cópia', () => {
  const segs = requestSegments('[1] Sobre "x": Caso tenhamos incidências simultâneas no Pulse e na WEQI como priorizamos o atendimento');
  const draft = 'Caso tenhamos incidências simultâneas no Pulse e na WEQI, como priorizamos o atendimento? A WEQI.';
  expect(findLeaks(draft, segs, KENNEDY)).toEqual([]);
});

test('marcadores de citação sempre são apontados', () => {
  const leaks = findLeaks('Oi Kennedy.\n\n[4] Sobre "Concorrência": priorizar a WEQI.', []);
  expect(leaks.length).toBeGreaterThan(0);
  expect(leaks[0].startsWith('[4] Sobre')).toBe(true);
});

test('parseInstruction separa citações e pedido livre', () => {
  const parsed = parseInstruction(PEDIDO);
  expect(parsed.citacoes.map((c) => c.n)).toEqual([1, 2, 3, 4]);
  expect(parsed.citacoes[3].comentario.startsWith('Sobre a concorrência concordo')).toBe(true);
  expect(parsed.livre.startsWith('Continue a resposta')).toBe(true);
  expect(parseInstruction('mais curto')).toEqual({ citacoes: [], livre: 'mais curto' });
});

test('citação do rascunho e "(sem comentário)"', () => {
  const parsed = parseInstruction('[1] Sobre o trecho do rascunho "abc": (sem comentário)');
  expect(parsed.citacoes).toEqual([{ n: 1, fonte: 'rascunho', trecho: 'abc', comentario: '' }]);
});

test('expandQuote devolve o trecho cortado inteiro', () => {
  const full = expandQuote('2 - Concorrência de demandas: Caso tenhamos incidências simultâneas no Pulse e n…', [KENNEDY]);
  expect(full.endsWith('como priorizamos o atendimento?')).toBe(true);
  expect(expandQuote('trecho que não existe…', [KENNEDY])).toBe('trecho que não existe…');
});

test('pontos do remetente colados sem resposta são detectados', () => {
  const quotes = parseInstruction(PEDIDO).citacoes.map((c) => expandQuote(c.trecho, [KENNEDY]));
  const pasted = findPastedQuotes(COLADO, quotes);
  expect(pasted).toHaveLength(2);
  expect(pasted[0].startsWith('- Atividades de devops')).toBe(true);
  expect(pasted[1]).toContain('Secops');
  // responder o ponto reusando parte dele como contexto não conta
  expect(findPastedQuotes(BOM, quotes)).toEqual([]);
});

test('reformulação leve de comentário que já era conteúdo não é apontada', () => {
  const draft =
    'Oi Kennedy,\n\nIsso é perfeito, exatamente o que o Claudeci já faz por aqui.\n\n' +
    'Sobre a concorrência, concordo que é um gargalo, mas devemos priorizar a WEQI.\n\nAbs,\nLeo';
  expect(findLeaks(draft, requestSegments(PEDIDO), KENNEDY)).toEqual([]);
});

test('norm tira acento, pontuação e caixa', () => {
  expect(norm('Concorrência: É um GARGALO!')).toBe('concorrencia e um gargalo');
});

test('ratio igual ao difflib.SequenceMatcher', () => {
  // valores conferidos no Python (difflib) — inclui o autojunk (b com 200+ itens)
  expect(ratio('abcd', 'bcde')).toBeCloseTo(0.75, 10);
  expect(ratio('', '')).toBe(1);
  expect(ratio('qabxcd', 'abycdf')).toBeCloseTo(0.6666666666666666, 10);
  const longA = 'a '.repeat(120) + 'fim';
  const longB = 'a '.repeat(110) + 'outro fim';
  expect(ratio(longA, longB)).toBeCloseTo(0.9491525423728814, 10);
});
