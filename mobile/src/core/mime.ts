// Parsing MIME das mensagens da Gmail API (format=full), porte de
// app/gmail_client.py: texto (text/plain, senão text/html virado texto),
// anexos, imagens inline por cid e o casamento de cada "[image: x]" do texto
// com o anexo certo (map_inline_placeholders). Puro: sem fetch, sem React.

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  historyId?: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  snippet?: string;
  messages?: GmailMessage[];
}

/** Anexo recebido (mesmo formato do GET /api/threads/{id}/gmail-attachments). */
export interface MimeFile {
  message_id: string;
  attachment_id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string;
  inline: boolean;
  is_image: boolean;
  in_body: boolean;
}

export interface InlineRef {
  token: string;
  name: string;
  attachment_id: string | null;
  filename: string | null;
  rule: 'cid' | 'filename' | 'ordem' | null;
}

// ── base64url → texto (sem Buffer/atob: roda igual no Hermes e no Jest) ──
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Record<string, number> = Object.fromEntries([...B64].map((c, i) => [c, i]));

export function b64urlToBytes(data: string): Uint8Array {
  const clean = (data || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let n = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX[clean[i]] ?? 0;
    const b = B64_INDEX[clean[i + 1]] ?? 0;
    const c = B64_INDEX[clean[i + 2]];
    const d = B64_INDEX[clean[i + 3]];
    out[n++] = (a << 2) | (b >> 4);
    if (c !== undefined) out[n++] = ((b & 15) << 4) | (c >> 2);
    if (d !== undefined) out[n++] = ((c & 3) << 6) | d;
  }
  return out.slice(0, n);
}

/** base64url (Gmail) → base64 padrão com padding (para data: URI / expo-file-system). */
export function b64urlToB64(data: string): string {
  const s = (data || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  return s + '='.repeat((4 - (s.length % 4)) % 4);
}

/** UTF-8 com troca de byte inválido por U+FFFD (o errors="replace" do Python). */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp = -1;
    let need = 0;
    if (b < 0x80) {
      cp = b;
    } else if (b >= 0xc2 && b <= 0xdf) {
      cp = b & 0x1f;
      need = 1;
    } else if (b >= 0xe0 && b <= 0xef) {
      cp = b & 0x0f;
      need = 2;
    } else if (b >= 0xf0 && b <= 0xf4) {
      cp = b & 0x07;
      need = 3;
    }
    if (cp < 0) {
      out += '�';
      i += 1;
      continue;
    }
    let j = 1;
    for (; j <= need; j++) {
      const c = bytes[i + j];
      if (c === undefined || (c & 0xc0) !== 0x80) break;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (j <= need) {
      out += '�';
      i += j;
      continue;
    }
    i += need + 1;
    if ((need === 2 && cp < 0x800) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += '�';
      continue;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

export const b64Text = (data: string) => utf8Decode(b64urlToBytes(data));

// ── entidades HTML (html.unescape / convert_charrefs) ──
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', ndash: '–',
  mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€', ordm: 'º', ordf: 'ª',
  deg: '°', aacute: 'á', Aacute: 'Á', agrave: 'à', Agrave: 'À', acirc: 'â', Acirc: 'Â', atilde: 'ã', Atilde: 'Ã',
  eacute: 'é', Eacute: 'É', ecirc: 'ê', Ecirc: 'Ê', iacute: 'í', Iacute: 'Í', oacute: 'ó', Oacute: 'Ó', ocirc: 'ô',
  Ocirc: 'Ô', otilde: 'õ', Otilde: 'Õ', uacute: 'ú', Uacute: 'Ú', uuml: 'ü', Uuml: 'Ü', ccedil: 'ç', Ccedil: 'Ç',
};

export function unescapeHtml(s: string): string {
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? ENTITIES[ent.toLowerCase()] ?? m;
  });
}

// ── HTML → texto (_HtmlTextExtractor + _html_to_text) ──
const BLOCK_TAGS = new Set(['br', 'p', 'div', 'tr', 'li', 'blockquote', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export function htmlToText(raw: string): string {
  const parts: string[] = [];
  let skip = 0;
  // comentários e <!DOCTYPE> fora; cada tag vira evento como no HTMLParser
  const src = (raw || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<![^>]*>/g, '');
  const re = /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/)?\s*>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last && !skip) parts.push(unescapeHtml(src.slice(last, m.index)));
    last = m.index + m[0].length;
    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    if (tag === 'script' || tag === 'style') {
      if (closing) skip = Math.max(0, skip - 1);
      else if (!m[3]) skip += 1;
    } else if (BLOCK_TAGS.has(tag)) {
      parts.push('\n');
    }
  }
  if (last < src.length && !skip) parts.push(unescapeHtml(src.slice(last)));
  const lines = parts.join('').split('\n').map((ln) => ln.replace(/[ \t]+/g, ' ').trim());
  const out: string[] = [];
  let blank = false;
  for (const ln of lines) {
    if (!ln) {
      if (!blank) out.push('');
      blank = true;
    } else {
      out.push(ln);
      blank = false;
    }
  }
  return out.join('\n').trim();
}

// ── cabeçalhos ──
export function headerMap(payload: GmailPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of payload?.headers || []) out[(h.name || '').toLowerCase()] = h.value || '';
  return out;
}

// ── texto da mensagem ──
export function collectText(payload: GmailPart | undefined, plain: string[], html: string[]): void {
  if (!payload) return;
  const mime = payload.mimeType || '';
  const data = payload.body?.data;
  if (data) {
    const text = b64Text(data);
    if (mime.startsWith('text/plain')) plain.push(text);
    else if (mime.startsWith('text/html')) html.push(text);
  }
  for (const part of payload.parts || []) collectText(part, plain, html);
}

/** (texto como em get_thread_text, html bruto) de uma mensagem. */
export function messageBodyText(payload: GmailPart | undefined): { text: string; html: string } {
  const plain: string[] = [];
  const html: string[] = [];
  collectText(payload, plain, html);
  const rawHtml = html.join('\n');
  return { text: plain.join('\n').trim() || htmlToText(rawHtml), html: rawHtml };
}

// ── anexos ──
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Imagem que dá pra mostrar no corpo (SVG fica de fora: pode ter script). */
export function isImageFile(f: { mime_type?: string; filename?: string }): boolean {
  const mime = (f.mime_type || '').toLowerCase();
  if (mime === 'image/svg+xml') return false;
  return mime.startsWith('image/') || IMAGE_EXT_RE.test(f.filename || '');
}

const stripAngles = (s: string) => s.trim().replace(/^<+|>+$/g, '');

export function collectAttachments(messageId: string, payload: GmailPart | undefined, out: MimeFile[]): void {
  if (!payload) return;
  const filename = payload.filename || '';
  const body = payload.body || {};
  if (filename && body.attachmentId) {
    const headers = headerMap(payload);
    const cid = stripAngles((headers['content-id'] || headers['x-attachment-id'] || '').trim());
    const disposition = (headers['content-disposition'] || '').trim().toLowerCase();
    out.push({
      message_id: messageId,
      attachment_id: body.attachmentId,
      filename,
      mime_type: payload.mimeType || 'application/octet-stream',
      size: body.size || 0,
      content_id: cid,
      inline: disposition.startsWith('inline'),
      is_image: false,
      in_body: false,
    });
  }
  for (const part of payload.parts || []) collectAttachments(messageId, part, out);
}

// <img src="cid:..."> do HTML, na ordem em que aparecem.
const IMG_TAG_RE = /<img\b[^>]*>/gi;
const IMG_SRC_CID_RE = /\bsrc\s*=\s*["']?\s*cid:([^"'\s>]+)/i;
const IMG_ALT_RE = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
// "[image: image.png]", "[imagem: foto.jpg]", "[cid:abc@123]"
export const INLINE_PLACEHOLDER_RE = /\[(?:image|imagem|img)\s*:\s*([^\]\n]{0,200}?)\s*\]|\[cid:([^\]\s]{1,200})\]/gi;

export function htmlImageRefs(html: string): { cid: string; alt: string }[] {
  const refs: { cid: string; alt: string }[] = [];
  for (const tag of (html || '').match(IMG_TAG_RE) || []) {
    const src = IMG_SRC_CID_RE.exec(tag);
    if (!src) continue;
    const alt = IMG_ALT_RE.exec(tag);
    const altText = alt ? (alt[1] ?? alt[2] ?? alt[3] ?? '') : '';
    refs.push({ cid: stripAngles(unescapeHtml(src[1]).trim()), alt: unescapeHtml(altText).trim() });
  }
  return refs;
}

/** Cada placeholder do texto → anexo de imagem da MESMA mensagem (porte 1:1 de map_inline_placeholders). */
export function mapInlinePlaceholders(text: string, files: MimeFile[], htmlRefs: { cid: string; alt: string }[]): InlineRef[] {
  const images = files.filter(isImageFile);
  const byCid: Record<string, MimeFile> = {};
  for (const f of images) if (f.content_id) byCid[f.content_id.toLowerCase()] = f;
  const used = new Set<string>();
  const refsLeft = htmlRefs.filter((r) => r.cid.toLowerCase() in byCid);
  const free = (f: MimeFile | undefined | null) => (f && !used.has(f.attachment_id) ? f : null);

  const out: InlineRef[] = [];
  const re = new RegExp(INLINE_PLACEHOLDER_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ''))) {
    const name = (m[1] || '').trim();
    const cid = (m[2] || '').trim();
    let hit: MimeFile | null = null;
    let rule: InlineRef['rule'] = null;
    if (cid) {
      hit = free(byCid[cid.toLowerCase()]);
      rule = 'cid';
    } else {
      let ref = refsLeft.find((r) => name && r.alt.toLowerCase() === name.toLowerCase());
      ref = ref || refsLeft.find((r) => free(byCid[r.cid.toLowerCase()]));
      if (ref) {
        refsLeft.splice(refsLeft.indexOf(ref), 1);
        hit = free(byCid[ref.cid.toLowerCase()]);
        rule = 'cid';
      }
      if (!hit && name) {
        hit = images.find((f) => free(f) && f.filename.toLowerCase() === name.toLowerCase()) || null;
        rule = hit ? 'filename' : null;
      }
      if (!hit) {
        const ordered = [
          ...images.filter((f) => f.inline || f.content_id),
          ...images.filter((f) => !(f.inline || f.content_id)),
        ];
        hit = ordered.find((f) => free(f)) || null;
        rule = hit ? 'ordem' : null;
      }
    }
    if (hit) used.add(hit.attachment_id);
    out.push({
      token: m[0],
      name: name || cid,
      attachment_id: hit ? hit.attachment_id : null,
      filename: hit ? hit.filename : null,
      rule: hit ? rule : null,
    });
    if (m[0] === '') re.lastIndex += 1;
  }
  return out;
}

/** Anexos da thread + ordem das mensagens + placeholders inline (list_thread_attachments). */
export function threadAttachments(thread: GmailThread): { files: MimeFile[]; message_ids: string[]; inline: Record<string, InlineRef[]> } {
  const files: MimeFile[] = [];
  const messageIds: string[] = [];
  const inline: Record<string, InlineRef[]> = {};
  for (const message of thread.messages || []) {
    const msgId = message.id || '';
    messageIds.push(msgId);
    const mine: MimeFile[] = [];
    collectAttachments(msgId, message.payload, mine);
    const { text, html } = messageBodyText(message.payload);
    const refs = htmlImageRefs(html);
    const cids = new Set(refs.map((r) => r.cid.toLowerCase()));
    const placeholders = mapInlinePlaceholders(text, mine, refs);
    const shown = new Set(placeholders.map((p) => p.attachment_id).filter(Boolean) as string[]);
    for (const f of mine) {
      f.is_image = isImageFile(f);
      f.inline = !!(f.inline || (f.content_id && cids.has(f.content_id.toLowerCase())));
      f.in_body = shown.has(f.attachment_id);
    }
    if (placeholders.length) inline[msgId] = placeholders;
    files.push(...mine);
  }
  return { files, message_ids: messageIds, inline };
}

/** Texto da thread no formato do get_thread_text ("De:/Data:" + corpo, blocos separados por ----). */
export function threadText(thread: GmailThread): string {
  const blocks: string[] = [];
  for (const message of thread.messages || []) {
    const headers = headerMap(message.payload);
    let { text: body } = messageBodyText(message.payload);
    if (body.length > 8000) body = body.slice(0, 8000) + '\n[cortado]';
    blocks.push(`De: ${headers.from || ''}\nData: ${headers.date || ''}\n\n${body}`);
  }
  return blocks.join('\n\n----\n\n');
}

// ── endereços (email.utils.parseaddr / getaddresses, o suficiente para cabeçalhos) ──
function splitAddressList(header: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === '\\' && quoted && i + 1 < header.length) {
      cur += ch + header[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle += 1;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && !angle) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseAddr(token: string): { name: string; email: string } {
  const t = (token || '').trim();
  if (!t) return { name: '', email: '' };
  const m = /^(.*?)<([^>]*)>\s*$/.exec(t);
  if (m) {
    let name = m[1].trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    return { name, email: m[2].trim() };
  }
  // "email (Nome)"
  const p = /^(\S+@\S+)\s*\((.*)\)\s*$/.exec(t);
  if (p) return { name: p[2].trim(), email: p[1] };
  return { name: '', email: t.replace(/^"+|"+$/g, '').trim() };
}

export function getAddresses(header: string | null | undefined): { name: string; email: string }[] {
  return splitAddressList(header || '').map(parseAddr).filter((a) => a.name || a.email);
}
