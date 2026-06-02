import { aesGcmDecrypt, aesGcmEncrypt } from "./aesgcm";

/**
 * Credential-at-rest: seal/open a short secret string (GCS HMAC secret, Drive
 * OAuth tokens) with the same AES-GCM key used for content E2EE, encoded as
 * base64 for storage in the plugin config. The plaintext secret never touches
 * disk; only this sealed blob does (and it is excluded from sync).
 */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export async function sealSecret(key: CryptoKey, secret: string): Promise<string> {
  return toBase64(await aesGcmEncrypt(key, new TextEncoder().encode(secret).buffer));
}

export async function openSecret(key: CryptoKey, sealed: string): Promise<string> {
  return new TextDecoder().decode(await aesGcmDecrypt(key, fromBase64(sealed)));
}
