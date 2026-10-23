// Cliente da API do IA.Email. A base URL fica salva no aparelho (tela Ajustes);
// sem nada salvo, usa EXPO_PUBLIC_API_URL ou um padrão por plataforma.
// O token de acesso (Ajustes > Token de acesso) fica no Keychain/Keystore via
// expo-secure-store e vai em todo request como Authorization: Bearer.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type {
  ActionResult, AppStatus, CopilotList, Digest, DraftResult, GmailAttachments, GmailFile, HistEntry, HistList, ItemDetail, Job, LearnedNote,
  LearnedScope, ModoDelegar, ModoResumoMsg, Prefs, Recipients, ResumoDetalhado, ResumoMensagem, SendResult, SyncStatus, VerifyResult,
} from './types';

const KEY = 'cp_base_url';
const TOKEN_KEY = 'cp_api_token';

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

let token = '';

export async function loadToken(): Promise<string> {
  try {
    token = (await SecureStore.getItemAsync(TOKEN_KEY)) || '';
  } catch {
    token = '';
  }
  return token;
}

/** Vazio apaga o token salvo. */
export async function saveToken(value: string): Promise<void> {
  token = value.trim();
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export const hasToken = () => !!token;

const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

/** Imagem servida pelo próprio IA.Email precisa do header; de fora (Google), não. */
export const imageSource = (uri: string) =>
  uri.startsWith(baseUrl) ? { uri, headers: authHeaders() } : { uri };

export const UNAUTHORIZED_MSG = 'Token inválido ou ausente. Confira em Ajustes.';

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

async function request<T>(path: string, method = 'GET', body?: object, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(`Sem conexão com ${baseUrl}. Confira o endereço em Ajustes.`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new ApiError(UNAUTHORIZED_MSG, 401);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new ApiError(typeof detail === 'string' ? detail : `Erro ${res.status}.`, res.status);
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
    request<DraftResult>(
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
  // Só chamado depois da confirmação explícita (ConfirmModal) no composer.
  // to vazio = padrão do servidor (último remetente); senão o Para editado no composer.
  send: (id: string, text: string, cc: string, to: string[] = []) =>
    request<SendResult>(`/api/threads/${enc(id)}/send`, 'POST', { text, cc, source: 'copilot', ...(to.length ? { to } : {}) }, 60000),
  health: () => request<{ ok: boolean }>('/api/health', 'GET', undefined, 8000),
  // Verificar na caixa: GET só lê o cache; POST gera (só leitura no Gmail).
  verifyCached: (id: string) => request<VerifyResult>(`/api/copilot/${enc(id)}/verificar`),
  verify: (id: string, regerar = false) =>
    request<VerifyResult>(`/api/copilot/${enc(id)}/verificar`, 'POST', { regerar }, 180000),
  resumoDetalhado: (id: string, regerar = false) =>
    regerar
      ? request<ResumoDetalhado>(`/api/copilot/${enc(id)}/resumo-detalhado`, 'POST', {}, 120000)
      : request<ResumoDetalhado>(`/api/copilot/${enc(id)}/resumo-detalhado`, 'GET', undefined, 120000),
  resumoMensagem: (id: string, idx: number, modo: ModoResumoMsg, regerar = false) =>
    request<ResumoMensagem>(`/api/copilot/${enc(id)}/mensagens/${idx}/resumo`, 'POST', { modo, regerar }, 90000),
  // Histórico de ações + desfazer/refazer (mesmas rotas da página Histórico da web).
  historico: (before?: number | null) => request<HistList>(`/api/historico?limit=50${before ? `&before=${before}` : ''}`),
  desfazer: (entryId: number) => request<{ ok: boolean; entry: HistEntry }>(`/api/historico/${entryId}/desfazer`, 'POST'),
  refazer: (entryId: number) => request<{ ok: boolean; entry: HistEntry }>(`/api/historico/${entryId}/refazer`, 'POST'),
  desfazerUltimo: () => request<{ ok: boolean; entry: HistEntry }>('/api/historico/desfazer-ultimo', 'POST'),
  gmailAttachments: (id: string) => request<GmailAttachments>(`/api/threads/${enc(id)}/gmail-attachments`, 'GET', undefined, 30000),
};

// ── anexos recebidos: imagem inline e arquivo (rotas autenticadas -> header) ──
const attBase = (tid: string, mid: string) => `${baseUrl}/api/threads/${enc(tid)}/gmail-attachments/${enc(mid)}`;
export const inlineImageUrl = (tid: string, f: Pick<GmailFile, 'message_id' | 'attachment_id'>) =>
  `${attBase(tid, f.message_id)}/image?attachment_id=${enc(f.attachment_id)}`;
export const attachmentFileUrl = (tid: string, f: GmailFile) =>
  `${attBase(tid, f.message_id)}/file?attachment_id=${enc(f.attachment_id)}&filename=${enc(f.filename || 'anexo')}`;

/** Baixa o anexo para o cache do app (com o token) e abre a folha do sistema
 * (Visualizar / Salvar em Arquivos / Compartilhar). */
export async function openAttachment(tid: string, f: GmailFile): Promise<void> {
  const safe = (f.filename || 'anexo').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120) || 'anexo';
  const dir = new Directory(Paths.cache, 'anexos', f.message_id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'msg');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, safe);
  let file = dest;
  if (!dest.exists) {
    try {
      file = await File.downloadFileAsync(attachmentFileUrl(tid, f), dest, { headers: authHeaders(), idempotent: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      throw new ApiError(/401/.test(msg) ? UNAUTHORIZED_MSG : 'Não consegui baixar o anexo. Confira a conexão com o servidor.');
    }
  }
  if (!(await Sharing.isAvailableAsync())) throw new ApiError('Este aparelho não abre a folha de compartilhar.');
  await Sharing.shareAsync(file.uri, { mimeType: f.mime_type || undefined, dialogTitle: f.filename || 'Anexo' });
}

/** Resultado do "Testar conexão" dos Ajustes, passo a passo e em pt-BR. */
export interface ConnCheck {
  ok: boolean;
  lines: { ok: boolean; text: string }[];
}

export async function testConnection(): Promise<ConnCheck> {
  const lines: ConnCheck['lines'] = [];
  const url = baseUrl;
  if (/^http:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2|[^/:]+\.local|[^/:]+\.ts\.net|100\.\d+\.\d+\.\d+|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url)) {
    lines.push({ ok: false, text: 'Endereço http:// fora da rede local/Tailscale: o iOS bloqueia (ATS). Use https:// (ex.: https://seu-mac.tailnet.ts.net).' });
  }
  try {
    await api.health();
    lines.push({ ok: true, text: `Servidor respondeu em ${url} (/api/health).` });
  } catch (e) {
    lines.push({ ok: false, text: e instanceof Error ? e.message : `Sem resposta de ${url}.` });
    return { ok: false, lines };
  }
  try {
    const s = await api.appStatus();
    lines.push({ ok: true, text: `Acesso autorizado${token ? ' com o token salvo' : ' (sem token: servidor em modo local livre)'}.` });
    lines.push({ ok: true, text: s.account ? `Conta do Gmail: ${s.account}.` : 'Gmail ainda não conectado no servidor.' });
    return { ok: true, lines };
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
    lines.push({
      ok: false,
      text: status === 401
        ? token ? 'O servidor recusou o token salvo. Confira o token em Ajustes.' : 'O servidor pede token: cole o token de acesso abaixo.'
        : e instanceof Error ? e.message : 'A rota autenticada falhou.',
    });
    return { ok: false, lines };
  }
}

/** open_url da API é relativo (/mail/..., /compose?...): vira URL absoluta do servidor. */
export const absolute = (url: string) => (/^https?:/.test(url) ? url : `${baseUrl}${url}`);
