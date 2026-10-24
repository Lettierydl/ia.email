// Chaves de IA no Keychain (expo-secure-store). Nunca no SQLite, nunca em log
// e nunca de volta para a tela: a UI só sabe se há ou não uma chave salva.
import * as SecureStore from 'expo-secure-store';

export type SecretProvider = 'gemini' | 'openrouter';
export const SECRET_PROVIDERS: SecretProvider[] = ['gemini', 'openrouter'];

const STORE_KEYS: Record<SecretProvider, string> = {
  gemini: 'ia_email_gemini_api_key',
  openrouter: 'ia_email_openrouter_api_key',
};

/** Quem a cadeia de IA consulta para achar as chaves (os testes passam um em memória). */
export interface SecretsProvider {
  get(provider: SecretProvider): Promise<string>;
}

export async function getSecret(provider: SecretProvider): Promise<string> {
  return ((await SecureStore.getItemAsync(STORE_KEYS[provider])) || '').trim();
}

export async function setSecret(provider: SecretProvider, value: string): Promise<void> {
  const v = (value || '').trim();
  if (!v) return deleteSecret(provider);
  await SecureStore.setItemAsync(STORE_KEYS[provider], v);
}

export async function deleteSecret(provider: SecretProvider): Promise<void> {
  await SecureStore.deleteItemAsync(STORE_KEYS[provider]);
}

export async function hasSecret(provider: SecretProvider): Promise<boolean> {
  return !!(await getSecret(provider));
}

/** { gemini: true/false, openrouter: true/false } — sem o valor. */
export async function secretStatus(): Promise<Record<SecretProvider, boolean>> {
  const [gemini, openrouter] = await Promise.all(SECRET_PROVIDERS.map(hasSecret));
  return { gemini, openrouter };
}

export const secureStoreSecrets: SecretsProvider = { get: getSecret };
