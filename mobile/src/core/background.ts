// Sync em segundo plano (fonte "local") — gancho mínimo.
//
// O que roda aqui é só o sync CURTO: incremental pelo historyId (history.list
// + as threads que mudaram). Nada de listagem completa, nada de IA em lote,
// nada de envio da outbox: o pesado (leitura da IA, fila de envio) só acontece
// com o app aberto (abrir, voltar ao app, puxar para baixo, ⟳).
//
// Quem agenda é o iOS (BGTaskScheduler): mínimo ~15 min, muitas vezes horas;
// não roda se o app foi fechado à força; ~30 s de execução. Não funciona no
// Expo Go (precisa de development build).
//
// `expo-background-task` / `expo-task-manager` NÃO estão nas dependências
// (instalar exige novo development build). Por isso o registro recebe um
// adaptador: sem ele, registerBackgroundSync só informa "indisponível". Para
// ligar depois (sem mudar expo/RN), em um módulo carregado pelo index.ts:
//
//   npx expo install expo-background-task expo-task-manager
//
//   import * as BackgroundTask from 'expo-background-task';
//   import * as TaskManager from 'expo-task-manager';
//   TaskManager.defineTask(BACKGROUND_TASK, async () => {
//     const r = await runBackgroundSync();
//     return r === 'failed' ? BackgroundTask.BackgroundTaskResult.Failed : BackgroundTask.BackgroundTaskResult.Success;
//   });
//   registerBackgroundSync({ register: (name, min) => BackgroundTask.registerTaskAsync(name, { minimumInterval: min }) });
//
// (`runBackgroundSync` = createBackgroundSync(...) ligado ao core/local.)

export const BACKGROUND_TASK = 'ia-email-sync-curto';
export const MIN_INTERVAL_MINUTES = 15;

export type BackgroundOutcome = 'ok' | 'skipped' | 'failed';

export interface BackgroundSyncDeps {
  /** logado no Google? (sem login, nem tenta) */
  signedIn(): Promise<boolean>;
  /** historyId salvo (sem ele o sync seria a listagem completa: fica para o app aberto) */
  historyId(): Promise<string | null>;
  /** sync incremental (o mesmo do app aberto) */
  syncIncremental(): Promise<unknown>;
}

/** A tarefa de segundo plano: sync curto ou nada. Nunca lança. */
export function createBackgroundSync(deps: BackgroundSyncDeps): () => Promise<BackgroundOutcome> {
  return async () => {
    try {
      if (!(await deps.signedIn())) return 'skipped';
      if (!(await deps.historyId())) return 'skipped';
      await deps.syncIncremental();
      return 'ok';
    } catch {
      return 'failed';
    }
  };
}

export interface BackgroundAdapter {
  register(taskName: string, minimumIntervalMinutes: number): Promise<void>;
}

/** Registra a tarefa se houver adaptador (lib instalada + dev build); senão, não faz nada. */
export async function registerBackgroundSync(adapter: BackgroundAdapter | null = null): Promise<'registrado' | 'indisponivel' | 'erro'> {
  if (!adapter) return 'indisponivel';
  try {
    await adapter.register(BACKGROUND_TASK, MIN_INTERVAL_MINUTES);
    return 'registrado';
  } catch {
    return 'erro';
  }
}
