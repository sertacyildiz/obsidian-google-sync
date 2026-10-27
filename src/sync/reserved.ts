/**
 * Files the plugin keeps at a remote root for itself (the E2EE header). They are
 * never vault content: the sync engine skips them on both sides, so a header is
 * not downloaded into the vault and a vault file of the same name never
 * overwrites it.
 */
export const RESERVED_PREFIX = ".gsync-";

export function isReservedPath(path: string): boolean {
  return path.startsWith(RESERVED_PREFIX);
}
