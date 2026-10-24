// E-mail novo preparado por uma ação (Delegar silencioso / Cobrar em e-mail
// novo) no modo local: Para/Cc/Assunto/Texto editáveis e o mesmo fluxo de
// envio — ConfirmModal "Enviar para X?" → fila com janela de desfazer.
import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { data } from '../data';
import { useTheme } from '../theme';
import { AddrChips } from './AddrChips';
import { ConfirmModal, ConfirmRequest } from './ConfirmModal';
import { Btn, Sheet, T, useToast } from './ui';

export interface NewMail {
  to: string;
  subject: string;
  body: string;
  verb: string;
}

export function ComposeNewSheet({ mail, onClose, onQueued }: { mail: NewMail; onClose: () => void; onQueued: () => void }) {
  const t = useTheme();
  const toast = useToast();
  const [to, setTo] = useState<string[]>(mail.to ? [mail.to.toLowerCase()] : []);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState(mail.subject);
  const [body, setBody] = useState(mail.body);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const input = { borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 10, backgroundColor: t.bg, color: t.ink, fontSize: 15, fontFamily: t.font };

  const send = () => {
    if (!to.length || !body.trim()) return;
    setConfirm({
      title: `Enviar para ${to.join(', ')}?`,
      message: `${cc.length ? `Cc: ${cc.join(', ')}\n` : ''}Assunto: ${subject}\n\n${body.trim()}\n\nVocê terá alguns segundos para desfazer antes de sair.`,
      confirmLabel: 'Enviar',
      destructive: true,
      onConfirm: async () => {
        setBusy(true);
        try {
          const r = await data.sendNew({ to: to.join(', '), cc: cc.join(', '), subject, body }, { confirmed: true });
          toast(r.message || 'Na fila de envio.');
          onQueued();
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Falha ao enviar.');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <Sheet visible onClose={onClose} title={`${mail.verb}: e-mail novo`}>
      <T muted style={{ fontSize: 13, marginBottom: 8 }}>Nada foi enviado. Revise e envie daqui.</T>
      <AddrChips label="Para" value={to} onChange={setTo} placeholder="e-mail" />
      <AddrChips label="Cc" value={cc} onChange={setCc} placeholder="sem cópia" />
      <TextInput value={subject} onChangeText={setSubject} placeholder="Assunto" placeholderTextColor={t.muted} accessibilityLabel="Assunto" style={[input, { marginTop: 6 }]} />
      <TextInput value={body} onChangeText={setBody} multiline accessibilityLabel="Texto do e-mail" style={[input, { marginTop: 8, minHeight: 160, textAlignVertical: 'top' }]} />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Btn primary label="Enviar…" busy={busy} disabled={!to.length || !body.trim() || busy} onPress={send} style={{ flex: 1 }} />
        <Btn label="Depois" onPress={onClose} />
      </View>
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </Sheet>
  );
}
