/**
 * Reject path traversal and normalize to a POSIX, vault-relative path.
 * Throws on any `..` segment so a malicious/maliformed remote key can never
 * cause a write outside the vault. (Obsidian's own normalizePath is applied
 * at the adapter boundary in the LocalStore implementation.)
 */
export function safeVaultPath(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const segs = norm.split("/");
  if (segs.some((s) => s === "..")) {
    throw new Error(`unsafe path (parent traversal): ${path}`);
  }
  return segs.filter((s) => s !== "." && s !== "").join("/");
}

/** Insert `.conflict-<stamp>` before the extension: a/b.md -> a/b.conflict-<stamp>.md */
export function conflictPath(path: string, stamp: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${base}.conflict-${stamp}${ext}`;
}
