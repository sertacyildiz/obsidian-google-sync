/* Offline test: ObsidianLocalStore.
 *  - delete() must route deletions through the trash (recoverable), NEVER a hard
 *    adapter.remove(). A wrong "remote deleted this" conclusion must be undoable.
 *  - list() must read only what it is allowed to see: with a scope folder set it
 *    must walk that subtree ONLY, never enumerating the whole vault, and a scope
 *    that does not exist must sync nothing rather than widening to everything.
 * Run:
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

// ---------------------------------------------------------------- list() scope

interface FakeFile {
  path: string;
  stat: { mtime: number };
}
interface FakeFolder {
  path: string;
  children: (FakeFile | FakeFolder)[];
}

/**
 * A vault whose tree is explicit, so a test can tell scoped traversal apart from
 * "list everything, then filter". `calls.getFiles` counts whole-vault
 * enumerations — the number this change exists to keep at zero.
 */
function makeVault(paths: string[]) {
  const calls = { getFiles: 0, readBinary: [] as string[] };
  const files = new Map<string, FakeFile>();
  const folders = new Map<string, FakeFolder>();
  const root: FakeFolder = { path: "", children: [] };
  folders.set("", root);

  const folderAt = (dir: string): FakeFolder => {
    let cur = folders.get(dir);
    if (cur) return cur;
    const slash = dir.lastIndexOf("/");
    const parent = folderAt(slash === -1 ? "" : dir.slice(0, slash));
    cur = { path: dir, children: [] };
    folders.set(dir, cur);
    parent.children.push(cur);
    return cur;
  };

  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const f: FakeFile = { path: p, stat: { mtime: 1 } };
    files.set(p, f);
    folderAt(slash === -1 ? "" : p.slice(0, slash)).children.push(f);
  }

  const app = {
    vault: {
      configDir: ".obsidian",
      getFiles: () => {
        calls.getFiles++;
        return [...files.values()];
      },
      getFileByPath: (p: string) => files.get(p) ?? null,
      getFolderByPath: (p: string) => folders.get(p) ?? null,
      adapter: {
        readBinary: async (p: string): Promise<ArrayBuffer> => {
          calls.readBinary.push(p);
          return new ArrayBuffer(0);
        },
      },
    },
  };
  return { app, calls };
}

const TREE = [
  "Notes/a.md",
  "Notes/deep/b.md",
  "Notes/deep/deeper/c.md",
  "Private/secret.md",
  "top.md",
  ".obsidian/plugins/google-cloud-sync/data.json",
  "Notes/.obsidian-like/not-config.md",
];

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

  // ---- list(): scoped traversal must not enumerate the whole vault ----
  const sorted = async (scope: string): Promise<{ paths: string[]; calls: ReturnType<typeof makeVault>["calls"] }> => {
    const { app, calls } = makeVault(TREE);
    const out = await new ObsidianLocalStore(app as never, scope).list();
    return { paths: out.map((f) => f.path).sort(), calls };
  };

  // 4. a scope folder walks ONLY that subtree — the whole-vault enumerator is never touched
  {
    const { paths, calls } = await sorted("Notes");
    check(
      "scoped list returns exactly the subtree (incl. nested)",
      JSON.stringify(paths) ===
        JSON.stringify(["Notes/.obsidian-like/not-config.md", "Notes/a.md", "Notes/deep/b.md", "Notes/deep/deeper/c.md"])
    );
    check("scoped list NEVER enumerates the whole vault (getFiles not called)", calls.getFiles === 0);
    check("scoped list never even reads an out-of-scope path", !calls.readBinary.some((p) => p.startsWith("Private/")));
  }

  // 5. a trailing slash must not change the scope
  {
    const { paths } = await sorted("Notes/");
    check("trailing slash on the scope is ignored", paths.length === 4 && paths.every((p) => p.startsWith("Notes/")));
  }

  // 6. no scope = whole vault: getFiles IS used, and the config dir is still excluded
  {
    const { paths, calls } = await sorted("");
    check(
      "empty scope syncs the whole vault, minus the config dir",
      JSON.stringify(paths) ===
        JSON.stringify([
          "Notes/.obsidian-like/not-config.md",
          "Notes/a.md",
          "Notes/deep/b.md",
          "Notes/deep/deeper/c.md",
          "Private/secret.md",
          "top.md",
        ])
    );
    check("whole-vault mode calls getFiles openly (once)", calls.getFiles === 1);
    check("plugin's own data.json is never in the synced set", !paths.some((p) => p.startsWith(".obsidian/")));
  }

  // 7. a scope that does not exist must sync NOTHING — never fall back to everything
  {
    const { paths, calls } = await sorted("DoesNotExist");
    check("missing scope folder syncs nothing (never widens to the whole vault)", paths.length === 0 && calls.getFiles === 0);
  }

  // 8. a scope naming a single file syncs just that file
  {
    const { paths, calls } = await sorted("Notes/a.md");
    check("scope naming one file syncs only that file", JSON.stringify(paths) === JSON.stringify(["Notes/a.md"]) && calls.getFiles === 0);
  }

  // 9. the config dir can never be reached even if named as the scope
  {
    const { paths } = await sorted(".obsidian");
    check("config dir as scope yields nothing", paths.length === 0);
  }

  console.log(`\n=== localstore: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("localstore-test crashed:", (e as Error).message);
  process.exitCode = 1;
});
