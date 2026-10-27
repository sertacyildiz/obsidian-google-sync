export interface HashCacheEntry {
  mtime: number;
  size: number;
  hash: string;
}

/**
 * Content hashes by path, trusted only while a file's mtime AND size are both
 * unchanged. Used on mobile, where every `readBinary` crosses the native bridge:
 * without it each sync reads and hashes the whole vault, which on a phone with
 * attachments costs seconds to minutes and battery. Desktop does not use it.
 *
 * mtime+size alone could, in theory, miss an edit that preserved both; the
 * plugin therefore also evicts a path on every vault modify/delete/rename event,
 * so anything Obsidian sees change is re-read regardless of its stat.
 *
 * Each eviction bumps the path's generation. A reader takes the generation
 * before it reads and passes it to {@link remember}, which refuses if it moved:
 * an edit saved while the read was in flight must never be cached under the old
 * content's hash, because that hash matches the baseline — the edit would never
 * upload, and a later remote change would overwrite it without a conflict copy.
 */
export class HashCache {
  private readonly entries = new Map<string, HashCacheEntry>();
  private readonly generations = new Map<string, number>();
  private changed = false;

  /** `entries` is untrusted (read back from disk): anything not shaped like an entry is dropped. */
  constructor(entries?: Record<string, HashCacheEntry>) {
    for (const [path, e] of Object.entries(entries ?? {})) {
      if (e && typeof e.mtime === "number" && typeof e.size === "number" && typeof e.hash === "string") {
        this.entries.set(path, { mtime: e.mtime, size: e.size, hash: e.hash });
      }
    }
  }

  /** True when there is something new to save. */
  get dirty(): boolean {
    return this.changed;
  }

  lookup(path: string, mtime: number, size: number): string | undefined {
    const e = this.entries.get(path);
    return e && e.mtime === mtime && e.size === size ? e.hash : undefined;
  }

  /** Take before reading a file; hand back to {@link remember}. */
  generation(path: string): number {
    return this.generations.get(path) ?? 0;
  }

  /** Record a hash — unless `generation` is given and the path was evicted since it was taken. */
  remember(path: string, mtime: number, size: number, hash: string, generation?: number): void {
    if (generation !== undefined && generation !== this.generation(path)) return;
    this.entries.set(path, { mtime, size, hash });
    this.changed = true;
  }

  forget(path: string): void {
    this.generations.set(path, this.generation(path) + 1);
    if (this.entries.delete(path)) this.changed = true;
  }

  /** Drop every entry whose path was not just listed (deleted or moved out of scope). */
  retainOnly(paths: Iterable<string>): void {
    const keep = new Set(paths);
    for (const path of [...this.entries.keys()]) {
      if (!keep.has(path)) {
        this.entries.delete(path);
        this.changed = true;
      }
    }
  }

  markSaved(): void {
    this.changed = false;
  }

  toJSON(): Record<string, HashCacheEntry> {
    return Object.fromEntries(this.entries);
  }
}
