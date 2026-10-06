// Peças visuais compartilhadas: chip, avatar, botão, bloco, folha (bottom sheet) e toast.
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  Text,
  TextProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { absolute, api } from '../api';
import { PASTEL, shadow, Theme, useTheme } from '../theme';
import type { Papel, Urgencia } from '../types';

// ── texto com a fonte da skin ──
export function T({ style, title, muted, children, ...rest }: TextProps & {
  style?: StyleProp<TextStyle>; title?: boolean; muted?: boolean; children?: ReactNode;
}) {
  const t = useTheme();
  return (
    <Text {...rest} style={[{ color: muted ? t.muted : t.ink, fontFamily: title ? t.fontTitle : t.font, fontSize: 15 }, style]}>
      {children}
    </Text>
  );
}

// ── chip ──
export function papelColor(t: Theme, papel: Papel): string {
  return { demanda: t.peach, mencionado_opiniao: t.lilac, so_copia: t.sky, fyi: t.sky, pode_ignorar: t.fog }[papel];
}
export function urgColor(t: Theme, u: Urgencia): string {
  return { alta: t.rose, media: t.butter, baixa: t.mint, neutra: t.fog }[u];
}

export function Chip({ label, bg, soft }: { label: string; bg?: string; soft?: boolean }) {
  const t = useTheme();
  return (
    <View
      style={{
        borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2,
        backgroundColor: soft ? 'transparent' : bg || t.fog,
        borderWidth: soft ? 1 : 0, borderColor: t.line,
      }}
    >
      <T style={{ fontSize: 11.5, color: soft ? t.muted : t.ink }}>{label}</T>
    </View>
  );
}

// ── avatar: foto quando o servidor tem, senão iniciais em pastel ──
const photoCache: Record<string, Promise<string | null>> = {};

function initials(name: string, email: string) {
  const base = (name || email || '?').replace(/["<].*$/, '').trim();
  const parts = base.split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

export function Avatar({ email, name, size = 34, a11y }: { email: string; name: string; size?: number; a11y?: string }) {
  const t = useTheme();
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    if (!email) return;
    photoCache[email] ??= api.avatar(email).then((r) => (r.photo_url ? absolute(r.photo_url) : null)).catch(() => null);
    let alive = true;
    photoCache[email].then((url) => alive && setPhoto(url));
    return () => {
      alive = false;
    };
  }, [email]);
  // sem nome nem e-mail: "–" em cinza (nunca "?")
  const known = !!(name || email);
  const label = name || email || 'ninguém identificado';
  const color = known ? PASTEL[[...(email || label)].reduce((a, c) => a + c.charCodeAt(0), 0) % PASTEL.length] : t.fog;
  return (
    <View
      accessibilityLabel={a11y || `Com ${label}`}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
    >
      {photo ? (
        <Image source={{ uri: photo }} style={{ width: size, height: size }} />
      ) : (
        <T style={{ fontSize: size * 0.37, fontWeight: '600', color: known ? t.ink : t.muted }}>{known ? initials(name, email) : '–'}</T>
      )}
    </View>
  );
}

// ── botão ──
export function Btn({ label, onPress, primary, disabled, busy, style }: {
  label: string; onPress?: () => void; primary?: boolean; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        {
          borderWidth: 1, borderColor: primary ? t.ink : t.line, backgroundColor: primary ? t.ink : pressed ? t.fog : t.card,
          borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center',
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={primary ? t.card : t.ink} />
      ) : (
        <T style={{ fontSize: 14, color: primary ? t.card : t.ink, textAlign: 'center' }}>{label}</T>
      )}
    </Pressable>
  );
}

/** Botão só ícone (title/accessibilityLabel = texto no hover/a11y). */
export function IconBtn({
  icon, label, onPress, primary, disabled, busy, style, iconColor,
}: {
  icon: string; label: string; onPress?: () => void; primary?: boolean; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>;
  /** cor própria do ícone (ex.: "M" vermelho do Gmail) */
  iconColor?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 48, height: 48, borderWidth: 1, borderColor: primary ? t.ink : t.line,
          backgroundColor: primary ? t.ink : pressed ? t.fog : t.card, borderRadius: 14,
          alignItems: 'center', justifyContent: 'center',
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={primary ? t.card : t.ink} />
      ) : (
        <T style={{ fontSize: 20, color: iconColor || (primary ? t.card : t.ink), lineHeight: 24, fontWeight: iconColor ? '700' : undefined }}>{icon}</T>
      )}
    </Pressable>
  );
}

// ── bloco branco (as 3 camadas do detalhe) ──
export function Block({ label, n, children, style }: { label?: string; n?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View
      style={[
        { backgroundColor: t.card, borderRadius: t.radius, padding: 14, marginBottom: 12 },
        t.dashed ? { borderWidth: 1, borderStyle: 'dashed', borderColor: t.line } : shadow,
        style,
      ]}
    >
      {label ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          {n ? (
            <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: t.fog, alignItems: 'center', justifyContent: 'center' }}>
              <T style={{ fontSize: 11 }}>{n}</T>
            </View>
          ) : null}
          <T muted style={{ fontSize: 11.5, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</T>
        </View>
      ) : null}
      {children}
    </View>
  );
}

// ── folha de baixo (Delegar, rascunho preparado) ──
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(45,43,58,0.28)' }} onPress={onClose} accessibilityLabel="Fechar" />
        <View
          style={{
            backgroundColor: t.card, borderTopLeftRadius: 22, borderTopRightRadius: 22,
            paddingHorizontal: 18, paddingTop: 18, paddingBottom: Math.max(20, insets.bottom), maxHeight: '88%',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <T title style={{ flex: 1, fontSize: 18, fontWeight: '600' }}>{title}</T>
            <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Fechar">
              <T style={{ fontSize: 22 }}>×</T>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── toast ──
const ToastContext = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(''), 4200);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {msg ? (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={{
            position: 'absolute', left: 20, right: 20, bottom: insets.bottom + 86, alignItems: 'center',
          }}
        >
          <View style={{ backgroundColor: t.ink, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 }}>
            <T style={{ color: t.card, fontSize: 13.5 }}>{msg}</T>
          </View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}
