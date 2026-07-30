/* Headless smoke test of the plugin's Obsidian load path: instantiate the
 * plugin against a mock Obsidian API, run onload(), build the settings tab,
 * and exercise credential seal/unlock — catching runtime crashes that the type
 * checker can't. Run:
 *   npx esbuild scripts/obsidian-smoke.ts --bundle --platform=node --format=cjs \
 *     --alias:obsidian=./scripts/_mock-obsidian.ts --outfile=/tmp/smoke.cjs && node /tmp/smoke.cjs
 */
import GoogleSyncPlugin from "../src/main";
import { SyncController } from "../src/SyncController";
import { Setting, SettingGroup } from "obsidian";

/** The shape of a declarative setting definition, as far as this test inspects it. */
interface SettingDef {
  name?: string;
  heading?: string;
  visible?: boolean | (() => boolean);
  control?: { type: string; key: string };
  render?: (setting: Setting, group: SettingGroup) => void | (() => void);
  items?: SettingDef[];
}

/** What a walk of the definition tree observed. */
interface Walked {
  headings: string[];
  controls: string[];
  rendered: number;
  hidden: number;
}
const fresh = (): Walked => ({ headings: [], controls: [], rendered: 0, hidden: 0 });

// Obsidian runs in a browser/Electron renderer; provide the globals the plugin uses.
(globalThis as unknown as { window: unknown }).window = {
  setInterval: () => 1,
  clearInterval: () => {},
  open: () => {},
};

function makeEl(): Record<string, unknown> {
  return { empty() {}, createEl() { return makeEl(); }, createDiv() { return makeEl(); }, setText() {} };
}
function makeApp(): unknown {
  return {
    vault: {
      configDir: ".obsidian",
      getName: () => "Test Vault",
      getFiles: () => [],
      adapter: {
        readBinary: async () => new ArrayBuffer(0),
        writeBinary: async () => {},
        exists: async () => true,
        mkdir: async () => {},
        remove: async () => {},
        trashSystem: async () => true,
        trashLocal: async () => {},
      },
      on: () => ({}),
    },
  };
}

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};
const throwsAsync = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

async function main(): Promise<void> {
  const plugin = new (GoogleSyncPlugin as unknown as new (a: unknown, m: unknown) => Record<string, unknown>)(
    makeApp(),
    { id: "google-sync", name: "Google Sync", version: "0.1.0" }
  ) as Record<string, unknown> & Record<string, any>;

  let onloadOk = true;
  try {
    await plugin.onload();
  } catch (e) {
    onloadOk = false;
    console.log("    onload threw:", (e as Error).message);
  }
  check("onload() runs without throwing", onloadOk);
  const cmdIds = (plugin._commands as { id: string }[]).map((c) => c.id);
  check("registers sync-now + lock commands", cmdIds.includes("sync-now") && cmdIds.includes("lock"));
  check("registers a ribbon + a settings tab", plugin._ribbons.length === 1 && plugin._settingTabs.length === 1);
  check("registers vault events for on-change auto-sync", plugin._events.length >= 3);

  // ---- declarative settings (Obsidian 1.13+) ----
  // The tab no longer implements display(); it returns definitions and the
  // framework renders them. So walk the returned tree the way Obsidian would:
  // evaluate every `visible` predicate, read every bound control value, and run
  // every `render` callback. Calling display() here would prove nothing — the
  // base-class method is a no-op.
  const tab = plugin._settingTabs[0] as {
    getSettingDefinitions: () => SettingDef[];
    getControlValue: (k: string) => unknown;
    setControlValue: (k: string, v: unknown) => void | Promise<void>;
  };

  const walk = (items: SettingDef[], seen: Walked): Walked => {
    for (const item of items) {
      if (typeof item.visible === "function" && !item.visible()) {
        seen.hidden++;
        continue;
      }
      if (item.heading) seen.headings.push(item.heading);
      if (item.control) {
        seen.controls.push(item.control.key);
        tab.getControlValue(item.control.key); // must not throw
      }
      if (item.render) {
        item.render(new Setting(), new SettingGroup());
        seen.rendered++;
      }
      if (item.items) walk(item.items, seen);
    }
    return seen;
  };

  let defsOk = true;
  let collapsed: Walked = fresh();
  try {
    collapsed = walk(tab.getSettingDefinitions(), fresh());
  } catch (e) {
    defsOk = false;
    console.log("    getSettingDefinitions walk threw:", (e as Error).message);
  }
  check("settings definitions build + render with no backend enabled", defsOk);
  console.log(
    `    collapsed: ${collapsed.controls.length} controls, ${collapsed.rendered} render rows, ` +
      `${collapsed.hidden} hidden, headings=[${collapsed.headings.join(", ")}]`
  );
  // Guards the walk itself: an empty definition tree would satisfy every
  // assertion below by vacuous truth, so require it to be substantial.
  check(
    "the walk actually visited a substantial tree",
    collapsed.controls.length >= 5 && collapsed.rendered >= 2 && collapsed.headings.length >= 3
  );
  check(
    "plugin name is not used as a settings heading",
    collapsed.headings.length > 0 && !collapsed.headings.some((h) => h.toLowerCase() === "google sync")
  );

  let expandedOk = true;
  let expanded: Walked = fresh();
  try {
    plugin.settings.driveEnabled = true;
    plugin.settings.gcsEnabled = true;
    plugin.settings.driveToken = { enc: false, data: "d" };
    plugin.settings.gcsToken = { enc: false, data: "g" };
    plugin.settings.autoSync = true;
    expanded = walk(tab.getSettingDefinitions(), fresh()); // both backends + advanced pages + disconnect
    plugin.settings.driveEnabled = false;
    plugin.settings.gcsEnabled = false;
    plugin.settings.driveToken = null;
    plugin.settings.gcsToken = null;
    plugin.settings.autoSync = false;
  } catch (e) {
    expandedOk = false;
    console.log("    expanded walk threw:", (e as Error).message);
  }
  check("settings definitions build + render with both backends connected", expandedOk);
  console.log(
    `    expanded:  ${expanded.controls.length} controls, ${expanded.rendered} render rows, ` +
      `${expanded.hidden} hidden, headings=[${expanded.headings.join(", ")}]`
  );
  check(
    "enabling a backend reveals more rows than it hides",
    expanded.controls.length > collapsed.controls.length && expanded.rendered > collapsed.rendered
  );
  check(
    "every bound control key exists in settings",
    expanded.controls.length > 0 && expanded.controls.every((k) => k in plugin.settings)
  );

  // Writing through the declarative binding must persist and stay typed.
  let bindOk = true;
  try {
    await tab.setControlValue("syncFolder", "  Notes/Sub  ");
    await tab.setControlValue("autoSyncIntervalMinutes", 42);
    await tab.setControlValue("driveScopeLevel", "full");
  } catch (e) {
    bindOk = false;
    console.log("    setControlValue threw:", (e as Error).message);
  }
  check(
    "setControlValue writes, trims and coerces",
    bindOk &&
      plugin.settings.syncFolder === "Notes/Sub" &&
      plugin.settings.autoSyncIntervalMinutes === 42 &&
      plugin.settings.driveScopeLevel === "full"
  );
  // A blank folder name must fall back to the default, not persist as "".
  await tab.setControlValue("appFolderName", "   ");
  check("blank folder name falls back to the default", plugin.settings.appFolderName === "Obsidian Sync");
  plugin.settings.syncFolder = "";
  plugin.settings.driveScopeLevel = "file";

  // No credential may be baked into the build any more.
  check(
    "no OAuth client is bundled — the user supplies their own",
    plugin.controller.hasOAuthClient === false && plugin.settings.oauthClientId === ""
  );
  plugin.settings.driveToken = { enc: false, data: "legacy" };
  check(
    "a legacy token with no client id asks the user to reconnect",
    plugin.controller.needsReconnectForOwnClient === true
  );
  plugin.settings.driveToken = null;

  // ---- credentials: passphrase is OPTIONAL ----
  plugin.settings.gcsEnabled = true;
  plugin.settings.bucket = "test-bucket";

  // (1) no passphrase → plaintext, ready immediately, no salt
  await plugin.controller.saveGcsCredentials("GOOGACCESSID", "secret-A");
  check(
    "no-passphrase save → plaintext (not encrypted), ready, no salt written",
    plugin.settings.gcsSecret?.enc === false &&
      plugin.settings.gcsSecret?.data === "secret-A" &&
      plugin.controller.ready === true &&
      plugin.settings.salt === null
  );
  // simulate a restart: a fresh controller over the same settings, prepare() with NO passphrase
  {
    const fresh = new SyncController(makeApp() as never, plugin.settings, async () => {});
    await fresh.prepare();
    check("after 'restart', plaintext creds auto-load (ready, no passphrase prompt)", fresh.ready === true);
  }

  // (2) with passphrase → encrypted at rest
  await plugin.controller.saveGcsCredentials("GOOGACCESSID", "secret-B", "pw-123");
  check(
    "passphrase save → sealed (not plaintext), salt set",
    plugin.settings.gcsSecret?.enc === true &&
      !plugin.settings.gcsSecret?.data.includes("secret-B") &&
      typeof plugin.settings.salt === "string"
  );
  plugin.controller.lock();
  check("after lock, encrypted creds are locked (not ready)", plugin.controller.ready === false);
  await plugin.controller.prepare("pw-123");
  check("prepare(correct passphrase) unlocks → ready", plugin.controller.ready === true);
  plugin.controller.lock();
  check("prepare(wrong passphrase) fails", await throwsAsync(() => plugin.controller.prepare("wrong-pass")));

  // (3) auto-sync while locked is a quiet no-op
  plugin.controller.lock();
  let autoOk = true;
  try {
    await plugin.runSync(true);
  } catch {
    autoOk = false;
  }
  check("auto-sync while locked is a quiet no-op", autoOk);

  plugin.onunload();
  console.log(`\n=== obsidian smoke: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("smoke crashed:", (e as Error).message);
  process.exitCode = 1;
});
