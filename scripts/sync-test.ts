/*
 * Offline test of the SyncEngine with in-memory LocalStore + RemoteProvider
 * fakes. No network, no credentials. Covers upload/download/noop/modify/delete/
 * conflict/path-traversal. Run: sh scripts/run-pilot.sh scripts/sync-test.ts
 */
import { SyncEngine } from "../src/sync/SyncEngine";
import { identityCryptor } from "../src/sync/Cryptor";
import { LocalStore } from "../src/sync/LocalStore";
import { LocalFile } from "../src/sync/types";
import { PutResult, RemoteObject, RemoteProvider } from "../src/providers/RemoteProvider";
import { sha256Hex } from "../src/util/hash";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);
const FIXED = (): Date => new Date("2026-02-03T04:05:06Z");

class FakeRemote implements RemoteProvider {
  readonly id = "fake";
  store = new Map<string, { data: ArrayBuffer; version: number }>();
  private v = 0;
  async put(path: string, data: ArrayBuffer): Promise<PutResult> {
    this.v++;
    this.store.set(path, { data, version: this.v });
    return { version: String(this.v) };
  }
  async get(path: string): Promise<ArrayBuffer | null> {
    return this.store.get(path)?.data ?? null;
  }
  async head(path: string): Promise<RemoteObject | null> {
    const e = this.store.get(path);
    return e ? { path, version: String(e.version), size: e.data.byteLength } : null;
  }
  async delete(path: string): Promise<void> {
    this.store.delete(path);
  }
  async list(prefix = ""): Promise<RemoteObject[]> {
    return [...this.store.entries()]
      .filter(([path]) => !prefix || path.startsWith(prefix))
      .map(([path, e]) => ({ path, version: String(e.version), size: e.data.byteLength }));
  }
}

class FakeLocal implements LocalStore {
  store = new Map<string, ArrayBuffer>();
  private mt = new Map<string, number>();
  private clock = 0;
  async list(): Promise<LocalFile[]> {
    return Promise.all(
      [...this.store.entries()].map(async ([path, data]) => ({ path, hash: await sha256Hex(data), mtime: this.mt.get(path) ?? 0 }))
    );
  }
  async read(path: string): Promise<ArrayBuffer> {
    const d = this.store.get(path);
    if (!d) throw new Error("not found: " + path);
    return d;
  }
  async write(path: string, data: ArrayBuffer): Promise<void> {
    this.store.set(path, data);
    this.mt.set(path, ++this.clock);
  }
  async delete(path: string): Promise<void> {
    this.store.delete(path);
    this.mt.delete(path);
  }
}

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}
const newEngine = (L: FakeLocal, R: FakeRemote) => new SyncEngine(L, R, identityCryptor, FIXED);

async function main(): Promise<void> {
  // 1. fresh local -> upload
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("hello"));
    const { state, report } = await newEngine(L, R).sync({});
    check("fresh local uploads", report.uploaded.includes("a.md") && dec(R.store.get("a.md")!.data) === "hello");
    check("state recorded after upload", !!state["a.md"]?.remoteVersion);
  }
  // 2. fresh remote -> download
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await R.put("b.md", enc("world"));
    const { report } = await newEngine(L, R).sync({});
    check("fresh remote downloads", report.downloaded.includes("b.md") && dec(L.store.get("b.md")!) === "world");
  }
  // 3. unchanged -> noop
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("x"));
    const s1 = (await newEngine(L, R).sync({})).state;
    const { report } = await newEngine(L, R).sync(s1);
    check("unchanged is noop", report.uploaded.length === 0 && report.downloaded.length === 0 && report.conflicts.length === 0);
  }
  // 4. local modified -> re-upload
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("v1"));
    const s1 = (await newEngine(L, R).sync({})).state;
    await L.write("a.md", enc("v2"));
    const { report } = await newEngine(L, R).sync(s1);
    check("local modify re-uploads", report.uploaded.includes("a.md") && dec(R.store.get("a.md")!.data) === "v2");
  }
  // 5. remote modified -> download
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("v1"));
    const s1 = (await newEngine(L, R).sync({})).state;
    await R.put("a.md", enc("remoteV2"));
    const { report } = await newEngine(L, R).sync(s1);
    check("remote modify downloads", report.downloaded.includes("a.md") && dec(L.store.get("a.md")!) === "remoteV2");
  }
  // 6. local delete -> delete remote
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("x"));
    const s1 = (await newEngine(L, R).sync({})).state;
    await L.delete("a.md");
    const { state, report } = await newEngine(L, R).sync(s1);
    check("local delete propagates to remote", report.deletedRemote.includes("a.md") && !R.store.has("a.md") && !state["a.md"]);
  }
  // 7. remote delete -> delete local
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("x"));
    const s1 = (await newEngine(L, R).sync({})).state;
    await R.delete("a.md");
    const { report } = await newEngine(L, R).sync(s1);
    check("remote delete propagates to local", report.deletedLocal.includes("a.md") && !L.store.has("a.md"));
  }
  // 8. both modified -> conflict (keep both)
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("base"));
    const s1 = (await newEngine(L, R).sync({})).state;
    await L.write("a.md", enc("localEdit"));
    await R.put("a.md", enc("remoteEdit"));
    const { report } = await newEngine(L, R).sync(s1);
    const cp = report.conflicts[0]?.conflictPath;
    check("conflict recorded once", report.conflicts.length === 1 && !!cp);
    check("conflict keeps remote copy locally", !!cp && dec(L.store.get(cp)!) === "remoteEdit");
    check("conflict keeps local as canonical (local + remote)", dec(L.store.get("a.md")!) === "localEdit" && dec(R.store.get("a.md")!.data) === "localEdit");
    check("conflict copy name carries the stamp", !!cp && cp.includes(".conflict-20260203T040506Z"));
  }
  // 9. path traversal in remote -> error, nothing written outside
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await R.put("../evil.md", enc("pwn"));
    const { report } = await newEngine(L, R).sync({});
    check("path traversal rejected + recorded", report.errors.some((e) => e.path === "../evil.md") && !L.store.has("../evil.md"));
  }

  // 10. scope: remote listing is scoped — engine never pulls out-of-scope remote files
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await R.put("Notes/in.md", enc("x"));
    await R.put("Other/out.md", enc("y"));
    const { report } = await new SyncEngine(L, R, identityCryptor, FIXED, "Notes").sync({});
    check(
      "scoped sync only touches in-scope remote",
      report.downloaded.includes("Notes/in.md") &&
        !report.downloaded.includes("Other/out.md") &&
        L.store.has("Notes/in.md") &&
        !L.store.has("Other/out.md")
    );
  }

  console.log(`\n=== sync engine: ${failed === 0 ? "ALL PASS" : failed + " FAILED"} (${passed} passed) ===`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("sync-test crashed:", (e as Error).message);
  process.exitCode = 1;
});
