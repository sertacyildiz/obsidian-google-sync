import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { LocalStore } from "../sync/LocalStore";
import { LocalFile } from "../sync/types";
import { sha256Hex } from "../util/hash";
import { HashCache } from "./HashCache";

/**
 * Mobile: how many files a listing reads at once. A cold first sync otherwise
 * reads every file in the vault concurrently, and on a phone holding all of that
 * in memory can get Obsidian killed before the sync gets anywhere.
 */
export const MOBILE_MAX_CONCURRENT_READS = 4;

/**
 * LocalStore backed by the Obsidian Vault adapter. Lists files within the
 * configured scope folder, ALWAYS excluding the vault config dir (`.obsidian`)
 * so the plugin's own (sealed) credentials are never part of the synced set.
 * With a {@link HashCache} (mobile), unchanged files are not re-read to hash.
 */
export class ObsidianLocalStore implements LocalStore {
  constructor(
    private readonly app: App,
    private readonly scopeFolder: string,
    private readonly cache?: HashCache,
    /** Reads in flight during {@link list}; unlimited unless set (desktop). */
    private readonly maxConcurrentReads = Infinity
  ) {}

  private inScope(path: string): boolean {
    const cfg = this.app.vault.configDir;
    if (path === cfg || path.startsWith(cfg + "/")) return false;
    const scope = this.scopeFolder.replace(/\/+$/, "");
    if (!scope) return true;
    return path === scope || path.startsWith(scope + "/");
  }

  /**
   * The files this sync may see.
   *
   * With a scope folder set, only that subtree is walked — paths elsewhere in the
   * vault are never enumerated, so the plugin genuinely never learns them. That
   * is the point of this method: narrow what is *read*, not just what is kept.
   *
   * Without a scope the user has asked to sync the whole vault, and that cannot
   * be done without listing the whole vault. `getFiles()` is called openly for
   * that case rather than reaching the same breadth by recursing from the vault
   * root, which would hide the access from readers without narrowing it.
   */
  private filesInScope(): TFile[] {
    const scope = this.scopeFolder.replace(/\/+$/, "");
    if (!scope) return this.app.vault.getFiles().filter((f) => this.inScope(f.path));

    // A scope naming a single file syncs exactly that file — preserves what the
    // previous prefix match (`path === scope`) accepted.
    const asFile = this.app.vault.getFileByPath(scope);
    if (asFile) return this.inScope(asFile.path) ? [asFile] : [];

    const root = this.app.vault.getFolderByPath(scope);
    // A scope that does not exist syncs NOTHING. It must never widen to the whole
    // vault: that would leak every path and mass-upload the entire vault.
    if (!root) return [];

    // `instanceof` rather than a cast: Obsidian's own guidance is to check the
    // concrete type of a TAbstractFile before using it, and a cast would happily
    // treat a folder as a file and try to hash it.
    const found: TFile[] = [];
    const visit = (entry: TAbstractFile): void => {
      if (entry instanceof TFolder) {
        for (const child of entry.children) visit(child);
      } else if (entry instanceof TFile && this.inScope(entry.path)) {
        found.push(entry);
      }
    };
    visit(root);
    return found;
  }

  async list(): Promise<LocalFile[]> {
    const files = this.filesInScope();
    const listed = await mapLimited(files, this.maxConcurrentReads, (f) => this.describe(f));
    this.cache?.retainOnly(files.map((f) => f.path));
    return listed;
  }

  /**
   * Hash one file. `f.stat` is live — Obsidian updates it when the user saves —
   * so it is snapshotted before the read, and the hash is paired with (and cached
   * under) that snapshot only. An edit saved while the read is in flight changes
   * the stat or evicts the path; either way nothing is cached and the next
   * listing reads the file again.
   */
  private async describe(f: TFile): Promise<LocalFile> {
    const { mtime, size } = f.stat;
    const cached = this.cache?.lookup(f.path, mtime, size);
    if (cached !== undefined) return { path: f.path, hash: cached, mtime };
    const generation = this.cache?.generation(f.path);
    const hash = await sha256Hex(await this.app.vault.adapter.readBinary(f.path));
    if (f.stat.mtime === mtime && f.stat.size === size) this.cache?.remember(f.path, mtime, size, hash, generation);
    return { path: f.path, hash, mtime };
  }

  read(path: string): Promise<ArrayBuffer> {
    return this.app.vault.adapter.readBinary(normalizePath(path));
  }

  async write(path: string, data: ArrayBuffer): Promise<void> {
    const p = normalizePath(path);
    const slash = p.lastIndexOf("/");
    if (slash > 0) await this.ensureDir(p.slice(0, slash));
    await this.app.vault.adapter.writeBinary(p, data);
    // Evict here rather than trusting Obsidian's modify event to arrive before the
    // next listing (with two backends, the second lists right after the first wrote).
    this.cache?.forget(p);
  }

  /** Create every missing ancestor folder (adapter.mkdir is not recursive). */
  private async ensureDir(dir: string): Promise<void> {
    let cur = "";
    for (const part of dir.split("/")) {
      if (!part) continue;
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(cur))) {
        await this.app.vault.adapter.mkdir(cur);
      }
    }
  }

  async delete(path: string): Promise<void> {
    const p = normalizePath(path);
    if (!(await this.app.vault.adapter.exists(p))) return;
    // NEVER hard-delete. Route through the trash so a wrong "remote deleted this"
    // conclusion is always recoverable. Prefer the OS trash; fall back to the
    // vault-local `.trash` if the system trash is unavailable or fails.
    const trashed = await this.app.vault.adapter.trashSystem(p).catch(() => false);
    if (!trashed) await this.app.vault.adapter.trashLocal(p);
    this.cache?.forget(p);
  }
}

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight; results keep input order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!(limit < items.length)) return Promise.all(items.map(fn));
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}
