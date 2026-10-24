// Ajustes → "Fonte de dados": de onde o quadro, a lista e o detalhe leem.
// Local (padrão) = Gmail + banco + IA no aparelho; Servidor = o IA.Email do Mac.
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { DataSource, getDataSource, onDataSourceChange, setDataSource } from '../data/source';
import { useTheme } from '../theme';
import { Block, T, useToast } from './ui';

const OPTIONS: { id: DataSource; title: string; hint: string }[] = [
  { id: 'local', title: 'Neste aparelho', hint: 'Lê o Gmail direto (conta Google acima) e classifica com as suas chaves de IA.' },
  { id: 'servidor', title: 'Servidor do Mac', hint: 'Usa o IA.Email do Mac (endereço e token acima). Fallback enquanto o modo local amadurece.' },
];

export function DataSourceBlock({ onChanged }: { onChanged?: () => void }) {
  const t = useTheme();
  const toast = useToast();
  const [cur, setCur] = useState<DataSource>(getDataSource());
  useEffect(() => onDataSourceChange(setCur), []);

  const choose = async (s: DataSource) => {
    if (s === cur) return;
    await setDataSource(s);
    toast(s === 'local' ? 'Lendo deste aparelho.' : 'Lendo do servidor do Mac.');
    onChanged?.();
  };

  return (
    <Block label="Fonte de dados">
      <View style={{ gap: 8 }}>
        {OPTIONS.map((o) => {
          const on = o.id === cur;
          return (
            <Pressable
              key={o.id}
              onPress={() => choose(o.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={{ borderWidth: 1, borderColor: on ? t.accent : t.line, backgroundColor: on ? t.lilac : t.bg, borderRadius: 12, padding: 10 }}
            >
              <T style={{ fontSize: 14, fontWeight: '600' }}>{on ? '● ' : '○ '}{o.title}</T>
              <T muted style={{ fontSize: 12.5, marginTop: 2 }}>{o.hint}</T>
            </Pressable>
          );
        })}
      </View>
      <T muted style={{ fontSize: 12, marginTop: 8 }}>
        Ações, rascunho, envio, resumos e histórico ainda usam o servidor nas duas opções.
      </T>
    </Block>
  );
}
