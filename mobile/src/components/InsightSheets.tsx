// Folhas sob demanda do detalhe, iguais às da web (/copilot):
// "Verificar na caixa" (confere na sua caixa, só leitura, o que o e-mail afirma)
// e "Resumo detalhado" da thread. Ambas abrem o cache primeiro (GET, sem IA)
// e só geram (POST) quando não há cache ou ele ficou desatualizado.
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';

import { data as source } from '../data';
import { useTheme } from '../theme';
import type { ResumoDetalhado, VerifyClaim, VerifyResult } from '../types';
import { ResumoView, THREAD_SECOES } from './MessageParts';
import { Btn, Sheet, T } from './ui';

const SELO: Record<string, string> = { confirmado: 'Confirmado', nao_encontrado: 'Não encontrado', inconclusivo: 'Inconclusivo' };

const when = (iso: string) => {
  const d = new Date(iso);
  return !iso || isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export function VerifySheet({ tid, subject, visible, onClose }: { tid: string; subject: string; visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const [data, setData] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState('');
  const [erro, setErro] = useState('');
  const seq = useRef(0);

  const run = async (regerar: boolean) => {
    const my = ++seq.current;
    setErro('');
    try {
      if (!regerar) {
        setBusy('abrindo');
        const c = await source.verifyCached(tid);
        if (my !== seq.current) return;
        if (Array.isArray(c.afirmacoes) && !c.desatualizado) {
          setData(c);
          return;
        }
      }
      setBusy('gerando');
      const r = await source.verify(tid, regerar);
      if (my === seq.current) setData(r);
    } catch (e) {
      if (my === seq.current) setErro(e instanceof Error ? e.message : 'Não deu para verificar agora.');
    } finally {
      if (my === seq.current) setBusy('');
    }
  };

  useEffect(() => {
    const ref = seq;
    // fora do corpo do efeito (próximo tick): abre o cache e, se faltar, gera
    const h = visible ? setTimeout(() => { setData(null); run(false); }, 0) : undefined;
    return () => { clearTimeout(h); ref.current++; };
  }, [visible, tid]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = data?.afirmacoes || [];
  const count = (k: string) => list.filter((a) => a.veredito === k).length;

  return (
    <Sheet visible={visible} onClose={onClose} title="🔎 Verificar na caixa">
      <T muted style={{ fontSize: 13, marginBottom: 10 }}>{subject}</T>
      {busy ? (
        <T muted style={{ fontSize: 13.5 }}>
          {busy === 'abrindo' ? 'Abrindo…' : 'Lendo o e-mail, buscando na sua caixa (só leitura) e conferindo… pode levar até 1 minuto.'}
        </T>
      ) : erro ? (
        <T style={{ fontSize: 13.5 }}>{erro}</T>
      ) : data ? (
        <View>
          {list.length ? (
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {Object.keys(SELO).filter(count).map((k) => (
                <View key={k} style={{ borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2, backgroundColor: k === 'confirmado' ? t.mint : k === 'nao_encontrado' ? t.rose : t.butter }}>
                  <T style={{ fontSize: 12 }}>{count(k)} {SELO[k].toLowerCase()}</T>
                </View>
              ))}
            </View>
          ) : (
            <T muted style={{ fontSize: 13.5 }}>{data.aviso || 'Nada para conferir neste e-mail.'}</T>
          )}
          {list.map((a, i) => <Claim key={i} a={a} />)}
          {data.gerado_em ? <T muted style={{ fontSize: 12, marginTop: 8 }}>Gerado em {when(data.gerado_em)}{data.cached ? ' · do cache' : ''}</T> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
        <Btn label="Verificar de novo" busy={busy === 'gerando'} disabled={!!busy} onPress={() => run(true)} style={{ flex: 1 }} />
        <Btn label="Fechar" onPress={onClose} />
      </View>
    </Sheet>
  );
}

function Claim({ a }: { a: VerifyClaim }) {
  const t = useTheme();
  const v = SELO[a.veredito] ? a.veredito : 'inconclusivo';
  const bg = v === 'confirmado' ? t.mint : v === 'nao_encontrado' ? t.rose : t.butter;
  return (
    <View style={{ borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 10, marginTop: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
        <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: bg }}>
          <T style={{ fontSize: 11.5, fontWeight: '600' }}>{SELO[v]}</T>
        </View>
        <T style={{ flex: 1, fontSize: 14, fontWeight: '600' }}>{a.texto}</T>
      </View>
      {a.explicacao ? <T style={{ fontSize: 13, marginTop: 6 }}>{a.explicacao}</T> : null}
      {(a.evidencias || []).map((ev, i) => (
        <View key={i} style={{ marginTop: 6, padding: 8, borderRadius: 10, backgroundColor: t.fog }}>
          <T style={{ fontSize: 12.5, fontWeight: '600' }}>{ev.assunto || '(sem assunto)'}{ev.pasta ? ` · ${ev.pasta}` : ''}</T>
          <T muted style={{ fontSize: 12 }}>{ev.de}{ev.data ? ` · ${when(ev.data) || ev.data}` : ''}{ev.mesma_thread ? ' · nesta conversa' : ''}</T>
          {ev.snippet ? <T style={{ fontSize: 12.5, marginTop: 3 }}>“{ev.snippet}”</T> : null}
          {ev.gmail_url ? (
            <Pressable onPress={() => Linking.openURL(ev.gmail_url)} accessibilityRole="link" style={{ marginTop: 4 }}>
              <T style={{ fontSize: 12.5, color: t.accentInk }}>Abrir no Gmail</T>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function ResumoSheet({ tid, subject, visible, onClose }: { tid: string; subject: string; visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const [data, setData] = useState<ResumoDetalhado | null>(null);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');
  const seq = useRef(0);

  const run = async (regerar: boolean) => {
    const my = ++seq.current;
    setBusy(true);
    setErro('');
    try {
      const r = await source.resumoDetalhado(tid, regerar);
      if (my === seq.current) setData(r);
    } catch (e) {
      if (my === seq.current) setErro(e instanceof Error ? e.message : 'Não deu para resumir agora.');
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  useEffect(() => {
    const ref = seq;
    // fora do corpo do efeito (próximo tick): abre o cache e, se faltar, gera
    const h = visible ? setTimeout(() => { setData(null); run(false); }, 0) : undefined;
    return () => { clearTimeout(h); ref.current++; };
  }, [visible, tid]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Sheet visible={visible} onClose={onClose} title="📑 Resumo detalhado">
      <T muted style={{ fontSize: 13, marginBottom: 10 }}>{subject}</T>
      {busy ? (
        <T muted style={{ fontSize: 13.5 }}>Resumindo a conversa…</T>
      ) : erro ? (
        <T style={{ fontSize: 13.5 }}>{erro}</T>
      ) : data ? (
        <View>
          {data.aviso ? (
            <View style={{ padding: 8, borderRadius: 10, backgroundColor: t.butter, marginBottom: 8 }}>
              <T style={{ fontSize: 13 }}>{data.aviso}</T>
            </View>
          ) : null}
          {data.desatualizado ? <T muted style={{ fontSize: 12.5, marginBottom: 6 }}>Chegou mensagem nova depois deste resumo: toque em Regerar.</T> : null}
          <ResumoView resumo={data.resumo} secoes={THREAD_SECOES} />
          {data.gerado_em ? <T muted style={{ fontSize: 12, marginTop: 8 }}>Gerado em {when(data.gerado_em)}{data.cached ? ' · do cache' : ''}</T> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
        <Btn label="Regerar" busy={busy} onPress={() => run(true)} style={{ flex: 1 }} />
        <Btn label="Fechar" onPress={onClose} />
      </View>
    </Sheet>
  );
}
