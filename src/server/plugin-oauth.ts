import { createHash, randomBytes } from 'node:crypto';
import { pluginFetch } from './plugin-network.js';

export interface OAuthSettings {
  clientId: string;
  /** Sealed with PLUGIN_SECRET_KEY. */
  clientSecretCipher: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  grantedScopes: string[];
  extraParams: Record<string, string>;
}

export const GOOGLE_OAUTH = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  extraParams: { access_type: 'offline', prompt: 'consent' },
};

export class OAuthRevokedError extends Error {}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

const STATE_TTL_MS = 10 * 60_000;

const base64url = (bytes: Buffer) => bytes.toString('base64url');

export class PluginOAuth {
  private pending = new Map<
    string,
    {
      pluginId: string;
      verifier: string;
      redirectUri: string;
      expiresAt: number;
    }
  >();
  private cache = new Map<string, { token: string; expiresAt: number }>();
  constructor(
    private options: {
      fetch?: (url: string, init: RequestInit) => Promise<Response>;
      now?: () => number;
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private post(url: string, body: Record<string, string>) {
    return (this.options.fetch ?? pluginFetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(body).toString(),
    });
  }
  /** Returns the URL the owner's browser opens. The state is single-use. */
  start(pluginId: string, settings: OAuthSettings, redirectUri: string) {
    const now = this.now();
    for (const [key, entry] of this.pending)
      if (entry.expiresAt <= now) this.pending.delete(key);
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    this.pending.set(state, {
      pluginId,
      verifier,
      redirectUri,
      expiresAt: now + STATE_TTL_MS,
    });
    const url = new URL(settings.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', settings.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', settings.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set(
      'code_challenge',
      base64url(createHash('sha256').update(verifier).digest()),
    );
    url.searchParams.set('code_challenge_method', 'S256');
    for (const [key, value] of Object.entries(settings.extraParams))
      url.searchParams.set(key, value);
    return url.toString();
  }
  /** Consumes a state. Returns the plugin it was issued for, or null. */
  claim(state: string) {
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return entry;
  }
  async exchange(
    claim: { pluginId: string; verifier: string; redirectUri: string },
    code: string,
    settings: OAuthSettings,
    clientSecret: string,
  ) {
    const response = await this.post(settings.tokenUrl, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: claim.redirectUri,
      client_id: settings.clientId,
      code_verifier: claim.verifier,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
    const data = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok || !data.access_token)
      throw new Error(
        `Sign-in failed: ${data.error_description ?? data.error ?? response.status}.`,
      );
    if (!data.refresh_token)
      throw new Error(
        'The provider did not return a refresh token. Remove Pods from your account permissions and connect again.',
      );
    this.cache.set(claim.pluginId, {
      token: data.access_token,
      expiresAt: this.now() + (data.expires_in ?? 3600) * 1000,
    });
    return {
      refreshToken: data.refresh_token,
      grantedScopes: data.scope
        ? data.scope.split(/\s+/).filter(Boolean)
        : settings.scopes,
      accessToken: data.access_token,
    };
  }
  /** A current access token, refreshed when it is within a minute of expiry. */
  async accessToken(
    pluginId: string,
    settings: OAuthSettings,
    refreshToken: string,
    clientSecret: string,
  ) {
    const cached = this.cache.get(pluginId);
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    const response = await this.post(settings.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: settings.clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
    const data = (await response.json().catch(() => ({}))) as TokenResponse;
    if (data.error === 'invalid_grant' || response.status === 401) {
      this.cache.delete(pluginId);
      throw new OAuthRevokedError('Access was revoked. Reconnect this plugin.');
    }
    if (!response.ok || !data.access_token)
      throw new Error(
        `Could not refresh access: ${data.error_description ?? data.error ?? response.status}.`,
      );
    this.cache.set(pluginId, {
      token: data.access_token,
      expiresAt: this.now() + (data.expires_in ?? 3600) * 1000,
    });
    return data.access_token;
  }
  forget(pluginId: string) {
    this.cache.delete(pluginId);
  }
}
