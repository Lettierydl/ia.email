// Anexos no modo local: baixa do Gmail (attachments.get), guarda no cache do
// app e abre a folha do sistema; imagem inline vira data: URI em memória.
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { b64urlToB64 } from '../core/mime';
import type { GmailFile } from '../types';

type FetchAttachment = (messageId: string, attachmentId: string) => Promise<{ data: string }>;

const MAX_IMAGES = 40;
const images = new Map<string, Promise<string>>();

/** data:image/...;base64 para o <Image>; cache LRU simples em memória. */
export function inlineImageUri(f: GmailFile, fetchAttachment: FetchAttachment): Promise<string> {
  const key = `${f.message_id}:${f.attachment_id}`;
  let hit = images.get(key);
  if (hit) {
    images.delete(key);
    images.set(key, hit);
    return hit;
  }
  hit = fetchAttachment(f.message_id, f.attachment_id).then((a) => `data:${f.mime_type || 'image/png'};base64,${b64urlToB64(a.data)}`);
  hit.catch(() => images.delete(key));
  images.set(key, hit);
  while (images.size > MAX_IMAGES) images.delete(images.keys().next().value as string);
  return hit;
}

export async function openLocalAttachment(f: GmailFile, fetchAttachment: FetchAttachment): Promise<void> {
  const safe = (f.filename || 'anexo').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120) || 'anexo';
  const dir = new Directory(Paths.cache, 'anexos', f.message_id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'msg');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, safe);
  if (!file.exists) {
    const a = await fetchAttachment(f.message_id, f.attachment_id);
    file.create({ intermediates: true, overwrite: true });
    file.write(b64urlToB64(a.data), { encoding: 'base64' });
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('Este aparelho não abre a folha de compartilhar.');
  await Sharing.shareAsync(file.uri, { mimeType: f.mime_type || undefined, dialogTitle: f.filename || 'Anexo' });
}
