import { PutResult, RemoteObject, RemoteProvider } from "../providers/RemoteProvider";
import { conflictPath, safeVaultPath } from "../util/paths";
import { sha256Hex } from "../util/hash";
import { Cryptor } from "./Cryptor";
import { LocalStore } from "./LocalStore";
import { FileState, LocalFile, SyncReport, SyncStateData } from "./types";

/**
 * Provider-agnostic two-way sync via a three-way merge (local vs remote vs the
 * last-synced baseline `state`). Conflict policy is **never lose data**:
 *  - modify/modify (or new-on-both): keep both — write remote as a
 *    `<name>.conflict-<utc>` copy locally, keep local as canonical, upload local.
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
    private readonly scope: string = ""
  ) {}

  async sync(prev: SyncStateData): Promise<{ state: SyncStateData; report: SyncReport }> {
    const [localList, remoteList] = await Promise.all([this.local.list(), this.remote.list(this.scope)]);
    const localMap = new Map<string, LocalFile>(localList.map((f) => [f.path, f]));
    const remoteMap = new Map<string, RemoteObject>(remoteList.map((o) => [o.path, o]));

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

    // modify/modify (or new-on-both): keep both.
    if (L && R && localChanged && remoteChanged) {
      const remoteBytes = await this.remote.get(path);
      if (remoteBytes) {
        const plain = await this.cryptor.decrypt(remoteBytes);
        const cp = safeVaultPath(conflictPath(path, this.stamp()));
        await this.local.write(cp, plain);
        report.conflicts.push({ path, conflictPath: cp });
      }
      await this.upload(path, L, state, report);
      return;
    }

    if (localChanged && !remoteChanged) {
      if (L) await this.upload(path, L, state, report);
      else await this.deleteRemote(path, state, report);
      return;
    }

    if (!localChanged && remoteChanged) {
      if (R) await this.download(path, R, state, report);
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
