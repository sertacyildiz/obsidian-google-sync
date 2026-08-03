import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { LocalStore } from "../sync/LocalStore";
import { LocalFile } from "../sync/types";
import { sha256Hex } from "../util/hash";

/** A folder carries `children`; a file does not. Avoids `instanceof`, which ties tests to real Obsidian classes. */
function isFolder(entry: TAbstractFile): entry is TFolder {
  return Array.isArray((entry as TFolder).children);
}

/**
 * LocalStore backed by the Obsidian Vault adapter. Lists files within the
 * configured scope folder, ALWAYS excluding the vault config dir (`.obsidian`)
 * so the plugin's own (sealed) credentials are never part of the synced set.
 */
export class ObsidianLocalStore implements LocalStore {
  constructor(private readonly app: App, private readonly scopeFolder: string) {}

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

    const found: TFile[] = [];
    const visit = (entry: TAbstractFile): void => {
      if (isFolder(entry)) {
        for (const child of entry.children) visit(child);
        return;
      }
      if (this.inScope(entry.path)) found.push(entry as TFile);
    };
    visit(root);
    return found;
  }

  async list(): Promise<LocalFile[]> {
    return Promise.all(
      this.filesInScope().map(async (f) => ({
        path: f.path,
        hash: await sha256Hex(await this.app.vault.adapter.readBinary(f.path)),
        mtime: f.stat.mtime,
      }))
    );
  }

  read(path: string): Promise<ArrayBuffer> {
    return this.app.vault.adapter.readBinary(normalizePath(path));
  }

  async write(path: string, data: ArrayBuffer): Promise<void> {
    const p = normalizePath(path);
    const slash = p.lastIndexOf("/");
    if (slash > 0) await this.ensureDir(p.slice(0, slash));
    await this.app.vault.adapter.writeBinary(p, data);
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
  }
}
