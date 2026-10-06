// Copiloto mobile: navegação em pilha simples (home sempre montada por baixo,
// detalhe e ajustes por cima) -- sem lib de rotas para manter o app enxuto.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { api, loadBaseUrl } from './src/api';
import { ToastProvider } from './src/components/ui';
import { DetailScreen } from './src/screens/DetailScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SkinName, ThemeContext, themes } from './src/theme';

type Route = { name: 'home' } | { name: 'detail'; id: string } | { name: 'settings' };

const SKIN_KEY = 'cp_skin';

export default function App() {
  const [ready, setReady] = useState(false);
  const [skin, setSkinState] = useState<SkinName>('clean');
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    (async () => {
      await loadBaseUrl();
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

  const back = useCallback(() => setRoute({ name: 'home' }), []);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'home') return false;
      back();
      return true;
    });
    return () => sub.remove();
  }, [route, back]);

  const theme = themes[skin];
  const ctx = useMemo(() => ({ theme, setSkin }), [theme, setSkin]);

  return (
    <SafeAreaProvider>
      <ThemeContext.Provider value={ctx}>
        <ToastProvider>
          <View style={[styles.fill, { backgroundColor: theme.bg }]}>
            {ready ? (
              <HomeScreen
                reloadKey={reloadKey}
                selected={route.name === 'detail' ? route.id : null}
                onOpen={(id) => setRoute({ name: 'detail', id })}
                onSettings={() => setRoute({ name: 'settings' })}
              />
            ) : null}
            {route.name === 'detail' ? (
              <View style={StyleSheet.absoluteFill}>
                <DetailScreen id={route.id} onBack={back} onChanged={reload} />
              </View>
            ) : null}
            {route.name === 'settings' ? (
              <View style={StyleSheet.absoluteFill}>
                <SettingsScreen onBack={back} onSkin={setSkin} onServerChanged={reload} />
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
