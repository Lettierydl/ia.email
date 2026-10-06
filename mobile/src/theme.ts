// Mesma paleta do /copilot web (static/copilot.css): clean pastel e caderno.
import { createContext, useContext } from 'react';
import { Platform } from 'react-native';

export type SkinName = 'clean' | 'caderno';

export interface Theme {
  name: SkinName;
  bg: string;
  card: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  accentInk: string;
  peach: string;
  lilac: string;
  mint: string;
  sky: string;
  butter: string;
  rose: string;
  fog: string;
  radius: number;
  font?: string;
  fontTitle?: string;
  dashed: boolean;
}

export const themes: Record<SkinName, Theme> = {
  clean: {
    name: 'clean',
    bg: '#f6f5fb', card: '#ffffff', ink: '#2d2b3a', muted: '#7b7890', line: '#ecebf3',
    accent: '#7c6fd6', accentInk: '#4b3fa8',
    peach: '#ffe6d6', lilac: '#e9e4ff', mint: '#dcf3e8', sky: '#dfeeff', butter: '#fff4c8', rose: '#fbe1e4', fog: '#eef0f5',
    radius: 18,
    dashed: false,
  },
  caderno: {
    name: 'caderno',
    bg: '#fbf8ef', card: '#fffdf7', ink: '#33302a', muted: '#857e6f', line: '#e7e0cf',
    accent: '#6f8fbf', accentInk: '#3f5f8f',
    peach: '#fde4cf', lilac: '#e6e1f7', mint: '#dbefdc', sky: '#dbe9f7', butter: '#fbf0bf', rose: '#f8dfdc', fog: '#efebe0',
    radius: 6,
    font: Platform.select({ ios: 'Palatino', android: 'serif' }),
    fontTitle: Platform.select({ ios: 'Bradley Hand', android: 'casual' }),
    dashed: true,
  },
};

export const PASTEL = ['#ffe6d6', '#e9e4ff', '#dcf3e8', '#dfeeff', '#fff4c8', '#fbe1e4'];

export const shadow = Platform.select({
  ios: { shadowColor: '#2d2b3a', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  default: { elevation: 1 },
});

export const ThemeContext = createContext<{ theme: Theme; setSkin: (s: SkinName) => void }>({
  theme: themes.clean,
  setSkin: () => {},
});

export const useTheme = () => useContext(ThemeContext).theme;
