/* Offline test: content E2EE across devices.
 *  - The salt lives on the remote (`.gsync-e2ee.json`), so every device derives the
 *    same key from the same passphrase; a fresh device can switch E2EE on, after
 *    confirming the passphrase once.
 *  - A wrong passphrase is refused before anything syncs; a remote with files but no
 *    header is never initialised over (unless every file opens with this device's
 *    pre-header salt); a header created concurrently by another device is adopted,
 *    not overwritten; a deleted header is restored from this device's copy; a
 *    damaged header is reported as damaged.
 *  - The sync engine never treats the header as a vault file.
 *  - Controllers sharing one bucket: a device with E2EE off refuses an encrypted
 *    folder; a key is only ever used for the folder it was derived for, and only
 *    while that folder's header still names its salt.
 * Run:
 *   npx esbuild scripts/e2ee-test.ts --bundle --platform=node --format=cjs \
 *     --alias:obsidian=./scripts/_mock-obsidian.ts --outfile=/tmp/e2ee.cjs && node /tmp/e2ee.cjs
 */
import { TFile, TFolder } from "obsidian";
import { E2EE_HEADER_PATH, unlockRemote } from "../src/crypto/e2eeHeader";
import { aesGcmDecrypt, aesGcmEncrypt, deriveAesKey } from "../src/crypto/aesgcm";
import { newSalt } from "../src/crypto/PassphraseCryptor";
import { base64Encode } from "../src/util/base64";
import { HttpResponse, HttpSend, PreconditionFailed, PutResult, RemoteObject, RemoteProvider } from "../src/providers/RemoteProvider";
import { SyncEngine } from "../src/sync/SyncEngine";
import { identityCryptor } from "../src/sync/Cryptor";
import { LocalStore } from "../src/sync/LocalStore";
import { LocalFile } from "../src/sync/types";
import { sha256Hex } from "../src/util/hash";
import { SyncController } from "../src/SyncController";
import { DEFAULT_SETTINGS, GoogleSyncSettings } from "../src/settings";

(globalThis as unknown as { window: unknown }).window = { setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {}, open: () => {} };

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};
const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);
const thrown = async (op: () => Promise<unknown>): Promise<string> => op().then(() => "", (e: Error) => e.message);
const ITER = 1000; // light work factor for tests; the header records whatever was used

class MemRemote implements RemoteProvider {
  readonly id = "mem";
  store = new Map<string, ArrayBuffer>();
  /** Test hook: runs right before a write lands (to stage a concurrent writer). */
  beforePut: ((path: string) => void) | null = null;
  private v = 0;
  async put(path: string, data: ArrayBuffer, _ct?: string, opts?: { ifAbsent?: boolean }): Promise<PutResult> {
    this.beforePut?.(path);
    if (opts?.ifAbsent && this.store.has(path)) throw new PreconditionFailed(path);
    this.store.set(path, data);
    return { version: String(++this.v) };
  }
  async get(path: string): Promise<ArrayBuffer | null> {
    return this.store.get(path) ?? null;
  }
  async head(path: string): Promise<RemoteObject | null> {
    const d = this.store.get(path);
    return d ? { path, version: "x", size: d.byteLength } : null;
  }
  async delete(path: string): Promise<void> {
    this.store.delete(path);
  }
  async list(prefix = ""): Promise<RemoteObject[]> {
    return [...this.store.keys()].filter((p) => !prefix || p.startsWith(prefix)).map((p) => ({ path: p, version: String(this.store.get(p)?.byteLength), size: 0 }));
  }
}

class MemLocal implements LocalStore {
  store = new Map<string, ArrayBuffer>();
  async list(): Promise<LocalFile[]> {
    return Promise.all([...this.store].map(async ([path, d]) => ({ path, hash: await sha256Hex(d), mtime: 1 })));
  }
  async read(path: string): Promise<ArrayBuffer> {
    return this.store.get(path) as ArrayBuffer;
  }
  async write(path: string, data: ArrayBuffer): Promise<void> {
    this.store.set(path, data);
  }
  async delete(path: string): Promise<void> {
    this.store.delete(path);
  }
}

async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  try {
    return dec(await aesGcmDecrypt(b, await aesGcmEncrypt(a, enc("same key?")))) === "same key?";
  } catch {
    return false;
  }
}

/** A tiny GCS XML API over a Map — enough for GcsProvider, incl. the create-only precondition. */
function fakeBucket(): { http: HttpSend; objects: Map<string, ArrayBuffer> } {
  const objects = new Map<string, ArrayBuffer>();
  let etag = 0;
  const res = (status: number, body: string | ArrayBuffer = "", headers: Record<string, string> = {}): HttpResponse => ({
    status,
    headers,
    text: async () => (typeof body === "string" ? body : dec(body)),
    arrayBuffer: async () => (typeof body === "string" ? enc(body) : body),
  });
  const http: HttpSend = async (method, url, headers, body) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.split("/").slice(2).join("/"));
    if (method === "GET" && !key) {
      const prefix = u.searchParams.get("prefix") ?? "";
      const rows = [...objects]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => `<Contents><Key>${k}</Key><ETag>"e${v.byteLength}-${k.length}"</ETag><Size>${v.byteLength}</Size></Contents>`)
        .join("");
      return res(200, `<ListBucketResult>${rows}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    if (method === "PUT") {
      const ifGen = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-goog-if-generation-match")?.[1];
      if (ifGen === "0" && objects.has(key)) return res(412);
      objects.set(key, body as ArrayBuffer);
      return res(200, "", { etag: `"e${++etag}"` });
    }
    if (method === "GET" || method === "HEAD") return objects.has(key) ? res(200, method === "GET" ? (objects.get(key) as ArrayBuffer) : "") : res(404);
    if (method === "DELETE") return res(objects.delete(key) ? 204 : 404);
    return res(404);
  };
  return { http, objects };
}

/** One device: its own vault (files in memory) and its own data.json, sharing a bucket. */
function device(http: HttpSend, files: Record<string, string>, e2ee = true) {
  const tfiles = new Map<string, TFile>();
  const data = new Map<string, ArrayBuffer>();
  const root = new TFolder("");
  const add = (p: string, content: string) => {
    const f = new TFile(p, 1);
    f.stat.size = content.length;
    tfiles.set(p, f);
    data.set(p, enc(content));
    root.children.push(f);
  };
  for (const [p, c] of Object.entries(files)) add(p, c);
  const app = {
    vault: {
      configDir: ".obsidian",
      getName: () => "Vault",
      getFiles: () => [...tfiles.values()],
      getFileByPath: (p: string) => tfiles.get(p) ?? null,
      getFolderByPath: (p: string) => (p === "" ? root : null),
      adapter: {
        readBinary: async (p: string) => data.get(p) as ArrayBuffer,
        writeBinary: async (p: string, d: ArrayBuffer) => {
          if (!tfiles.has(p)) add(p, "");
          data.set(p, d);
        },
        exists: async (p: string) => data.has(p) || p === "",
        mkdir: async () => {},
        trashSystem: async () => true,
        trashLocal: async () => {},
      },
    },
  };
  const settings: GoogleSyncSettings = {
    ...DEFAULT_SETTINGS,
    syncState: {},
    backendLastSync: {},
    e2eeHeaders: {},
    gcsEnabled: true,
    bucket: "b",
    gcsAuthMode: "hmac",
    accessId: "GOOGTEST",
    gcsSecret: { enc: false, data: "secret" },
    e2ee,
  };
  const c = new SyncController(app as never, settings, async () => {}, http);
  return { c, settings, data };
}

async function main(): Promise<void> {
  console.log("Header: creating it (I5 — confirm once)");
  {
    const r = new MemRemote();
    check("empty remote, no confirmation → asks to confirm, writes nothing", (await thrown(() => unlockRemote(r, "pw", { iterations: ITER }))).includes("Confirm") && !r.store.has(E2EE_HEADER_PATH));
    check("confirmation that does not match → refused, writes nothing", (await thrown(() => unlockRemote(r, "pw", { iterations: ITER, confirm: "pW" }))).includes("match") && !r.store.has(E2EE_HEADER_PATH));
    const a = await unlockRemote(r, "pw", { iterations: ITER, confirm: "pw" });
    const text = dec(r.store.get(E2EE_HEADER_PATH) ?? enc("{}"));
    const json = JSON.parse(text) as Record<string, unknown>;
    check("confirmed → header written (v1, PBKDF2-SHA256, work factor, salt, check)", json.v === 1 && json.kdf === "PBKDF2-SHA256" && json.iterations === ITER && typeof json.salt === "string" && typeof json.check === "string");
    check("unlock returns the header text and its salt (for the local copy / per-sync check)", a.header === text && a.salt === json.salt);
    check("the header never contains the passphrase", !text.includes("\"pw\"") && !/"pw/.test(text));
    const b = await unlockRemote(r, "pw", { iterations: ITER });
    check("another device, same passphrase, no confirmation needed → same key", await sameKey(a.key, b.key));
    check("wrong passphrase → refused", (await thrown(() => unlockRemote(r, "nope", { iterations: ITER }))).includes("Wrong passphrase"));
  }

  console.log("Header: a remote with files but no header (I3, I4)");
  {
    const r = new MemRemote();
    await r.put("a.md", enc("plain text"));
    const msg = await thrown(() => unlockRemote(r, "pw", { iterations: ITER, confirm: "pw" }));
    check("no header, no copy, no legacy salt → refused, nothing written", msg !== "" && !r.store.has(E2EE_HEADER_PATH));
    check("…and the message does not claim a wrong passphrase", !msg.includes("Wrong passphrase") && msg.includes("header"));
  }
  {
    const salt = newSalt();
    const oldKey = await deriveAesKey("pw", salt, ITER);
    const r = new MemRemote();
    await r.put("a.md", await aesGcmEncrypt(oldKey, enc("secret a")));
    await r.put("b.md", await aesGcmEncrypt(oldKey, enc("secret b")));
    check("legacy, wrong passphrase → refused, no header", (await thrown(() => unlockRemote(r, "nope", { iterations: ITER, legacySalt: salt }))).includes("Wrong passphrase") && !r.store.has(E2EE_HEADER_PATH));
    const k = await unlockRemote(r, "pw", { iterations: ITER, legacySalt: salt });
    check("legacy, every file opens → adopted: old files still read, header carries the old salt", dec(await aesGcmDecrypt(k.key, (await r.get("b.md")) as ArrayBuffer)) === "secret b" && k.salt === base64Encode(salt));
    check("…and a new device then unlocks with it", await sameKey(k.key, (await unlockRemote(r, "pw", { iterations: ITER })).key));
  }
  {
    const salt = newSalt();
    const oldKey = await deriveAesKey("pw", salt, ITER);
    const r = new MemRemote();
    await r.put("a.md", await aesGcmEncrypt(oldKey, enc("secret a")));
    await r.put("plain.md", enc("written before E2EE was on"));
    const msg = await thrown(() => unlockRemote(r, "pw", { iterations: ITER, legacySalt: salt }));
    check("legacy, mixed remote → refused with what was found, not 'wrong passphrase'", msg.includes("not encrypted") && msg.includes("1") && !msg.includes("Wrong passphrase") && !r.store.has(E2EE_HEADER_PATH));
  }
  {
    const r = new MemRemote();
    const a = await unlockRemote(r, "pw", { iterations: ITER, confirm: "pw" });
    await r.put("n.md", await aesGcmEncrypt(a.key, enc("n")));
    await r.delete(E2EE_HEADER_PATH);
    const restored = await unlockRemote(r, "pw", { iterations: ITER, localCopy: a.header });
    check("header deleted → restored from this device's copy, same key", r.store.has(E2EE_HEADER_PATH) && (await sameKey(a.key, restored.key)));
    await r.delete(E2EE_HEADER_PATH);
    check("…a copy does not open with a wrong passphrase → refused, nothing written", (await thrown(() => unlockRemote(r, "nope", { iterations: ITER, localCopy: a.header }))).includes("Wrong passphrase") && !r.store.has(E2EE_HEADER_PATH));
  }

  console.log("Header: two devices creating it at once (I2)");
  {
    const r = new MemRemote();
    const first = await unlockRemote(new MemRemote(), "pw", { iterations: ITER, confirm: "pw" }); // device A's header, staged below
    r.beforePut = (p) => {
      if (p === E2EE_HEADER_PATH && !r.store.has(p)) r.store.set(p, enc(first.header)); // A's write lands first
    };
    const b = await unlockRemote(r, "pw", { iterations: ITER, confirm: "pw" });
    check("B does not overwrite A's header and adopts it — both on one key", dec(r.store.get(E2EE_HEADER_PATH) as ArrayBuffer) === first.header && (await sameKey(first.key, b.key)));
  }

  console.log("Header: damaged (M1)");
  {
    const damaged = async (h: string) => {
      const r = new MemRemote();
      await r.put(E2EE_HEADER_PATH, enc(h));
      return thrown(() => unlockRemote(r, "pw", { iterations: ITER }));
    };
    const good = JSON.parse((await unlockRemote(new MemRemote(), "pw", { iterations: ITER, confirm: "pw" })).header) as Record<string, unknown>;
    check("not JSON → 'damaged'", (await damaged("{not json")).includes("damaged"));
    check("absurd work factor (a 10-billion-round hang) → 'damaged'", (await damaged(JSON.stringify({ ...good, iterations: 1e10 }))).includes("damaged"));
    check("short salt → 'damaged'", (await damaged(JSON.stringify({ ...good, salt: "AAAA" }))).includes("damaged"));
  }

  console.log("Sync engine never treats the header as a vault file");
  {
    const L = new MemLocal();
    const R = new MemRemote();
    await R.put(E2EE_HEADER_PATH, enc("{}"));
    await R.put("n.md", enc("n"));
    L.store.set(".gsync-e2ee.json", enc("local impostor"));
    const { report } = await new SyncEngine(L, R, identityCryptor, () => new Date(0)).sync({});
    check("remote header is not downloaded", !report.downloaded.includes(E2EE_HEADER_PATH) && report.downloaded.includes("n.md"));
    check("a local file with the header's name is not uploaded over it", !report.uploaded.includes(".gsync-e2ee.json") && dec(R.store.get(E2EE_HEADER_PATH) as ArrayBuffer) === "{}");
  }

  console.log("Controllers sharing one bucket");
  {
    const bucket = fakeBucket();
    const a = device(bucket.http, { "note.md": "written on device A" });
    await a.c.prepare("correct horse", "correct horse");
    check("fresh device: E2EE unlocks after confirming", a.c.ready === true);
    check("the header text is kept as a local copy for this folder", Object.values(a.settings.e2eeHeaders).some((h) => h.includes("PBKDF2-SHA256")));
    await a.c.sync();
    const stored = [...bucket.objects].find(([k]) => k.endsWith("note.md"))?.[1];
    check("uploaded content is ciphertext", !!stored && !dec(stored).includes("written on device A"));

    const b = device(bucket.http, {});
    await b.c.prepare("correct horse");
    check("second fresh device, same passphrase (no confirmation): unlocks", b.c.ready === true);
    await b.c.sync();
    check("second device downloads and decrypts the note; header stays out of its vault", dec(b.data.get("note.md") ?? enc("")) === "written on device A" && !b.data.has(E2EE_HEADER_PATH));

    const third = device(bucket.http, {});
    check("wrong passphrase on a third device: refused, stays locked", (await thrown(() => third.c.prepare("wrong horse"))).includes("Wrong passphrase") && third.c.ready === false);

    // C1 — a device with E2EE off must not touch an encrypted folder.
    const off = device(bucket.http, { "mine.md": "B plaintext secret" }, false);
    await off.c.prepare();
    const before = new Map(bucket.objects);
    const offMsg = await thrown(() => off.c.sync());
    check("E2EE off + encrypted folder → sync refused", offMsg.includes("end-to-end encrypted"));
    check("…nothing uploaded in plaintext, nothing written into its vault", bucket.objects.size === before.size && ![...bucket.objects.values()].some((v) => dec(v).includes("B plaintext secret")) && dec(off.data.get("mine.md") as ArrayBuffer) === "B plaintext secret" && !off.data.has("note.md"));

    // I1 — a key belongs to the folder it was derived for.
    a.settings.prefix = "moved";
    const movedMsg = await thrown(() => a.c.sync());
    check("folder changed while unlocked → refused until unlocked for the new folder", movedMsg.includes("Unlock") && ![...bucket.objects.keys()].some((k) => k.startsWith("moved/")));
    a.settings.prefix = "";

    // I1/I2/I4 — before each sync the header must still name this key's salt.
    const headerKey = [...bucket.objects.keys()].find((k) => k.endsWith(E2EE_HEADER_PATH)) as string;
    const original = bucket.objects.get(headerKey) as ArrayBuffer;
    const other = await unlockRemote(new MemRemote(), "correct horse", { iterations: ITER, confirm: "correct horse" });
    bucket.objects.set(headerKey, enc(other.header)); // another device re-initialised the folder
    const changedMsg = await thrown(() => a.c.sync());
    check("header now names another salt → sync refused, key dropped", changedMsg.includes("Unlock") && a.c.ready === false);
    bucket.objects.set(headerKey, original);
    bucket.objects.delete(headerKey);
    await a.c.prepare("correct horse");
    check("header deleted → Unlock restores it from the local copy", bucket.objects.has(headerKey) && a.c.ready === true);
  }

  console.log(`\n=== e2ee: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("e2ee test crashed:", (e as Error).message);
  process.exitCode = 1;
});
