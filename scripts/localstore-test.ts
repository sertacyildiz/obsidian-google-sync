/* Offline test: ObsidianLocalStore.delete() must route deletions through the
 * trash (recoverable), NEVER a hard adapter.remove(). A wrong "remote deleted
 * this" conclusion must always be undoable. Run:
 *   npx esbuild scripts/localstore-test.ts --bundle --platform=node --format=cjs \
 *     --alias:obsidian=./scripts/_mock-obsidian.ts --outfile=/tmp/ls.cjs && node /tmp/ls.cjs
 */
import { ObsidianLocalStore } from "../src/obsidian/ObsidianLocalStore";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

/** A fake vault adapter that records which deletion path was taken. */
function makeApp(trashSystem: () => Promise<boolean>) {
  const calls = { trashSystem: 0, trashLocal: 0, remove: 0 };
  const app = {
    vault: {
      configDir: ".obsidian",
      adapter: {
        exists: async (): Promise<boolean> => true,
        trashSystem: async (_p: string): Promise<boolean> => {
          calls.trashSystem++;
          return trashSystem();
        },
        trashLocal: async (_p: string): Promise<void> => {
          calls.trashLocal++;
        },
        remove: async (_p: string): Promise<void> => {
          calls.remove++;
        },
      },
    },
  };
  return { app, calls };
}

async function main(): Promise<void> {
  // 1. system trash available → use it, NEVER hard-remove
  {
    const { app, calls } = makeApp(async () => true);
    await new ObsidianLocalStore(app as never, "").delete("Notes/a.md");
    check("delete routes to system trash (no hard remove)", calls.trashSystem === 1 && calls.remove === 0);
  }
  // 2. system trash unavailable (returns false) → fall back to vault-local trash, still no hard remove
  {
    const { app, calls } = makeApp(async () => false);
    await new ObsidianLocalStore(app as never, "").delete("Notes/a.md");
    check("delete falls back to vault-local trash when system trash is unavailable", calls.trashLocal === 1 && calls.remove === 0);
  }
  // 3. system trash throws → fall back to vault-local trash (never hard remove)
  {
    const { app, calls } = makeApp(async () => {
      throw new Error("no FS trash here");
    });
    await new ObsidianLocalStore(app as never, "").delete("Notes/a.md");
    check("delete falls back to local trash when system trash throws", calls.trashLocal === 1 && calls.remove === 0);
  }

  console.log(`\n=== localstore: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("localstore-test crashed:", (e as Error).message);
  process.exitCode = 1;
});
