// Login Google (Sign in with Google nativo, @react-native-google-signin) com
// um único escopo: gmail.modify (ler, rótulos, lido/arquivar). Nada de envio
// nesta fase. O módulo nativo só existe no development build: no Expo Go o
// require falha e a UI mostra "requer development build" sem quebrar.
//
// Tudo atrás da interface GoogleAuth: o app usa getGoogleAuth(); os testes
// passam um falso com setGoogleAuth() ou montam um com createGoogleAuth(native).
// O token de acesso nunca vai para log, SQLite ou tela — o google-signin já o
// guarda no Keychain e o renova (getTokens) quando expira.
import Constants from 'expo-constants';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const SCOPES = [GMAIL_SCOPE];
export const PLACEHOLDER = 'REPLACE_WITH_IOS_CLIENT_ID';

export interface GoogleUser {
  email: string;
  name: string;
  photo: string | null;
  scopes: string[];
}

export type AuthState =
  /** módulo nativo ausente (Expo Go) */
  | { kind: 'unavailable'; reason: string }
  /** client ID ainda é o placeholder do app.json */
  | { kind: 'not_configured'; reason: string }
  | { kind: 'signed_out' }
  | { kind: 'signed_in'; user: GoogleUser; hasGmailScope: boolean };

export interface GoogleAuth {
  /** o módulo nativo está no binário (dev build) */
  isAvailable(): boolean;
  state(): Promise<AuthState>;
  signIn(): Promise<GoogleUser>;
  signOut(): Promise<void>;
  /** token de acesso válido (renova se preciso); erro AuthError se não há login */
  getAccessToken(): Promise<string>;
  /** o Gmail recusou o token (401): descarta o cache para a próxima chamada renovar */
  invalidateToken(token: string): Promise<void>;
}

export class AuthError extends Error {
  code: 'unavailable' | 'not_configured' | 'signed_out' | 'cancelled' | 'scope_denied' | 'failed';
  constructor(code: AuthError['code'], message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export const MSG_UNAVAILABLE = 'O login Google requer development build (não funciona no Expo Go).';
export const MSG_NOT_CONFIGURED =
  'Falta o client ID iOS do Google: cole em app.json (extra.googleAuth.iosClientId e iosUrlScheme do plugin) e gere um novo build.';
export const MSG_SIGNED_OUT = 'Entre com a conta Google em Ajustes → Conta Google.';

// ── O pedaço do módulo nativo que usamos ──
type NativeUser = { user: { email: string; name: string | null; photo: string | null }; scopes?: string[] };
type NativeResponse = { type: string; data: NativeUser | null };

export interface NativeGoogleSignin {
  configure(params: { iosClientId?: string; scopes?: string[]; offlineAccess?: boolean }): void;
  hasPreviousSignIn(): boolean;
  getCurrentUser(): NativeUser | null;
  signInSilently(): Promise<NativeResponse>;
  signIn(): Promise<NativeResponse>;
  addScopes(params: { scopes: string[] }): Promise<NativeResponse | null>;
  signOut(): Promise<unknown>;
  getTokens(): Promise<{ accessToken: string; idToken: string }>;
  clearCachedAccessToken(token: string): Promise<unknown>;
}

export interface GoogleConfig {
  iosClientId: string;
}

/** Client ID lido do app.json (expo.extra.googleAuth.iosClientId). */
export function configFromExpo(): GoogleConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as { googleAuth?: { iosClientId?: string } };
  return { iosClientId: String(extra.googleAuth?.iosClientId ?? '').trim() };
}

export function isConfigured(cfg: GoogleConfig): boolean {
  return !!cfg.iosClientId && !cfg.iosClientId.includes(PLACEHOLDER) && cfg.iosClientId.endsWith('.apps.googleusercontent.com');
}

/** "123-abc.apps.googleusercontent.com" → "com.googleusercontent.apps.123-abc" (o iosUrlScheme do plugin). */
export function reversedClientId(clientId: string): string {
  return `com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/, '')}`;
}

const toUser = (u: NativeUser): GoogleUser => ({
  email: String(u.user.email || '').toLowerCase(),
  name: u.user.name || '',
  photo: u.user.photo || null,
  scopes: Array.isArray(u.scopes) ? u.scopes : [],
});

/** Mensagem curta em pt-BR para erro do módulo nativo (nunca inclui token). */
function nativeMessage(e: unknown): string {
  const code = String((e as { code?: unknown })?.code ?? '');
  if (code === 'IN_PROGRESS') return 'Já há um login em andamento.';
  if (code === 'SIGN_IN_REQUIRED') return MSG_SIGNED_OUT;
  if (/network/i.test(String((e as Error)?.message ?? ''))) return 'Sem conexão para falar com o Google.';
  return 'O login Google falhou. Tente de novo.';
}

export function createGoogleAuth(native: NativeGoogleSignin | null, cfg: GoogleConfig, unavailableReason = MSG_UNAVAILABLE): GoogleAuth {
  let configured = false;

  function ready(): NativeGoogleSignin {
    if (!native) throw new AuthError('unavailable', unavailableReason);
    if (!isConfigured(cfg)) throw new AuthError('not_configured', MSG_NOT_CONFIGURED);
    if (!configured) {
      native.configure({ iosClientId: cfg.iosClientId, scopes: SCOPES, offlineAccess: false });
      configured = true;
    }
    return native;
  }

  async function currentUser(n: NativeGoogleSignin): Promise<NativeUser | null> {
    const cur = n.getCurrentUser();
    if (cur) return cur;
    if (!n.hasPreviousSignIn()) return null;
    try {
      const r = await n.signInSilently();
      return r.type === 'success' ? r.data : null;
    } catch {
      return null;
    }
  }

  return {
    isAvailable: () => !!native,

    async state() {
      if (!native) return { kind: 'unavailable', reason: unavailableReason };
      if (!isConfigured(cfg)) return { kind: 'not_configured', reason: MSG_NOT_CONFIGURED };
      const u = await currentUser(ready());
      if (!u) return { kind: 'signed_out' };
      const user = toUser(u);
      return { kind: 'signed_in', user, hasGmailScope: user.scopes.includes(GMAIL_SCOPE) };
    },

    async signIn() {
      const n = ready();
      let r: NativeResponse;
      try {
        r = await n.signIn();
      } catch (e) {
        throw new AuthError('failed', nativeMessage(e));
      }
      if (r.type !== 'success' || !r.data) throw new AuthError('cancelled', 'Login cancelado.');
      let user = toUser(r.data);
      if (!user.scopes.includes(GMAIL_SCOPE)) {
        // a pessoa desmarcou o Gmail na tela de consentimento: pede de novo só o escopo
        const added = await n.addScopes({ scopes: SCOPES }).catch(() => null);
        if (added?.type === 'success' && added.data) user = toUser(added.data);
        if (!user.scopes.includes(GMAIL_SCOPE)) {
          throw new AuthError('scope_denied', 'Sem permissão de acesso ao Gmail: entre de novo e marque o acesso ao Gmail.');
        }
      }
      return user;
    },

    async signOut() {
      if (!native) return;
      await native.signOut().catch(() => undefined);
    },

    async getAccessToken() {
      const n = ready();
      const u = await currentUser(n);
      if (!u) throw new AuthError('signed_out', MSG_SIGNED_OUT);
      try {
        // no iOS o getTokens renova o access token quando ele venceu
        const t = await n.getTokens();
        if (!t?.accessToken) throw new Error('sem token');
        return t.accessToken;
      } catch {
        throw new AuthError('signed_out', 'O acesso ao Google expirou: entre de novo em Ajustes → Conta Google.');
      }
    },

    async invalidateToken(token: string) {
      if (!native || !token) return;
      // só tem efeito no Android; no iOS o getTokens seguinte já renova
      await native.clearCachedAccessToken(token).catch(() => undefined);
    },
  };
}

/** Carrega o módulo nativo; no Expo Go o TurboModule não existe e o require lança. */
function loadNative(): NativeGoogleSignin | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-google-signin/google-signin');
    return (mod?.GoogleSignin as NativeGoogleSignin) ?? null;
  } catch {
    return null;
  }
}

let instance: GoogleAuth | null = null;

export function getGoogleAuth(): GoogleAuth {
  if (!instance) instance = createGoogleAuth(loadNative(), configFromExpo());
  return instance;
}

/** Troca a implementação (testes, ou um mock para desenvolver a UI). null volta ao padrão. */
export function setGoogleAuth(auth: GoogleAuth | null): void {
  instance = auth;
}
