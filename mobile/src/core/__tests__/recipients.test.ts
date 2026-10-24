// Destinatários: Para/Cc padrão como o servidor ("responder a todos" sem o
// Leo), mensagem padrão a responder (última de terceiros) e validação.
import { cleanAddresses, defaultTargetIndex, finalRecipients, replyDefaults, replyToAddr } from '../recipients';

const ME = 'leo@confrapag.com.br';
const H = [
  { from: 'Ana Souza <ana@x.com>', to: ME, cc: 'Bia <bia@x.com>' },
  { from: `Leo <${ME}>`, to: 'ana@x.com', cc: 'bia@x.com' },
  { from: 'Bruno Lima <bruno@x.com>', to: `${ME}, Ana Souza <ana@x.com>`, cc: 'bia@x.com, Carla <carla@x.com>' },
  { from: `Leo <${ME}>`, to: 'bruno@x.com', cc: '' },
];

it('mensagem padrão: a última de outra pessoa (pula a do Leo)', () => {
  expect(defaultTargetIndex(H, ME)).toBe(2);
  expect(defaultTargetIndex([H[1]], ME)).toBe(0);
});

it('Para = remetente; se foi o Leo, o Para dele', () => {
  expect(replyToAddr(H[2], ME)).toBe('bruno@x.com');
  expect(replyToAddr(H[3], ME)).toBe('bruno@x.com');
});

it('responder a todos sem o Leo e sem repetir o Para; participantes com nome', () => {
  const r = replyDefaults(H, ME, 2);
  expect(r.reply_to).toEqual([{ email: 'bruno@x.com', name: 'Bruno Lima' }]);
  expect(r.reply_cc.map((a) => a.email)).toEqual(['ana@x.com', 'bia@x.com', 'carla@x.com']);
  expect(r.participants.map((a) => a.email).sort()).toEqual(['ana@x.com', 'bia@x.com', 'bruno@x.com', 'carla@x.com']);
  expect(r.participants.find((a) => a.email === 'bia@x.com')!.name).toBe('Bia');
  expect(r.participants.some((a) => a.email === ME)).toBe(false);
});

it('escolher outra mensagem muda o Para/Cc padrão', () => {
  const r = replyDefaults(H, ME, 0);
  expect(r.reply_to.map((a) => a.email)).toEqual(['ana@x.com']);
  expect(r.reply_cc.map((a) => a.email)).toEqual(['bia@x.com']);
});

it('cleanAddresses valida e normaliza; finalRecipients tira do Cc quem está no Para', () => {
  expect(cleanAddresses(['Ana <ANA@x.com>', 'b@y.com, ana@x.com'])).toEqual(['ana@x.com', 'b@y.com']);
  expect(() => cleanAddresses('isso não')).toThrow('E-mail inválido');
  expect(finalRecipients(['a@x.com'], ['A@x.com', 'b@x.com', ME, 'b@x.com'], ME)).toEqual({ to: ['a@x.com'], cc: ['b@x.com'] });
});

it('nenhum teste usa fetch real', async () => {
  await expect(fetch('https://gmail.googleapis.com/x')).rejects.toThrow('Teste tentou usar fetch real');
});
