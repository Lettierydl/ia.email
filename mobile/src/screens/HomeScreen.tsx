// Home: saudação, cartões Hoje / Aguardando outras pessoas, abas e lista de cards.
// Views: Quadro (3 abas) | Resolvidos | Marcados como lido.
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ApiError } from '../api';
import { Avatar, Btn, Chip, papelColor, T, urgColor, useToast } from '../components/ui';
import { ago, ddmm, PAPEL, STATUS, TAB_TITLE, URG } from '../labels';
import { shadow, useTheme } from '../theme';
import type { CopilotList, Item, ItemTab, Job } from '../types';

type Mode = 'quadro' | 'resolvido' | 'lidos';

const MODES: { key: Mode; title: string; hint: string }[] = [
  { key: 'quadro', title: 'Quadro', hint: 'Não lidos que ainda pedem algo.' },
  { key: 'resolvido', title: 'Resolvidos', hint: 'Fechados por você — já marcados como lidos no Gmail.' },
  { key: 'lidos', title: 'Marcados como lido', hint: 'Lidos no Gmail que o copiloto já leu ou em que você agiu.' },
];

function histKey(i: Item): '' | 'resolvido' | 'lidos' {
  if (i.status === 'resolvido') return 'resolvido';
  if (!i.is_unread && (i as Item & { no_copiloto?: boolean }).no_copiloto && !i.pendente) return 'lidos';
  return '';
}

export function HomeScreen({ onOpen, onSettings, reloadKey, selected }: {
  onOpen: (id: string) => void; onSettings: () => void; reloadKey: number; selected: string | null;
}) {
  const t = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<CopilotList | null>(null);
  const [mode, setMode] = useState<Mode>('quadro');
  const [tab, setTab] = useState<ItemTab>('precisa_de_voce');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.list(modeRef.current !== 'quadro');
      setData(d);
      setError('');
      watchJob(d.job);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const watchJob = (j: Job) => {
    setJob(j);
    if (poll.current) clearTimeout(poll.current);
    if (!j.running) return;
    poll.current = setTimeout(async () => {
      try {
        const s = await api.status();
        if (s.running && s.done === j.done) watchJob(s);
        else if (s.running) load();
        else {
          setJob(null);
          load();
        }
      } catch {
        setJob(null);
      }
    }, 2500);
  };

  useEffect(() => {
    load();
  }, [load, reloadKey, mode]);
  useEffect(() => () => {
    if (poll.current) clearTimeout(poll.current);
  }, []);

  const run = async () => {
    if (data && !data.llm) {
      toast('Falta chave de IA no .env do servidor: sigo só com a leitura por regra.');
      return;
    }
    try {
      // ⟳ baixa o Gmail primeiro (antes só relia o banco do servidor)
      const s = await api.syncNow();
      if (s.status !== 'online') {
        toast(s.status === 'auth_error' ? 'O acesso ao Gmail expirou: entre no Gmail de novo no computador.' : 'Sem conexão: não consegui baixar e-mails novos.');
        load();
        return;
      }
      const n = s.result?.fetched || 0;
      const synced = n ? `Gmail sincronizado: ${n} nova(s)/atualizada(s).` : 'Gmail sincronizado: nada novo.';
      const j = await api.run(12);
      if (!j.running) toast(`${synced} A IA já leu tudo.`);
      else watchJob(j);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falha ao iniciar.');
    }
  };

  const filaN = data?.fila?.count ?? 0;
  useEffect(() => {
    if (mode !== 'quadro') return;
    if (tab === 'analisando' && data && !filaN) setTab('precisa_de_voce');
    else if (tab !== 'analisando' && data && !data.tabs.some((tb) => tb.key === tab)) setTab('precisa_de_voce');
  }, [tab, data, filaN, mode]);

  const histCounts = Object.fromEntries((data?.historico || []).map((h) => [h.key, h.count]));
  const boardCount = (data?.tabs || []).reduce((a, tb) => a + tb.count, 0) + filaN;

  const items = (() => {
    const all = data?.items || [];
    if (mode === 'quadro') return all.filter((i) => i.tab === tab);
    return all.filter((i) => histKey(i) === mode).sort((a, b) => (b.internal_date || 0) - (a.internal_date || 0));
  })();

  const reading = (it: Item) => !!job?.running && job.current_id === it.thread_id;
  const today = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  // Gmail conta os não lidos da aba Principal; o quadro, só os que ainda pedem algo.
  const sync = data?.sync;
  const countLine = sync
    ? `${sync.gmail_primary_unread != null ? ` · Gmail Principal: ${sync.gmail_primary_unread} não lidos` : ''}${data && !data.show_all ? ` · no quadro: ${data.items.length}` : ''}${sync.last_sync_label ? ` · sync ${sync.last_sync_label}` : ''}`
    : '';
  const modeMeta = MODES.find((m) => m.key === mode)!;

  const header = (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <View style={{ flex: 1 }}>
          <T muted style={{ fontSize: 13 }}>{today}{countLine}</T>
          <T title style={{ fontSize: 24, fontWeight: '600' }}>{data?.saudacao || 'Olá'}</T>
        </View>
        <IconBtn label="⟳" a11y="Pedir para a IA ler os e-mails novos" onPress={run} />
        <IconBtn label="⚙" a11y="Ajustes" onPress={onSettings} />
      </View>
      {sync && sync.status !== 'online' ? (
        <View style={{ marginTop: 10, padding: 10, borderRadius: 12, backgroundColor: sync.status === 'auth_error' ? '#fde3e3' : '#fff4d6' }}>
          <T style={{ fontSize: 13, color: sync.status === 'auth_error' ? '#6d1a1a' : '#5c4400' }}>
            {sync.status === 'auth_error'
              ? 'O acesso ao Gmail expirou — entre no Gmail de novo para ler e enviar. O que você já confirmou fica na fila.'
              : 'Sem conexão — não estou conseguindo ler/baixar e-mails novos. Você pode responder os que já estão aqui; envio fica na fila e sai quando a conexão voltar.'}
            {sync.last_sync_label ? ` Último e-mail baixado em ${sync.last_sync_label}.` : ''}
          </T>
        </View>
      ) : null}
      {sync?.outbox && (sync.outbox.pending || sync.outbox.failed) ? (
        <T muted style={{ fontSize: 12.5, marginTop: 8 }}>
          Na fila de envio: {sync.outbox.pending}{sync.outbox.failed ? ` · ${sync.outbox.failed} não saiu (veja no computador)` : ''}
        </T>
      ) : null}
      {job?.running ? (
        <View style={{ marginTop: 10, padding: 10, borderRadius: 12, backgroundColor: t.sky }}>
          <T style={{ fontSize: 13, color: t.accentInk }} numberOfLines={1}>
            Lendo {job.done + 1} de {job.total}{job.current ? ` · ${job.current}` : ''}
          </T>
        </View>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 14, paddingBottom: 8 }}>
        {MODES.map((m) => {
          const on = m.key === mode;
          const n = m.key === 'quadro' ? boardCount : (histCounts[m.key] ?? 0);
          return (
            <Pressable
              key={m.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => setMode(m.key)}
              style={{
                borderWidth: 1, borderColor: on ? t.ink : t.line, backgroundColor: on ? t.ink : t.card,
                borderRadius: 999, paddingVertical: 7, paddingHorizontal: 14,
              }}
            >
              <T style={{ fontSize: 13.5, color: on ? t.card : t.ink }}>
                {m.title} <T style={{ fontSize: 13.5, fontWeight: '600', color: on ? t.card : t.muted }}>{n}</T>
              </T>
            </Pressable>
          );
        })}
      </ScrollView>
      <T muted style={{ fontSize: 12, marginBottom: 8 }}>{modeMeta.hint}</T>

      {mode === 'quadro' ? (
        <>
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 14 }}>
            <Card bg={t.peach} title="Hoje" n={data?.cards.hoje ?? 0} hint="pedem você hoje" onPress={() => setTab('precisa_de_voce')} />
            <Card bg={t.lilac} title={TAB_TITLE.bola_com_outros} n={data?.cards.esperando_outros ?? 0} hint="esperando retorno" onPress={() => setTab('bola_com_outros')} />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 10 }}>
            {filaN ? (
              <Pressable
                accessibilityRole="tab"
                accessibilityLabel={`Analisando: ${filaN} e-mails que a IA ainda não leu`}
                accessibilityState={{ selected: tab === 'analisando' }}
                onPress={() => setTab('analisando')}
                style={{
                  borderWidth: 1.5, borderStyle: 'dashed', borderColor: tab === 'analisando' ? t.accent : t.muted,
                  backgroundColor: tab === 'analisando' ? t.sky : 'transparent',
                  borderRadius: 999, paddingVertical: 6, paddingHorizontal: 13,
                }}
              >
                <T style={{ fontSize: 13.5, color: tab === 'analisando' ? t.accentInk : t.muted }}>
                  Analisando <T style={{ fontSize: 13.5, fontWeight: '600', color: tab === 'analisando' ? t.accentInk : t.muted }}>{filaN}</T>
                </T>
              </Pressable>
            ) : null}
            {(data?.tabs || []).map((tb) => {
              const on = tb.key === tab;
              return (
                <Pressable
                  key={tb.key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  onPress={() => setTab(tb.key)}
                  style={{
                    borderWidth: 1, borderColor: on ? t.ink : t.line, backgroundColor: on ? t.ink : t.card,
                    borderRadius: 999, paddingVertical: 7, paddingHorizontal: 14,
                  }}
                >
                  <T style={{ fontSize: 13.5, color: on ? t.card : t.ink }}>
                    {tb.title} <T style={{ fontSize: 13.5, fontWeight: '600', color: on ? t.card : t.muted }}>{tb.count}</T>
                  </T>
                </Pressable>
              );
            })}
          </ScrollView>
          {tab === 'analisando' ? (
            <T muted style={{ fontSize: 12.5, marginBottom: 8 }}>
              A IA ainda não leu estes e-mails: cada um entra na aba certa quando a leitura terminar.
            </T>
          ) : null}
        </>
      ) : null}

      {error ? (
        <View style={{ backgroundColor: t.rose, borderRadius: 12, padding: 12, marginBottom: 10, gap: 8 }}>
          <T style={{ fontSize: 13.5 }}>{error}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn label="Tentar de novo" onPress={load} />
            <Btn label="Ajustes" onPress={onSettings} />
          </View>
        </View>
      ) : null}
    </View>
  );

  const emptyMsg = mode === 'quadro'
    ? (data?.show_all ? 'Nada por aqui.' : 'Nenhum não lido aqui.')
    : 'Nada por aqui.';

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ paddingTop: Math.max(14, insets.top), paddingHorizontal: 16, paddingBottom: insets.bottom + 40, gap: 10 }}
      data={items}
      keyExtractor={(i) => i.thread_id}
      ListHeaderComponent={header}
      ListEmptyComponent={
        data ? <T muted style={{ textAlign: 'center', paddingVertical: 30, fontSize: 14 }}>{emptyMsg} 🌿</T> : null
      }
      renderItem={({ item }) => (
        <ItemCard it={item} reading={reading(item)} llm={!!data?.llm} selected={item.thread_id === selected} onPress={() => onOpen(item.thread_id)} />
      )}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={t.accent} />}
    />
  );
}

function IconBtn({ label, a11y, onPress }: { label: string; a11y: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={a11y} hitSlop={6} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
      <T style={{ fontSize: 20 }}>{label}</T>
    </Pressable>
  );
}

function Card({ bg, title, n, hint, onPress }: { bg: string; title: string; n: number; hint: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={[{ flex: 1, backgroundColor: bg, borderRadius: t.radius, padding: 14, gap: 2 }, shadow]}>
      <T style={{ fontWeight: '600', fontSize: 14 }}>{title}</T>
      <T title style={{ fontSize: 30, fontWeight: '700' }}>{n}</T>
      <T muted style={{ fontSize: 12 }}>{hint}</T>
    </Pressable>
  );
}

function aiLabel(it: Item, reading: boolean, llm: boolean): string {
  if (reading) return it.pendente ? 'lendo agora' : 'lendo de novo';
  if (it.pendente) return it.falhou ? 'falhou — toque para tentar de novo' : 'na fila';
  if (!it.analisado && !it.lido_por_regra) return llm ? 'na fila da IA' : 'sem IA: leitura por regra';
  if (it.desatualizado && llm) return 'mensagem nova';
  return '';
}

function ItemCard({ it, reading, llm, selected, onPress }: {
  it: Item; reading: boolean; llm: boolean; selected: boolean; onPress: () => void;
}) {
  const t = useTheme();
  const ai = aiLabel(it, reading, llm);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        {
          backgroundColor: t.card, borderRadius: t.radius, paddingVertical: 12, paddingRight: 12, paddingLeft: 16,
          flexDirection: 'row', gap: 10, alignItems: 'flex-start', overflow: 'hidden', opacity: pressed ? 0.9 : 1,
          borderWidth: selected ? 2 : t.dashed ? 1 : 0, borderColor: selected ? t.accent : t.line,
          borderStyle: t.dashed && !selected ? 'dashed' : 'solid',
        },
        t.dashed ? null : shadow,
      ]}
    >
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, backgroundColor: urgColor(t, it.urgencia) }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={2} style={{ fontSize: 14.5, fontWeight: '600', lineHeight: 19 }}>{it.subject}</T>
        <T muted numberOfLines={2} style={{ fontSize: 13, marginTop: 3 }}>{it.o_que_aconteceu || it.from_name}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Chip label={PAPEL[it.papel] || it.papel} bg={papelColor(t, it.papel)} />
          {URG[it.urgencia] ? <Chip label={URG[it.urgencia]} bg={urgColor(t, it.urgencia)} /> : null}
          {it.prazo ? <Chip soft label={`prazo ${ddmm(it.prazo)}`} /> : null}
          {STATUS[it.status] ? <Chip soft label={STATUS[it.status]!} /> : null}
          {it.sem_resposta_desde && it.tab !== 'resolvido' ? <Chip soft label={`sem resposta ${ago(it.sem_resposta_desde)}`} /> : null}
          {ai ? <Chip soft={!reading && !it.falhou} bg={reading ? t.sky : it.falhou ? t.rose : undefined} label={ai} /> : null}
        </View>
      </View>
      {it.bola && it.bola.com !== 'ninguem' ? <Avatar email={it.bola.email} name={it.bola.nome} /> : null}
    </Pressable>
  );
}
