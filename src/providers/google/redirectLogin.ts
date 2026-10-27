import { buildAuthUrl } from "./oauth";
import { codeChallengeS256, generateCodeVerifier } from "./pkce";

/**
 * Phone sign-in. A mobile app cannot listen on a loopback port, so Google
 * redirects to a static page instead, which hands the one-time code back to
 * Obsidian through `obsidian://google-cloud-sync-auth`. The page sees only that
 * code; redeeming it needs the PKCE verifier and the client secret, which never
 * leave the device. Provider-neutral and Obsidian-free, like `oauth.ts`: the
 * controller persists the PendingAuth and opens the browser.
 *
 * The page lives in this repo (`docs/oauth/`), served by GitHub Pages from `docs/`;
 * users who would rather host it themselves set `oauthRedirectPage`.
 */
export const REDIRECT_PAGE_URL = "https://sertacyildiz.github.io/obsidian-google-sync/oauth/";

/** The `obsidian://` action the redirect page calls. */
export const AUTH_CALLBACK_ACTION = "google-cloud-sync-auth";

/** How long a started sign-in stays redeemable — Google's authorization codes last about as long. */
export const PENDING_AUTH_TTL_MS = 10 * 60_000;

export type OAuthBackend = "drive" | "gcs";

/**
 * A sign-in waiting for its callback. Persisted (data.json) before the browser
 * opens, because the OS may kill Obsidian while the browser is in front and the
 * callback then cold-starts it. Single-use: cleared once a callback is handled.
 */
export interface PendingAuth {
  backend: OAuthBackend;
  scope: string;
  /** Echoed back by Google; ties the callback to this attempt (and this vault). */
  state: string;
  /** PKCE verifier — the half of the proof that never leaves the device. */
  verifier: string;
  redirectUri: string;
  /** epoch ms */
  createdAt: number;
}

export async function startRedirectLogin(p: {
  clientId: string;
  scope: string;
  backend: OAuthBackend;
  redirectUri: string;
  now: number;
}): Promise<{ pending: PendingAuth; authUrl: string }> {
  const verifier = generateCodeVerifier();
  // Same 256-bit base64url token the verifier uses — unguessable, URL-safe, 43 chars.
  const state = generateCodeVerifier();
  const pending: PendingAuth = { backend: p.backend, scope: p.scope, state, verifier, redirectUri: p.redirectUri, createdAt: p.now };
  const authUrl = buildAuthUrl({
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    scope: p.scope,
    codeChallenge: await codeChallengeS256(verifier),
    state,
  });
  return { pending, authUrl };
}

/**
 * Decide whether an `obsidian://google-cloud-sync-auth` callback belongs to the
 * pending sign-in, and return its authorization code if it does. Anyone can
 * open an `obsidian://` link, so this is the gate in front of the token
 * exchange. Throws an Error whose message is shown to the user as-is — it must
 * never contain the code, the state or the verifier.
 */
export function acceptCallback(
  pending: PendingAuth | null,
  params: Record<string, string>,
  now: number
): { code: string; pending: PendingAuth } {
  if (!pending) throw new Error("No sign-in in progress — tap Connect again.");
  // State first: a genuine callback — success or cancel — always carries ours, so
  // checking it before anything else costs real users nothing, and a crafted link
  // cannot steer what the user is told.
  if (params.state !== pending.state) {
    throw new Error("This sign-in was started in another vault or an earlier attempt — tap Connect again in this vault.");
  }
  if (now - pending.createdAt > PENDING_AUTH_TTL_MS) throw new Error("Sign-in expired — tap Connect again.");
  if (params.error) {
    // Google's error codes are short snake_case words; anything else is not worth echoing into a notice.
    const reason = /^[a-z_]{1,64}$/.test(params.error) ? params.error : "unknown error";
    throw new Error(reason === "access_denied" ? "Google sign-in was cancelled (access_denied)." : `Google sign-in failed (${reason}).`);
  }
  if (!params.code) throw new Error("Google returned no authorization code — tap Connect again.");
  return { code: params.code, pending };
}
