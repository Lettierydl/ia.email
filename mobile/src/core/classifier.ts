// Regras de ruído/importância sem LLM — porte 1:1 de app/classifier.py.

export const ME_DEFAULT = 'leo@confrapag.com.br';

const ACEITE = /^\s*(aceito|aceita|aceite)\s*:/i;
const REACAO = /reagiu pelo gmail/i;
const MARKETING_FROM = /(no-?reply|noreply|newsletter|mailer-daemon|notifications?@)/i;
const ACAO_HINT = /\b(urgente|prazo|at[eé]\s+\d{1,2}[/-]\d{1,2}|validar|aprovar|decis[aã]o|day off|hora extra|bonifica)/i;

export interface Classified {
  is_unread: boolean;
  last_from_me: boolean;
  is_automatic: boolean;
  is_marketing: boolean;
  needs_action_hint: boolean;
  awaiting_reply: boolean;
  hide_as_replied: boolean;
}

export function parseEmail(header: string): string {
  if (!header) return '';
  const m = /<([^>]+)>/.exec(header);
  return (m ? m[1] : header).trim().toLowerCase();
}

export function classify(args: { label_ids: string[]; last_from_header: string; subject: string; snippet: string; me?: string }): Classified {
  const me = (args.me ?? ME_DEFAULT).trim().toLowerCase();
  const labels = new Set(args.label_ids.map((l) => l.toUpperCase()));
  const is_unread = labels.has('UNREAD');
  const last_from_me = parseEmail(args.last_from_header) === me;
  const blob = `${args.subject}\n${args.snippet}`;
  const is_automatic = ACEITE.test(args.subject || '') || REACAO.test(blob);
  const is_marketing = MARKETING_FROM.test(args.last_from_header || '');
  const needs_action_hint = ACAO_HINT.test(blob) && !is_automatic && !is_marketing;
  const hide_as_replied = last_from_me && !is_unread;
  const awaiting_reply = !is_unread && !last_from_me && !is_automatic && !hide_as_replied;
  return { is_unread, last_from_me, is_automatic, is_marketing, needs_action_hint, awaiting_reply, hide_as_replied };
}
