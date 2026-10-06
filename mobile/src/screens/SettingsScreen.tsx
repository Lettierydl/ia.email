// Ajustes: endereço do servidor (fica no aparelho), skin, horários do digest
// (por usuário, no servidor) e prévia do resumo diário/semanal.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, DEFAULT_BASE_URL, getBaseUrl, saveBaseUrl } from '../api';
import { Block, Btn, T, useToast } from '../components/ui';
import { WEEK } from '../labels';
import { SkinName, useTheme } from '../theme';
import type { Digest, Prefs } from '../types';

const DEFAULT_PREFS: Prefs = { skin: 'clean', digest_daily: '08:00', digest_weekly_day: 0, digest_weekly_time: '08:30', digest_enabled: true, show_all: false };

export function SettingsScreen({ onBack, onSkin, onServerChanged }: {
  onBack: () => void; onSkin: (s: SkinName) => void; onServerChanged: () => void;
}) {
  const t = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState(getBaseUrl());
  const [prefs, setPrefs] = useState<Prefs>({ ...DEFAULT_PREFS, skin: t.name });
  const [prefsOk, setPrefsOk] = useState(false);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [busy, setBusy] = useState('');

  const loadPrefs = async () => {
    try {
      setPrefs(await api.prefs());
      setPrefsOk(true);
    } catch {
      setPrefsOk(false);
    }
  };
  useEffect(() => {
    loadPrefs();
  }, []);

  const testAndSave = async () => {
    setBusy('url');
    await saveBaseUrl(url);
    setUrl(getBaseUrl());
    try {
      await api.status();
      toast('Conectado. Endereço salvo.');
      onServerChanged();
      loadPrefs();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Sem conexão.');
    } finally {
      setBusy('');
    }
  };

  const setSkin = (s: SkinName) => {
    setPrefs({ ...prefs, skin: s });
    onSkin(s);
  };

  const save = async () => {
    setBusy('save');
    try {
      setPrefs(await api.savePrefs(prefs));
      toast('Ajustes salvos.');
      onServerChanged(); // a lista da home segue o filtro de não lidos salvo
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não salvou.');
    } finally {
      setBusy('');
    }
  };

  const preview = async (period: 'daily' | 'weekly') => {
    setBusy(period);
    try {
      setDigest(await api.digest(period));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falha no resumo.');
    } finally {
      setBusy('');
    }
  };

  const input = { borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 10, backgroundColor: t.bg, color: t.ink, fontSize: 15, fontFamily: t.font };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: Math.max(12, insets.top), paddingHorizontal: 16, paddingBottom: insets.bottom + 40 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Pressable onPress={onBack} accessibilityLabel="Voltar" hitSlop={8} style={{ width: 40, height: 40, justifyContent: 'center' }}>
          <T style={{ fontSize: 22 }}>←</T>
        </Pressable>
        <T title style={{ fontSize: 20, fontWeight: '600' }}>Ajustes do copiloto</T>
      </View>

      <Block label="Servidor">
        <T muted style={{ fontSize: 13, marginBottom: 6 }}>
          Endereço do IA.Email. No celular físico use o IP do Mac na mesma rede (ex.: http://192.168.0.10:8765).
        </T>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={DEFAULT_BASE_URL}
          placeholderTextColor={t.muted}
          style={input}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <Btn primary label="Testar e salvar" busy={busy === 'url'} onPress={testAndSave} style={{ flex: 1 }} />
          <Btn label="Padrão" onPress={() => setUrl(DEFAULT_BASE_URL)} />
        </View>
      </Block>

      <Block label="Visual">
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['clean', 'caderno'] as SkinName[]).map((s) => {
            const on = prefs.skin === s;
            return (
              <Pressable
                key={s}
                onPress={() => setSkin(s)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={{ flex: 1, borderWidth: 1, borderColor: on ? t.accent : t.line, backgroundColor: on ? t.lilac : t.bg, borderRadius: 12, padding: 10, alignItems: 'center' }}
              >
                <T style={{ fontSize: 14 }}>{s === 'clean' ? 'Clean pastel' : 'Caderno'}</T>
              </Pressable>
            );
          })}
        </View>
      </Block>

      <Block label="Painel">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <T style={{ fontSize: 14 }}>Mostrar todos os e-mails</T>
            <T muted style={{ fontSize: 12.5 }}>Desligado: só os não lidos (abas, cards e contadores). Vale ao salvar.</T>
          </View>
          <Switch
            value={!!prefs.show_all}
            onValueChange={(v) => setPrefs({ ...prefs, show_all: v })}
            trackColor={{ true: t.accent, false: t.line }}
          />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <T style={{ fontSize: 14 }}>Card “Tarefas” no detalhe</T>
            <T muted style={{ fontSize: 12.5 }}>Tarefas que a IA tirou do e-mail. Vale ao salvar.</T>
          </View>
          <Switch
            value={prefs.show_tasks_card !== false}
            onValueChange={(v) => setPrefs({ ...prefs, show_tasks_card: v })}
            trackColor={{ true: t.accent, false: t.line }}
          />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <T style={{ fontSize: 14 }}>Card “Quem pediu / Sem resposta / Depende de outros”</T>
            <T muted style={{ fontSize: 12.5 }}>Fatos da conversa no detalhe. Vale ao salvar.</T>
          </View>
          <Switch
            value={prefs.show_facts_card !== false}
            onValueChange={(v) => setPrefs({ ...prefs, show_facts_card: v })}
            trackColor={{ true: t.accent, false: t.line }}
          />
        </View>
      </Block>

      <Block label="Resumos (digest)">
        {!prefsOk ? <T muted style={{ fontSize: 13, marginBottom: 8 }}>Sem conexão: mostrando valores padrão.</T> : null}
        <T muted style={{ fontSize: 13.5, marginBottom: 4 }}>Resumo diário (manhã) — HH:MM</T>
        <TextInput value={prefs.digest_daily} onChangeText={(v) => setPrefs({ ...prefs, digest_daily: v })} keyboardType="numbers-and-punctuation" maxLength={5} style={input} />
        <T muted style={{ fontSize: 13.5, marginTop: 10, marginBottom: 4 }}>Resumo semanal</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {WEEK.map((d, i) => {
            const on = Number(prefs.digest_weekly_day) === i;
            return (
              <Pressable
                key={d}
                onPress={() => setPrefs({ ...prefs, digest_weekly_day: i })}
                style={{ borderWidth: 1, borderColor: on ? t.ink : t.line, backgroundColor: on ? t.ink : t.card, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 11 }}
              >
                <T style={{ fontSize: 13, color: on ? t.card : t.ink }}>{d}</T>
              </Pressable>
            );
          })}
        </View>
        <T muted style={{ fontSize: 13.5, marginTop: 10, marginBottom: 4 }}>Horário do semanal — HH:MM</T>
        <TextInput value={prefs.digest_weekly_time} onChangeText={(v) => setPrefs({ ...prefs, digest_weekly_time: v })} keyboardType="numbers-and-punctuation" maxLength={5} style={input} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <View style={{ flex: 1 }}>
            <T style={{ fontSize: 14 }}>Gerar os resumos</T>
            <T muted style={{ fontSize: 12.5 }}>Nesta versão o resumo só é montado; a entrega automática vem depois.</T>
          </View>
          <Switch
            value={prefs.digest_enabled}
            onValueChange={(v) => setPrefs({ ...prefs, digest_enabled: v })}
            trackColor={{ true: t.accent, false: t.line }}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <Btn primary label="Salvar" busy={busy === 'save'} onPress={save} />
          <Btn label="Ver resumo de hoje" busy={busy === 'daily'} onPress={() => preview('daily')} />
          <Btn label="Ver semanal" busy={busy === 'weekly'} onPress={() => preview('weekly')} />
        </View>
      </Block>

      {digest ? (
        <Block label={digest.titulo}>
          <T muted style={{ fontSize: 13, marginBottom: 8 }}>Próximo: {digest.agendamento}{digest.ativo ? '' : ' (desligado)'}</T>
          {digest.secoes.map((s, i) => (
            <View key={i} style={{ marginBottom: 10 }}>
              <T style={{ fontSize: 14, fontWeight: '600' }}>{s.titulo}</T>
              {s.itens.map((x, j) => (
                <T key={j} style={{ fontSize: 13.5, marginTop: 2 }}>• {x}</T>
              ))}
            </View>
          ))}
        </Block>
      ) : null}
    </ScrollView>
  );
}
