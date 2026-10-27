/* Offline test: shouldSyncOnResume() — when the mobile app opens or returns to
 * the foreground, sync if auto-sync is on and the last successful sync is at
 * least RESUME_SYNC_MIN_GAP_MS old (timers do not run while Obsidian mobile is
 * in the background, so this is how the phone catches up). Scheduling only:
 * what gets synced is still decided by the three-way-merge baseline.
 * Run: sh scripts/run-pilot.sh scripts/resume-test.ts
 */
import { RESUME_SYNC_MIN_GAP_MS, shouldSyncOnResume } from "../src/sync/resume";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};
const now = 1_000_000_000_000;
const S = 1000;

check("the gap is 60 s", RESUME_SYNC_MIN_GAP_MS === 60 * S);
check("auto-sync off → never", shouldSyncOnResume({ autoSync: false, lastSyncAt: null }, now) === false);
check("auto-sync off, long ago → still never", shouldSyncOnResume({ autoSync: false, lastSyncAt: now - 3600 * S }, now) === false);
check("never synced → sync", shouldSyncOnResume({ autoSync: true, lastSyncAt: null }, now) === true);
check("59 s since the last sync → wait", shouldSyncOnResume({ autoSync: true, lastSyncAt: now - 59 * S }, now) === false);
check("exactly 60 s → sync", shouldSyncOnResume({ autoSync: true, lastSyncAt: now - 60 * S }, now) === true);
check("61 s → sync", shouldSyncOnResume({ autoSync: true, lastSyncAt: now - 61 * S }, now) === true);
check("a clock that went backwards (last sync 'in the future') → sync rather than stall", shouldSyncOnResume({ autoSync: true, lastSyncAt: now + 3600 * S }, now) === true);

console.log(`\n=== resume: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
if (fail) process.exitCode = 1;
