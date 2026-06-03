import { HttpSend } from "../RemoteProvider";

/**
 * Provider-neutral Google OAuth 2.0 primitives (installed-app / PKCE). Shared by
 * the Drive and GCS "Connect" flows — neither the auth-URL builder nor the token
 * exchange/refresh is provider-specific; only the requested *scope* differs, and
 * scopes live with their provider (`driveScope`, `gcsOAuthScope`). No client
 * secret is used (PKCE), so nothing confidential ships in the plugin.
 */
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms; refresh shortly before this. */
  expiresAt: number;
}

export function buildAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
}): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", p.scope);
  u.searchParams.set("code_challenge", p.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

function formBody(params: Record<string, string>): ArrayBuffer {
  const s = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return new TextEncoder().encode(s).buffer;
}

async function postToken(http: HttpSend, params: Record<string, string>, now: number): Promise<TokenSet> {
  const res = await http(
    "POST",
    TOKEN_ENDPOINT,
    { "content-type": "application/x-www-form-urlencoded" },
    formBody(params)
  );
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) throw new Error(`OAuth token ${res.status}: ${text.slice(0, 200)}`);
  const t = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: now + (t.expires_in ?? 3600) * 1000,
  };
}

export function exchangeCode(
  http: HttpSend,
  p: { clientId: string; code: string; codeVerifier: string; redirectUri: string },
  now: number
): Promise<TokenSet> {
  return postToken(
    http,
    {
      client_id: p.clientId,
      code: p.code,
      code_verifier: p.codeVerifier,
      redirect_uri: p.redirectUri,
      grant_type: "authorization_code",
    },
    now
  );
}

export async function refreshAccessToken(
  http: HttpSend,
  p: { clientId: string; refreshToken: string },
  now: number
): Promise<TokenSet> {
  const t = await postToken(
    http,
    { client_id: p.clientId, refresh_token: p.refreshToken, grant_type: "refresh_token" },
    now
  );
  // Google omits refresh_token on refresh — keep the existing one.
  if (!t.refreshToken) t.refreshToken = p.refreshToken;
  return t;
}
