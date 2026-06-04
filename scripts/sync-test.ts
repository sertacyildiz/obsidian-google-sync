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
import { DEFAULT_SETTINGS } from "../src/settings";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);
const FIXED = (): Date => new Date("2026-02-03T04:05:06Z");

class FakeRemote implements RemoteProvider {
  readonly id = "fake";
  store = new Map<string, { data: ArrayBuffer; version: number; mtime?: number }>();
  private v = 0;
  async put(path: string, data: ArrayBuffer): Promise<PutResult> {
    this.v++;
    this.store.set(path, { data, version: this.v, mtime: this.v });
    return { version: String(this.v) };
  }
  /** Test hook: override an entry's last-modified time (undefined = provider didn't supply one). */
  setMtime(path: string, mtime: number | undefined): void {
    const e = this.store.get(path);
    if (e) e.mtime = mtime;
  }
  async get(path: string): Promise<ArrayBuffer | null> {
    return this.store.get(path)?.data ?? null;
  }
  async head(path: string): Promise<RemoteObject | null> {
    const e = this.store.get(path);
    return e ? { path, version: String(e.version), size: e.data.byteLength, mtime: e.mtime } : null;
  }
  async delete(path: string): Promise<void> {
    this.store.delete(path);
  }
  async list(prefix = ""): Promise<RemoteObject[]> {
    return [...this.store.entries()]
      .filter(([path]) => !prefix || path.startsWith(prefix))
      .map(([path, e]) => ({ path, version: String(e.version), size: e.data.byteLength, mtime: e.mtime }));
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
  /** Test hook: override a file's mtime so conflict-direction tests are deterministic. */
  setMtime(path: string, mtime: number): void {
    this.mt.set(path, mtime);
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
  // 7b. protect-local ON: remote delete keeps the local file + restores it on the remote (never deletes local)
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("keep"));
    const s1 = (await new SyncEngine(L, R, identityCryptor, FIXED, "", true).sync({})).state;
    await R.delete("a.md");
    const { report } = await new SyncEngine(L, R, identityCryptor, FIXED, "", true).sync(s1);
    check(
      "protect-local: remote delete keeps local + re-uploads (no local delete)",
      report.deletedLocal.length === 0 && L.store.has("a.md") && R.store.has("a.md") && report.uploaded.includes("a.md")
    );
  }
  // 7c. protect-local ON still propagates LOCAL deletes to the remote
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("x"));
    const s1 = (await new SyncEngine(L, R, identityCryptor, FIXED, "", true).sync({})).state;
    await L.delete("a.md");
    const { report } = await new SyncEngine(L, R, identityCryptor, FIXED, "", true).sync(s1);
    check("protect-local: local delete still removes from remote", report.deletedRemote.includes("a.md") && !R.store.has("a.md"));
  }
  // 8a. both modified, REMOTE newer -> remote wins as canonical, older local kept as backup
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("base"));
    const s1 = (await newEngine(L, R).sync({})).state;
    await L.write("a.md", enc("localEdit"));
    L.setMtime("a.md", 100);
    await R.put("a.md", enc("remoteEdit"));
    R.setMtime("a.md", 200); // remote is newer
    const { state, report } = await newEngine(L, R).sync(s1);
    const cp = report.conflicts[0]?.conflictPath;
    check("conflict (remote newer): recorded once with a stamped copy", report.conflicts.length === 1 && !!cp && cp.includes(".conflict-20260203T040506Z"));
    check("conflict (remote newer): remote wins as canonical (local content overwritten)", dec(L.store.get("a.md")!) === "remoteEdit");
    check("conflict (remote newer): older local kept as recoverable backup", !!cp && dec(L.store.get(cp)!) === "localEdit");
    check("conflict (remote newer): baseline adopts the remote version", state["a.md"]?.remoteVersion === String(R.store.get("a.md")!.version));
  }
  // 8b. both modified, LOCAL newer -> local wins as canonical (uploaded), older remote kept as backup
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("base"));
    const s1 = (await newEngine(L, R).sync({})).state;
    await L.write("a.md", enc("localEdit"));
    L.setMtime("a.md", 200); // local is newer
    await R.put("a.md", enc("remoteEdit"));
    R.setMtime("a.md", 100);
    const { report } = await newEngine(L, R).sync(s1);
    const cp = report.conflicts[0]?.conflictPath;
    check("conflict (local newer): recorded once", report.conflicts.length === 1 && !!cp);
    check("conflict (local newer): local wins as canonical (local + remote)", dec(L.store.get("a.md")!) === "localEdit" && dec(R.store.get("a.md")!.data) === "localEdit");
    check("conflict (local newer): older remote kept as recoverable backup", !!cp && dec(L.store.get(cp)!) === "remoteEdit");
  }
  // 8c. both "changed" vs baseline but content CONVERGED -> not a conflict; adopt silently
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("base"));
    const s1 = (await newEngine(L, R).sync({})).state;
    await L.write("a.md", enc("converged"));
    await R.put("a.md", enc("converged")); // both edited to the same content
    const { state, report } = await newEngine(L, R).sync(s1);
    check("identical content is NOT a conflict (no copy, no transfer)", report.conflicts.length === 0 && report.uploaded.length === 0 && report.downloaded.length === 0);
    check("identical content adopts the baseline", state["a.md"]?.localHash === (await sha256Hex(enc("converged"))));
  }
  // 8d. BOOTSTRAP (the reported bug): new device, empty baseline, SAME content on both sides -> no conflict
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("note.md", enc("note"));
    await R.put("note.md", enc("note")); // already on Drive, byte-identical
    const { state, report } = await newEngine(L, R).sync({}); // fresh device: no baseline
    check("bootstrap identical: no .conflict copy, no upload/download", report.conflicts.length === 0 && report.uploaded.length === 0 && report.downloaded.length === 0);
    check("bootstrap identical: baseline adopted so next sync is a noop", !!state["note.md"]?.localHash && !!state["note.md"]?.remoteVersion);
  }
  // 8e. BOOTSTRAP, differing content, remote newer -> remote (the newer copy) wins, old local backed up
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("note.md", enc("old local copy"));
    L.setMtime("note.md", 100);
    await R.put("note.md", enc("newer copy from other pc"));
    R.setMtime("note.md", 200);
    const { report } = await newEngine(L, R).sync({}); // no baseline
    const cp = report.conflicts[0]?.conflictPath;
    check("bootstrap differing (remote newer): newer remote wins", dec(L.store.get("note.md")!) === "newer copy from other pc");
    check("bootstrap differing (remote newer): old local kept as backup", !!cp && dec(L.store.get(cp)!) === "old local copy");
  }
  // 8f. both modified but REMOTE mtime unknown -> safe default: local wins, remote backed up
  {
    const L = new FakeLocal(), R = new FakeRemote();
    await L.write("a.md", enc("base"));
    const s1 = (await newEngine(L, R).sync({})).state;
    await L.write("a.md", enc("localEdit"));
    await R.put("a.md", enc("remoteEdit"));
    R.setMtime("a.md", undefined); // provider gave no modified time
    const { report } = await newEngine(L, R).sync(s1);
    const cp = report.conflicts[0]?.conflictPath;
    check("conflict (remote mtime unknown): local wins (safe default)", dec(L.store.get("a.md")!) === "localEdit" && dec(R.store.get("a.md")!.data) === "localEdit");
    check("conflict (remote mtime unknown): remote kept as backup", !!cp && dec(L.store.get(cp)!) === "remoteEdit");
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

  // 11. SAFETY: a sync that would mass-delete LOCAL files is aborted (bad/empty remote listing)
  {
    const L = new FakeLocal(), R = new FakeRemote();
    for (let i = 0; i < 15; i++) await L.write(`f${i}.md`, enc("v" + i));
    const s1 = (await newEngine(L, R).sync({})).state; // 15 files synced on both sides
    for (let i = 0; i < 15; i++) await R.delete(`f${i}.md`); // remote listing comes back empty
    let aborted = false;
    try { await newEngine(L, R).sync(s1); } catch (e) { aborted = (e as Error).name === "MassDeletionAbort"; }
    check("mass LOCAL deletion is aborted — nothing deleted locally", aborted && (await L.list()).length === 15);
  }
  // 12. SAFETY: a sync that would mass-delete REMOTE files is aborted (local listing glitched empty)
  {
    const L = new FakeLocal(), R = new FakeRemote();
    for (let i = 0; i < 15; i++) await L.write(`f${i}.md`, enc("v" + i));
    const s1 = (await newEngine(L, R).sync({})).state;
    for (let i = 0; i < 15; i++) await L.delete(`f${i}.md`); // local vanished (e.g. adapter glitch)
    let aborted = false;
    try { await newEngine(L, R).sync(s1); } catch (e) { aborted = (e as Error).name === "MassDeletionAbort"; }
    check("mass REMOTE deletion is aborted — nothing deleted on remote", aborted && R.store.size === 15);
  }
  // 13. a deletion UNDER the safety limit still propagates normally (guard must not over-block)
  {
    const L = new FakeLocal(), R = new FakeRemote();
    for (let i = 0; i < 15; i++) await L.write(`f${i}.md`, enc("v" + i));
    const s1 = (await newEngine(L, R).sync({})).state;
    await R.delete("f0.md");
    const { report } = await newEngine(L, R).sync(s1);
    check("a small deletion under the guard still deletes locally", report.deletedLocal.includes("f0.md") && !L.store.has("f0.md"));
  }
  // 14. protect-local defaults OFF — multi-device deletes propagate; safety comes from the guard + trash, not from never-deleting
  check("protect-local defaults OFF for both backends", DEFAULT_SETTINGS.driveProtectLocal === false && DEFAULT_SETTINGS.gcsProtectLocal === false);

  console.log(`\n=== sync engine: ${failed === 0 ? "ALL PASS" : failed + " FAILED"} (${passed} passed) ===`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("sync-test crashed:", (e as Error).message);
  process.exitCode = 1;
});
