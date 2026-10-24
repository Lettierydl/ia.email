// Composer "Responder" do detalhe: abre com o rascunho da IA já salvo na thread
// e só gera um novo se não houver nenhum ou em Regenerar. Pela camada `data`:
// no modo local, rascunho/destinatários/envio rodam no aparelho (escolha da
// mensagem a responder, Para/Cc em chips, fila com janela de desfazer); no
// modo servidor, as rotas do /mail como antes. Nada sai sem o ConfirmModal
// ("Enviar para X?"). O pai monta com key por thread + preset.
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, TextInput, View } from 'react-native';

import { absolute } from '../api';
import { data } from '../data';
import { ICON, ICON_COLOR } from '../icons';
import { useTheme } from '../theme';
import type { DraftResult, ItemDetail, Recipients, SendResult } from '../types';
import { AddrChips, lower } from './AddrChips';
import { ConfirmModal, ConfirmRequest } from './ConfirmModal';
import { Block, Btn, IconBtn, T, useToast } from './ui';

/** Rascunho que uma ação acabou de preparar (Aplicar / Cobrar / Delegar). */
export interface ReplyPreset {
  text: string;
  cc: string[];
  status: string;
  nonce: number;
}

export function ReplyComposer({ item, preset, me, canSend, onSent, onLearn }: {
  item: ItemDetail; preset: ReplyPreset | null; me: string; canSend: boolean; onSent: (r: SendResult) => void; onLearn: () => void;
}) {
  const t = useTheme();
  const toast = useToast();
  const initial = preset?.text || item.draft || '';
  const [text, setText] = useState(initial);
  const [aiText, setAiText] = useState(initial);
  const [all, setAll] = useState(true);
  const [extraCc] = useState<string[]>(preset?.cc || []);
  const [rcpt, setRcpt] = useState<Recipients | null>(null);
  // Para/Cc editáveis (chips). null = ainda no padrão calculado.
  const [toEdit, setToEdit] = useState<string[] | null>(null);
  const [ccEdit, setCcEdit] = useState<string[] | null>(null);
  // modo local: mensagem da thread que está sendo respondida ('' = padrão: última de terceiros)
  const [target, setTarget] = useState('');
  const [pickOpen, setPickOpen] = useState(false);
  const local = data.isLocal();
  // guarda do backend: trechos que a IA pode ter copiado do pedido
  const [alerta, setAlerta] = useState<DraftResult['alerta_copia'] | null>(null);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(preset?.status || '');
  // Ideia principal / instrução para a IA (mesmo /draft do /mail, campo instruction)
  const [instr, setInstr] = useState('');
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const tid = useRef(item.thread_id);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  tid.current = item.thread_id;

  useEffect(() => {
    let alive = true;
    data.recipients(item.thread_id, target || undefined).then((r) => alive && setRcpt(r)).catch(() => alive && setRcpt({ to: [], cc: [] }));
    return () => { alive = false; };
  }, [item.thread_id, target]);

  useEffect(() => {
    if (!preset && !(item.draft || '').trim()) regenerate(true);
  }, [item.thread_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const msgs = rcpt?.messages || [];
  const targetId = target || rcpt?.target_id || '';
  const targetMsg = msgs.find((m) => m.id === targetId);
  const pickTarget = (id: string) => {
    // trocar a mensagem respondida recalcula o Para/Cc padrão a partir dela
    setTarget(id === rcpt?.target_id && !target ? '' : id);
    setToEdit(null);
    setCcEdit(null);
    setPickOpen(false);
  };

  // Padrão: o mesmo do servidor (reply_to / reply_cc, sem você); servidor
  // antigo sem esses campos: último remetente que não é você.
  const defaultTo = (() => {
    if (rcpt?.reply_to?.length) return rcpt.reply_to.map((a) => lower(a.email));
    if (lower(item.from_email) !== me) return [lower(item.from_email)];
    const other = (rcpt?.to || []).find((a) => lower(a.email) !== me);
    return [lower(other?.email || item.from_email)];
  })().filter(Boolean);
  const toList = toEdit ?? defaultTo;
  // Mesma sugestão do "responder a todos" do /mail (sem você e sem quem já está no Para).
  const defaultCc = (() => {
    const seen = new Set([me, ...toList.map(lower)]);
    const out: string[] = [];
    const base = all ? (rcpt?.reply_cc ? rcpt.reply_cc : [...(rcpt?.to || []), ...(rcpt?.cc || [])]).map((a) => a.email) : [];
    [...base, ...extraCc].forEach((e) => {
      const email = lower(e);
      if (email && !seen.has(email)) { seen.add(email); out.push(email); }
    });
    return out;
  })();
  const ccList = ccEdit ?? defaultCc;
  const cc = ccList.join(', ');
  const people = (rcpt?.participants || []).filter((a) => a.email && lower(a.email) !== me);
  const names = Object.fromEntries(people.filter((a) => a.name).map((a) => [lower(a.email), a.name]));
  const inUse = new Set([...toList, ...ccList].map(lower));
  const others = people.filter((a) => !inUse.has(lower(a.email)));

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
        const r = await data.draft(id, instruction, instruction ? text : '', target || undefined);
        if (tid.current !== id) return;
        const last = (r.chat || []).slice(-1)[0];
        setAlerta(last?.kind === 'answer' ? null : r.alerta_copia || null);
        // pergunta pra IA (kind=answer): a resposta vai no status, o rascunho fica
        if (last?.kind === 'answer') setStatus(last.text || 'A IA respondeu sem rascunho novo.');
        else if (r.draft) {
          setText(r.draft);
          setAiText(r.draft);
          if (r.alerta_copia) setStatus(r.alerta_copia.mensagem || 'A IA pode ter copiado parte do seu pedido no texto — revise os trechos abaixo.');
        }
        else setStatus(last?.text || 'A IA não devolveu rascunho.');
        if (r.aviso) setStatus(r.aviso);
        if (withInstruction) setInstr('');
      } catch (e) {
        if (tid.current === id) setStatus(e instanceof Error ? e.message : 'Falha no rascunho.');
      } finally {
        setBusy('');
      }
    };
    if (!auto && text.trim() && text !== aiText) {
      setConfirm({
        title: withInstruction ? 'Ajustar?' : 'Regenerar?',
        message: withInstruction
          ? 'A IA vai reescrever a partir do texto que você editou. Trocar o texto da caixa pelo resultado?'
          : 'Trocar o texto que você editou por um rascunho novo da IA?',
        confirmLabel: 'Trocar',
        onConfirm: doIt,
      });
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
    if (!toList.length) {
      toast('Informe pelo menos um destinatário no Para.');
      return;
    }
    const id = item.thread_id;
    let files = 0;
    try { files = await data.attachmentsCount(id); } catch { /* segue sem a contagem */ }
    const subject = /^re:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`;
    const warn = /anex/i.test(body) && files === 0 ? '\n\n⚠️ O texto menciona anexo, mas nenhum arquivo foi anexado a essa resposta.' : '';
    const replyTo = targetMsg && targetMsg.id !== msgs[msgs.length - 1]?.id ? `\nRespondendo a: ${targetMsg.de} · ${targetMsg.data}` : '';
    const tail = local
      ? 'Você terá 10 s para desfazer antes de sair; sem conexão, fica na fila e sai quando o Gmail voltar.'
      : 'Essa ação é definitiva — o e-mail sai imediatamente e não pode ser desfeito.';
    setConfirm({
      title: `Enviar para ${toList.join(', ')}?`,
      message: `${cc ? `Cc: ${cc}\n` : ''}Assunto: ${subject}${replyTo}\n\n${body}${warn}\n\n${tail}`,
      confirmLabel: local ? 'Enviar' : 'Enviar agora',
      destructive: true,
      onConfirm: async () => {
        setBusy('send');
        try {
          // confirmed: true só existe aqui, dentro do "Enviar" do ConfirmModal
          const r = await data.send(id, { text: body, cc, to: toList, replyToMessageId: target || undefined }, { confirmed: true });
          if (local) toast(r.message || 'Na fila de envio: dá para desfazer por alguns segundos.');
          // sem conexão: ficou na fila de envio do servidor e sai quando voltar
          else if (r.queued) toast(`Na fila de envio. ${r.message || 'Sai quando a conexão voltar.'}`);
          else toast(r.cc ? `Enviado para ${r.to} (Cc: ${r.cc}).` : `Enviado para ${r.to}.`);
          onSent(r);
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Falha ao enviar.');
        } finally {
          setBusy('');
        }
      },
    });
  }

  const seg = (on: boolean) => ({
    flex: 1, borderWidth: 1, borderRadius: 12, paddingVertical: 8, alignItems: 'center' as const,
    borderColor: on ? t.accent : t.line, backgroundColor: on ? t.lilac : t.bg,
  });
  const edited = !!text.trim() && text !== aiText;

  return (
    <Block label="Responder">
      <T muted style={{ fontSize: 12.5, marginBottom: 8 }}>
        {local ? 'Rascunho da IA feito no aparelho. Nada sai sem você confirmar.' : 'Rascunho da IA, o mesmo do /mail. Nada sai sem você confirmar.'}
      </T>
      {msgs.length > 1 ? (
        <View style={{ marginBottom: 8 }}>
          <Pressable onPress={() => setPickOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: pickOpen }}
            style={{ borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 8, backgroundColor: t.bg }}>
            <T muted style={{ fontSize: 12 }}>Respondendo a {pickOpen ? '▾' : '▸'}</T>
            <T style={{ fontSize: 13.5 }} numberOfLines={1}>{targetMsg ? `${targetMsg.voce ? 'Você' : targetMsg.de} · ${targetMsg.data}` : 'última mensagem'}</T>
          </Pressable>
          {pickOpen ? msgs.map((m) => (
            <Pressable key={m.id} onPress={() => pickTarget(m.id)} accessibilityRole="radio" accessibilityState={{ selected: m.id === targetId }}
              style={{ marginTop: 4, padding: 8, borderRadius: 10, borderWidth: 1, borderColor: m.id === targetId ? t.accent : t.line, backgroundColor: m.id === targetId ? t.lilac : t.card }}>
              <T style={{ fontSize: 13 }}>{m.idx + 1}. {m.voce ? 'Você' : m.de} · {m.data}</T>
              {m.snippet ? <T muted style={{ fontSize: 12.5 }} numberOfLines={2}>{m.snippet}</T> : null}
            </Pressable>
          )) : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <Pressable style={seg(!all)} onPress={() => { setAll(false); setCcEdit(null); }} accessibilityRole="button" accessibilityState={{ selected: !all }}>
          <T style={{ fontSize: 13.5 }}>Responder</T>
        </Pressable>
        <Pressable style={seg(all)} onPress={() => { setAll(true); setCcEdit(null); }} accessibilityRole="button" accessibilityState={{ selected: all }}>
          <T style={{ fontSize: 13.5 }}>Responder a todos</T>
        </Pressable>
      </View>
      <AddrChips label="Para" value={toList} onChange={setToEdit} names={names} placeholder={rcpt ? 'e-mail do destinatário' : 'carregando…'} />
      <AddrChips label="Cc" value={ccList} onChange={setCcEdit} names={names} suggestions={others} placeholder={rcpt ? 'sem cópia' : 'carregando cópias…'} />
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
      {alerta?.trechos?.length && text === aiText ? (
        <View style={{ marginTop: 8, padding: 10, borderRadius: 12, backgroundColor: t.butter }} accessibilityLiveRegion="polite">
          <T style={{ fontSize: 13, fontWeight: '600' }}>⚠️ {alerta.mensagem || 'Revise estes trechos do rascunho'}</T>
          {alerta.trechos.map((tr, i) => (
            <T key={i} style={{ fontSize: 13, marginTop: 4 }}>• “{tr}”</T>
          ))}
        </View>
      ) : null}
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
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </Block>
  );
}
