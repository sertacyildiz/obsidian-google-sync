/* Offline test: relativeTime() — human "x ago" rendering for the last-synced
 * info shown in settings. PURE display helper; zero effect on sync/delete logic.
 * Run: sh scripts/run-pilot.sh scripts/time-test.ts
 */
import { relativeTime } from "../src/util/time";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
const now = 1_000_000_000_000;

check("just now (< 45s)", relativeTime(now - 10 * S, now) === "just now");
check("1 minute singular", relativeTime(now - 1 * M, now) === "1 minute ago");
check("minutes plural", relativeTime(now - 5 * M, now) === "5 minutes ago");
check("1 hour singular", relativeTime(now - 1 * H, now) === "1 hour ago");
check("hours plural", relativeTime(now - 3 * H, now) === "3 hours ago");
check("1 day singular", relativeTime(now - 1 * D, now) === "1 day ago");
check("days plural", relativeTime(now - 2 * D, now) === "2 days ago");

console.log(`\n=== time: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
if (fail) process.exitCode = 1;
