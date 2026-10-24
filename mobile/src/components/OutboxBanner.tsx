// Fila de envio do aparelho (modo local): mostra o que está saindo para esta
// thread — "sai em N s" com Desfazer, "na fila (sem conexão)", "enviando",
// "falhou" — e permite cancelar enquanto não saiu.
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { data } from '../data';
import { useTheme } from '../theme';
import type { OutboxView } from '../types';
import { Btn, T, useToast } from './ui';

export function outboxLabel(i: OutboxView, nowMs: number): string {
  if (i.status === 'queued' && i.undo_until > nowMs) return `Sai em ${Math.ceil((i.undo_until - nowMs) / 1000)} s`;
  if (i.status === 'queued') return i.last_error ? `Na fila (sem conexão): sai quando o Gmail voltar. ${i.last_error}` : 'Na fila de envio…';
  if (i.status === 'sending') return 'Enviando…';
  if (i.status === 'failed') return `Não saiu: ${i.last_error || 'erro'}`;
  if (i.status === 'sent') return 'Enviado.';
  return 'Cancelado.';
}

export function OutboxBanner({ threadId, nonce, onSent }: { threadId?: string; nonce?: number; onSent?: () => void }) {
  const t = useTheme();
  const toast = useToast();
  const [items, setItems] = useState<OutboxView[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState('');
  const prev = useRef<OutboxView[]>([]);

  const load = useCallback(async () => {
    if (!data.isLocal()) return;
    try {
      const next = await data.outbox(threadId);
      // saiu da lista aberta = enviado (ou cancelado): avisa o pai para recarregar
      const gone = prev.current.some((p) => !next.find((n) => n.id === p.id));
      prev.current = next;
      setItems(next);
      if (gone) onSent?.();
    } catch {
      // sem banco ainda: tenta no próximo ciclo
    }
  }, [threadId, onSent]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load, nonce]);

  // enquanto há algo aberto, atualiza a contagem e o status a cada segundo
  useEffect(() => {
    if (!items.length) return;
    const h = setInterval(() => {
      setNow(Date.now());
      load();
    }, 1000);
    return () => clearInterval(h);
  }, [items.length, load]);

  if (!items.length) return null;
  return (
    <View style={{ gap: 8, marginBottom: 10 }} accessibilityLiveRegion="polite">
      {items.map((i) => (
        <View key={i.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 12, backgroundColor: i.status === 'failed' ? t.rose : t.butter }}>
          <View style={{ flex: 1 }}>
            <T style={{ fontSize: 13.5, fontWeight: '600' }}>{i.kind === 'new' ? `E-mail para ${i.to}` : `Resposta para ${i.to || 'o remetente'}`}</T>
            <T style={{ fontSize: 13 }}>{outboxLabel(i, now)}</T>
          </View>
          {i.status === 'queued' || i.status === 'failed' ? (
            <Btn
              label={i.status === 'queued' && i.undo_until > now ? 'Desfazer' : 'Cancelar'}
              busy={busy === i.id}
              onPress={async () => {
                setBusy(i.id);
                try {
                  await data.cancelSend(i.id);
                  toast('Envio cancelado: nada saiu.');
                  await load();
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Não deu para cancelar.');
                } finally {
                  setBusy('');
                }
              }}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}
