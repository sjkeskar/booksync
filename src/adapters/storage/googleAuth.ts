import { AuthError } from './backend';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const TOKEN_KEY = 'gtoken'; // chrome.storage.session — memory only, cleared on browser exit
const EMAIL_KEY = 'googleEmail'; // chrome.storage.local — login hint for silent refresh

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

function randomState(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * OAuth 2.0 implicit flow via chrome.identity.launchWebAuthFlow — works in Chrome, Edge, Brave and
 * Vivaldi (getAuthToken only works in Google Chrome). No client secret exists anywhere.
 * Access tokens live ~1h in session storage; renewal is silent (prompt=none) while the user is
 * signed in to Google in this browser.
 */
export class GoogleAuth {
  private inflight: Promise<string> | null = null;

  constructor(private readonly clientId: string) {}

  get configured(): boolean {
    return !!this.clientId;
  }

  async email(): Promise<string | undefined> {
    return (await chrome.storage.local.get(EMAIL_KEY))[EMAIL_KEY] as string | undefined;
  }

  async setEmail(email: string): Promise<void> {
    await chrome.storage.local.set({ [EMAIL_KEY]: email });
  }

  async invalidate(): Promise<void> {
    await chrome.storage.session.remove(TOKEN_KEY);
  }

  /** A valid access token. Throws AuthError if the user must sign in interactively. */
  async getToken(interactive = false): Promise<string> {
    const s = (await chrome.storage.session.get(TOKEN_KEY))[TOKEN_KEY] as StoredToken | undefined;
    if (s && s.expiresAt > Date.now() + 60_000) return s.accessToken;
    this.inflight ??= this.acquire(interactive).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async acquire(interactive: boolean): Promise<string> {
    if (!this.clientId) throw new AuthError('Google client id not configured (see README)');
    try {
      return await this.launch(false);
    } catch (e) {
      if (!interactive) throw e instanceof AuthError ? e : new AuthError('Sign-in required');
    }
    return this.launch(true);
  }

  private async launch(interactive: boolean): Promise<string> {
    const state = randomState();
    const p = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'token',
      redirect_uri: chrome.identity.getRedirectURL(),
      scope: DRIVE_SCOPE,
      state,
      prompt: interactive ? 'select_account' : 'none',
    });
    const hint = await this.email();
    if (hint) p.set('login_hint', hint);
    let redirect: string | undefined;
    try {
      redirect = await chrome.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${p}`, interactive });
    } catch (e) {
      throw new AuthError(e instanceof Error ? e.message : 'Sign-in failed');
    }
    if (!redirect) throw new AuthError('Sign-in cancelled');
    const frag = new URLSearchParams(new URL(redirect).hash.slice(1));
    if (frag.get('error')) throw new AuthError(`Sign-in failed: ${frag.get('error')}`);
    if (frag.get('state') !== state) throw new AuthError('Sign-in failed: state mismatch');
    const token = frag.get('access_token');
    const expiresIn = Number(frag.get('expires_in') ?? '3600');
    if (!token) throw new AuthError('Sign-in failed: no token');
    if (!(frag.get('scope') ?? DRIVE_SCOPE).split(' ').includes(DRIVE_SCOPE)) throw new AuthError('Drive app-data permission was not granted');
    await this.verifyAudience(token);
    await chrome.storage.session.set({ [TOKEN_KEY]: { accessToken: token, expiresAt: Date.now() + expiresIn * 1000 } satisfies StoredToken });
    return token;
  }

  /** Reject tokens that were not issued to this extension's client id. */
  private async verifyAudience(token: string): Promise<void> {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new AuthError('Could not verify sign-in token');
    const info = (await r.json()) as { aud?: string; azp?: string };
    if (info.aud !== this.clientId && info.azp !== this.clientId) throw new AuthError('Token was issued to a different app');
  }

  async signOut(): Promise<void> {
    const s = (await chrome.storage.session.get(TOKEN_KEY))[TOKEN_KEY] as StoredToken | undefined;
    if (s) await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(s.accessToken)}` }).catch(() => undefined);
    await chrome.storage.session.remove(TOKEN_KEY);
    await chrome.storage.local.remove(EMAIL_KEY);
  }
}
