/* Headless smoke test of the plugin's Obsidian load path: instantiate the
 * plugin against a mock Obsidian API, run onload(), build the settings tab,
 * and exercise credential seal/unlock — catching runtime crashes that the type
 * checker can't. Run:
 *   npx esbuild scripts/obsidian-smoke.ts --bundle --platform=node --format=cjs \
 *     --alias:obsidian=./scripts/_mock-obsidian.ts --outfile=/tmp/smoke.cjs && node /tmp/smoke.cjs
 */
import GoogleSyncPlugin from "../src/main";

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
      getFiles: () => [],
      adapter: {
        readBinary: async () => new ArrayBuffer(0),
        writeBinary: async () => {},
        exists: async () => true,
        mkdir: async () => {},
        remove: async () => {},
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

  let displayOk = true;
  try {
    plugin._settingTabs[0].display();
  } catch (e) {
    displayOk = false;
    console.log("    display threw:", (e as Error).message);
  }
  check("settings tab display() builds the full UI without throwing", displayOk);

  // credential seal/unlock through the real controller (real crypto) in plugin context
  await plugin.controller.saveGcsCredentials("pw-123", "GOOGACCESSID", "the-secret");
  check(
    "saveGcsCredentials → unlocked + secret sealed (not plaintext on disk)",
    plugin.controller.unlocked &&
      typeof plugin.settings.sealedSecret === "string" &&
      !plugin.settings.sealedSecret.includes("the-secret")
  );
  plugin.controller.lock();
  check("lock() clears the in-memory key", !plugin.controller.unlocked);
  await plugin.controller.unlock("pw-123");
  check("unlock() with the correct passphrase succeeds", plugin.controller.unlocked);
  plugin.controller.lock();
  check("unlock() with a wrong passphrase fails", await throwsAsync(() => plugin.controller.unlock("wrong-pass")));

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
