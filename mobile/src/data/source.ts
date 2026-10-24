// Fonte de dados das telas: "local" (Gmail + SQLite + IA no aparelho, padrão)
// ou "servidor" (o FastAPI do Mac via src/api.ts — fallback). Fica salva no
// aparelho (AsyncStorage); quem precisa reage a onDataSourceChange.
import AsyncStorage from '@react-native-async-storage/async-storage';

export type DataSource = 'local' | 'servidor';
export const DATA_SOURCES: DataSource[] = ['local', 'servidor'];
export const DEFAULT_SOURCE: DataSource = 'local';
const KEY = 'cp_data_source';

let current: DataSource = DEFAULT_SOURCE;
const listeners = new Set<(s: DataSource) => void>();

export const getDataSource = () => current;

export async function loadDataSource(): Promise<DataSource> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    current = saved === 'servidor' || saved === 'local' ? saved : DEFAULT_SOURCE;
  } catch {
    current = DEFAULT_SOURCE;
  }
  return current;
}

export async function setDataSource(s: DataSource): Promise<void> {
  if (!DATA_SOURCES.includes(s)) return;
  current = s;
  listeners.forEach((fn) => fn(s));
  await AsyncStorage.setItem(KEY, s).catch(() => undefined);
}

export function onDataSourceChange(fn: (s: DataSource) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
