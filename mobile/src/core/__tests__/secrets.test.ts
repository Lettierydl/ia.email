// expo-secure-store em memória: confere chaves por provedor, apagar e status sem valor.
// (o jest.mock abaixo é içado para antes dos imports pelo babel-jest)
import * as SecureStore from 'expo-secure-store';

import { deleteSecret, getSecret, hasSecret, secretStatus, setSecret } from '../secrets';

jest.mock('expo-secure-store', () => {
  const mem = new Map<string, string>();
  return {
    __mem: mem,
    getItemAsync: jest.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      mem.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      mem.delete(k);
    }),
  };
});

const mem = (SecureStore as unknown as { __mem: Map<string, string> }).__mem;

beforeEach(() => mem.clear());

test('salva, lê (sem espaços) e apaga por provedor', async () => {
  await setSecret('gemini', '  g-key  ');
  expect(await getSecret('gemini')).toBe('g-key');
  expect(await getSecret('openrouter')).toBe('');
  expect(await secretStatus()).toEqual({ gemini: true, openrouter: false });
  await deleteSecret('gemini');
  expect(await hasSecret('gemini')).toBe(false);
});

test('salvar vazio apaga a chave', async () => {
  await setSecret('openrouter', 'or-key');
  await setSecret('openrouter', '   ');
  expect(await hasSecret('openrouter')).toBe(false);
  expect(mem.size).toBe(0);
});

test('chaves de Gemini e OpenRouter ficam em entradas separadas do Keychain', async () => {
  await setSecret('gemini', 'a');
  await setSecret('openrouter', 'b');
  expect(mem.size).toBe(2);
  expect(new Set(mem.values())).toEqual(new Set(['a', 'b']));
});
