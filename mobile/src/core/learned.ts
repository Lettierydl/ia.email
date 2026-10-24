// "Aprender" no aparelho — porte de app/learned.py: cadastro (add/delete com as
// mesmas validações e mensagens), notas relevantes à conversa (for_thread) e o
// bloco que entra nos prompts do copiloto/rascunho/resumos (notes_block).
// A fonte da verdade é o SQLite; o espelho em Markdown na Learning Base do Mac
// não existe no aparelho.
import { addLearnedNote, deleteLearnedNote, getThread, listLearnedNotes, type Row } from './db';
import { getAddresses } from './mime';
import { looksLikeSecret } from './secretsGuard';

export const SCOPES = ['thread', 'person', 'general'] as const;
export const MAX_TEXT = 1000;

const BLOCK_MAX_CHARS = 3000;
const PREFIX_RE = /^\s*(?:(?:re|res|fw|fwd|enc|tr|encaminhado|resposta)\s*:\s*)+/i;

export interface LearnedNote {
  id: number;
  scope: string;
  thread_id: string;
  subject: string;
  subject_key: string;
  person_email: string;
  text: string;
  created_at: string;
}

/** Pedido inválido (no servidor vira 400): a mensagem vai direto para a tela. */
export class LearnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearnedError';
  }
}

/** Assunto normalizado: sem Re:/Fwd:/Enc: (repetidos), espaços colapsados, minúsculo. */
export function subjectKey(subject: string | null | undefined): string {
  return (subject || '').replace(PREFIX_RE, '').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

/** Remetente + participantes (Para/Cc/último remetente), sem a própria conta. */
export function threadEmails(row: Record<string, unknown> | null | undefined, me: string): string[] {
  const r = row || {};
  const header = ['from_email', 'last_from_header', 'to_header', 'cc_header'].map((k) => String(r[k] ?? '')).join(',');
  const out: string[] = [];
  for (const a of getAddresses(header)) {
    const email = a.email.trim().toLowerCase();
    if (email.includes('@') && email !== me && !out.includes(email)) out.push(email);
  }
  return out;
}

function matches(n: LearnedNote, threadId: string, key: string, emails: Set<string>): boolean {
  if (n.scope === 'general') return true;
  if (n.scope === 'person') return emails.has(n.person_email || '');
  if (n.scope === 'thread') return (!!threadId && n.thread_id === threadId) || (!!key && n.subject_key === key);
  return false;
}

const toNote = (r: Row): LearnedNote => ({
  id: Number(r.id),
  scope: String(r.scope ?? ''),
  thread_id: String(r.thread_id ?? ''),
  subject: String(r.subject ?? ''),
  subject_key: String(r.subject_key ?? ''),
  person_email: String(r.person_email ?? ''),
  text: String(r.text ?? ''),
  created_at: String(r.created_at ?? ''),
});

export function relevantFrom(all: LearnedNote[], threadId = '', subject = '', emails: string[] = []): LearnedNote[] {
  const key = subjectKey(subject);
  const mails = new Set(emails.filter(Boolean).map((e) => e.trim().toLowerCase()));
  return all.filter((n) => matches(n, threadId, key, mails)).sort((a, b) => a.id - b.id);
}

/** Bloco pronto para o prompt (vazio se não houver nada) — mesmo texto do Python. */
export function notesBlockFrom(notes: LearnedNote[]): string {
  if (!notes.length) return '';
  const order: Record<string, number> = { general: 0, person: 1, thread: 2 };
  const lines: string[] = [];
  let used = 0;
  const sorted = [...notes].sort((a, b) => (order[a.scope] ?? 3) - (order[b.scope] ?? 3) || b.id - a.id);
  for (const n of sorted) {
    const tag = n.scope === 'general' ? 'geral' : n.scope === 'person' ? `sobre ${n.person_email}` : 'neste assunto';
    const line = `- (${tag}) ${(n.text || '').split(/\s+/).filter(Boolean).join(' ').slice(0, 500)}`;
    if (used + line.length > BLOCK_MAX_CHARS && lines.length) break;
    lines.push(line);
    used += line.length;
  }
  return 'Aprendizados que o Leo registrou (regras e contexto — siga-os quando pertinentes):\n' + lines.join('\n') + '\n\n';
}

export async function notesBlock(threadId = '', subject = '', emails: string[] = []): Promise<string> {
  const all = (await listLearnedNotes()).map(toNote);
  return notesBlockFrom(relevantFrom(all, threadId, subject, emails));
}

/** Todas as notas, mais novas primeiro (GET /api/learned sem thread_id). */
export async function listAll(): Promise<LearnedNote[]> {
  return (await listLearnedNotes()).map(toNote);
}

/** Notas que valem para esta conversa (learned.for_thread), mais antigas primeiro. */
export async function forThread(threadId: string, me: string): Promise<LearnedNote[]> {
  const row = (await getThread(threadId)) || {};
  return relevantFrom(await listAll(), threadId, String(row.subject ?? ''), threadEmails(row, me));
}

/** learned.add: mesmas validações e mensagens do Python. */
export async function addNote(scopeIn: string, textIn: string, threadIdIn = '', personIn = ''): Promise<LearnedNote> {
  const scope = (scopeIn || '').trim().toLowerCase();
  const text = (textIn || '').trim();
  const threadId = (threadIdIn || '').trim();
  let person = (personIn || '').trim().toLowerCase();
  if (!(SCOPES as readonly string[]).includes(scope)) throw new LearnedError('Escopo desconhecido (use thread, person ou general).');
  if (!text) throw new LearnedError('Escreva o que a IA deve saber.');
  if (Array.from(text).length > MAX_TEXT) throw new LearnedError(`Texto longo demais (máx. ${MAX_TEXT} caracteres).`);
  if (looksLikeSecret(text)) {
    throw new LearnedError('Isso parece senha, token ou chave: não guardo segredos nos aprendizados. Tire a credencial e tente de novo.');
  }
  const row = threadId ? await getThread(threadId) : null;
  const subject = String(row?.subject ?? '');
  if (scope === 'thread') {
    if (!row) throw new LearnedError('Conversa não encontrada para o aprendizado.');
    person = '';
  } else if (scope === 'person') {
    if (!person.includes('@')) throw new LearnedError('Informe o e-mail da pessoa.');
  } else person = '';
  const thread = scope === 'thread';
  return toNote(
    await addLearnedNote({
      scope, text, thread_id: thread ? threadId : '', subject: thread ? subject : '', subject_key: thread ? subjectKey(subject) : '', person_email: person,
    }),
  );
}

export const deleteNote = (id: number): Promise<boolean> => deleteLearnedNote(id);
