// Copiloto mobile: navegação simples, sem lib de rotas.
// Tela estreita (celular / iPad em Split View): pilha -- home sempre montada
// por baixo, detalhe por cima. Tela larga (>= 768, iPad): duas colunas, lista
// à esquerda e detalhe à direita. Ajustes e Histórico cobrem a tela nos dois.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { api, loadBaseUrl, loadToken } from './src/api';
import { loadDataSource } from './src/data/source';
import { T, ToastProvider } from './src/components/ui';
import { DetailScreen } from './src/screens/DetailScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SkinName, ThemeContext, themes } from './src/theme';

type Overlay = 'settings' | 'history' | null;

const SKIN_KEY = 'cp_skin';
export const WIDE_MIN = 768;

export default function App() {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_MIN;
  const [ready, setReady] = useState(false);
  const [skin, setSkinState] = useState<SkinName>('clean');
  const [selected, setSelected] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    (async () => {
      await Promise.all([loadBaseUrl(), loadToken(), loadDataSource()]);
      const saved = (await AsyncStorage.getItem(SKIN_KEY).catch(() => null)) as SkinName | null;
      if (saved && saved in themes) setSkinState(saved);
      setReady(true);
      // a skin salva no servidor (por usuário) vale mais que a local
      api.prefs().then((p) => p.skin in themes && setSkinState(p.skin)).catch(() => {});
    })();
  }, []);

  const setSkin = useCallback((s: SkinName) => {
    setSkinState(s);
    AsyncStorage.setItem(SKIN_KEY, s).catch(() => {});
  }, []);

  const closeDetail = useCallback(() => setSelected(null), []);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const open = useCallback((id: string) => { setSelected(id); setOverlay(null); }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (overlay) { closeOverlay(); return true; }
      if (selected) { closeDetail(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [overlay, selected, closeOverlay, closeDetail]);

  const theme = themes[skin];
  const ctx = useMemo(() => ({ theme, setSkin }), [theme, setSkin]);
  // coluna da lista no iPad: ~40% da tela, entre 340 e 460
  const listW = Math.round(Math.min(460, Math.max(340, width * 0.4)));

  const home = ready ? (
    <HomeScreen
      reloadKey={reloadKey}
      selected={selected}
      onOpen={open}
      onSettings={() => setOverlay('settings')}
      onHistory={() => setOverlay('history')}
    />
  ) : null;
  const detail = selected ? <DetailScreen key={selected} id={selected} wide={wide} onBack={closeDetail} onChanged={reload} /> : null;

  return (
    <SafeAreaProvider>
      <ThemeContext.Provider value={ctx}>
        <ToastProvider>
          <View style={[styles.fill, { backgroundColor: theme.bg }]}>
            {wide ? (
              <View style={[styles.fill, { flexDirection: 'row' }]}>
                <View style={{ width: listW, borderRightWidth: 1, borderRightColor: theme.line }}>{home}</View>
                <View style={styles.fill}>
                  {detail || (
                    <View style={[styles.fill, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
                      <T muted style={{ fontSize: 15, textAlign: 'center' }}>Escolha um e-mail na lista para ver o detalhe aqui.</T>
                    </View>
                  )}
                </View>
              </View>
            ) : (
              <>
                {home}
                {detail ? <View style={StyleSheet.absoluteFill}>{detail}</View> : null}
              </>
            )}
            {overlay === 'settings' ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }]}>
                <SettingsScreen onBack={closeOverlay} onSkin={setSkin} onServerChanged={reload} />
              </View>
            ) : null}
            {overlay === 'history' ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }]}>
                <HistoryScreen onBack={closeOverlay} onChanged={reload} onOpen={open} />
              </View>
            ) : null}
          </View>
          <StatusBar style="dark" />
        </ToastProvider>
      </ThemeContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
