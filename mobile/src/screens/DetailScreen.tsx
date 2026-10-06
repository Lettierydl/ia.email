// Detalhe em 3 camadas: seu papel, o que aconteceu, o que eu faria (com o porquê).
// Ações Acompanhar / Cobrar / Delegar / Resolvido só mudam estado ou preparam
// rascunho no servidor. Responder abre o composer com o rascunho da IA; o envio
// usa a rota do /mail e só sai depois da confirmação.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { absolute, api } from '../api';
import { DelegateSheet } from '../components/DelegateSheet';
import { LearnSheet } from '../components/LearnSheet';
import { ReplyComposer, type ReplyPreset } from '../components/ReplyComposer';
import { Avatar, Block, Btn, Chip, IconBtn, papelColor, Sheet, T, urgColor, useToast } from '../components/ui';
import { ACAO, ago, ddmm, EVID, PAPEL, PAPEL_HINT, URG } from '../labels';
import { ICON, ICON_COLOR } from '../icons';
import { useTheme } from '../theme';
import type { ActionResult, ItemDetail, Opcao, Prefs, ResumoContexto } from '../types';

const DONE_MSG: Record<string, string> = { assumir: 'Você acompanha.', acompanhar: 'Você acompanha.', resolver: 'Resolvido e marcado como lido.', reabrir: 'Reaberto.' };
// Ícones: mesmo conjunto da web (src/icons.ts ↔ static/icons.js). Resolvido = duplo check verde.
const ICO = { reply: ICON.reply, eye: ICON.eye, bell: ICON.bell, bellOff: ICON['bell-off'], share: ICON.handoff, done: ICON['check-circle-double'], reopen: ICON.reopen, thread: ICON.thread, summary: ICON.summary, mail: ICON.mail, spark: ICON.sparkles, learn: ICON.learn };

export function DetailScreen({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const t = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [it, setIt] = useState<ItemDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>('');
  const [delegating, setDelegating] = useState(false);
  const [learning, setLearning] = useState(false);
  const [draft, setDraft] = useState<{ verb: string; res: ActionResult } | null>(null);
  const [threadOpen, setThreadOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyPreset, setReplyPreset] = useState<ReplyPreset | null>(null);
  const [sendInfo, setSendInfo] = useState({ me: '', canSend: false });
  const [prefs, setPrefs] = useState<Partial<Prefs>>({});
  const scroll = useRef<ScrollView>(null);
  const replyY = useRef(0);
  const replyNonce = useRef(0);

  useEffect(() => {
    api.appStatus().then((s) => setSendInfo({ me: (s.account || '').toLowerCase(), canSend: !!s.can_send })).catch(() => undefined);
    api.prefs().then(setPrefs).catch(() => undefined);
  }, []);

  const load = useCallback(async (refresh = false) => {
    try {
      setIt(await api.detail(id, refresh));
      setError('');
      if (refresh) onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Falha ao abrir.';
      if (refresh) toast(msg);
      else setError(msg);
    }
  }, [id, onChanged, toast]);

  useEffect(() => {
    setIt(null);
    setThreadOpen(false);
    setSummaryOpen(true);
    setReplyOpen(false);
    setReplyPreset(null);
    (async () => {
      try {
        const first = await api.detail(id);
        setIt(first);
        setError('');
        // ainda sem leitura da IA (ou com mensagem nova): lê agora
        if ((!first.analisado && !first.lido_por_regra) || first.desatualizado) {
          setBusy('reread');
          await load(true);
          setBusy('');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Falha ao abrir.');
      }
    })();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openReply = (preset: ReplyPreset | null = null) => {
    if (preset) setReplyPreset(preset);
    setReplyOpen(true);
    setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, replyY.current - 12), animated: true }), 250);
  };

  const afterDraft = (res: ActionResult, verb: string) => {
    // rascunho na própria conversa: abre o composer já preenchido
    if (res.open_url && res.open_url.startsWith('/mail/')) {
      const cc = new URLSearchParams(res.open_url.split('?')[1] || '').get('cc') || '';
      openReply({
        text: res.draft || '', cc: cc.split(',').map((e) => e.trim()).filter(Boolean), nonce: ++replyNonce.current,
        status: `${verb} preparado pela IA. Nada foi enviado: revise e envie daqui.`,
      });
    } else if (res.open_url) setDraft({ verb, res });
    else toast(`${verb}: feito.`);
  };

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!it) return;
    setBusy(action);
    try {
      const r = await api.action(it.thread_id, action, extra);
      setIt(r.item);
      onChanged();
      // Resolvido = lido no Gmail: sai do quadro, então volta para a lista.
      if (action === 'resolver') onBack();
      if (action === 'cobrar') afterDraft(r, 'Cobrança');
      else if (action !== 'tarefa') toast(DONE_MSG[action] || 'Pronto.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não deu certo.');
    } finally {
      setBusy('');
    }
  };

  const apply = async (op: Opcao, idx: number) => {
    if (!it) return;
    if (op.acao === 'direcionar' && !op.para) {
      setDelegating(true);
      return;
    }
    setBusy(`apply${idx}`);
    try {
      const r = await api.action(it.thread_id, 'aplicar', { opcao: idx });
      setIt(r.item);
      onChanged();
      afterDraft(r, op.acao === 'direcionar' ? 'Delegação' : op.acao === 'pedir_contexto' ? 'Pedido de contexto' : 'Rascunho');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não deu certo.');
    } finally {
      setBusy('');
    }
  };

  const top = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <Pressable onPress={onBack} accessibilityLabel="Voltar à lista" hitSlop={8} style={{ width: 40, height: 40, justifyContent: 'center' }}>
        <T style={{ fontSize: 22 }}>←</T>
      </Pressable>
      <T title style={{ flex: 1, fontSize: 19, fontWeight: '600', lineHeight: 25 }}>{it?.subject || ''}</T>
      {it && it.bola.com !== 'ninguem' ? <Avatar email={it.bola.email} name={it.bola.nome} size={44} a11y={it.bola.com === 'outros' ? `Aguardando: ${it.bola.nome || it.bola.email || 'outra pessoa'}` : 'Com você'} /> : null}
    </View>
  );

  if (!it) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: Math.max(12, insets.top), paddingHorizontal: 16 }}>
        {top}
        {error ? (
          <View style={{ gap: 10 }}>
            <T>{error}</T>
            <Btn label="Tentar de novo" onPress={() => load()} />
          </View>
        ) : (
          <ActivityIndicator style={{ marginTop: 40 }} color={t.accent} />
        )}
      </View>
    );
  }

  const ballLabel = it.bola.com === 'leo' ? 'próximo passo com você' : it.bola.com === 'outros' ? `aguardando ${it.bola.nome || it.bola.email || 'outra pessoa'}` : 'ninguém precisa agir';
  // quem pediu / respondido / sem resposta: das mensagens reais (it.conversa), igual à web
  const conv = it.conversa || null;
  const facts: [string, string][] = [];
  if (conv?.solicitante) facts.push(['Quem pediu', `${conv.solicitante.nome}${conv.solicitante.quando ? ` · ${conv.solicitante.quando}` : ''}`]);
  else if (it.quem_pediu?.email) facts.push(['Quem pediu', it.quem_pediu.nome || it.quem_pediu.email]);
  if (it.prazo) facts.push(['Prazo', ddmm(it.prazo)]);
  if (conv?.status === 'respondido' && conv.rotulo_resposta) facts.push(['Resposta', conv.rotulo_resposta]);
  else if (it.sem_resposta_desde) {
    const since = conv?.status === 'aguardando' ? conv.rotulo_resposta.replace(/^Sem resposta\s*/, '') : '';
    facts.push(['Sem resposta', `${ago(it.sem_resposta_desde)}${since ? ` · ${since}` : ''}`]);
  }
  facts.push(['Depende de outros', it.depende_de_outros ? 'sim' : 'não']);
  if (it.delegado?.para) facts.push(['Delegado para', it.delegado.para]);
  const canCobrar = it.bola.com === 'outros' || !!it.delegado?.para;
  const resolved = it.status === 'resolvido';

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView ref={scroll} contentContainerStyle={{ paddingTop: Math.max(12, insets.top), paddingHorizontal: 16, paddingBottom: 120 + insets.bottom }}>
        {top}
        <T muted style={{ fontSize: 13, marginBottom: 12 }}>
          {conv?.solicitante ? (conv.solicitante.voce ? 'Você pediu' : `${conv.solicitante.nome} pediu`) : it.from_name}
          {conv?.status === 'respondido' && conv.rotulo_resposta ? ` · ${conv.rotulo_resposta}` : it.sem_resposta_desde ? ` · sem resposta ${ago(it.sem_resposta_desde)}` : ''}
          {` · ${ballLabel}`}{it.desatualizado ? ' · chegou mensagem nova' : ''}
        </T>

        <Block label="Seu papel" n={1}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Chip label={PAPEL[it.papel] || it.papel} bg={papelColor(t, it.papel)} />
            {URG[it.urgencia] ? <Chip label={URG[it.urgencia]} bg={urgColor(t, it.urgencia)} /> : null}
          </View>
          <T muted style={{ fontSize: 13, marginTop: 8 }}>{PAPEL_HINT[it.papel] || ''}</T>
        </Block>

        <Block label="O que aconteceu" n={2}>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            <IconBtn icon={ICO.summary} label="Ver resumo" onPress={() => setSummaryOpen((v) => !v)} style={{ width: 40, height: 40 }} />
            {it.mensagens && it.mensagens.length ? (
              <IconBtn
                icon={ICO.thread}
                label={`Ver thread completa (${it.mensagens.length})`}
                onPress={() => setThreadOpen((v) => !v)}
                style={{ width: 40, height: 40 }}
              />
            ) : null}
          </View>
          {summaryOpen ? <T style={{ fontSize: 16, lineHeight: 23 }}>{it.o_que_aconteceu || '—'}</T> : null}
          {threadOpen && it.mensagens
            ? it.mensagens.map((m, i) => (
                <View key={i} style={{ backgroundColor: t.bg, borderRadius: 12, padding: 10, marginTop: 8 }}>
                  <T style={{ fontWeight: '600', fontSize: 13 }}>{m.de || '—'}</T>
                  {m.data ? <T muted style={{ fontSize: 12 }}>{m.data}</T> : null}
                  <T style={{ fontSize: 13.5, lineHeight: 20, marginTop: 6 }}>{m.texto}</T>
                </View>
              ))
            : null}
        </Block>

        <Block label="O que eu faria" n={3}>
          {it.opcoes.map((op, i) => (
            <OptionCard key={i} op={op} busy={busy === `apply${i}`} onApply={() => apply(op, i)} resumo={it.resumo_contexto} />
          ))}
          {it.needs_context ? (
            <View style={{ backgroundColor: t.butter, borderRadius: 14, padding: 12, marginTop: 10 }}>
              <T style={{ fontWeight: '600', fontSize: 14.5 }}>Preciso de contexto</T>
              <T style={{ fontSize: 14, marginTop: 4 }}>{it.o_que_falta}</T>
              {it.pergunta ? <T style={{ fontSize: 14, marginTop: 4, fontWeight: '600' }}>{it.pergunta}</T> : null}
            </View>
          ) : null}
          {!it.opcoes.length && !it.needs_context ? (
            <T muted style={{ fontSize: 13 }}>{busy === 'reread' ? 'Lendo o e-mail…' : it.analisado || it.lido_por_regra ? 'Nada a sugerir: não pede ação sua.' : 'A leitura da IA falhou; peça de novo.'}</T>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <IconBtn
              icon={ICO.spark}
              label={busy === 'reread' ? 'Lendo…' : it.analisado ? 'Ler de novo' : 'Pedir leitura da IA'}
              busy={busy === 'reread'}
              onPress={async () => {
                if (busy === 'reread') return;
                setBusy('reread');
                try {
                  await load(true);
                  toast(it.analisado ? 'Leitura da IA atualizada.' : 'Leitura concluída.');
                } finally {
                  setBusy('');
                }
              }}
            />
            <IconBtn
              icon={ICO.mail}
              iconColor={ICON_COLOR.mail}
              label="Abrir e-mail"
              onPress={() => Linking.openURL(absolute(`/mail/${encodeURIComponent(it.thread_id)}`))}
            />
            {/* mesmo link do /mail: o thread_id do app é o id da thread no Gmail */}
            <IconBtn
              icon="M"
              iconColor="#EA4335"
              label="Abrir no Gmail"
              onPress={() => Linking.openURL(
                `https://mail.google.com/mail/${sendInfo.me ? `?authuser=${encodeURIComponent(sendInfo.me)}` : ''}#all/${encodeURIComponent(it.thread_id)}`,
              )}
            />
          </View>
        </Block>

        {replyOpen ? (
          <View onLayout={(e) => { replyY.current = e.nativeEvent.layout.y; }}>
            <ReplyComposer
              key={`${it.thread_id}:${replyPreset?.nonce || 0}`}
              item={it}
              preset={replyPreset}
              me={sendInfo.me}
              canSend={sendInfo.canSend}
              onSent={() => { setReplyOpen(false); setReplyPreset(null); onChanged(); load(); }}
              onLearn={() => setLearning(true)}
            />
          </View>
        ) : null}

        {prefs.show_tasks_card !== false && it.tarefas.length ? (
          <Block label="Tarefas">
            {it.tarefas.map((tk, i) => (
              <Pressable
                key={i}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: tk.feita }}
                onPress={() => act('tarefa', { index: i, feita: !tk.feita })}
                style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 5 }}
              >
                <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: tk.feita ? t.accent : t.muted, backgroundColor: tk.feita ? t.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {tk.feita ? <T style={{ color: t.card, fontSize: 12 }}>✓</T> : null}
                </View>
                <T style={{ flex: 1, fontSize: 14, color: tk.feita ? t.muted : t.ink, textDecorationLine: tk.feita ? 'line-through' : 'none' }}>{tk.texto}</T>
              </Pressable>
            ))}
          </Block>
        ) : null}

        {prefs.show_facts_card === false ? null : <Block>
          {facts.map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', gap: 12, paddingVertical: 2 }}>
              <T muted style={{ fontSize: 13.5, width: 130 }}>{k}</T>
              <T style={{ fontSize: 13.5, flex: 1 }}>{v}</T>
            </View>
          ))}
        </Block>}

        {it.historico.length ? (
          <Block label="Histórico">
            {it.historico.map((h, i) => (
              <T key={i} muted style={{ fontSize: 12.5, paddingVertical: 1 }}>
                {new Date(h.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {h.acao}
                {h.para ? ` → ${h.para}` : ''}
              </T>
            ))}
          </Block>
        ) : null}
      </ScrollView>

      {/* barra fixa de ações */}
      <View
        style={{
          // 6 botões numa linha em 360px: 6×48 + 5×6 + 2×10 = 338
          position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 6,
          justifyContent: 'space-evenly', alignItems: 'center',
          paddingHorizontal: 10, paddingTop: 10, paddingBottom: Math.max(10, insets.bottom),
          backgroundColor: t.bg, borderTopWidth: 1, borderTopColor: t.line,
        }}
      >
        <IconBtn icon={ICO.reply} label="Responder" onPress={() => openReply()} />
        <IconBtn primary icon={ICO.eye} label="Acompanhar" busy={busy === 'acompanhar' || busy === 'assumir'} onPress={() => act('acompanhar')} />
        <IconBtn icon={canCobrar ? ICO.bell : ICO.bellOff} label={canCobrar ? 'Cobrar' : 'Cobrar indisponível: ninguém está te devendo resposta'} disabled={!canCobrar} busy={busy === 'cobrar'} onPress={() => act('cobrar')} />
        <IconBtn icon={ICO.share} label="Delegar" onPress={() => setDelegating(true)} />
        <IconBtn icon={ICO.learn} label="Aprender" onPress={() => setLearning(true)} />
        <IconBtn
          icon={resolved ? ICO.reopen : ICO.done}
          iconColor={resolved ? undefined : ICON_COLOR['check-circle-double']}
          label={resolved ? 'Reabrir' : 'Resolvido'}
          busy={busy === 'resolver' || busy === 'reabrir'}
          onPress={() => act(resolved ? 'reabrir' : 'resolver')}
        />
      </View>

      <DelegateSheet
        item={it}
        visible={delegating}
        onClose={() => setDelegating(false)}
        onDone={(r) => {
          setDelegating(false);
          setIt(r.item);
          onChanged();
          afterDraft(r, 'Delegação');
        }}
      />

      {learning ? <LearnSheet item={it} me={sendInfo.me} visible onClose={() => setLearning(false)} /> : null}

      <Sheet visible={!!draft} onClose={() => setDraft(null)} title={`${draft?.verb || ''} preparado`}>
        <T muted style={{ fontSize: 13, marginBottom: 10 }}>Nada foi enviado. Revise e envie pela tela do e-mail.</T>
        {draft?.res.draft ? (
          <View style={{ backgroundColor: t.bg, borderRadius: 12, padding: 12 }}>
            <T selectable style={{ fontSize: 13.5 }}>{draft.res.draft}</T>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Btn
            primary
            label="Abrir rascunho"
            style={{ flex: 1 }}
            onPress={() => {
              if (draft?.res.open_url) Linking.openURL(absolute(draft.res.open_url));
              setDraft(null);
            }}
          />
          <Btn label="Depois" onPress={() => setDraft(null)} />
        </View>
      </Sheet>
    </View>
  );
}

function OptionCard({ op, busy, onApply, resumo }: { op: Opcao; busy: boolean; onApply: () => void; resumo?: ResumoContexto }) {
  const t = useTheme();
  const [why, setWhy] = useState(false);
  const [sum, setSum] = useState(false);
  const pct = Math.round((op.confianca || 0) * 100);
  const n = resumo?.total_mensagens || 0;
  return (
    <View style={{ borderWidth: 1, borderColor: t.line, borderRadius: 14, padding: 12, marginTop: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <T style={{ fontSize: 14.5, fontWeight: '600', flex: 1 }}>{ACAO[op.acao] || op.acao}</T>
        <Btn label="Aplicar" busy={busy} onPress={onApply} style={{ paddingVertical: 6 }} />
      </View>
      {op.texto ? <T style={{ fontSize: 14, marginTop: 4 }}>{op.texto}</T> : null}
      {op.para ? <T muted style={{ fontSize: 13, marginTop: 2 }}>para {op.para}</T> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <T muted style={{ fontSize: 12 }}>confiança</T>
        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: t.fog, overflow: 'hidden' }}>
          <View style={{ width: `${pct}%`, height: '100%', backgroundColor: '#9ad9b8' }} />
        </View>
        <T muted style={{ fontSize: 12 }}>{pct}%</T>
      </View>
      <View style={{ flexDirection: 'row', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
        <Pressable onPress={() => setWhy(!why)} accessibilityRole="button" accessibilityState={{ expanded: why }}>
          <T style={{ color: t.accentInk, fontSize: 13.5 }}>{why ? '▾' : '▸'} Por quê?</T>
        </Pressable>
        <Pressable onPress={() => setSum(!sum)} accessibilityRole="button" accessibilityState={{ expanded: sum }}>
          <T style={{ color: t.accentInk, fontSize: 13.5 }}>{sum ? '▾' : '▸'} Resumo{n ? ` · ${n}` : ''}</T>
        </Pressable>
      </View>
      {why
        ? op.evidencias.map((ev, i) => (
            <View key={i} style={{ marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: t.fog }}>
              <T style={{ fontSize: 12, fontWeight: '600' }}>{EVID[ev.tipo] || ev.tipo} · {ev.titulo}</T>
              <T style={{ fontSize: 13, marginTop: 4 }}>“{ev.trecho}”</T>
              {ev.porque ? <T muted style={{ fontSize: 12.5, marginTop: 4 }}>{ev.porque}</T> : null}
            </View>
          ))
        : null}
      {sum ? <ResumoBox rc={resumo} /> : null}
    </View>
  );
}

function ResumoBox({ rc }: { rc?: ResumoContexto }) {
  const t = useTheme();
  if (!rc) return <T muted style={{ fontSize: 13, marginTop: 8 }}>Sem resumo ainda.</T>;
  const row = (label: string, who?: string | null, trecho?: string | null) =>
    who || trecho ? (
      <View key={label} style={{ marginTop: 8 }}>
        <T style={{ fontSize: 12, fontWeight: '600', color: t.muted }}>{label}{who ? ` · ${who}` : ''}</T>
        {trecho ? <T style={{ fontSize: 13.5, marginTop: 2 }}>{trecho}</T> : null}
      </View>
    ) : null;
  return (
    <View style={{ marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: t.fog }}>
      {rc.o_que_aconteceu ? <T style={{ fontSize: 14, lineHeight: 20 }}>{rc.o_que_aconteceu}</T> : null}
      {row('Quem abriu pedindo', rc.abertura ? (rc.abertura.nome || rc.abertura.email) : null, rc.abertura?.trecho)}
      {row('Você respondeu', rc.sua_resposta ? 'você' : null, rc.sua_resposta?.trecho)}
      {row('Último', rc.ultima ? (rc.ultima.voce ? 'você' : (rc.ultima.nome || rc.ultima.email)) : null, rc.ultima?.trecho)}
    </View>
  );
}
