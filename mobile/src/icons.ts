// Ícones padrão do app (mesmos nomes de static/icons.js, usado na web em
// /, /mail, /copilot, /settings e /board). O app ainda não tem
// react-native-svg, então aqui cada nome vira um glifo equivalente; quando
// o pacote entrar, troque por <Svg> com os mesmos paths do static/icons.js.
export const ICON = {
  sparkles: '✨',
  mail: '✉︎',
  gmail: 'M',
  reply: '↩︎',
  forward: '↪︎',
  handoff: '➦',
  bell: '🔔',
  'bell-off': '🔕',
  'check-circle-double': '✔✔',
  check: '✓',
  eye: '◎',
  reopen: '↺',
  thread: '☰',
  summary: '📄',
  learn: '💡',
  chat: '💬',
  back: '←',
} as const;

export type IconName = keyof typeof ICON;

/** Cores fixas de alguns ícones (iguais às da web). */
export const ICON_COLOR: Partial<Record<IconName, string>> = {
  mail: '#1a73e8',
  gmail: '#EA4335',
  'check-circle-double': '#1e8e3e',
};

/** Ícones da camada 1 (seu papel) e urgência. */
export const ROLE_ICON: Record<string, string> = { so_copia: '⧉', mencionado_opiniao: '💭', demanda: '◎', fyi: 'ⓘ', pode_ignorar: '⊘' };
export const URG_ICON: Record<string, string> = { alta: '🔥', media: '◷', baixa: '🍃' };
