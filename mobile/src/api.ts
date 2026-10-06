// Cliente da API do IA.Email. A base URL fica salva no aparelho (tela Ajustes);
// sem nada salvo, usa EXPO_PUBLIC_API_URL ou um padrão por plataforma.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import type {
  ActionResult, AppStatus, CopilotList, Digest, ItemDetail, Job, LearnedNote, LearnedScope, ModoDelegar, Prefs, Recipients, SendResult,
  SyncStatus,
} from './types';

const KEY = 'cp_base_url';

// Emulador Android enxerga o Mac em 10.0.2.2; simulador iOS usa 127.0.0.1 direto.
// Celular físico precisa do IP do Mac na rede (ver README).
export const DEFAULT_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || (Platform.OS === 'android' ? 'http://10.0.2.2:8765' : 'http://127.0.0.1:8765');

let baseUrl = DEFAULT_BASE_URL;

export async function loadBaseUrl(): Promise<string> {
  try {
    baseUrl = (await AsyncStorage.getItem(KEY)) || DEFAULT_BASE_URL;
  } catch {
    baseUrl = DEFAULT_BASE_URL;
  }
  return baseUrl;
}

export async function saveBaseUrl(url: string): Promise<string> {
  baseUrl = url.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  await AsyncStorage.setItem(KEY, baseUrl);
  return baseUrl;
}

export const getBaseUrl = () => baseUrl;

export class ApiError extends Error {}

async function request<T>(path: string, method = 'GET', body?: object, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(`Sem conexão com ${baseUrl}. Confira o endereço em Ajustes.`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new ApiError(typeof detail === 'string' ? detail : `Erro ${res.status}.`);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  list: (all = false) => request<CopilotList>(`/api/copilot${all ? '?all=1' : ''}`),
  status: () => request<Job>('/api/copilot/status'),
  run: (limit = 12) => request<Job>(`/api/copilot/run?limit=${limit}`, 'POST'),
  // Baixa o Gmail agora (nunca dá erro HTTP: o estado online/offline vem no corpo).
  syncNow: () => request<SyncStatus>('/api/sync/now', 'POST', undefined, 120000),
  // Leitura pela IA pode demorar: prazo maior.
  detail: (id: string, refresh = false) =>
    request<ItemDetail>(`/api/copilot/${enc(id)}${refresh ? '?refresh=1' : ''}`, 'GET', undefined, refresh ? 120000 : 20000),
  action: (id: string, action: string, extra: Record<string, unknown> = {}) =>
    request<ActionResult>(`/api/copilot/${enc(id)}/action`, 'POST', { action, ...extra }, 120000),
  delegar: (id: string, para: string, modo: ModoDelegar, nome = '', nota = '') =>
    api.action(id, 'delegar', { para, modo, nome, nota }),
  digest: (period: 'daily' | 'weekly') => request<Digest>(`/api/copilot/digest?period=${period}`),
  prefs: () => request<Prefs>('/api/copilot/settings'),
  savePrefs: (p: Partial<Prefs>) => request<Prefs>('/api/copilot/settings', 'POST', p),
  aliasSuggest: (q: string) =>
    request<{ suggestions: { name: string; email: string }[] }>(`/api/settings/alias-suggest?q=${enc(q)}`),
  avatar: (email: string) => request<{ photo_url?: string }>(`/api/avatar?email=${enc(email)}`),
  // Responder: as mesmas rotas do /mail (rascunho da IA, destinatários e envio).
  appStatus: () => request<AppStatus>('/api/status'),
  // instruction/currentDraft opcionais: sem eles é o "Regenerar" de sempre.
  // currentDraft = texto editado na caixa, vira o "Rascunho anterior" do prompt.
  draft: (id: string, instruction = '', currentDraft = '') =>
    request<{ draft: string; chat?: { role: string; text: string; kind?: string }[] }>(
      `/api/threads/${enc(id)}/draft`,
      'POST',
      { instruction, comment: '', ...(instruction && currentDraft.trim() ? { current_draft: currentDraft } : {}) },
      120000,
    ),
  // Aprender: contexto para os próximos e-mails (não gera rascunho).
  learned: (threadId: string) => request<{ notes: LearnedNote[] }>(`/api/learned?thread_id=${enc(threadId)}`),
  learn: (scope: LearnedScope, text: string, threadId: string, personEmail = '') =>
    request<{ note: LearnedNote }>('/api/learned', 'POST', { scope, text, thread_id: threadId, person_email: personEmail }),
  unlearn: (noteId: number) => request<{ ok: boolean }>(`/api/learned/${noteId}`, 'DELETE'),
  recipients: (id: string) => request<Recipients>(`/api/threads/${enc(id)}/recipients`),
  attachments: (id: string) => request<{ files: { name: string }[] }>(`/api/threads/${enc(id)}/attachments`),
  // Só chamado depois da confirmação explícita (Alert) no composer.
  send: (id: string, text: string, cc: string) =>
    request<SendResult>(`/api/threads/${enc(id)}/send`, 'POST', { text, cc, source: 'copilot' }, 60000),
};

/** open_url da API é relativo (/mail/..., /compose?...): vira URL absoluta do servidor. */
export const absolute = (url: string) => (/^https?:/.test(url) ? url : `${baseUrl}${url}`);
