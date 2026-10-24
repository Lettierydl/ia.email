// Ajustes → "Chaves de IA" (app standalone): chaves Gemini e OpenRouter no
// Keychain. A chave salva nunca volta para a tela — só "configurada" ou não.
// "Testar IA" faz uma chamada curta pela cadeia e diz qual modelo respondeu.
import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';

import { testAi } from '../core/ai';
import { deleteSecret, secretStatus, SecretProvider, setSecret } from '../core/secrets';
import { useTheme } from '../theme';
import { ConfirmModal, ConfirmRequest } from './ConfirmModal';
import { Block, Btn, T, useToast } from './ui';

const PROVIDERS: { id: SecretProvider; label: string; hint: string }[] = [
  { id: 'gemini', label: 'Gemini (Google AI Studio)', hint: 'Usada primeiro: Gemini Flash e Flash-Lite.' },
  { id: 'openrouter', label: 'OpenRouter', hint: 'Reserva gratuita quando o Gemini falha ou fica sem cota.' },
];

type TestResult = { ok: true; name: string; seconds: number; skipped: { name: string; reason: string }[] } | { ok: false; error: string };

export function AiKeysBlock() {
  const t = useTheme();
  const toast = useToast();
  const [status, setStatus] = useState<Record<SecretProvider, boolean>>({ gemini: false, openrouter: false });
  const [draft, setDraft] = useState<Record<SecretProvider, string>>({ gemini: '', openrouter: '' });
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  const refresh = async () => {
    try {
      setStatus(await secretStatus());
    } catch {
      // Keychain indisponível: fica "não configurada"
    }
  };
  useEffect(() => {
    let alive = true;
    secretStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const save = async (p: SecretProvider) => {
    if (!draft[p].trim()) return;
    setBusy(`save-${p}`);
    try {
      await setSecret(p, draft[p]);
      setDraft((d) => ({ ...d, [p]: '' }));
      setResult(null);
      await refresh();
      toast('Chave salva no aparelho.');
    } catch {
      toast('Não consegui salvar a chave.');
    } finally {
      setBusy('');
    }
  };

  const askRemove = (p: SecretProvider, label: string) =>
    setConfirm({
      title: 'Apagar chave?',
      message: `A chave ${label} sai do aparelho. Para usar de novo, cole outra vez.`,
      confirmLabel: 'Apagar',
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteSecret(p);
          setResult(null);
          await refresh();
          toast('Chave apagada.');
        } catch {
          toast('Não consegui apagar a chave.');
        }
      },
    });

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const r = await testAi();
      setResult({ ok: true, name: r.name, seconds: r.seconds, skipped: r.skipped });
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : 'Falha ao testar a IA.' });
    } finally {
      setBusy('');
    }
  };

  const input = { flex: 1, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 10, backgroundColor: t.bg, color: t.ink, fontSize: 15, fontFamily: t.font };

  return (
    <Block label="Chaves de IA">
      <T muted style={{ fontSize: 13, marginBottom: 6 }}>
        Ficam só neste aparelho (Keychain). Depois de salva, a chave não aparece mais aqui.
      </T>
      {PROVIDERS.map((p) => (
        <View key={p.id} style={{ marginTop: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T style={{ fontSize: 14, fontWeight: '600' }}>{p.label}</T>
            <View style={{ borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8, backgroundColor: status[p.id] ? t.mint : t.fog }}>
              <T style={{ fontSize: 12 }}>{status[p.id] ? 'configurada' : 'não configurada'}</T>
            </View>
          </View>
          <T muted style={{ fontSize: 12.5, marginTop: 2, marginBottom: 6 }}>{p.hint}</T>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextInput
              value={draft[p.id]}
              onChangeText={(v) => setDraft((d) => ({ ...d, [p.id]: v }))}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              textContentType="password"
              placeholder={status[p.id] ? '•••••••• (cole outra para trocar)' : 'Cole a chave aqui'}
              placeholderTextColor={t.muted}
              accessibilityLabel={`Chave ${p.label}`}
              style={[input, { minWidth: 180 }]}
            />
            <Btn primary label="Salvar" busy={busy === `save-${p.id}`} disabled={!draft[p.id].trim()} onPress={() => save(p.id)} />
            {status[p.id] ? <Btn label="Apagar" onPress={() => askRemove(p.id, p.label)} /> : null}
          </View>
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
        <Btn label="Testar IA" busy={busy === 'test'} disabled={!status.gemini && !status.openrouter} onPress={test} />
      </View>
      {result ? (
        <View accessibilityLiveRegion="polite" style={{ marginTop: 10, padding: 10, borderRadius: 12, backgroundColor: result.ok ? t.mint : t.rose, gap: 4 }}>
          {result.ok ? (
            <>
              <T style={{ fontSize: 14, fontWeight: '600' }}>IA respondeu: {result.name} ({result.seconds}s)</T>
              {result.skipped.map((s, i) => (
                <T key={i} style={{ fontSize: 12.5 }}>✗ {s.name}: {s.reason}</T>
              ))}
            </>
          ) : (
            <>
              <T style={{ fontSize: 14, fontWeight: '600' }}>IA não respondeu</T>
              <T style={{ fontSize: 13 }}>{result.error}</T>
            </>
          )}
        </View>
      ) : null}
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </Block>
  );
}
