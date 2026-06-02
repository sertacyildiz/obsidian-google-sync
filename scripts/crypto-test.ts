/*
 * Offline security tests for the E2EE + credential-at-rest crypto. No network.
 * Covers: round-trip (empty/text/binary), random-IV uniqueness, wrong-passphrase
 * rejection, tamper detection, and secret seal/open. Also exercises the engine's
 * Cryptor hook contract. Run: sh scripts/run-pilot.sh scripts/crypto-test.ts
 */
import { PassphraseCryptor, newSalt } from "../src/crypto/PassphraseCryptor";
import { deriveAesKey } from "../src/crypto/aesgcm";
import { openSecret, sealSecret } from "../src/crypto/secret";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);
const eq = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

let passed = 0, failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}
async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

// Low, fixed iteration count keeps the test fast; production uses 600k.
const ITER = 50_000;

async function main(): Promise<void> {
  const salt = newSalt();
  const cryptor = await PassphraseCryptor.fromPassphrase("correct horse battery staple", salt, ITER);

  // round-trip across sizes
  for (const [label, data] of [
    ["empty", enc("")],
    ["text", enc("# Secret notes\nαβγ 漢字 🔐")],
    ["binary 4KB", crypto.getRandomValues(new Uint8Array(4096)).buffer],
  ] as const) {
    const ct = await cryptor.encrypt(data);
    const back = await cryptor.decrypt(ct);
    check(`round-trip (${label})`, eq(back, data));
    if (label === "text") check("ciphertext != plaintext + has overhead", !eq(ct, data) && ct.byteLength > data.byteLength);
  }

  // random IV => same plaintext encrypts to different ciphertext
  const p = enc("repeat me");
  const c1 = await cryptor.encrypt(p);
  const c2 = await cryptor.encrypt(p);
  check("same plaintext -> distinct ciphertext (random IV)", !eq(c1, c2));
  check("...but both decrypt back", eq(await cryptor.decrypt(c1), p) && eq(await cryptor.decrypt(c2), p));

  // wrong passphrase cannot decrypt
  const wrong = await PassphraseCryptor.fromPassphrase("wrong passphrase", salt, ITER);
  check("wrong passphrase fails (auth)", await throws(() => wrong.decrypt(c1)));

  // different salt -> different key -> fails
  const otherSalt = await PassphraseCryptor.fromPassphrase("correct horse battery staple", newSalt(), ITER);
  check("same passphrase, different salt fails", await throws(() => otherSalt.decrypt(c1)));

  // tamper detection
  const tampered = new Uint8Array(c1.slice(0));
  tampered[tampered.length - 1] ^= 0xff;
  check("tampered ciphertext is rejected", await throws(() => cryptor.decrypt(tampered.buffer)));

  // credential-at-rest seal/open
  const key = await deriveAesKey("master-pass", salt, ITER);
  const secret = "GOOG1EXAMPLE/hmacSecret+abcDEF0123456789";
  const sealed = await sealSecret(key, secret);
  check("sealed secret is not plaintext", !sealed.includes(secret));
  check("seal/open round-trip", (await openSecret(key, sealed)) === secret);
  const wrongKey = await deriveAesKey("master-pass", newSalt(), ITER);
  check("open with wrong key fails", await throws(() => openSecret(wrongKey, sealed)));

  console.log(`\n=== crypto: ${failed === 0 ? "ALL PASS" : failed + " FAILED"} (${passed} passed) ===`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("crypto-test crashed:", (e as Error).message);
  process.exitCode = 1;
});
