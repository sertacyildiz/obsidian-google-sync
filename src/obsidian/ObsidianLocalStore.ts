import { App, normalizePath } from "obsidian";
import { LocalStore } from "../sync/LocalStore";
import { LocalFile } from "../sync/types";
import { sha256Hex } from "../util/hash";

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

  async list(): Promise<LocalFile[]> {
    const files = this.app.vault.getFiles().filter((f) => this.inScope(f.path));
    return Promise.all(
      files.map(async (f) => ({
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
    if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
  }
}
