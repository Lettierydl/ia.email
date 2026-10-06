// Composer "Responder" do detalhe: abre com o rascunho da IA já salvo na thread
// (o mesmo do /mail) e só gera um novo se não houver nenhum ou em Regenerar.
// O envio usa a mesma rota do /mail e só sai depois do "Enviar agora" no Alert.
// O pai monta com key por thread + preset: estado novo a cada rascunho preparado.
import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, TextInput, View } from 'react-native';

import { absolute, api } from '../api';
import { ICON, ICON_COLOR } from '../icons';
import { useTheme } from '../theme';
import type { ItemDetail, Recipients } from '../types';
import { Block, Btn, IconBtn, T, useToast } from './ui';

/** Rascunho que uma ação acabou de preparar (Aplicar / Cobrar / Delegar). */
export interface ReplyPreset {
  text: string;
  cc: string[];
  status: string;
  nonce: number;
}

const lower = (e?: string) => String(e || '').trim().toLowerCase();

export function ReplyComposer({ item, preset, me, canSend, onSent, onLearn }: {
  item: ItemDetail; preset: ReplyPreset | null; me: string; canSend: boolean; onSent: () => void; onLearn: () => void;
}) {
  const t = useTheme();
  const toast = useToast();
  const initial = preset?.text || item.draft || '';
  const [text, setText] = useState(initial);
  const [aiText, setAiText] = useState(initial);
  const [all, setAll] = useState(true);
  const [extraCc] = useState<string[]>(preset?.cc || []);
  const [rcpt, setRcpt] = useState<Recipients | null>(null);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(preset?.status || '');
  // Ideia principal / instrução para a IA (mesmo /draft do /mail, campo instruction)
  const [instr, setInstr] = useState('');
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const tid = useRef(item.thread_id);
  tid.current = item.thread_id;

  useEffect(() => {
    let alive = true;
    api.recipients(item.thread_id).then((r) => alive && setRcpt(r)).catch(() => alive && setRcpt({ to: [], cc: [] }));
    if (!preset && !(item.draft || '').trim()) regenerate(true);
    return () => { alive = false; };
  }, [item.thread_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const to = (() => {
    if (lower(item.from_email) !== me) return item.from_email;
    const other = (rcpt?.to || []).find((a) => lower(a.email) !== me);
    return other?.email || item.from_email;
  })();
  // Mesma sugestão do "responder a todos" do /mail.
  const cc = (() => {
    const seen = new Set([me, lower(to)]);
    const out: string[] = [];
    const base = all ? [...(rcpt?.to || []), ...(rcpt?.cc || [])].map((a) => a.email) : [];
    [...base, ...extraCc].forEach((e) => {
      const email = lower(e);
      if (email && !seen.has(email)) { seen.add(email); out.push(email); }
    });
    return out.join(', ');
  })();

  // withInstruction=false: Regenerar. true: Gerar/Ajustar com a instrução; o
  // texto atual da caixa vai junto como "Rascunho anterior".
  async function regenerate(auto = false, withInstruction = false) {
    if (busy) return;
    const id = item.thread_id;
    const instruction = withInstruction ? instr.trim() : '';
    if (withInstruction && !instruction) return;
    const doIt = async () => {
      setBusy('regen');
      setStatus('');
      try {
        const r = await api.draft(id, instruction, instruction ? text : '');
        if (tid.current !== id) return;
        const last = (r.chat || []).slice(-1)[0];
        // pergunta pra IA (kind=answer): a resposta vai no status, o rascunho fica
        if (last?.kind === 'answer') setStatus(last.text || 'A IA respondeu sem rascunho novo.');
        else if (r.draft) { setText(r.draft); setAiText(r.draft); }
        else setStatus(last?.text || 'A IA não devolveu rascunho.');
        if (withInstruction) setInstr('');
      } catch (e) {
        if (tid.current === id) setStatus(e instanceof Error ? e.message : 'Falha no rascunho.');
      } finally {
        setBusy('');
      }
    };
    if (!auto && text.trim() && text !== aiText) {
      Alert.alert(
        withInstruction ? 'Ajustar?' : 'Regenerar?',
        withInstruction
          ? 'A IA vai reescrever a partir do texto que você editou. Trocar o texto da caixa pelo resultado?'
          : 'Trocar o texto que você editou por um rascunho novo da IA?',
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Trocar', onPress: doIt },
        ],
      );
      return;
    }
    await doIt();
  }

  // Citar o trecho selecionado no rascunho: vira `[n] Sobre o trecho do rascunho "…": `
  // na instrução (mesmo formato do /copilot web), e o Leo completa o comentário.
  const selected = text.slice(sel.start, sel.end).trim();
  const quoteSelection = () => {
    if (!selected) return;
    const n = (instr.match(/^\[\d+\]/gm) || []).length + 1;
    const quote = selected.length > 600 ? `${selected.slice(0, 600)}…` : selected;
    setInstr((prev) => `${prev.trim() ? `${prev.trimEnd()}\n` : ''}[${n}] Sobre o trecho do rascunho "${quote}": `);
  };

  async function send() {
    const body = text.trim();
    if (!body || !canSend) return;
    const id = item.thread_id;
    let files = 0;
    try { files = (await api.attachments(id)).files.length; } catch { /* segue sem a contagem */ }
    const subject = /^re:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`;
    const warn = /anex/i.test(body) && files === 0 ? '\n\n⚠️ O texto menciona anexo, mas nenhum arquivo foi anexado a essa resposta.' : '';
    Alert.alert(
      'Enviar e-mail?',
      `Para: ${to}${cc ? `\nCc: ${cc}` : ''}\nAssunto: ${subject}\n\n${body}${warn}\n\nEssa ação é definitiva — o e-mail sai imediatamente e não pode ser desfeito.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Enviar agora',
          style: 'destructive',
          onPress: async () => {
            setBusy('send');
            try {
              const r = await api.send(id, body, cc);
              // sem conexão: ficou na fila de envio do servidor e sai quando voltar
              if (r.queued) toast(`Na fila de envio. ${r.message || 'Sai quando a conexão voltar.'}`);
              else toast(r.cc ? `Enviado para ${r.to} (Cc: ${r.cc}).` : `Enviado para ${r.to}.`);
              onSent();
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Falha ao enviar.');
            } finally {
              setBusy('');
            }
          },
        },
      ],
    );
  }

  const seg = (on: boolean) => ({
    flex: 1, borderWidth: 1, borderRadius: 12, paddingVertical: 8, alignItems: 'center' as const,
    borderColor: on ? t.accent : t.line, backgroundColor: on ? t.lilac : t.bg,
  });
  const edited = !!text.trim() && text !== aiText;

  return (
    <Block label="Responder">
      <T muted style={{ fontSize: 12.5, marginBottom: 8 }}>Rascunho da IA, o mesmo do /mail. Nada sai sem você confirmar.</T>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <Pressable style={seg(!all)} onPress={() => setAll(false)} accessibilityRole="button" accessibilityState={{ selected: !all }}>
          <T style={{ fontSize: 13.5 }}>Responder</T>
        </Pressable>
        <Pressable style={seg(all)} onPress={() => setAll(true)} accessibilityRole="button" accessibilityState={{ selected: all }}>
          <T style={{ fontSize: 13.5 }}>Responder a todos</T>
        </Pressable>
      </View>
      <T muted style={{ fontSize: 13, marginBottom: 8 }}>
        Para: {to || '?'}{cc ? `\nCc: ${cc}` : rcpt ? ' · sem cópia' : ' · carregando cópias…'}
      </T>
      <TextInput
        value={text}
        onChangeText={(v) => { setText(v); setStatus(''); }}
        onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
        editable={busy !== 'regen'}
        multiline
        textAlignVertical="top"
        placeholder={busy === 'regen' ? 'A IA está escrevendo…' : 'Escreva a resposta ou peça um rascunho à IA.'}
        placeholderTextColor={t.muted}
        style={{ minHeight: 170, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 12, backgroundColor: t.bg, color: t.ink, fontSize: 15, fontFamily: t.font }}
      />
      <T muted style={{ fontSize: 12.5, marginTop: 6 }}>
        {busy === 'regen' ? 'Gerando rascunho…' : status || (edited ? 'Editado por você.' : text ? 'Sugestão da IA.' : '')}
      </T>
      {selected ? (
        <Pressable onPress={quoteSelection} accessibilityRole="button" style={{ alignSelf: 'flex-start', marginTop: 6, borderRadius: 999, backgroundColor: t.mint, paddingHorizontal: 10, paddingVertical: 4 }}>
          <T style={{ fontSize: 12.5 }}>❝ Citar trecho selecionado</T>
        </Pressable>
      ) : null}
      <View style={{ marginTop: 10, borderWidth: 1, borderColor: t.line, borderRadius: 12, backgroundColor: t.bg, padding: 8 }}>
        <T muted style={{ fontSize: 12, marginBottom: 4 }}>Ideia principal / instrução para a IA</T>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <TextInput
            value={instr}
            onChangeText={setInstr}
            multiline
            editable={busy !== 'regen'}
            placeholder="Diga o que quer responder…"
            placeholderTextColor={t.muted}
            accessibilityLabel="Ideia principal ou instrução para a IA"
            style={{ flex: 1, minHeight: 40, maxHeight: 160, textAlignVertical: 'top', color: t.ink, fontSize: 15, fontFamily: t.font, paddingVertical: 6 }}
          />
          <Btn primary label={text.trim() ? '✦ Ajustar' : '✦ Gerar'} busy={busy === 'regen'} disabled={!instr.trim() || !!busy} onPress={() => regenerate(false, true)} />
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <IconBtn icon={ICON.sparkles} label="Regenerar" busy={busy === 'regen'} onPress={() => regenerate()} />
        <IconBtn icon={ICON.learn} label="Aprender" onPress={onLearn} />
        <IconBtn icon={ICON.mail} iconColor={ICON_COLOR.mail} label="Abrir no /mail" onPress={() => Linking.openURL(absolute(`/mail/${encodeURIComponent(item.thread_id)}`))} />
        <Btn
          primary
          label={canSend ? 'Enviar…' : 'Sem permissão de envio'}
          busy={busy === 'send'}
          disabled={!canSend || !text.trim() || !!busy}
          onPress={send}
          style={{ flex: 1 }}
        />
      </View>
    </Block>
  );
}
