// Ajustes → "Conta Google" (modo standalone): entrar/sair e status. O token
// fica com o google-signin (Keychain) e nunca aparece na tela. No Expo Go o
// módulo nativo não existe: mostra "requer development build" e segue.
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { AuthError, getGoogleAuth, type AuthState } from '../core/googleAuth';
import { useTheme } from '../theme';
import { ConfirmModal, ConfirmRequest } from './ConfirmModal';
import { Block, Btn, T, useToast } from './ui';

export function GoogleAccountBlock({ onChanged }: { onChanged?: () => void }) {
  const t = useTheme();
  const toast = useToast();
  const [state, setState] = useState<AuthState | null>(null);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const refresh = async () => {
    try {
      setState(await getGoogleAuth().state());
    } catch (e) {
      setState({ kind: 'unavailable', reason: e instanceof Error ? e.message : 'Login Google indisponível.' });
    }
  };
  useEffect(() => {
    let alive = true;
    getGoogleAuth()
      .state()
      .then((s) => alive && setState(s))
      .catch(() => alive && setState({ kind: 'unavailable', reason: 'Login Google indisponível.' }));
    return () => {
      alive = false;
    };
  }, []);

  const signIn = async () => {
    setBusy('in');
    try {
      const u = await getGoogleAuth().signIn();
      await refresh();
      toast(`Conectado como ${u.email}.`);
      onChanged?.();
    } catch (e) {
      if (!(e instanceof AuthError && e.code === 'cancelled')) toast(e instanceof Error ? e.message : 'O login falhou.');
    } finally {
      setBusy('');
    }
  };

  const askSignOut = () =>
    setConfirm({
      title: 'Sair da conta Google?',
      message: 'O app para de baixar e-mails deste Gmail. O que já está no aparelho continua aqui até você entrar de novo.',
      confirmLabel: 'Sair',
      onConfirm: async () => {
        setBusy('out');
        try {
          await getGoogleAuth().signOut();
          await refresh();
          toast('Você saiu da conta Google.');
          onChanged?.();
        } finally {
          setBusy('');
        }
      },
    });

  const badge = (label: string, bg: string) => (
    <View style={{ alignSelf: 'flex-start', borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8, backgroundColor: bg }}>
      <T style={{ fontSize: 12 }}>{label}</T>
    </View>
  );

  return (
    <Block label="Conta Google">
      <T muted style={{ fontSize: 13, marginBottom: 8 }}>
        Para o app ler o Gmail sozinho, sem o servidor do Mac. Acesso pedido: ler e organizar e-mails (gmail.modify). Nada é enviado por aqui.
      </T>
      {!state ? (
        <T muted style={{ fontSize: 13 }}>Verificando…</T>
      ) : state.kind === 'unavailable' ? (
        <View style={{ gap: 6 }}>
          {badge('requer development build', t.peach)}
          <T style={{ fontSize: 13 }}>{state.reason} Instale o build de desenvolvimento (EAS) para entrar com o Google.</T>
        </View>
      ) : state.kind === 'not_configured' ? (
        <View style={{ gap: 6 }}>
          {badge('client ID não configurado', t.peach)}
          <T style={{ fontSize: 13 }}>{state.reason}</T>
        </View>
      ) : state.kind === 'signed_out' ? (
        <View style={{ gap: 8 }}>
          {badge('não conectado', t.fog)}
          <Btn primary label="Entrar com Google" busy={busy === 'in'} onPress={signIn} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {badge(state.hasGmailScope ? 'conectado' : 'sem acesso ao Gmail', state.hasGmailScope ? t.mint : t.rose)}
          <T style={{ fontSize: 14 }}>{state.user.name ? `${state.user.name} · ` : ''}{state.user.email}</T>
          {!state.hasGmailScope ? (
            <T style={{ fontSize: 13 }}>O acesso ao Gmail não foi concedido. Entre de novo e marque a permissão do Gmail.</T>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {!state.hasGmailScope ? <Btn primary label="Entrar de novo" busy={busy === 'in'} onPress={signIn} /> : null}
            <Btn label="Sair" busy={busy === 'out'} onPress={askSignOut} />
          </View>
        </View>
      )}
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </Block>
  );
}
