// Campo de destinatários com chips (Para/Cc): cada e-mail vira um chip com ×,
// o campo aceita vírgula/Enter para adicionar e as sugestões (participantes
// da thread que ainda não estão no e-mail) entram com um toque.
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { useTheme } from '../theme';
import type { Endereco } from '../types';
import { T } from './ui';

const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;
export const lower = (e?: string) => String(e || '').trim().toLowerCase();

/** "a@x, Nome <b@y>" → e-mails válidos (minúsculos) e o que sobrou digitado. */
export function parseTyped(text: string): { emails: string[]; rest: string } {
  const parts = text.split(/[,;\n]+/);
  const rest = /[,;\n]\s*$/.test(text) ? '' : (parts.pop() || '');
  const emails: string[] = [];
  for (const p of parts) {
    const m = /<([^>]+)>/.exec(p);
    const e = lower(m ? m[1] : p);
    if (EMAIL_RE.test(e) && !emails.includes(e)) emails.push(e);
  }
  return { emails, rest };
}

export function AddrChips({ label, value, onChange, suggestions = [], names = {}, placeholder }: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  suggestions?: Endereco[];
  names?: Record<string, string>;
  placeholder?: string;
}) {
  const t = useTheme();
  const [typed, setTyped] = useState('');
  const add = (emails: string[]) => {
    const next = [...value];
    for (const e of emails) if (!next.map(lower).includes(lower(e))) next.push(lower(e));
    onChange(next);
  };
  const onType = (text: string) => {
    const { emails, rest } = parseTyped(text);
    if (emails.length) add(emails);
    setTyped(rest);
  };
  const commit = () => {
    const e = lower(typed.replace(/^.*<|>.*$/g, ''));
    if (EMAIL_RE.test(e)) {
      add([e]);
      setTyped('');
    }
  };
  const inUse = new Set(value.map(lower));
  const sug = suggestions.filter((a) => a.email && !inUse.has(lower(a.email))).slice(0, 8);
  return (
    <View style={{ marginBottom: 6, borderBottomWidth: 1, borderBottomColor: t.line, paddingBottom: 4 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <T muted style={{ fontSize: 13, width: 34 }}>{label}</T>
        {value.map((e) => (
          <Pressable
            key={e}
            onPress={() => onChange(value.filter((x) => lower(x) !== lower(e)))}
            accessibilityRole="button"
            accessibilityLabel={`Tirar ${names[lower(e)] || e} de ${label}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, backgroundColor: t.lilac, paddingHorizontal: 10, paddingVertical: 4 }}
          >
            <T style={{ fontSize: 13 }}>{names[lower(e)] ? `${names[lower(e)]} · ${e}` : e}</T>
            <T muted style={{ fontSize: 13 }}>×</T>
          </Pressable>
        ))}
        <TextInput
          value={typed}
          onChangeText={onType}
          onSubmitEditing={commit}
          onBlur={commit}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          placeholder={value.length ? '' : placeholder}
          placeholderTextColor={t.muted}
          accessibilityLabel={`${label}: digite um e-mail e toque Enter`}
          style={{ flexGrow: 1, minWidth: 120, color: t.ink, fontSize: 14, fontFamily: t.font, paddingVertical: 6 }}
        />
      </View>
      {sug.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {sug.map((a) => (
            <Pressable
              key={a.email}
              onPress={() => add([a.email])}
              accessibilityRole="button"
              accessibilityLabel={`Adicionar ${a.name || a.email} em ${label}`}
              style={{ borderWidth: 1, borderColor: t.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}
            >
              <T style={{ fontSize: 12.5 }}>+ {a.name || a.email}</T>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
