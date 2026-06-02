/**
 * Authenticated encryption primitives (AES-256-GCM) over Web Crypto — works in
 * Obsidian and Node, no native/runtime deps. Key is derived from a passphrase
 * via PBKDF2-SHA256 (run once; reused across files). Each message gets a fresh
 * random 96-bit IV. The GCM tag authenticates the ciphertext (tamper-evident).
 *
 * Envelope layout: [version:1][iv:12][ciphertext+tag].
 */
const VERSION = 1;
const IV_LEN = 12;
const MIN_LEN = 1 + IV_LEN + 16; // version + iv + GCM tag (empty plaintext)

export async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function aesGcmEncrypt(key: CryptoKey, plaintext: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const out = new Uint8Array(1 + IV_LEN + ct.byteLength);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(new Uint8Array(ct), 1 + IV_LEN);
  return out.buffer;
}

export async function aesGcmDecrypt(key: CryptoKey, envelope: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(envelope);
  if (bytes.length < MIN_LEN || bytes[0] !== VERSION) {
    throw new Error("invalid or unsupported ciphertext envelope");
  }
  const iv = bytes.slice(1, 1 + IV_LEN);
  const ct = bytes.slice(1 + IV_LEN);
  // Throws OperationError if the tag fails (wrong key or tampered data).
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
}
