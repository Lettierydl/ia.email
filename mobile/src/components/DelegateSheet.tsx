// Delegar em 2 modos: às claras (rascunho na thread com Cc de quem já está nela)
// ou e-mail novo silencioso (só para a pessoa). Nada é enviado.
import { useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { api } from '../api';
import { useTheme } from '../theme';
import type { ActionResult, ItemDetail, ModoDelegar } from '../types';
import { Btn, Sheet, T, useToast } from './ui';

export function DelegateSheet({ item, visible, onClose, onDone }: {
  item: ItemDetail; visible: boolean; onClose: () => void; onDone: (r: ActionResult) => void;
}) {
  const t = useTheme();
  const toast = useToast();
  const [para, setPara] = useState('');
  const [nome, setNome] = useState('');
  const [modo, setModo] = useState<ModoDelegar>('cc_originais');
  const [nota, setNota] = useState('');
  const [sug, setSug] = useState<{ name: string; email: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (visible) {
      setPara(''); setNome(''); setNota(''); setSug([]); setModo('cc_originais');
    }
  }, [visible]);

  const onType = async (q: string) => {
    setPara(q);
    setNome('');
    const s = q.trim();
    if (s.length < 2 || s.includes('@')) {
      setSug([]);
      return;
    }
    const mine = ++seq.current;
    try {
      const r = await api.aliasSuggest(s);
      if (mine === seq.current) setSug(r.suggestions || []);
    } catch {
      setSug([]);
    }
  };

  const go = async () => {
    setBusy(true);
    try {
      onDone(await api.delegar(item.thread_id, para.trim(), modo, nome, nota.trim()));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não deu certo.');
    } finally {
      setBusy(false);
    }
  };

  const orig = item.originarios.map((a) => a.email).join(', ') || 'ninguém';
  const input = { borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 10, backgroundColor: t.bg, color: t.ink, fontSize: 15, fontFamily: t.font };

  return (
    <Sheet visible={visible} onClose={onClose} title="Delegar">
      <T muted style={{ fontSize: 13.5, marginBottom: 4 }}>Para quem</T>
      <TextInput
        value={para}
        onChangeText={onType}
        placeholder="nome ou e-mail"
        placeholderTextColor={t.muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        style={input}
      />
      {sug.length ? (
        <View style={{ borderWidth: 1, borderColor: t.line, borderRadius: 12, marginTop: 4, overflow: 'hidden' }}>
          {sug.map((s) => (
            <Pressable
              key={s.email}
              onPress={() => { setPara(s.email); setNome(s.name); setSug([]); }}
              style={({ pressed }) => ({ padding: 10, backgroundColor: pressed ? t.fog : t.card })}
            >
              <T style={{ fontSize: 13.5 }}>{s.name} &lt;{s.email}&gt;</T>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={{ height: 12 }} />
      <Radio
        on={modo === 'cc_originais'}
        onPress={() => setModo('cc_originais')}
        title="Às claras, na própria conversa"
        hint={`Rascunho na thread com Cc de quem já está nela (${orig}).`}
      />
      <Radio
        on={modo === 'novo_silencioso'}
        onPress={() => setModo('novo_silencioso')}
        title="E-mail novo, silencioso"
        hint="Só para a pessoa, sem copiar ninguém da conversa."
      />

      <T muted style={{ fontSize: 13.5, marginTop: 4, marginBottom: 4 }}>Recado (opcional)</T>
      <TextInput value={nota} onChangeText={setNota} multiline style={[input, { minHeight: 60, textAlignVertical: 'top' }]} />

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
        <Btn primary label="Preparar rascunho" onPress={go} busy={busy} disabled={!para.trim()} style={{ flex: 1 }} />
        <Btn label="Cancelar" onPress={onClose} />
      </View>
      <T muted style={{ fontSize: 13, marginTop: 10 }}>Nada é enviado: você revisa antes.</T>
    </Sheet>
  );
}

export function Radio({ on, onPress, title, hint }: { on: boolean; onPress: () => void; title: string; hint: string }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{
        flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderWidth: 1, borderColor: on ? t.accent : t.line,
        backgroundColor: on ? t.lilac : 'transparent', borderRadius: 12, padding: 10, marginBottom: 8,
      }}
    >
      <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: on ? t.accent : t.muted, marginTop: 2, alignItems: 'center', justifyContent: 'center' }}>
        {on ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent }} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: 14 }}>{title}</T>
        <T muted style={{ fontSize: 12.5 }}>{hint}</T>
      </View>
    </Pressable>
  );
}
