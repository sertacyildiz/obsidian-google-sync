/**
 * OAuth2 PKCE (RFC 7636) helpers — Web Crypto only. Used for the Google Drive
 * installed-app flow: no client secret is needed, so nothing confidential ships
 * in the plugin.
 */
function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A high-entropy code verifier (43 chars from 32 random bytes). */
export function generateCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

/** S256 challenge = base64url(SHA-256(verifier)). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}
