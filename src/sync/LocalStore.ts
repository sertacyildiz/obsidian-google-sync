import { LocalFile } from "./types";

/**
 * The local side of a sync (a vault, or a chosen subfolder). The Obsidian
 * implementation wraps the Vault/DataAdapter API; tests use an in-memory fake.
 * Implementations apply `normalizePath()` and stay within the sync scope.
 */
export interface LocalStore {
  /** All files in scope, with content hashes. Excludes the plugin's own config. */
  list(): Promise<LocalFile[]>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer): Promise<void>;
  delete(path: string): Promise<void>;
}
