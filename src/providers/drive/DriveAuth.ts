/**
 * Drive-specific OAuth scope. The provider-neutral OAuth machinery (auth URL,
 * code exchange, token refresh, `TokenSet`) lives in `../google/oauth`.
 */
export type DriveScopeLevel = "file" | "full";

/** `drive.file` (app-managed files only — no CASA) or full `drive` (existing folders). */
export function driveScope(level: DriveScopeLevel): string {
  return level === "full"
    ? "https://www.googleapis.com/auth/drive"
    : "https://www.googleapis.com/auth/drive.file";
}
