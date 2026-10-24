// Corrigir português sem reescrever ("Corrigir português" / "Usar meu texto"):
// porte de app/fixpt.py (mesmo prompt, mesmos limites e mensagens). A IA só
// mexe em ortografia/gramática/pontuação/acentuação; se a saída divergir
// demais do original, é rejeitada e o texto do Leo fica como estava.
import { ratio } from './draftGuard';
import { looksLikeSecret } from './secretsGuard';

export const MIN_SIMILARITY = 0.8;
export const MAX_LEN_RATIO = 1.25;

export const PROMPT =
  'Você é um revisor de português do Brasil. Corrija SOMENTE ortografia, gramática, ' +
  'concordância, pontuação, acentuação e maiúsculas do texto abaixo.\n' +
  'Regras obrigatórias:\n' +
  '- NÃO mude o tom, o conteúdo, a ordem das frases nem o significado.\n' +
  '- NÃO troque palavras por sinônimos, NÃO deixe mais formal nem mais curto.\n' +
  '- NÃO acrescente saudação, despedida, assinatura, explicação nem frases novas.\n' +
  '- Mantenha nomes próprios, números, e-mails, links, siglas e quebras de linha como estão.\n' +
  '- Se não houver nada a corrigir, devolva o texto idêntico.\n' +
  'Responda APENAS com o texto corrigido: sem aspas, sem markdown, sem comentários.\n\n' +
  'Texto:\n<<<\n{text}\n>>>';

export class FixRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixRejected';
  }
}

/** Sem acento, minúsculo, espaços normalizados. */
export function fold(text: string): string {
  return (text || '').normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function similarity(original: string, fixed: string): number {
  const a = fold(original);
  const b = fold(fixed);
  if (!a && !b) return 1;
  return ratio(a, b, false);
}

export function check(original: string, fixed: string): void {
  if (!(fixed || '').trim()) throw new FixRejected('A IA não devolveu o texto corrigido. Nada foi trocado.');
  const la = Array.from(fold(original)).length;
  const lb = Array.from(fold(fixed)).length;
  if (la && (lb / la > MAX_LEN_RATIO || la / Math.max(lb, 1) > MAX_LEN_RATIO)) {
    throw new FixRejected('A correção mudou demais o tamanho do texto; mantive o seu como estava.');
  }
  if (similarity(original, fixed) < MIN_SIMILARITY) {
    throw new FixRejected('A correção mudou demais o texto (parecia uma reescrita); mantive o seu como estava.');
  }
}

const PAIRS: Record<string, string> = { '"': '"', '“': '”', "'": "'", '«': '»' };

export function clean(raw: string, original: string): string {
  let text = (raw || '').trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  if (text.startsWith('<<<') && text.endsWith('>>>')) text = text.slice(3, -3).trim();
  text = text.replace(/^(texto corrigido|texto|corre[cç][aã]o)\s*:\s*/i, '').trim();
  const stripped = original.trim();
  if (text.length >= 2 && PAIRS[text[0]] !== undefined && text[text.length - 1] === PAIRS[text[0]] &&
      !(stripped.slice(0, 1) === text[0] && stripped.slice(-1) === text[text.length - 1])) {
    text = text.slice(1, -1).trim();
  }
  const lead = original.slice(0, original.length - original.trimStart().length);
  const trail = original.slice(original.trimEnd().length);
  return text ? `${lead}${text}${trail}` : '';
}

export interface FixDeps {
  complete(prompt: string): Promise<string>;
  hasKey(): Promise<boolean>;
}

/** {text, changed}. FixRejected (divergiu/vazio) ou Error (sem IA). */
export async function fix(text: string, deps: FixDeps): Promise<{ text: string; changed: boolean }> {
  text = text || '';
  if (!text.trim()) return { text, changed: false };
  if (!(await deps.hasKey())) throw new Error('Falta chave de LLM (Claude/Gemini/OpenRouter) para corrigir o português.');
  const fixed = clean(await deps.complete(PROMPT.replace('{text}', text.trim())), text);
  check(text, fixed);
  if (looksLikeSecret(fixed) && !looksLikeSecret(text)) throw new FixRejected('A IA devolveu algo com cara de senha/token; nada foi trocado.');
  return { text: fixed, changed: fixed !== text };
}

// ── "Usar meu texto (só corrigir)" ──
const KEEP_VERBS =
  'escreva\\s+(?:da\\s+mesma\\s+forma|do\\s+mesmo\\s+jeito|exatamente(?:\\s+(?:isso|assim|isto|desse\\s+jeito|deste\\s+jeito))?|assim|isso)' +
  '|escrev[ea]\\s+igual' +
  '|(?:use|usa|utilize|mantenha|mant[eé]m|deixe|deixa)\\s+(?:o\\s+)?(?:meu|este|esse|o\\s+meu|exatamente\\s+(?:este|esse|o\\s+meu))\\s+texto(?:\\s+(?:como\\s+est[aá]|assim))?' +
  '|(?:manda|mande|mandar|envia|envie|enviar|responda|responde)\\s+(?:exatamente\\s+)?(?:assim|isso|isto|desse\\s+jeito|deste\\s+jeito|do\\s+jeito\\s+que\\s+escrevi)' +
  '|(?:s[oó]\\s+)?corri(?:ja|gir|ge)\\s+(?:s[oó]\\s+)?(?:o\\s+)?portugu[eê]s(?:\\s+(?:disso|disto|deste|desse|do\\s+texto))?' +
  '|copie\\s+(?:exatamente\\s+)?(?:isso|isto|este\\s+texto|esse\\s+texto)';
const KEEP_FILLER = '(?:\\s*,?\\s*(?:aqui|abaixo|a\\s+seguir|pra\\s+mim|para\\s+mim|por\\s+favor|o\\s+e-?mail|a\\s+resposta|na\\s+resposta|no\\s+e-?mail))*';
const KEEP_RE = new RegExp(`^\\s*(?:por\\s+favor,?\\s*)?(?:${KEEP_VERBS})${KEEP_FILLER}\\s*:\\s*([\\s\\S]+)$`, 'i');

export function keepTextRequest(instruction: string): string | null {
  const m = KEEP_RE.exec(instruction || '');
  if (!m) return null;
  let text = m[1].trim();
  if (text.length >= 2 && '"“\'«'.includes(text[0]) && '"”\'»'.includes(text[text.length - 1])) text = text.slice(1, -1).trim();
  return text || null;
}

const CLOSING_RE =
  /^(abra[cç]os?|abs\.?|att\.?|atenciosamente|at\.?te|obrigad[oa]s?|grato|grata|saudações|cordialmente|um abra[cç]o|forte abra[cç]o|valeu|até mais|leo|leonardo)(?![\p{L}\p{N}_])[,.!]?/iu;

export function signatureOf(draft: string): string {
  const blocks = (draft || '').trim().split(/\n\s*\n/).filter((b) => b.trim());
  if (blocks.length < 2) return '';
  const last = blocks[blocks.length - 1].trim();
  const lines = last.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 4 || lines.some((l) => l.length > 60)) return '';
  return CLOSING_RE.test(lines[0]) ? last : '';
}

export function hasSignature(text: string): boolean {
  const lines = (text || '').trim().split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-3).some((l) => CLOSING_RE.test(l));
}

export function withSignature(text: string, previousDraft: string): string {
  const sig = signatureOf(previousDraft);
  if (!sig || hasSignature(text)) return text;
  return `${text.trimEnd()}\n\n${sig}`;
}
