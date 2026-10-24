// Corpo da "Conversa completa" com paridade da web: imagens inline no lugar
// do "[image: x]" (o backend já casa cada placeholder com o anexo, campo
// `inline` de /gmail-attachments), lista de anexos (abre a folha do sistema
// para ver/salvar) e "Resumir este e-mail" (direto/abrangente) por mensagem.
import { ReactNode, useEffect, useState } from 'react';
import { Image, type ImageURISource, Modal, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { data as source } from '../data';
import { useTheme } from '../theme';
import type { GmailAttachments, GmailFile, ModoResumoMsg, ResumoLista, ResumoMensagem } from '../types';
import { Btn, T, useToast } from './ui';

// mesmo padrão do static/inlineimg.js e do backend
const PH_RE = /\[(?:image|imagem|img)\s*:\s*([^\]\n]{0,200}?)\s*\]|\[cid:([^\]\s]{1,200})\]/gi;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** Anexos de uma mensagem (pelo índice na conversa) quando a contagem bate com a do Gmail. */
export function filesFor(att: GmailAttachments | null, idx: number, total: number): { mid: string; files: GmailFile[] } {
  if (!att || att.message_ids.length !== total) return { mid: '', files: [] };
  const mid = att.message_ids[idx] || '';
  return { mid, files: att.files.filter((f) => f.message_id === mid) };
}

export function MessageBody({ tid, text, mid, att, onImage }: {
  tid: string; text: string; mid: string; att: GmailAttachments | null; onImage: (f: GmailFile) => void;
}) {
  const placeholders = (mid && att?.inline[mid]) || [];
  const byId = Object.fromEntries((att?.files || []).map((f) => [f.attachment_id, f]));
  if (!mid || !placeholders.length) return <T selectable style={{ fontSize: 13.5, lineHeight: 20, marginTop: 6 }}>{text}</T>;

  const parts: ({ kind: 'text'; v: string } | { kind: 'img'; f: GmailFile } | { kind: 'miss'; v: string })[] = [];
  let cursor = 0;
  let last = 0;
  const re = new RegExp(PH_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ kind: 'text', v: text.slice(last, m.index) });
    let hit = null;
    for (let k = cursor; k < placeholders.length; k++) {
      if (norm(placeholders[k].token) === norm(m[0])) { hit = placeholders[k]; cursor = k + 1; break; }
    }
    const f = hit?.attachment_id ? byId[hit.attachment_id] : undefined;
    parts.push(f ? { kind: 'img', f } : { kind: 'miss', v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', v: text.slice(last) });

  return (
    <View style={{ marginTop: 6 }}>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <T key={i} selectable style={{ fontSize: 13.5, lineHeight: 20 }}>{p.v}</T>
        ) : p.kind === 'img' ? (
          <InlineImage key={i} tid={tid} f={p.f} onPress={() => onImage(p.f)} />
        ) : (
          <T key={i} muted style={{ fontSize: 12.5 }}>{p.v}</T>
        ),
      )}
    </View>
  );
}

/** Fonte da imagem do anexo: URL do servidor (com token) ou data: URI baixada do Gmail no modo local. */
function useAttachmentImage(tid: string, f: GmailFile | null): { src: ImageURISource | null; failed: boolean; fail: () => void } {
  const [state, setState] = useState<{ key: string; src: ImageURISource | null; failed: boolean }>({ key: '', src: null, failed: false });
  const key = f ? `${tid}:${f.message_id}:${f.attachment_id}` : '';
  useEffect(() => {
    if (!f) return;
    let alive = true;
    source.imageSource(tid, f).then(
      (src) => alive && setState({ key, src, failed: false }),
      () => alive && setState({ key, src: null, failed: true }),
    );
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = state.key === key ? state : { src: null, failed: false };
  return { src: cur.src, failed: cur.failed, fail: () => setState({ key, src: null, failed: true }) };
}

function InlineImage({ tid, f, onPress }: { tid: string; f: GmailFile; onPress: () => void }) {
  const t = useTheme();
  const { src, failed, fail } = useAttachmentImage(tid, f);
  if (failed) {
    return (
      <Pressable onPress={onPress} style={{ alignSelf: 'flex-start', marginVertical: 4, borderWidth: 1, borderColor: t.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
        <T style={{ fontSize: 12.5 }}>🖼 {f.filename || 'imagem'}</T>
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} accessibilityRole="imagebutton" accessibilityLabel={`${f.filename || 'imagem'} — toque para ampliar`} style={{ marginVertical: 6 }}>
      <Image
        source={src || undefined}
        onError={fail}
        resizeMode="contain"
        style={{ width: '100%', height: 220, borderRadius: 10, backgroundColor: t.fog }}
      />
    </Pressable>
  );
}

/** Pills dos anexos: imagem abre no visualizador; o resto baixa e abre a folha do sistema. */
export function AttachmentPills({ tid, files, onImage }: { tid: string; files: GmailFile[]; onImage: (f: GmailFile) => void }) {
  const t = useTheme();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  if (!files.length) return null;
  const open = async (f: GmailFile) => {
    if (f.is_image) return onImage(f);
    setBusy(f.attachment_id);
    try {
      await source.openAttachment(tid, f);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não abriu o anexo.');
    } finally {
      setBusy('');
    }
  };
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {files.map((f) => (
        <Pressable
          key={`${f.message_id}:${f.attachment_id}`}
          onPress={() => open(f)}
          disabled={!!busy}
          accessibilityRole="button"
          accessibilityLabel={`Abrir anexo ${f.filename}`}
          style={{ borderWidth: 1, borderColor: t.line, backgroundColor: t.card, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, opacity: busy && busy !== f.attachment_id ? 0.5 : 1 }}
        >
          <T style={{ fontSize: 12.5 }}>
            {busy === f.attachment_id ? '⏳' : f.is_image ? '🖼' : '📎'} {f.filename || 'anexo'}
            <T muted style={{ fontSize: 11.5 }}> {fmtSize(f.size)}{f.in_body ? ' · no corpo' : ''}</T>
          </T>
        </Pressable>
      ))}
    </View>
  );
}

/** Imagem em tela cheia, com Abrir/Salvar (folha do sistema). */
export function ImageViewer({ tid, file, onClose }: { tid: string; file: GmailFile | null; onClose: () => void }) {
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const { src } = useAttachmentImage(tid, file);
  return (
    <Modal visible={!!file} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, backgroundColor: 'rgba(20,20,28,0.94)', paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8 }}>
          <T style={{ flex: 1, color: '#fff', fontSize: 14 }} numberOfLines={1}>{file?.filename || 'imagem'}</T>
          <Btn
            label="Salvar / compartilhar"
            busy={busy}
            onPress={async () => {
              if (!file) return;
              setBusy(true);
              try { await source.openAttachment(tid, file); } catch (e) { toast(e instanceof Error ? e.message : 'Não abriu.'); } finally { setBusy(false); }
            }}
          />
          <Btn label="Fechar" onPress={onClose} />
        </View>
        {file && src ? (
          <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Fechar imagem">
            <Image source={src} resizeMode="contain" style={{ width, height: height - insets.top - insets.bottom - 80 }} />
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

// ── resumos ──
const MSG_SECOES: [string, string][] = [
  ['pontos_principais', 'Pontos principais'],
  ['numeros_dados', 'Números e dados'],
  ['pedidos_por_pessoa', 'Pedidos por pessoa'],
  ['prazos', 'Prazos'],
  ['riscos', 'Riscos e pendências'],
];
export const THREAD_SECOES: [string, string][] = [
  ['pontos_principais', 'Pontos principais'],
  ['numeros_dados', 'Números e dados'],
  ['pedidos_ao_leo', 'Pedidos a você'],
  ['pedidos_a_outros', 'Pedidos a outras pessoas'],
  ['prazos', 'Prazos'],
  ['decisoes_riscos', 'Decisões, pendências e riscos'],
  ['anexos_mencionados', 'Anexos'],
  ['proximos_passos', 'Próximos passos'],
];

function itemText(v: ResumoLista[number]): string {
  if (typeof v === 'string') return v;
  if (v.pedido !== undefined) return `${v.nome || 'Alguém'}: ${v.pedido}`;
  if (v.o_que !== undefined) return `${v.data || 'Sem data'}: ${v.o_que}`;
  return JSON.stringify(v);
}

export function ResumoView({ resumo, secoes }: { resumo: Record<string, unknown> | null; secoes: [string, string][] }) {
  const t = useTheme();
  if (!resumo) return null;
  const out: ReactNode[] = [];
  if (typeof resumo.principal === 'string' && resumo.principal) {
    out.push(<T key="p" style={{ fontSize: 14, fontWeight: '600' }}>Principal: <T style={{ fontSize: 14, fontWeight: '400' }}>{resumo.principal}</T></T>);
  }
  if (Array.isArray(resumo.bullets)) {
    (resumo.bullets as ResumoLista).forEach((b, i) => out.push(<T key={`b${i}`} style={{ fontSize: 13.5, marginTop: 3 }}>• {itemText(b)}</T>));
  }
  if (typeof resumo.contexto === 'string' && resumo.contexto) {
    out.push(<Section key="c" title="Contexto"><T style={{ fontSize: 13.5, lineHeight: 20 }}>{resumo.contexto}</T></Section>);
  }
  secoes.forEach(([k, title]) => {
    const list = resumo[k];
    if (Array.isArray(list) && list.length) {
      out.push(
        <Section key={k} title={title}>
          {(list as ResumoLista).map((v, i) => <T key={i} style={{ fontSize: 13.5, marginTop: 2 }}>• {itemText(v)}</T>)}
        </Section>,
      );
    }
  });
  return out.length ? <View>{out}</View> : <T muted style={{ fontSize: 13, color: t.muted }}>A IA não encontrou nada para destacar.</T>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ marginTop: 10 }}>
      <T muted style={{ fontSize: 11.5, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 2 }}>{title}</T>
      {children}
    </View>
  );
}

/** "Resumir este e-mail" de uma mensagem da conversa (cache no aparelho ou no servidor, conforme a fonte; Regerar refaz). */
export function MessageSummary({ tid, idx }: { tid: string; idx: number }) {
  const t = useTheme();
  const [modo, setModo] = useState<ModoResumoMsg | null>(null);
  const [data, setData] = useState<ResumoMensagem | null>(null);
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (m: ModoResumoMsg, regerar = false) => {
    setModo(m);
    setBusy(true);
    setErro('');
    try {
      setData(await source.resumoMensagem(tid, idx, m, regerar));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não deu para resumir agora.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {(['direto', 'abrangente'] as ModoResumoMsg[]).map((m) => (
          <Pressable
            key={m}
            onPress={() => run(m)}
            accessibilityRole="button"
            accessibilityState={{ selected: modo === m }}
            style={{ borderWidth: 1, borderColor: modo === m ? t.accent : t.line, backgroundColor: modo === m ? t.lilac : 'transparent', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}
          >
            <T style={{ fontSize: 12.5 }}>📄 Resumo {m === 'direto' ? 'direto' : 'abrangente'}</T>
          </Pressable>
        ))}
        {modo && !busy ? (
          <Pressable onPress={() => run(modo, true)} accessibilityRole="button" style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
            <T style={{ fontSize: 12.5, color: t.accentInk }}>↻ Regerar</T>
          </Pressable>
        ) : null}
      </View>
      {modo ? (
        <View style={{ marginTop: 6, padding: 10, borderRadius: 10, backgroundColor: t.fog }}>
          {busy ? <T muted style={{ fontSize: 13 }}>Resumindo…</T> : erro ? <T style={{ fontSize: 13 }}>{erro}</T> : <ResumoView resumo={data?.resumo || null} secoes={MSG_SECOES} />}
        </View>
      ) : null}
    </View>
  );
}

