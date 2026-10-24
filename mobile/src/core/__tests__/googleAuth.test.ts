// Login Google atrás da interface: módulo nativo falso (nada fala com o Google).
import {
  AuthError, createGoogleAuth, GMAIL_SCOPE, getGoogleAuth, isConfigured, MSG_NOT_CONFIGURED, MSG_UNAVAILABLE, reversedClientId, setGoogleAuth,
  type GoogleAuth, type NativeGoogleSignin,
} from '../googleAuth';

const CFG = { iosClientId: '123-abc.apps.googleusercontent.com' };
const USER = { user: { email: 'Leo@Confrapag.com.br', name: 'Leo', photo: null }, scopes: ['email', GMAIL_SCOPE] };

function fakeNative(over: Partial<NativeGoogleSignin> = {}) {
  let current: typeof USER | null = null;
  const n: NativeGoogleSignin & { configureCalls: unknown[] } = {
    configureCalls: [],
    configure: jest.fn((p) => {
      n.configureCalls.push(p);
    }),
    hasPreviousSignIn: jest.fn(() => current !== null),
    getCurrentUser: jest.fn(() => current),
    signInSilently: jest.fn(async () => (current ? { type: 'success', data: current } : { type: 'noSavedCredentialFound', data: null })),
    signIn: jest.fn(async () => {
      current = USER;
      return { type: 'success', data: USER };
    }),
    addScopes: jest.fn(async () => null),
    signOut: jest.fn(async () => {
      current = null;
      return null;
    }),
    getTokens: jest.fn(async () => ({ accessToken: 'ya29.falso', idToken: 'id' })),
    clearCachedAccessToken: jest.fn(async () => null),
    ...over,
  };
  return n;
}

describe('googleAuth', () => {
  it('sem módulo nativo (Expo Go): "requer development build", sem quebrar', async () => {
    const a = createGoogleAuth(null, CFG);
    expect(a.isAvailable()).toBe(false);
    expect(await a.state()).toEqual({ kind: 'unavailable', reason: MSG_UNAVAILABLE });
    expect(MSG_UNAVAILABLE).toContain('requer development build');
    await expect(a.signIn()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(a.getAccessToken()).rejects.toBeInstanceOf(AuthError);
    await expect(a.signOut()).resolves.toBeUndefined();
  });

  it('client ID ainda no placeholder: não configura o módulo e explica onde colar', async () => {
    const n = fakeNative();
    const a = createGoogleAuth(n, { iosClientId: 'REPLACE_WITH_IOS_CLIENT_ID.apps.googleusercontent.com' });
    expect(await a.state()).toEqual({ kind: 'not_configured', reason: MSG_NOT_CONFIGURED });
    await expect(a.signIn()).rejects.toMatchObject({ code: 'not_configured' });
    expect(n.configure).not.toHaveBeenCalled();
    expect(isConfigured(CFG)).toBe(true);
    expect(reversedClientId(CFG.iosClientId)).toBe('com.googleusercontent.apps.123-abc');
  });

  it('entrar: configura só com gmail.modify, devolve o usuário; estado vira signed_in', async () => {
    const n = fakeNative();
    const a = createGoogleAuth(n, CFG);
    expect(await a.state()).toEqual({ kind: 'signed_out' });
    const u = await a.signIn();
    expect(u.email).toBe('leo@confrapag.com.br');
    expect(n.configure).toHaveBeenCalledTimes(1);
    expect(n.configureCalls[0]).toEqual({ iosClientId: CFG.iosClientId, scopes: [GMAIL_SCOPE], offlineAccess: false });
    expect(await a.state()).toMatchObject({ kind: 'signed_in', hasGmailScope: true, user: { email: 'leo@confrapag.com.br' } });
  });

  it('pessoa desmarcou o Gmail: pede o escopo de novo; se negar, erro claro', async () => {
    const semGmail = { ...USER, scopes: ['email'] };
    const ok = fakeNative({
      signIn: jest.fn(async () => ({ type: 'success', data: semGmail })),
      addScopes: jest.fn(async () => ({ type: 'success', data: USER })),
    });
    expect((await createGoogleAuth(ok, CFG).signIn()).scopes).toContain(GMAIL_SCOPE);
    expect(ok.addScopes).toHaveBeenCalledWith({ scopes: [GMAIL_SCOPE] });
    const nega = fakeNative({ signIn: jest.fn(async () => ({ type: 'success', data: semGmail })) });
    await expect(createGoogleAuth(nega, CFG).signIn()).rejects.toMatchObject({ code: 'scope_denied' });
  });

  it('cancelar e erro nativo viram AuthError em pt-BR', async () => {
    const cancel = fakeNative({ signIn: jest.fn(async () => ({ type: 'cancelled', data: null })) });
    await expect(createGoogleAuth(cancel, CFG).signIn()).rejects.toMatchObject({ code: 'cancelled', message: 'Login cancelado.' });
    const boom = fakeNative({ signIn: jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'IN_PROGRESS' }); }) });
    await expect(createGoogleAuth(boom, CFG).signIn()).rejects.toMatchObject({ code: 'failed', message: 'Já há um login em andamento.' });
  });

  it('getAccessToken: renova via getTokens; login salvo é recuperado em silêncio; sem login, signed_out', async () => {
    const n = fakeNative();
    const a = createGoogleAuth(n, CFG);
    await expect(a.getAccessToken()).rejects.toMatchObject({ code: 'signed_out' });
    await a.signIn();
    expect(await a.getAccessToken()).toBe('ya29.falso');
    (n.getCurrentUser as jest.Mock).mockReturnValueOnce(null);
    expect(await a.getAccessToken()).toBe('ya29.falso');
    expect(n.signInSilently).toHaveBeenCalled();
    (n.getTokens as jest.Mock).mockRejectedValueOnce(new Error('expirou ya29.falso'));
    const err = await a.getAccessToken().catch((e) => e);
    expect(err).toMatchObject({ code: 'signed_out' });
    expect(err.message).not.toContain('ya29');
  });

  it('sair e invalidar token', async () => {
    const n = fakeNative();
    const a = createGoogleAuth(n, CFG);
    await a.signIn();
    await a.invalidateToken('ya29.falso');
    expect(n.clearCachedAccessToken).toHaveBeenCalledWith('ya29.falso');
    await a.signOut();
    expect(await a.state()).toEqual({ kind: 'signed_out' });
  });

  it('getGoogleAuth sem o módulo nativo no ambiente (como no Expo Go) fica "unavailable"; setGoogleAuth troca por um mock', async () => {
    jest.isolateModules(() => {
      jest.doMock('@react-native-google-signin/google-signin', () => {
        throw new Error("TurboModuleRegistry.getEnforcing(...): 'RNGoogleSignin' could not be found");
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../googleAuth') as typeof import('../googleAuth');
      expect(mod.getGoogleAuth().isAvailable()).toBe(false);
    });
    const mock: GoogleAuth = {
      isAvailable: () => true,
      state: async () => ({ kind: 'signed_in', user: { email: 'x@y.com', name: '', photo: null, scopes: [GMAIL_SCOPE] }, hasGmailScope: true }),
      signIn: async () => ({ email: 'x@y.com', name: '', photo: null, scopes: [GMAIL_SCOPE] }),
      signOut: async () => undefined,
      getAccessToken: async () => 'mock',
      invalidateToken: async () => undefined,
    };
    setGoogleAuth(mock);
    expect(getGoogleAuth()).toBe(mock);
    expect(await getGoogleAuth().getAccessToken()).toBe('mock');
    setGoogleAuth(null);
    expect(getGoogleAuth()).not.toBe(mock);
  });
});
