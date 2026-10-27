import { PreconditionFailed, RemoteProvider } from "../providers/RemoteProvider";
import { RESERVED_PREFIX, isReservedPath } from "../sync/reserved";
import { base64Decode, base64Encode } from "../util/base64";
import { aesGcmDecrypt, aesGcmEncrypt, deriveAesKey } from "./aesgcm";
import { PBKDF2_ITERATIONS, newSalt } from "./PassphraseCryptor";

/**
 * Content E2EE needs every device to derive the same key from the same
 * passphrase, so the salt lives with the encrypted content: a small plaintext
 * header at each backend's remote root. Nothing in it is secret — the salt only
 * makes the derivation unique to this folder, and `check` (a fixed string
 * encrypted with the derived key) lets a device tell a wrong passphrase apart
 * before it syncs anything. It also pins the salt and work factor: a header
 * edited by someone without the passphrase no longer opens, so it cannot talk a
 * device into a weaker derivation. See SECURITY.md ("End-to-end content encryption").
 */
export const E2EE_HEADER_PATH = `${RESERVED_PREFIX}e2ee.json`;

const CHECK_TEXT = "google-sync:e2ee:v1";
/** Bounds a header must respect. Not a downgrade defence (`check` is) — a guard against a hang or a crash. */
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 10_000_000;

export interface E2eeHeader {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  check: string;
}

export interface UnlockOptions {
  /** This device's pre-header salt, for content encrypted before the header existed. */
  legacySalt?: Uint8Array | null;
  /** The passphrase typed a second time; required only when a header is created. */
  confirm?: string;
  /** This device's copy of the folder's header, to restore a deleted or damaged one. */
  localCopy?: string | null;
  /** Work factor for a newly created header (tests use a light one). */
  iterations?: number;
}

export interface Unlocked {
  key: CryptoKey;
  /** The header's salt (base64) — what a later sync checks the remote against. */
  salt: string;
  /** The header text, for this device's local copy. */
  header: string;
}

const WRONG_PASSPHRASE = "Wrong passphrase — this folder's content was encrypted with a different one.";
const DAMAGED = "This folder's encryption header is damaged. Unlock on a device that has used this folder to restore it.";
const CONFIRM = "Confirm the passphrase to start encrypting this folder — type it again under Confirm passphrase.";
const NO_MATCH = "The passphrase and its confirmation don't match.";
const NO_HEADER =
  "This folder has files but no encryption header. If it is encrypted, unlock on a device that has used it — that restores the header. " +
  "If it is not, end-to-end encryption needs an empty folder: choose a new Drive folder or GCS prefix.";

/** Validate a header's text; anything malformed or out of bounds is "damaged". */
export function parseHeader(text: string): E2eeHeader {
  let h: Partial<E2eeHeader>;
  try {
    h = JSON.parse(text) as Partial<E2eeHeader>;
  } catch {
    throw new Error(DAMAGED);
  }
  if (h.v !== 1 || h.kdf !== "PBKDF2-SHA256") {
    if (typeof h.v === "number" && h.v > 1) throw new Error("This folder was encrypted by a newer version of the plugin — update it first.");
    throw new Error(DAMAGED);
  }
  const ok =
    Number.isInteger(h.iterations) &&
    (h.iterations as number) >= MIN_ITERATIONS &&
    (h.iterations as number) <= MAX_ITERATIONS &&
    typeof h.salt === "string" &&
    typeof h.check === "string" &&
    saltLength(h.salt) >= 16 &&
    saltLength(h.salt) <= 64;
  if (!ok) throw new Error(DAMAGED);
  return h as E2eeHeader;
}

/** The remote's header, or null when there is none. Throws "damaged" for a malformed one. */
export async function readHeader(remote: RemoteProvider): Promise<{ text: string; header: E2eeHeader } | null> {
  const raw = await remote.get(E2EE_HEADER_PATH);
  if (!raw) return null;
  const text = new TextDecoder().decode(raw);
  return { text, header: parseHeader(text) };
}

/**
 * Derive this remote's content key from `passphrase`. Opens the existing header;
 * otherwise creates one only when that cannot strand data: restoring this device's
 * copy, initialising an empty folder (after the passphrase is confirmed), or
 * adopting the pre-header salt when every existing file opens with it. Every
 * other case is refused with a message saying what was found — nothing is written.
 */
export async function unlockRemote(remote: RemoteProvider, passphrase: string, opts: UnlockOptions = {}): Promise<Unlocked> {
  const existing = await readHeader(remote);
  if (existing) return open(existing.text, existing.header, passphrase);

  if (opts.localCopy) {
    return publish(remote, await open(opts.localCopy, parseHeader(opts.localCopy), passphrase), passphrase);
  }

  const files = (await remote.list("")).filter((o) => o.path !== "" && !o.path.endsWith("/") && !isReservedPath(o.path));
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;

  if (files.length === 0) {
    if (opts.confirm === undefined || opts.confirm === "") throw new Error(CONFIRM);
    if (opts.confirm !== passphrase) throw new Error(NO_MATCH);
    return publish(remote, await create(passphrase, newSalt(), iterations), passphrase);
  }

  if (!opts.legacySalt) throw new Error(NO_HEADER);

  // Content from before the header existed, encrypted with this device's salt.
  // Adopt that salt only if EVERY file opens with it — a single sample could be the
  // one plaintext or foreign file in the folder.
  const candidate = await create(passphrase, opts.legacySalt, iterations);
  let opened = 0;
  let plain = 0;
  let foreign = 0;
  for (const f of files) {
    const bytes = await remote.get(f.path);
    if (!bytes) continue;
    if (!isEnvelope(bytes)) plain++;
    else if (await opens(candidate.key, bytes)) opened++;
    else foreign++;
  }
  if (plain > 0) {
    throw new Error(`${plain} of ${files.length} files in this folder are not encrypted, so encryption cannot take it over. Nothing was changed.`);
  }
  if (opened === 0) throw new Error(WRONG_PASSPHRASE);
  if (foreign > 0) {
    throw new Error(`${foreign} of ${files.length} files in this folder were encrypted with a different key (another device or passphrase). Nothing was changed.`);
  }
  return publish(remote, candidate, passphrase);
}

async function open(text: string, h: E2eeHeader, passphrase: string): Promise<Unlocked> {
  const key = await deriveAesKey(passphrase, base64Decode(h.salt), h.iterations);
  if (!(await opens(key, base64Decode(h.check)))) throw new Error(WRONG_PASSPHRASE);
  return { key, salt: h.salt, header: text };
}

async function create(passphrase: string, salt: Uint8Array, iterations: number): Promise<Unlocked> {
  const key = await deriveAesKey(passphrase, salt, iterations);
  const check = await aesGcmEncrypt(key, new TextEncoder().encode(CHECK_TEXT).buffer);
  const header: E2eeHeader = { v: 1, kdf: "PBKDF2-SHA256", iterations, salt: base64Encode(salt), check: base64Encode(new Uint8Array(check)) };
  const text = JSON.stringify(header);
  return { key, salt: header.salt, header: text };
}

/**
 * Write the header, create-only. If another device got there first, adopt
 * theirs — never overwrite: both devices must end up on the one key the folder
 * records (with the same passphrase theirs opens; with another, it is refused).
 */
async function publish(remote: RemoteProvider, ours: Unlocked, passphrase: string): Promise<Unlocked> {
  try {
    await remote.put(E2EE_HEADER_PATH, new TextEncoder().encode(ours.header).buffer, "application/json", { ifAbsent: true });
    return ours;
  } catch (e) {
    if (!(e instanceof PreconditionFailed)) throw e;
    const theirs = await readHeader(remote);
    if (!theirs) throw e;
    return open(theirs.text, theirs.header, passphrase);
  }
}

function isEnvelope(bytes: ArrayBuffer): boolean {
  const b = new Uint8Array(bytes);
  return b.length >= 29 && b[0] === 1; // see aesgcm.ts: [version:1][iv:12][ciphertext+tag:16+]
}

async function opens(key: CryptoKey, envelope: ArrayBuffer | Uint8Array): Promise<boolean> {
  try {
    await aesGcmDecrypt(key, envelope instanceof Uint8Array ? envelope.slice().buffer : envelope);
    return true;
  } catch {
    return false;
  }
}

function saltLength(b64: string): number {
  try {
    return base64Decode(b64).length;
  } catch {
    return 0;
  }
}
