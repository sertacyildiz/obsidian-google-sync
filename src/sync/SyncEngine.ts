import { PutResult, RemoteObject, RemoteProvider } from "../providers/RemoteProvider";
import { conflictPath, safeVaultPath } from "../util/paths";
import { sha256Hex } from "../util/hash";
import { Cryptor } from "./Cryptor";
import { LocalStore } from "./LocalStore";
import { FileState, LocalFile, SyncReport, SyncStateData } from "./types";

/**
 * Thrown by {@link SyncEngine.sync} when a single sync would delete more files
 * than the safety guard allows — almost always a sign of a bad/empty listing
 * (auth glitch, wrong remote folder) rather than a genuine mass delete. The sync
 * is aborted with NOTHING changed, so the condition is recoverable.
 */
export class MassDeletionAbort extends Error {
  constructor(
    readonly localDeletes: number,
    readonly remoteDeletes: number,
    readonly limit: number
  ) {
    super(
      `Sync aborted for safety: it would delete ${localDeletes} local and ${remoteDeletes} remote file(s) at once ` +
        `(limit ${limit}). This usually means the other side listed empty or wrong, not a real mass delete. ` +
        `Nothing was changed — check the connection/folder, then sync again.`
    );
    this.name = "MassDeletionAbort";
  }
}

/** Default delete guard: allow up to max(10, 20% of tracked files) deletions per side, per sync. */
export const defaultDeleteGuard = (trackedCount: number): number => Math.max(10, Math.ceil(trackedCount * 0.2));

/**
 * Provider-agnostic two-way sync via a three-way merge (local vs remote vs the
 * last-synced baseline `state`). Conflict policy is **never lose data**:
 *  - modify/modify (or new-on-both, e.g. the first sync of an already-populated
 *    vault on a new device): if both sides hold identical content it is NOT a
 *    conflict — adopt the baseline silently. Otherwise the newer side (by mtime)
 *    becomes the canonical file and the older one is kept as a recoverable
 *    `<name>.conflict-<utc>` copy. When the remote mtime is unknown the local
 *    side wins (a safe default — the remote mtime is its upload time, which can
 *    lag the real edit time).
 *  - local-deleted vs remote-modified: restore (download).
 *  - local-modified vs remote-deleted: re-upload (local wins).
 * Deletions propagate via the baseline (a path in `state` but missing on one
 * side = deleted there). Content passes through the injected `Cryptor`.
 */
export class SyncEngine {
  constructor(
    private readonly local: LocalStore,
    private readonly remote: RemoteProvider,
    private readonly cryptor: Cryptor,
    private readonly now: () => Date,
    /** Sync-root-relative prefix; remote listing is scoped to it (local is scoped by the LocalStore). */
    private readonly scope: string = "",
    /** Protect local: a file missing on the remote is re-uploaded, never deleted locally. */
    private readonly protectLocal: boolean = false,
    /** Abort the whole sync if it would delete more than this many files on either side. */
    private readonly deleteGuard: (trackedCount: number) => number = defaultDeleteGuard
  ) {}

  async sync(prev: SyncStateData): Promise<{ state: SyncStateData; report: SyncReport }> {
    const [localList, remoteList] = await Promise.all([this.local.list(), this.remote.list(this.scope)]);
    const localMap = new Map<string, LocalFile>(localList.map((f) => [f.path, f]));
    const remoteMap = new Map<string, RemoteObject>(remoteList.map((o) => [o.path, o]));

    // Safety guard — runs BEFORE anything is applied. A correct sync deletes a
    // file only when it was synced before (present in `prev`), is unchanged on
    // the surviving side, and has vanished from the other side. If that count is
    // implausibly large it almost always means a bad/empty listing (auth glitch,
    // wrong folder), not a real mass delete — so abort the whole sync untouched.
    let plannedLocalDeletes = 0;
    let plannedRemoteDeletes = 0;
    for (const path of Object.keys(prev)) {
      const S = prev[path];
      const L = localMap.get(path);
      const R = remoteMap.get(path);
      if (!this.protectLocal && L && L.hash === S.localHash && !R) plannedLocalDeletes++;
      if (!L && R && R.version === S.remoteVersion) plannedRemoteDeletes++;
    }
    const limit = this.deleteGuard(Object.keys(prev).length);
    if (plannedLocalDeletes > limit || plannedRemoteDeletes > limit) {
      throw new MassDeletionAbort(plannedLocalDeletes, plannedRemoteDeletes, limit);
    }

    const state: SyncStateData = { ...prev };
    const report: SyncReport = {
      uploaded: [],
      downloaded: [],
      deletedLocal: [],
      deletedRemote: [],
      conflicts: [],
      errors: [],
    };

    const paths = new Set<string>([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(prev)]);
    for (const path of paths) {
      try {
        await this.reconcile(path, localMap.get(path), remoteMap.get(path), prev[path], state, report);
      } catch (e) {
        report.errors.push({ path, error: (e as Error).message });
      }
    }
    return { state, report };
  }

  private async reconcile(
    path: string,
    L: LocalFile | undefined,
    R: RemoteObject | undefined,
    S: FileState | undefined,
    state: SyncStateData,
    report: SyncReport
  ): Promise<void> {
    const localChanged = L ? !S || L.hash !== S.localHash : !!S;
    const remoteChanged = R ? !S || R.version !== S.remoteVersion : !!S;

    if (!localChanged && !remoteChanged) {
      if (!L && !R) delete state[path];
      return;
    }

    // modify/modify (or new-on-both, e.g. first sync of a populated vault on a new device).
    if (L && R && localChanged && remoteChanged) {
      await this.resolveConflict(path, L, R, state, report);
      return;
    }

    if (localChanged && !remoteChanged) {
      if (L) await this.upload(path, L, state, report);
      else await this.deleteRemote(path, state, report);
      return;
    }

    if (!localChanged && remoteChanged) {
      if (R) await this.download(path, R, state, report);
      else if (this.protectLocal && L) await this.upload(path, L, state, report); // protect local: keep it, restore on remote
      else await this.deleteLocal(path, state, report);
      return;
    }

    // delete/modify conflicts — keep the surviving content (never lose data).
    if (L && !R) {
      await this.upload(path, L, state, report); // local modified, remote deleted
      return;
    }
    if (!L && R) {
      await this.download(path, R, state, report); // local deleted, remote modified
      return;
    }
    delete state[path]; // both deleted
  }

  /**
   * Both sides changed since the baseline (or there is no baseline yet). Resolve
   * without ever losing data:
   *  - identical content ⇒ not a conflict; adopt the baseline silently. This is
   *    the common case when an already-populated vault is first synced on a new
   *    device, where every co-existing file would otherwise look like a conflict.
   *  - otherwise the newer side (by mtime) becomes canonical and the older side
   *    is written as a recoverable `<name>.conflict-<utc>` copy. The remote mtime
   *    is its upload time and may be unknown; only when it is strictly newer than
   *    the local mtime does the remote win — otherwise the local side wins.
   */
  private async resolveConflict(
    path: string,
    L: LocalFile,
    R: RemoteObject,
    state: SyncStateData,
    report: SyncReport
  ): Promise<void> {
    const remoteBytes = await this.remote.get(path);
    if (remoteBytes === null) {
      await this.upload(path, L, state, report); // remote vanished mid-run; next sync reconciles
      return;
    }
    const remotePlain = await this.cryptor.decrypt(remoteBytes);
    const remoteHash = await sha256Hex(remotePlain);

    if (remoteHash === L.hash) {
      state[path] = { localHash: L.hash, remoteVersion: R.version }; // identical → adopt, no conflict
      return;
    }

    const cp = safeVaultPath(conflictPath(path, this.stamp()));
    if (R.mtime !== undefined && R.mtime > L.mtime) {
      // Remote is newer: it becomes canonical; back up the older local copy first.
      await this.local.write(cp, await this.local.read(path));
      await this.local.write(safeVaultPath(path), remotePlain);
      state[path] = { localHash: remoteHash, remoteVersion: R.version };
      report.downloaded.push(path);
      report.conflicts.push({ path, conflictPath: cp });
    } else {
      // Local is newer (or remote mtime unknown): local wins; back up the older remote copy.
      await this.local.write(cp, remotePlain);
      report.conflicts.push({ path, conflictPath: cp });
      await this.upload(path, L, state, report);
    }
  }

  private async upload(path: string, L: LocalFile, state: SyncStateData, report: SyncReport): Promise<void> {
    const plain = await this.local.read(path);
    const cipher = await this.cryptor.encrypt(plain);
    const res: PutResult = await this.remote.put(path, cipher);
    state[path] = { localHash: L.hash, remoteVersion: res.version };
    report.uploaded.push(path);
  }

  private async download(path: string, R: RemoteObject, state: SyncStateData, report: SyncReport): Promise<void> {
    const cipher = await this.remote.get(path);
    if (cipher === null) return; // vanished mid-run; next sync reconciles
    const plain = await this.cryptor.decrypt(cipher);
    await this.local.write(safeVaultPath(path), plain);
    state[path] = { localHash: await sha256Hex(plain), remoteVersion: R.version };
    report.downloaded.push(path);
  }

  private async deleteRemote(path: string, state: SyncStateData, report: SyncReport): Promise<void> {
    await this.remote.delete(path);
    delete state[path];
    report.deletedRemote.push(path);
  }

  private async deleteLocal(path: string, state: SyncStateData, report: SyncReport): Promise<void> {
    await this.local.delete(safeVaultPath(path));
    delete state[path];
    report.deletedLocal.push(path);
  }

  private stamp(): string {
    const d = this.now();
    const p = (n: number) => n.toString().padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }
}
