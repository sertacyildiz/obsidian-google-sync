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
import { MOBILE_MAX_CONCURRENT_READS, ObsidianLocalStore } from "../src/obsidian/ObsidianLocalStore";
import { HashCache } from "../src/obsidian/HashCache";
import { TFile, TFolder } from "obsidian";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

// ---------------------------------------------------------------- list() scope

/**
 * A vault whose tree is explicit, so a test can tell scoped traversal apart from
 * "list everything, then filter". `calls.getFiles` counts whole-vault
 * enumerations — the number this change exists to keep at zero.
 *
 * Nodes are real TFile / TFolder instances because the store narrows with
 * `instanceof`; plain object literals would silently fall through both branches
 * and every scoped result would come back empty.
 */
function makeVault(paths: string[]) {
  const calls = { getFiles: 0, readBinary: [] as string[] };
  const files = new Map<string, TFile>();
  const folders = new Map<string, TFolder>();
  folders.set("", new TFolder(""));

  const folderAt = (dir: string): TFolder => {
    const existing = folders.get(dir);
    if (existing) return existing;
    const slash = dir.lastIndexOf("/");
    const parent = folderAt(slash === -1 ? "" : dir.slice(0, slash));
    const made = new TFolder(dir);
    folders.set(dir, made);
    parent.children.push(made);
    return made;
  };

  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const f = new TFile(p);
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

  console.log("hash cache (mobile): a sync must not re-read unchanged files");
  {
    const { app, calls } = makeVault(["Notes/a.md", "Notes/b.md", "c.md"]);
    const cache = new HashCache();
    const store = new ObsidianLocalStore(app as never, "", cache);
    const first = await store.list();
    calls.readBinary.length = 0;
    const second = await store.list();
    check("unchanged files are not read again, same result", calls.readBinary.length === 0 && JSON.stringify(second) === JSON.stringify(first));
    (app.vault.getFileByPath("Notes/a.md") as TFile).stat.size = 5;
    (app.vault.getFileByPath("Notes/b.md") as TFile).stat.mtime = 99;
    calls.readBinary.length = 0;
    await store.list();
    check("a size or an mtime change re-reads exactly that file", JSON.stringify([...calls.readBinary].sort()) === JSON.stringify(["Notes/a.md", "Notes/b.md"]));
    cache.forget("c.md");
    calls.readBinary.length = 0;
    await store.list();
    check("forget(p) forces a re-read even with identical stat", JSON.stringify(calls.readBinary) === JSON.stringify(["c.md"]));
  }
  {
    const cache = new HashCache();
    await new ObsidianLocalStore(makeVault(["x.md", "y.md"]).app as never, "", cache).list();
    await new ObsidianLocalStore(makeVault(["x.md"]).app as never, "", cache).list(); // y.md deleted since
    const json = cache.toJSON();
    check("a deleted file's entry is dropped", Object.keys(json).join(",") === "x.md");
    check("toJSON round-trips through the constructor", new HashCache(JSON.parse(JSON.stringify(json))).lookup("x.md", 1, 0) === json["x.md"].hash);
    const junk = new HashCache({ "a.md": { mtime: "1", size: 0, hash: "h" }, "b.md": null } as never);
    check("malformed entries are ignored, never trusted", junk.lookup("a.md", 1, 0) === undefined && Object.keys(junk.toJSON()).length === 0);
    const dirtyBefore = cache.dirty;
    cache.markSaved();
    check("dirty after changes, clean after markSaved()", dirtyBefore === true && cache.dirty === false);
  }
  {
    const { app, calls } = makeVault(["p.md", "q.md"]);
    const store = new ObsidianLocalStore(app as never, "");
    await store.list();
    await store.list();
    check("no cache: every list reads every file (desktop behaviour unchanged)", calls.readBinary.length === 4);
  }
  // An edit saved while its file is being read must never be cached under the old content's hash:
  // that hash matches the baseline, so the edit would never upload and a later remote change would
  // overwrite it without a conflict copy.
  const racyVault = (onRead: (f: TFile, cache: HashCache) => void) => {
    const f = new TFile("note.md", 1);
    const cache = new HashCache();
    const reads: string[] = [];
    let content = "v1";
    const app = {
      vault: {
        configDir: ".obsidian",
        getFiles: () => [f],
        getFileByPath: () => null,
        getFolderByPath: () => null,
        adapter: {
          readBinary: async (p: string): Promise<ArrayBuffer> => {
            reads.push(p);
            const bytes = new TextEncoder().encode(content).buffer;
            if (reads.length === 1) {
              onRead(f, cache); // the user saves while the read is in flight…
              content = "v2"; // …and the next read sees the new content
            }
            return bytes;
          },
        },
      },
    };
    return { store: new ObsidianLocalStore(app as never, "", cache), cache, reads, f };
  };
  {
    const { store, cache, reads, f } = racyVault((file, c) => {
      file.stat.mtime = 2; // Obsidian updates the live stat…
      file.stat.size = 2;
      c.forget(file.path); // …and fires modify, which evicts
    });
    const first = await store.list();
    check("race: the stat that changed during the read is not cached", cache.lookup("note.md", 2, 2) === undefined && cache.lookup("note.md", 1, 0) === undefined);
    check("race: the listing pairs the hash with the stat it was read under", first[0].mtime === 1);
    const second = await store.list();
    check("race: the next listing reads the file again and sees the edit", reads.length === 2 && second[0].hash !== first[0].hash && f.stat.mtime === 2);
  }
  {
    const { store, cache, reads } = racyVault((file, c) => c.forget(file.path)); // edit that kept mtime AND size
    await store.list();
    check("race: an eviction during the read blocks caching even when the stat is unchanged", cache.lookup("note.md", 1, 0) === undefined);
    await store.list();
    check("race: …so the next listing reads it again", reads.length === 2);
  }
  {
    // The store's own writes and deletes evict too — no reliance on when Obsidian updates stat or fires events.
    const f = new TFile("w.md", 1);
    const cache = new HashCache();
    const app = {
      vault: {
        configDir: ".obsidian",
        getFiles: () => [f],
        getFileByPath: () => null,
        getFolderByPath: () => null,
        adapter: {
          readBinary: async () => new ArrayBuffer(0),
          writeBinary: async () => {},
          exists: async () => true,
          mkdir: async () => {},
          trashSystem: async () => true,
          trashLocal: async () => {},
        },
      },
    };
    const store = new ObsidianLocalStore(app as never, "", cache);
    await store.list();
    await store.write("w.md", new ArrayBuffer(3));
    check("own write evicts the written path", cache.lookup("w.md", 1, 0) === undefined);
    await store.list();
    await store.delete("w.md");
    check("own delete evicts the deleted path", cache.lookup("w.md", 1, 0) === undefined);
  }
  {
    // A cold first sync on a phone must not read the whole vault into memory at once.
    const inFlight = { now: 0, max: 0 };
    const files = Array.from({ length: 20 }, (_, i) => new TFile(`f${String(i).padStart(2, "0")}.md`, 1));
    const app = {
      vault: {
        configDir: ".obsidian",
        getFiles: () => files,
        getFileByPath: () => null,
        getFolderByPath: () => null,
        adapter: {
          readBinary: async (): Promise<ArrayBuffer> => {
            inFlight.max = Math.max(inFlight.max, ++inFlight.now);
            await new Promise((r) => setTimeout(r, 1));
            inFlight.now--;
            return new ArrayBuffer(0);
          },
        },
      },
    };
    const listed = await new ObsidianLocalStore(app as never, "", new HashCache(), MOBILE_MAX_CONCURRENT_READS).list();
    check(
      `mobile: at most ${MOBILE_MAX_CONCURRENT_READS} reads in flight, every file listed, input order kept`,
      MOBILE_MAX_CONCURRENT_READS === 4 && inFlight.max === 4 && listed.map((f) => f.path).join() === files.map((f) => f.path).join()
    );
    inFlight.max = 0;
    await new ObsidianLocalStore(app as never, "").list();
    check("desktop: no cap (0.7.3 behaviour)", inFlight.max === 20);
  }

  console.log(`\n=== localstore: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("localstore-test crashed:", (e as Error).message);
  process.exitCode = 1;
});
