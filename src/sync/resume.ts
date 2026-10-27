/** Minimum time since the last successful sync before opening / returning to the app syncs again. */
export const RESUME_SYNC_MIN_GAP_MS = 60_000;

/**
 * Mobile: interval timers do not run while Obsidian is in the background, so the
 * phone would otherwise open on stale notes. When it opens or comes back to the
 * foreground, sync if auto-sync is on and the last successful sync is at least
 * {@link RESUME_SYNC_MIN_GAP_MS} old — enough to skip the flurry of resumes from
 * quick app switches. This only decides *when* to sync; what changes is still
 * decided by the baseline, never by the clock. A last-sync time in the future (a
 * clock that went backwards) syncs rather than waiting it out.
 */
export function shouldSyncOnResume(s: { autoSync: boolean; lastSyncAt: number | null }, now: number): boolean {
  if (!s.autoSync) return false;
  if (s.lastSyncAt === null || now < s.lastSyncAt) return true;
  return now - s.lastSyncAt >= RESUME_SYNC_MIN_GAP_MS;
}
