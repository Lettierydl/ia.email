// Destinatários da resposta: porte de recipients.clean_addresses e de
// gmail_client.reply_defaults/_reply_to_addr/_find_target. Só texto: as
// mensagens vêm do SQLite (sync) ou dos cabeçalhos do Gmail na hora do envio.
import { getAddresses, parseAddr } from './mime';

const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;

export interface Endereco {
  name: string;
  email: string;
}

/** Cabeçalhos de uma mensagem (minúsculos: from, to, cc). */
export type Headers = Record<string, string>;

/** Lista ou string ("a@x.com, Nome <b@y.com>") → e-mails minúsculos sem repetição. Inválido → Error. */
export function cleanAddresses(value: string | string[] | null | undefined): string[] {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    for (const tok of String(item || '').split(/[,;\n]+/)) {
      if (!tok.trim()) continue;
      const a = parseAddr(tok);
      const addr = (a.email || a.name || '').trim().toLowerCase();
      if (!addr) continue;
      if (!EMAIL_RE.test(addr)) throw new Error(`E-mail inválido: ${addr}`);
      if (!out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

/** Para padrão: o remetente; se foi o Leo, o Para da mensagem dele. */
export function replyToAddr(h: Headers, me: string): string {
  const from = getAddresses(h.from || '')[0]?.email || '';
  if (from.toLowerCase() !== me) return from;
  return getAddresses(h.to || '')[0]?.email || me;
}

/**
 * reply_defaults: Para/Cc de "responder a todos" a partir da mensagem
 * respondida (padrão: a última) e todos os participantes, sem o Leo.
 */
export function replyDefaults(all: Headers[], me: string, targetIndex = all.length - 1): { reply_to: Endereco[]; reply_cc: Endereco[]; participants: Endereco[] } {
  const target = all[targetIndex] || {};
  const toAddr = replyToAddr(target, me).toLowerCase();
  const people = new Map<string, Endereco>();
  for (const h of all) {
    for (const key of ['from', 'to', 'cc']) {
      for (const a of getAddresses(h[key] || '')) {
        const email = a.email.toLowerCase();
        if (!email || email === me) continue;
        const cur = people.get(email);
        if (!cur || (a.name && !cur.name)) people.set(email, { email, name: a.name });
      }
    }
  }
  const seen = new Set([me, toAddr]);
  const replyCc: Endereco[] = [];
  for (const a of [...getAddresses(target.to || ''), ...getAddresses(target.cc || '')]) {
    const email = a.email.toLowerCase();
    if (email && !seen.has(email)) {
      seen.add(email);
      replyCc.push({ email, name: people.get(email)?.name || a.name });
    }
  }
  return {
    reply_to: toAddr ? [{ email: toAddr, name: people.get(toAddr)?.name || '' }] : [],
    reply_cc: replyCc,
    participants: [...people.values()],
  };
}

/** Mensagem padrão a responder: a última de outra pessoa (se só houver do Leo, a última). */
export function defaultTargetIndex(all: Headers[], me: string): number {
  for (let i = all.length - 1; i >= 0; i--) {
    const from = getAddresses(all[i].from || '')[0]?.email?.toLowerCase() || '';
    if (from && from !== me) return i;
  }
  return all.length - 1;
}

/** Para final + Cc sem quem já está no Para nem o Leo (send_reply). */
export function finalRecipients(to: string[], cc: string[], me: string): { to: string[]; cc: string[] } {
  const toSet = new Set(to.map((a) => a.toLowerCase()));
  return { to, cc: cc.filter((a) => !toSet.has(a.toLowerCase()) && a.toLowerCase() !== me).filter((a, i, l) => l.indexOf(a) === i) };
}
