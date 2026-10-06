// Aprender: o Leo registra uma regra/contexto que a IA usa nos PRÓXIMOS e-mails
// (rascunho e leitura do copiloto). Não gera rascunho nem envia nada. Mostra
// também o que já vale para esta conversa, com × para remover.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { api } from '../api';
import { useTheme } from '../theme';
import type { ItemDetail, LearnedNote, LearnedScope } from '../types';
import { Radio } from './DelegateSheet';
import { Btn, Sheet, T, useToast } from './ui';

const SCOPE_TAG: Record<LearnedScope, string> = { thread: 'neste assunto', person: 'pessoa', general: 'geral' };

export function LearnSheet({ item, me, visible, onClose }: { item: ItemDetail; me: string; visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const toast = useToast();
  const [text, setText] = useState('');
  const [scope, setScope] = useState<LearnedScope>('thread');
  const [notes, setNotes] = useState<LearnedNote[]>([]);
  const [busy, setBusy] = useState(false);

  // Pessoa: o remetente (ou quem pediu, se o último a escrever foi você).
  const from = (item.from_email || '').trim().toLowerCase();
  const person = from && from !== me ? from : (item.quem_pediu?.email || '').trim().toLowerCase();

  const reload = useCallback(async () => {
    try {
      setNotes((await api.learned(item.thread_id)).notes || []);
    } catch {
      setNotes([]);
    }
  }, [item.thread_id]);

  // O pai só monta a folha quando abre: estado sempre novo, aqui só busca a lista.
  useEffect(() => {
    let alive = true;
    api.learned(item.thread_id).then((r) => alive && setNotes(r.notes || [])).catch(() => undefined);
    return () => { alive = false; };
  }, [item.thread_id]);

  const save = async () => {
    setBusy(true);
    try {
      await api.learn(scope, text.trim(), item.thread_id, scope === 'person' ? person : '');
      setText('');
      toast(`Aprendido: vale para ${scope === 'person' ? person : scope === 'general' ? 'todos os e-mails' : 'esta conversa/assunto'}.`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não salvou.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.unlearn(id);
      toast('Aprendizado removido.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não removeu.');
    }
    reload();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Aprender">
      <T muted style={{ fontSize: 13, marginBottom: 10 }}>A IA guarda isto e usa nos próximos rascunhos e leituras. Não gera rascunho nem envia nada.</T>
      <T muted style={{ fontSize: 13.5, marginBottom: 4 }}>O que a IA deve saber/lembrar</T>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        maxLength={1000}
        placeholder="Ex.: pix estático é com o time de Produto."
        placeholderTextColor={t.muted}
        style={{ minHeight: 70, textAlignVertical: 'top', borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 10, backgroundColor: t.bg, color: t.ink, fontSize: 15, fontFamily: t.font, marginBottom: 12 }}
      />
      <Radio on={scope === 'thread'} onPress={() => setScope('thread')} title="Esta conversa/assunto" hint={`${item.subject || '(sem assunto)'} — e outras com o mesmo assunto.`} />
      {person ? <Radio on={scope === 'person'} onPress={() => setScope('person')} title={`Esta pessoa (${person})`} hint="Qualquer e-mail em que ela esteja." /> : null}
      <Radio on={scope === 'general'} onPress={() => setScope('general')} title="Geral" hint="Vale para todos os e-mails." />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
        <Btn primary label="Salvar" onPress={save} busy={busy} disabled={!text.trim()} style={{ flex: 1 }} />
        <Btn label="Fechar" onPress={onClose} />
      </View>

      <T muted style={{ fontSize: 11.5, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 16, marginBottom: 6 }}>Já vale para esta conversa</T>
      {notes.length ? (
        notes.map((n) => (
          <View key={n.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: t.bg, borderRadius: 10, padding: 10, marginBottom: 6 }}>
            <View style={{ flex: 1 }}>
              <T style={{ fontSize: 13.5 }}>{n.text}</T>
              <T muted style={{ fontSize: 11.5 }}>{SCOPE_TAG[n.scope] || n.scope}{n.scope === 'person' ? ` · ${n.person_email}` : ''}</T>
            </View>
            <Pressable onPress={() => remove(n.id)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Remover este aprendizado">
              <T muted style={{ fontSize: 18 }}>×</T>
            </Pressable>
          </View>
        ))
      ) : (
        <T muted style={{ fontSize: 13 }}>Nada aprendido ainda para esta conversa.</T>
      )}
    </Sheet>
  );
}
