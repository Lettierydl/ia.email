// Camada de dados das telas: a mesma "API" de antes (lista, detalhe, lote,
// sync, anexos, ações, rascunho, destinatários, envio, histórico) com duas
// fontes — "local" (padrão: Gmail + SQLite + IA no aparelho) e "servidor"
// (src/api.ts, o FastAPI do Mac). Resumos, Verificar na caixa e Aprender
// também passam por aqui (Fase 3). O que o aparelho ainda não faz (avatar,
// prefs/digest do painel) as telas chamam direto no servidor.
import type { ImageURISource } from 'react-native';

import { api, imageSource, inlineImageUrl, openAttachment } from '../api';
import type {
  ActionResult, AppStatus, CopilotList, DraftResult, GmailAttachments, GmailFile, HistEntry, HistList, ItemDetail, Job, LearnedNote, LearnedScope,
  ModoResumoMsg, OutboxView, Prefs, Recipients, ResumoDetalhado, ResumoMensagem, SendInput, SendResult, SyncStatus, VerifyResult,
} from '../types';
import { getDataSource, type DataSource } from './source';

export interface DataBackend {
  list(all: boolean): Promise<CopilotList>;
  status(): Promise<Job>;
  /** ⟳: baixa o Gmail e pede a leitura do que falta */
  run(limit: number): Promise<Job>;
  syncNow(): Promise<SyncStatus>;
  detail(id: string, refresh: boolean): Promise<ItemDetail>;
  gmailAttachments(id: string): Promise<GmailAttachments>;
  imageSource(tid: string, f: GmailFile): Promise<ImageURISource>;
  openAttachment(tid: string, f: GmailFile): Promise<void>;
  appStatus(): Promise<AppStatus>;
  prefs(): Promise<Partial<Prefs>>;
  action(id: string, action: string, extra: Record<string, unknown>): Promise<ActionResult>;
  aliasSuggest(q: string): Promise<{ suggestions: { name: string; email: string }[] }>;
  /** targetMessageId: responder a essa mensagem (Para/Cc saem dela) */
  recipients(id: string, targetMessageId?: string): Promise<Recipients>;
  draft(id: string, instruction: string, currentDraft: string, targetMessageId?: string): Promise<DraftResult>;
  attachmentsCount(id: string): Promise<number>;
  /** só depois do ConfirmModal: { confirmed: true } é obrigatório */
  send(id: string, input: SendInput, confirm: { confirmed: true }): Promise<SendResult>;
  sendNew(input: { to: string; cc: string; subject: string; body: string }, confirm: { confirmed: true }): Promise<SendResult>;
  outbox(threadId?: string): Promise<OutboxView[]>;
  cancelSend(outboxId: string): Promise<void>;
  historico(before?: number | null): Promise<HistList>;
  desfazer(entryId: number): Promise<{ ok: boolean; entry: HistEntry }>;
  refazer(entryId: number): Promise<{ ok: boolean; entry: HistEntry }>;
  desfazerUltimo(): Promise<{ ok: boolean; entry: HistEntry }>;
  /** resumo detalhado da thread: cache se a thread não mudou; regerar refaz */
  resumoDetalhado(id: string, regerar: boolean): Promise<ResumoDetalhado>;
  resumoMensagem(id: string, idx: number, modo: ModoResumoMsg, regerar: boolean): Promise<ResumoMensagem>;
  /** só o cache (nunca chama a IA): resumo null quando ainda não há */
  resumoMensagemCached(id: string, idx: number, modo: ModoResumoMsg): Promise<ResumoMensagem>;
  /** Verificar na caixa: só o cache (nunca chama IA nem Gmail) */
  verifyCached(id: string): Promise<VerifyResult>;
  /** extrai → busca na caixa (só leitura) → avalia */
  verify(id: string, regerar: boolean): Promise<VerifyResult>;
  learned(threadId: string): Promise<{ notes: LearnedNote[] }>;
  learn(scope: LearnedScope, text: string, threadId: string, personEmail: string): Promise<{ note: LearnedNote }>;
  unlearn(noteId: number): Promise<{ ok: boolean }>;
}

export const serverBackend: DataBackend = {
  list: (all) => api.list(all),
  status: () => api.status(),
  run: (limit) => api.run(limit),
  syncNow: () => api.syncNow(),
  detail: (id, refresh) => api.detail(id, refresh),
  gmailAttachments: (id) => api.gmailAttachments(id),
  imageSource: async (tid, f) => imageSource(inlineImageUrl(tid, f)),
  openAttachment: (tid, f) => openAttachment(tid, f),
  appStatus: () => api.appStatus(),
  prefs: () => api.prefs(),
  action: (id, action, extra) => api.action(id, action, extra),
  aliasSuggest: (q) => api.aliasSuggest(q),
  recipients: (id) => api.recipients(id),
  draft: (id, instruction, currentDraft) => api.draft(id, instruction, currentDraft),
  attachmentsCount: async (id) => (await api.attachments(id)).files.length,
  // o servidor tem a fila dele (sem janela de desfazer); o confirm já veio do ConfirmModal
  send: (id, input) => api.send(id, input.text, input.cc, input.to),
  sendNew: async () => {
    throw new Error('No modo servidor, o e-mail novo abre no /compose do Mac.');
  },
  outbox: async () => [],
  cancelSend: async () => {
    throw new Error('A fila do servidor se gerencia no Mac.');
  },
  historico: (before) => api.historico(before),
  desfazer: (id) => api.desfazer(id),
  refazer: (id) => api.refazer(id),
  desfazerUltimo: () => api.desfazerUltimo(),
  resumoDetalhado: (id, regerar) => api.resumoDetalhado(id, regerar),
  resumoMensagem: (id, idx, modo, regerar) => api.resumoMensagem(id, idx, modo, regerar),
  resumoMensagemCached: (id, idx, modo) => api.resumoMensagemCached(id, idx, modo),
  verifyCached: (id) => api.verifyCached(id),
  verify: (id, regerar) => api.verify(id, regerar),
  learned: (threadId) => api.learned(threadId),
  learn: (scope, text, threadId, personEmail) => api.learn(scope, text, threadId, personEmail),
  unlearn: (noteId) => api.unlearn(noteId),
};

export function createDataLayer(backends: { local: () => DataBackend; servidor: () => DataBackend }, source: () => DataSource = getDataSource) {
  const pick = () => backends[source()]();
  return {
    source,
    isLocal: () => source() === 'local',
    list: (all = false) => pick().list(all),
    status: () => pick().status(),
    run: (limit = 12) => pick().run(limit),
    syncNow: () => pick().syncNow(),
    detail: (id: string, refresh = false) => pick().detail(id, refresh),
    gmailAttachments: (id: string) => pick().gmailAttachments(id),
    imageSource: (tid: string, f: GmailFile) => pick().imageSource(tid, f),
    openAttachment: (tid: string, f: GmailFile) => pick().openAttachment(tid, f),
    appStatus: () => pick().appStatus(),
    prefs: () => pick().prefs(),
    action: (id: string, action: string, extra: Record<string, unknown> = {}) => pick().action(id, action, extra),
    delegar: (id: string, para: string, modo: 'cc_originais' | 'novo_silencioso', nome = '', nota = '') =>
      pick().action(id, 'delegar', { para, modo, nome, nota }),
    aliasSuggest: (q: string) => pick().aliasSuggest(q),
    recipients: (id: string, targetMessageId?: string) => pick().recipients(id, targetMessageId),
    draft: (id: string, instruction = '', currentDraft = '', targetMessageId?: string) => pick().draft(id, instruction, currentDraft, targetMessageId),
    attachmentsCount: (id: string) => pick().attachmentsCount(id),
    send: (id: string, input: SendInput, confirm: { confirmed: true }) => pick().send(id, input, confirm),
    sendNew: (input: { to: string; cc: string; subject: string; body: string }, confirm: { confirmed: true }) => pick().sendNew(input, confirm),
    outbox: (threadId?: string) => pick().outbox(threadId),
    cancelSend: (outboxId: string) => pick().cancelSend(outboxId),
    historico: (before?: number | null) => pick().historico(before),
    desfazer: (id: number) => pick().desfazer(id),
    refazer: (id: number) => pick().refazer(id),
    desfazerUltimo: () => pick().desfazerUltimo(),
    resumoDetalhado: (id: string, regerar = false) => pick().resumoDetalhado(id, regerar),
    resumoMensagem: (id: string, idx: number, modo: ModoResumoMsg, regerar = false) => pick().resumoMensagem(id, idx, modo, regerar),
    resumoMensagemCached: (id: string, idx: number, modo: ModoResumoMsg) => pick().resumoMensagemCached(id, idx, modo),
    verifyCached: (id: string) => pick().verifyCached(id),
    verify: (id: string, regerar = false) => pick().verify(id, regerar),
    learned: (threadId: string) => pick().learned(threadId),
    learn: (scope: LearnedScope, text: string, threadId: string, personEmail = '') => pick().learn(scope, text, threadId, personEmail),
    unlearn: (noteId: number) => pick().unlearn(noteId),
  };
}

// O backend local só é carregado na primeira chamada (o núcleo abre o SQLite
// e o módulo do Google): quem usa só o servidor não paga esse custo.
let localBackend: DataBackend | null = null;
function local(): DataBackend {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (!localBackend) localBackend = (require('./local') as typeof import('./local')).localBackend;
  return localBackend;
}

export const data = createDataLayer({ local, servidor: () => serverBackend });
export type DataLayer = ReturnType<typeof createDataLayer>;
