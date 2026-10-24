// Porte 1:1 de app/draft_guard.py: separa o pedido do Leo (instrução +
// comentários [n] sobre trechos) do texto do e-mail e confere se o rascunho
// gerado não copiou o pedido para dentro do e-mail.
//
// Caso real que motivou: o Leo comentou trechos do e-mail da Kennedy e pediu
// "Continue a resposta dos outros pontos da forma como você fez no primeiro
// ponto." -- o rascunho saiu com as frases coladas literalmente. Aqui ficam:
// - parseInstruction(): quebra o texto composto pelo front em citações
//   {n, fonte, trecho, comentario} + pedido livre;
// - expandQuote(): o front corta trechos longos com "…"; volta o trecho inteiro;
// - findLeaks(): trechos do rascunho que são cópia (quase) literal do pedido do
//   Leo ou frases de meta. Só cópia longa (>= 10 palavras seguidas) ou frase
//   quase idêntica conta.
// - findPastedQuotes(): ponto do remetente colado de volta sem resposta.
// SequenceMatcher.ratio() é porte do difflib (com o autojunk), para dar os
// mesmos números que o Python.

export interface Citacao {
  n: number;
  fonte: 'email' | 'rascunho';
  trecho: string;
  comentario: string;
}

const CITE_RE = () => /^\[(\d+)\] Sobre( o trecho do rascunho)? "([\s\S]*?)": /gm;
const ELLIPSIS = ['…', '...'];

export const MIN_RUN_WORDS = 10; // cópia literal: tantas palavras seguidas do pedido
export const MIN_SENTENCE_WORDS = 8; // frase curta demais não entra na comparação por similaridade
export const SIMILARITY = 0.95; // reformulação leve de comentário que já era conteúdo fica em ~0.92-0.94

export const ALERTA_COPIA = 'A IA pode ter copiado parte do seu pedido no texto — revise os trechos destacados.';
export const ALERTA_COLADO = 'A IA pode ter colado pontos do e-mail original sem responder — revise os trechos destacados.';
export const QUOTE_SIMILARITY = 0.93; // resposta que reusa o ponto como contexto fica abaixo (~0.91)

// Frase de meta que só pode estar no e-mail se o Leo NÃO a usou no pedido
// (normalizada: minúsculas, sem acento, sem pontuação).
const META_IF_IN_REQUEST = [
  /continue (a resposta|respondendo|os outros|as outras|com os outros|nos outros|o resto)/,
  /como voce fez/,
  /da (mesma )?forma (como|que) voce/,
  /do mesmo jeito que voce/,
  /\breescrev(a|e) (o|a|os|as|este|esse|isso|tudo)\b/,
  /responda (todos|todas|os outros|as outras|cada)/,
  /(deixe|deixa|fique|faca|faz) (mais )?(curto|curta|longo|formal|direto)/,
  /\bcite (o|a|os|as)\b/,
];
// Sempre meta (não existe em e-mail de verdade). Sobre o texto normalizado,
// menos META_ALWAYS_RAW, que olha a frase como está ("[1] Sobre").
const META_ALWAYS_RAW = /\[\d+\]\s*Sobre\b/i;
const META_ALWAYS = [
  /sobre o trecho do rascunho/,
  /\binstruc(ao|oes) do leo\b/,
  /\bo leo (pediu|disse|quer|comentou|explicou|esclareceu)\b/,
  /\bcomentario do leo\b/,
];

export function norm(text: string): string {
  const t = (text || '').toLowerCase().normalize('NFKD').replace(/\p{Mn}/gu, '');
  return (t.match(/[\p{L}\p{N}_]+/gu) || []).join(' ');
}

const pyStrip = (s: string) => s.replace(/^\s+|\s+$/g, '');
const pySplit = (s: string) => s.split(/\s+/).filter(Boolean);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseInstruction(instruction: string): { citacoes: Citacao[]; livre: string } {
  const text = pyStrip(instruction || '');
  const found = [...text.matchAll(CITE_RE())];
  if (!found.length) return { citacoes: [], livre: text };
  const cites: Citacao[] = [];
  let tailFree = '';
  found.forEach((m, i) => {
    const mEnd = m.index! + m[0].length;
    const end = i + 1 < found.length ? found[i + 1].index! : text.length;
    let comment = pyStrip(text.slice(mEnd, end));
    if (i + 1 === found.length) {
      // o front põe o pedido livre depois de uma linha em branco
      const sep = /\n\s*\n/.exec(comment);
      if (sep) {
        tailFree = pyStrip(comment.slice(sep.index + sep[0].length));
        comment = pyStrip(comment.slice(0, sep.index));
      } else {
        comment = pyStrip(comment);
        tailFree = '';
      }
    }
    if (comment === '(sem comentário)') comment = '';
    cites.push({ n: parseInt(m[1], 10), fonte: m[2] ? 'rascunho' : 'email', trecho: pyStrip(m[3]), comentario: comment });
  });
  const headFree = pyStrip(text.slice(0, found[0].index!));
  const livre = [headFree, tailFree].filter(Boolean).join('\n\n');
  return { citacoes: cites, livre };
}

function loosePattern(snippet: string): RegExp | null {
  const words = pySplit(snippet);
  if (!words.length) return null;
  return new RegExp(words.map(escapeRe).join('\\s+'));
}

/** Posição do trecho na fonte (espaços flexíveis); -1 se não achar. */
export function locate(quote: string, source: string): number {
  let q = pyStrip(quote || '');
  for (const end of ELLIPSIS) {
    if (q.endsWith(end)) q = q.slice(0, -end.length).replace(/\s+$/, '');
  }
  const pat = loosePattern(q.slice(0, 300));
  if (!pat || !source) return -1;
  const m = pat.exec(source);
  return m ? m.index : -1;
}

/** Trecho cortado com "…" volta inteiro: acha o começo numa das fontes e vai
 * até o fim do parágrafo (linha em branco), no máximo maxChars. */
export function expandQuote(quote: string, sources: string[], maxChars = 2000): string {
  const q = pyStrip(quote || '');
  const cut = ELLIPSIS.find((e) => q.endsWith(e));
  if (!cut) return q;
  const prefix = q.slice(0, -cut.length).replace(/\s+$/, '');
  const pat = loosePattern(prefix);
  if (!pat) return q;
  for (const src0 of sources) {
    const src = src0 || '';
    const m = pat.exec(src);
    if (!m) continue;
    const mEnd = m.index + m[0].length;
    const rest = src.slice(mEnd);
    const stop = /\n\s*\n/.exec(rest);
    const tail = stop ? rest.slice(0, stop.index) : rest;
    const full = pyStrip((m[0] + tail).slice(0, maxChars));
    if (full.length >= prefix.length) return full;
  }
  return q;
}

/** Texto entre aspas no pedido livre é o que o Leo quer escrito assim: não conta como cópia. */
function stripQuoted(text: string): string {
  return (text || '').replace(/"[^"\n]{3,}"|“[^”\n]{3,}”|«[^»\n]{3,}»/g, ' ');
}

const DICTATION =
  /^(diga|diz|fala|fale|responda|responde|avise|avisa|informe|explique|escreva|coloque|pergunte|pergunta|agradeca|confirme|peca|pede|mande|manda|comente|reforce|lembre|deixe claro|coloca)\b/;

/** Pedaços do pedido do Leo que nunca deveriam ir literais para o e-mail. */
export function requestSegments(instruction: string, earlierRequests: string[] = []): string[] {
  const out: string[] = [];
  for (const text of [instruction, ...earlierRequests]) {
    const parsed = parseInstruction(text);
    out.push(...parsed.citacoes.filter((c) => c.comentario).map((c) => c.comentario));
    if (parsed.livre) out.push(parsed.livre);
  }
  const segs: string[] = [];
  for (const raw of out) {
    const seg = stripQuoted(raw);
    // "diga que X" / "responda que X": X é o que o Leo quer dito no e-mail
    const kept = sentences(seg)
      .map(([s, e]) => seg.slice(s, e))
      .filter((x) => !DICTATION.test(norm(x)));
    if (kept.some((k) => pyStrip(k))) segs.push(kept.join('\n'));
  }
  return segs;
}

export function sentences(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const t = text || '';
  for (const m of t.matchAll(/[^.!?\n]+[.!?]*/g)) {
    let s = m.index!;
    let e = s + m[0].length;
    while (s < e && /\s/.test(t[s])) s += 1;
    while (e > s && /\s/.test(t[e - 1])) e -= 1;
    if (e > s) spans.push([s, e]);
  }
  return spans;
}

function ngrams(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** Frases do rascunho (texto exato, na ordem) que copiam o pedido do Leo.
 * allowed: texto do e-mail (thread) -- o que já está lá não conta como cópia. */
export function findLeaks(draft: string, segments: string[], allowed = ''): string[] {
  draft = draft || '';
  if (!pyStrip(draft)) return [];
  const allowedN = norm(allowed);
  const allowedGrams = ngrams(pySplit(allowedN), MIN_RUN_WORDS);
  const segGrams = new Set<string>();
  const segSents: string[] = [];
  const requestN = norm(segments.join(' '));
  for (const seg of segments) {
    for (const g of ngrams(pySplit(norm(seg)), MIN_RUN_WORDS)) if (!allowedGrams.has(g)) segGrams.add(g);
    for (const [s, e] of sentences(seg)) {
      const sn = norm(seg.slice(s, e));
      if (pySplit(sn).length >= MIN_SENTENCE_WORDS && !allowedN.includes(sn)) segSents.push(sn);
    }
  }
  const metaReq = META_IF_IN_REQUEST.filter((p) => p.test(requestN) && !p.test(allowedN));

  // palavras do rascunho com posição, para marcar quais caem numa cópia longa
  const tokens: [number, string][] = [...draft.matchAll(/[\p{L}\p{N}_]+/gu)].map((m) => [m.index!, norm(m[0])]);
  const words = tokens.map((t) => t[1]);
  const copied = new Array<boolean>(words.length).fill(false);
  for (let i = 0; i + MIN_RUN_WORDS <= words.length; i++) {
    if (segGrams.has(words.slice(i, i + MIN_RUN_WORDS).join(' '))) {
      for (let k = i; k < i + MIN_RUN_WORDS; k++) copied[k] = true;
    }
  }

  const leaks: string[] = [];
  for (const [s, e] of sentences(draft)) {
    const sent = draft.slice(s, e);
    const sn = norm(sent);
    let hit = tokens.some(([pos], k) => copied[k] && s <= pos && pos < e);
    if (!hit && pySplit(sn).length >= MIN_SENTENCE_WORDS && !allowedN.includes(sn)) {
      hit = segSents.some((ref) => ratio(sn, ref) >= SIMILARITY);
    }
    if (!hit) {
      hit = META_ALWAYS_RAW.test(sent) || META_ALWAYS.some((p) => p.test(sn)) || metaReq.some((p) => p.test(sn));
    }
    if (hit && !leaks.includes(sent)) leaks.push(sent);
  }
  return leaks;
}

/** Frases do rascunho que são o ponto do remetente colado de volta quase
 * igual, em vez da resposta do Leo. Usar parte do ponto como contexto não conta. */
export function findPastedQuotes(draft: string, quotes: string[]): string[] {
  const refs: string[] = [];
  for (const q of quotes) {
    if (pySplit(norm(q)).length >= MIN_SENTENCE_WORDS) refs.push(norm(q));
    for (const [s, e] of sentences(q)) {
      const qn = norm(q.slice(s, e));
      if (pySplit(qn).length >= MIN_SENTENCE_WORDS) refs.push(qn);
    }
  }
  if (!refs.length) return [];
  const out: string[] = [];
  const d = draft || '';
  for (const [s, e] of sentences(d)) {
    const sent = d.slice(s, e);
    const sn = norm(sent);
    if (pySplit(sn).length < MIN_SENTENCE_WORDS) continue;
    if (refs.some((r) => r.includes(sn) || ratio(sn, r) >= QUOTE_SIMILARITY) && !out.includes(sent)) out.push(sent);
  }
  return out;
}

// ── difflib.SequenceMatcher(None, a, b, autojunk=...).ratio() ──
export function ratio(aStr: string, bStr: string, autojunk = true): number {
  const a = Array.from(aStr);
  const b = Array.from(bStr);
  const la = a.length;
  const lb = b.length;
  if (la + lb === 0) return 1;
  const b2j = new Map<string, number[]>();
  b.forEach((ch, i) => {
    const list = b2j.get(ch);
    if (list) list.push(i);
    else b2j.set(ch, [i]);
  });
  // autojunk: em b com 200+ itens, os que aparecem mais de 1% + 1 vezes saem do índice
  if (autojunk && lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [ch, idxs] of [...b2j.entries()]) if (idxs.length > ntest) b2j.delete(ch);
  }
  const longest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    // sem isjunk, o "lixo" é vazio: estende a melhor pelos dois lados (inclui os populares)
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize += 1;
    return [besti, bestj, bestsize];
  };
  let matches = 0;
  const queue: [number, number, number, number][] = [[0, la, 0, lb]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2 * matches) / (la + lb);
}
