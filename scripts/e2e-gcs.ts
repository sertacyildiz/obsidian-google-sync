/*
 * END-TO-END test against REAL GCS: the full SyncEngine + GcsProvider +
 * PassphraseCryptor (E2EE) + a temp-dir LocalStore, across two "devices".
 * Auth is a short-lived OAuth Bearer token (the org blocks SA-HMAC). This
 * exercises the integration + the special-char/unicode filename fix + nested
 * folders against actual GCS, and verifies stored objects are ciphertext.
 * Run: GCS_BUCKET=.. GCS_BEARER=$(gcloud auth print-access-token) \
 *        sh scripts/run-pilot.sh scripts/e2e-gcs.ts
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SyncEngine } from "../src/sync/SyncEngine";
import { GCS_ENDPOINT, GcsProvider } from "../src/providers/gcs/GcsProvider";
import { bearerAuthorizer } from "../src/providers/gcs/auth";
import { PassphraseCryptor, newSalt } from "../src/crypto/PassphraseCryptor";
import { LocalStore } from "../src/sync/LocalStore";
import { LocalFile, SyncStateData } from "../src/sync/types";
import { sha256Hex } from "../src/util/hash";
import { nodeHttpSend } from "./node-http";

const toAB = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const txt = (ab: ArrayBuffer): string => new TextDecoder().decode(ab);
const env = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error("missing env " + n);
  return v;
};

class NodeLocalStore implements LocalStore {
  constructor(private readonly root: string) {}
  async list(): Promise<LocalFile[]> {
    const out: LocalFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else {
          const data = await fs.readFile(p);
          out.push({
            path: path.relative(this.root, p).split(path.sep).join("/"),
            hash: await sha256Hex(toAB(data)),
            mtime: (await fs.stat(p)).mtimeMs,
          });
        }
      }
    };
    await walk(this.root);
    return out;
  }
  async read(p: string): Promise<ArrayBuffer> {
    return toAB(await fs.readFile(path.join(this.root, p)));
  }
  async write(p: string, data: ArrayBuffer): Promise<void> {
    const full = path.join(this.root, p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.from(data));
  }
  async delete(p: string): Promise<void> {
    await fs.rm(path.join(this.root, p), { force: true });
  }
}

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

const SPECIAL = "My Notes/iş (a) b!.md"; // spaces + unicode + specials — the signing fix
const SPECIAL_BODY = "şçğ unicode body";

async function main(): Promise<void> {
  const bucket = env("GCS_BUCKET");
  const token = env("GCS_BEARER");
  const salt = newSalt();
  const cryptor = await PassphraseCryptor.fromPassphrase("e2e-passphrase", salt, 50_000);
  const provider = (): GcsProvider =>
    new GcsProvider({ bucket, prefix: "e2e", endpoint: GCS_ENDPOINT }, bearerAuthorizer(() => token), nodeHttpSend);

  const A = await fs.mkdtemp(path.join(os.tmpdir(), "gsync-A-"));
  const B = await fs.mkdtemp(path.join(os.tmpdir(), "gsync-B-"));
  const engA = new SyncEngine(new NodeLocalStore(A), provider(), cryptor, () => new Date());
  const engB = new SyncEngine(new NodeLocalStore(B), provider(), cryptor, () => new Date());
  let stateA: SyncStateData = {};
  let stateB: SyncStateData = {};

  try {
    // device A: a plain file, a special-char/unicode file, and a deeply nested file
    await fs.writeFile(path.join(A, "a.md"), "alpha");
    await fs.mkdir(path.join(A, "My Notes"), { recursive: true });
    await fs.writeFile(path.join(A, SPECIAL), SPECIAL_BODY);
    await fs.mkdir(path.join(A, "sub", "deep"), { recursive: true });
    await fs.writeFile(path.join(A, "sub/deep/x.md"), "deep");

    let a = await engA.sync(stateA);
    stateA = a.state;
    check("A → GCS: 3 uploaded, 0 errors", a.report.uploaded.length === 3 && a.report.errors.length === 0);

    // raw read (through the provider, NOT the cryptor) — content should be ciphertext
    const raw = await provider().get(SPECIAL);
    check("special-char key round-trips on real GCS", raw !== null);
    check("stored object is E2EE ciphertext (not plaintext)", raw !== null && txt(raw) !== SPECIAL_BODY);

    // device B: fresh vault, pulls everything
    let b = await engB.sync(stateB);
    stateB = b.state;
    check("B ← GCS: 3 downloaded", b.report.downloaded.length === 3 && b.report.errors.length === 0);
    check("B decrypts the special-char/unicode file", (await fs.readFile(path.join(B, SPECIAL), "utf8")) === SPECIAL_BODY);
    check("B recreated nested folders", (await fs.readFile(path.join(B, "sub/deep/x.md"), "utf8")) === "deep");

    // modify on A → propagate to B
    await fs.writeFile(path.join(A, "a.md"), "alpha-v2");
    a = await engA.sync(stateA);
    stateA = a.state;
    b = await engB.sync(stateB);
    stateB = b.state;
    check("modify on A propagates to B", b.report.downloaded.includes("a.md") && (await fs.readFile(path.join(B, "a.md"), "utf8")) === "alpha-v2");

    // delete on A → propagate to B
    await fs.rm(path.join(A, "a.md"));
    a = await engA.sync(stateA);
    stateA = a.state;
    b = await engB.sync(stateB);
    stateB = b.state;
    const bHasA = await fs.access(path.join(B, "a.md")).then(() => true, () => false);
    check("delete on A propagates to B", b.report.deletedLocal.includes("a.md") && !bHasA);

    // steady state: nothing to do
    const noop = await engA.sync(stateA);
    check("A re-sync is a no-op", noop.report.uploaded.length === 0 && noop.report.downloaded.length === 0 && noop.report.conflicts.length === 0);
  } finally {
    await fs.rm(A, { recursive: true, force: true });
    await fs.rm(B, { recursive: true, force: true });
  }

  console.log(`\n=== e2e GCS: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("e2e crashed:", (e as Error).message);
  process.exitCode = 1;
});
