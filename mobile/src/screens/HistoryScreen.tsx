// Histórico de ações (fonte local: historico_acoes do aparelho; servidor: as
// rotas da página Histórico da web): lista o que foi feito (resolver, mover,
// delegar…) com Desfazer / Refazer por linha e "Desfazer a última". E-mail
// enviado não volta (marcado não reversível).
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { data as source } from '../data';
import { ConfirmModal, ConfirmRequest } from '../components/ConfirmModal';
import { Btn, T, useToast } from '../components/ui';
import { useTheme } from '../theme';
import type { HistEntry } from '../types';

const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export function HistoryScreen({ onBack, onChanged, onOpen }: { onBack: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const t = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<HistEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | 'ultimo' | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await source.historico();
      setItems(r.items);
      setNext(r.proximo);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar o histórico.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const h = setTimeout(load, 0);
    return () => clearTimeout(h);
  }, [load]);

  const more = async () => {
    if (!next || loading) return;
    try {
      const r = await source.historico(next);
      setItems((prev) => [...prev, ...r.items]);
      setNext(r.proximo);
    } catch { /* puxar para atualizar tenta de novo */ }
  };

  const doIt = async (key: number | 'ultimo', fn: () => Promise<{ entry: HistEntry }>, okMsg: string) => {
    setBusy(key);
    try {
      const r = await fn();
      toast(`${okMsg}${r.entry?.rotulo ? `: ${r.entry.rotulo}` : ''}.`);
      onChanged();
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não deu certo.');
    } finally {
      setBusy(null);
    }
  };

  const undo = (h: HistEntry) =>
    setConfirm({
      title: 'Desfazer?',
      message: `${h.rotulo}${h.assunto ? `\n“${h.assunto}”` : ''}${h.n > 1 ? `\n(${h.n} e-mails)` : ''}\n\nVolta ao estado de antes desta ação (no app e no Gmail, quando for o caso).`,
      confirmLabel: 'Desfazer',
      onConfirm: () => doIt(h.id, () => source.desfazer(h.id), 'Desfeito'),
    });

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={items}
        keyExtractor={(h) => String(h.id)}
        onEndReached={more}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={t.accent} />}
        contentContainerStyle={{ paddingTop: Math.max(12, insets.top), paddingHorizontal: 16 + Math.max(insets.left, insets.right), paddingBottom: insets.bottom + 40, gap: 8 }}
        ListHeaderComponent={
          <View style={{ marginBottom: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Pressable onPress={onBack} accessibilityLabel="Voltar" hitSlop={8} style={{ width: 40, height: 40, justifyContent: 'center' }}>
                <T style={{ fontSize: 22 }}>←</T>
              </Pressable>
              <T title style={{ flex: 1, fontSize: 20, fontWeight: '600' }}>Histórico</T>
              <Btn
                label="↶ Desfazer a última"
                busy={busy === 'ultimo'}
                disabled={busy !== null}
                onPress={() => doIt('ultimo', () => source.desfazerUltimo(), 'Desfeito')}
              />
            </View>
            <T muted style={{ fontSize: 12.5 }}>Suas ações no copiloto e no /mail. E-mail enviado não pode ser desfeito.</T>
            {error ? (
              <View style={{ backgroundColor: t.rose, borderRadius: 12, padding: 12, marginTop: 10, gap: 8 }}>
                <T style={{ fontSize: 13.5 }}>{error}</T>
                <Btn label="Tentar de novo" onPress={load} />
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={!loading && !error ? <T muted style={{ textAlign: 'center', paddingVertical: 30 }}>Nada no histórico ainda.</T> : undefined}
        renderItem={({ item: h }) => (
          <View style={{ backgroundColor: t.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: t.line, opacity: h.desfeito ? 0.7 : 1 }}>
            <Pressable disabled={!h.thread_id} onPress={() => onOpen(h.thread_id)} accessibilityRole="button">
              <T style={{ fontSize: 14, fontWeight: '600', textDecorationLine: h.desfeito ? 'line-through' : 'none' }}>{h.rotulo}</T>
              {h.assunto ? <T muted numberOfLines={2} style={{ fontSize: 13, marginTop: 2 }}>{h.assunto}{h.n > 1 ? ` · ${h.n} e-mails` : ''}</T> : null}
              <T muted style={{ fontSize: 12, marginTop: 2 }}>
                {when(h.at)}{h.origem ? ` · ${h.origem}` : ''}{h.desfeito ? ' · desfeito' : ''}{h.estado === 'nao_reversivel' ? ` · ${h.motivo || 'não dá para desfazer'}` : ''}
              </T>
            </Pressable>
            {h.estado !== 'nao_reversivel' ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                {h.desfeito ? (
                  <Btn label="↷ Refazer" busy={busy === h.id} disabled={busy !== null} onPress={() => doIt(h.id, () => source.refazer(h.id), 'Refeito')} />
                ) : (
                  <Btn label="↶ Desfazer" busy={busy === h.id} disabled={busy !== null} onPress={() => undo(h)} />
                )}
              </View>
            ) : null}
          </View>
        )}
      />
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </View>
  );
}
