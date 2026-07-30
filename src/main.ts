import { App, Notice, Plugin, PluginSettingTab, SettingDefinitionItem, SettingDefinitionRender, debounce } from "obsidian";
import { DEFAULT_APP_FOLDER, DEFAULT_SETTINGS, GoogleSyncSettings } from "./settings";
import { SyncController } from "./SyncController";
import { relativeTime } from "./util/time";

export default class GoogleSyncPlugin extends Plugin {
  settings: GoogleSyncSettings = DEFAULT_SETTINGS;
  controller!: SyncController;
  private intervalId: number | null = null;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.controller = new SyncController(this.app, this.settings, () => this.saveData(this.settings));
    void this.controller.prepare(); // auto-load plaintext credentials (no passphrase unless E2EE is on)

    this.addRibbonIcon("refresh-cw", "Google Sync: sync now", () => void this.runSync());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync() });
    this.addCommand({
      id: "lock",
      name: "Lock (forget passphrase)",
      callback: () => {
        this.controller.lock();
        new Notice("Google Sync: locked.");
      },
    });
    this.addSettingTab(new GoogleSyncSettingTab(this.app, this));

    const onChange = debounce(
      () => {
        if (this.settings.autoSync && this.settings.autoSyncMode === "on-change") void this.runSync(true);
      },
      5000,
      true
    );
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));

    this.applyAutoSync();
  }

  onunload(): void {
    this.stopInterval();
  }

  async runSync(auto = false): Promise<void> {
    if (auto && !this.controller.ready) return; // skip quietly while locked or unconfigured
    if (this.syncing) {
      new Notice("Google Sync: a sync is already running…");
      return;
    }
    this.syncing = true;
    try {
      const r = await this.controller.sync();
      const dels = r.deletedLocal.length + r.deletedRemote.length;
      new Notice(
        `Google Sync: ↑${r.uploaded.length} ↓${r.downloaded.length} ✗${dels} ⚠${r.conflicts.length}` +
          (r.errors.length ? ` — ${r.errors.length} error(s)` : "")
      );
    } catch (e) {
      new Notice(`Google Sync: ${(e as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  applyAutoSync(): void {
    this.stopInterval();
    if (this.settings.autoSync && this.settings.autoSyncMode === "interval") {
      const ms = Math.max(1, this.settings.autoSyncIntervalMinutes) * 60_000;
      this.intervalId = window.setInterval(() => void this.runSync(true), ms);
      this.registerInterval(this.intervalId);
    }
  }

  private stopInterval(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as
      | (Partial<GoogleSyncSettings> & {
          provider?: "drive" | "gcs";
          driveClientId?: string;
          state?: GoogleSyncSettings["syncState"][string];
        })
      | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!this.settings.syncState) this.settings.syncState = {};
    this.settings.backendLastSync = { ...(this.settings.backendLastSync || {}) }; // fresh object (don't share the default)
    if (data) {
      // Migrations from the pre-0.4 single-provider model:
      if (!this.settings.oauthClientId && data.driveClientId) this.settings.oauthClientId = data.driveClientId;
      if (data.provider === "drive" && this.settings.driveToken) this.settings.driveEnabled = true;
      if (data.provider === "gcs" && (this.settings.gcsToken || this.settings.gcsSecret)) this.settings.gcsEnabled = true;
      if (data.state && data.provider && Object.keys(this.settings.syncState).length === 0) {
        this.settings.syncState = { [data.provider]: data.state };
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/** Settings keys bound to a declarative control, i.e. read/written by name. */
type ControlKey =
  | "driveEnabled"
  | "appFolderName"
  | "driveProtectLocal"
  | "driveScopeLevel"
  | "gcsEnabled"
  | "bucket"
  | "prefix"
  | "gcsProtectLocal"
  | "region"
  | "service"
  | "oauthClientId"
  | "syncFolder"
  | "autoSync"
  | "autoSyncMode"
  | "autoSyncIntervalMinutes"
  | "e2ee";

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asBoolean = (v: unknown): boolean => v === true;

/**
 * Declarative settings (Obsidian 1.13+). Returning definitions instead of
 * painting `containerEl` by hand is what puts every row into Obsidian's settings
 * search; the framework owns rendering, so `display()` is not implemented here.
 *
 * Rows that need something the control types don't express — a masked input, or
 * buttons with explicit CTA/destructive styling — use `render`, which still
 * contributes its name and description to search.
 */
class GoogleSyncSettingTab extends PluginSettingTab {
  /** Typed into the UI and handed straight to the controller; never persisted here. */
  private hmacAccessId = "";
  private hmacSecret = "";
  private passphrase = "";

  constructor(app: App, private readonly plugin: GoogleSyncPlugin) {
    super(app, plugin);
  }

  private notify(msg: string): void {
    new Notice(`Google Sync: ${msg}`);
  }

  private connect(which: "drive" | "gcs"): void {
    const c = this.plugin.controller;
    const run = which === "drive" ? c.connectDrive() : c.connectGcs();
    run.then(
      () => {
        this.notify(`${which === "drive" ? "Google Drive" : "Google Cloud"} connected.`);
        this.update();
      },
      (e: unknown) => this.notify(e instanceof Error ? e.message : String(e))
    );
  }

  // ---------------------------------------------------------------- bindings

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    switch (key as ControlKey) {
      // Blank means "use the default", so show blank rather than echoing the
      // default back — the placeholder carries the hint instead.
      case "appFolderName":
        return s.appFolderName === DEFAULT_APP_FOLDER ? "" : s.appFolderName;
      default:
        return s[key as ControlKey];
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key as ControlKey) {
      case "appFolderName":
        s.appFolderName = asString(value).trim() || DEFAULT_APP_FOLDER;
        break;
      case "oauthClientId":
        s.oauthClientId = asString(value).trim();
        break;
      case "bucket":
        s.bucket = asString(value).trim();
        break;
      case "prefix":
        s.prefix = asString(value).trim();
        break;
      case "syncFolder":
        s.syncFolder = asString(value).trim();
        break;
      case "region":
        s.region = asString(value).trim();
        break;
      case "service":
        s.service = asString(value).trim();
        break;
      case "driveScopeLevel":
        s.driveScopeLevel = asString(value) === "full" ? "full" : "file";
        break;
      case "autoSyncMode":
        s.autoSyncMode = asString(value) === "on-change" ? "on-change" : "interval";
        break;
      case "autoSyncIntervalMinutes":
        s.autoSyncIntervalMinutes = typeof value === "number" && value > 0 ? Math.floor(value) : s.autoSyncIntervalMinutes;
        break;
      case "driveEnabled":
        s.driveEnabled = asBoolean(value);
        break;
      case "gcsEnabled":
        s.gcsEnabled = asBoolean(value);
        break;
      case "driveProtectLocal":
        s.driveProtectLocal = asBoolean(value);
        break;
      case "gcsProtectLocal":
        s.gcsProtectLocal = asBoolean(value);
        break;
      case "autoSync":
        s.autoSync = asBoolean(value);
        break;
      case "e2ee":
        s.e2ee = asBoolean(value);
        break;
    }
    await this.plugin.saveSettings();

    // Side effects the framework can't know about: reschedule the timer, and
    // repaint when a toggle reveals or hides a whole section.
    if (key === "autoSync" || key === "autoSyncMode" || key === "autoSyncIntervalMinutes") this.plugin.applyAutoSync();
    if (key === "driveEnabled" || key === "gcsEnabled") this.update();
  }

  // ------------------------------------------------------------ row helpers

  /** A row of explicit buttons, so CTA / destructive styling stays under our control. */
  private buttonRow(
    name: string,
    desc: string | DocumentFragment,
    buttons: { label: string; cta?: boolean; destructive?: boolean; onClick: () => void }[]
  ): SettingDefinitionRender {
    return {
      name,
      desc,
      render: (setting) => {
        for (const spec of buttons) {
          setting.addButton((b) => {
            b.setButtonText(spec.label).onClick(spec.onClick);
            if (spec.cta) b.setCta();
            if (spec.destructive) b.setDestructive();
          });
        }
      },
    };
  }

  /** A masked text row — no control type covers `input[type=password]`. */
  private passwordRow(
    name: string,
    desc: string,
    read: () => string,
    write: (value: string) => void
  ): SettingDefinitionRender {
    return {
      name,
      desc,
      render: (setting) => {
        setting.addText((t) => {
          t.inputEl.type = "password";
          t.setValue(read()).onChange(write);
        });
      },
    };
  }

  // ------------------------------------------------------------ definitions

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.reconnectNotice(),
      this.oauthClientGroup(),
      this.driveGroup(),
      this.gcsGroup(),
      this.syncGroup(),
      this.encryptionPage(),
    ];
  }

  /**
   * Versions before 0.7.0 shipped a shared OAuth client. Google binds a refresh
   * token to the client that issued it, so those tokens cannot be refreshed once
   * that client is gone — the only fix is to reconnect with the user's own client.
   * Stated up front rather than surfacing later as a failed sync.
   */
  private reconnectNotice(): SettingDefinitionItem {
    return {
      type: "group",
      heading: "Reconnect required",
      visible: () => this.plugin.controller.needsReconnectForOwnClient,
      items: [
        {
          name: "This version uses your own Google OAuth client",
          desc:
            "Earlier versions signed in through a shared client that was bundled into the plugin. That client has been removed, so your existing sign-in can no longer be refreshed. " +
            "Create your own OAuth client below, then reconnect the backends you use. Your synced files are untouched.",
        },
      ],
    };
  }

  private oauthClientGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const configured = this.plugin.controller.hasOAuthClient;
    return {
      type: "group",
      heading: "Google OAuth client",
      items: [
        {
          name: configured ? "Client configured" : "Set up required",
          desc: createFragment((f) => {
            f.appendText(
              configured
                ? "Signing in uses your own Google OAuth client. Nothing is shared with anyone else."
                : "This plugin talks to Google with an OAuth client that you own — no shared credential ships in the plugin, so nothing to leak and nothing to revoke on your behalf. Create one once: "
            );
            if (!configured) {
              const ol = f.createEl("ol");
              ol.createEl("li", { text: "Open the Google Cloud Console credentials page and pick (or create) a project." });
              ol.createEl("li", { text: 'Enable the "Google Drive API" if you plan to sync to Drive.' });
              ol.createEl("li", { text: 'Create credentials → OAuth client ID → application type "Desktop app".' });
              ol.createEl("li", { text: "Paste the client ID and client secret into the two rows below." });
              f.createEl("a", {
                text: "console.cloud.google.com/apis/credentials",
                href: "https://console.cloud.google.com/apis/credentials",
              });
            }
          }),
        },
        {
          name: "OAuth client ID",
          desc: "The client ID from your Google Cloud OAuth client.",
          aliases: ["google", "credentials", "sign in", "login"],
          control: {
            type: "text",
            key: "oauthClientId",
            placeholder: "…apps.googleusercontent.com",
          },
        },
        this.passwordRow(
          "OAuth client secret",
          'Required for Google "Desktop app" clients. Stored only in this vault\'s plugin data, which is never synced.',
          () => s.oauthClientSecret,
          (v) => {
            s.oauthClientSecret = v.trim();
            void this.plugin.saveSettings();
          }
        ),
      ],
    };
  }

  private driveGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const c = this.plugin.controller;
    const status = s.driveToken
      ? `✓ Connected.${s.backendLastSync.drive ? ` Last synced ${relativeTime(s.backendLastSync.drive, Date.now())}.` : ""}`
      : "Not connected.";
    const buttons: { label: string; cta?: boolean; destructive?: boolean; onClick: () => void }[] = [
      { label: s.driveToken ? "Reconnect" : "Connect Google Drive", cta: true, onClick: () => this.connect("drive") },
    ];
    if (s.driveToken) {
      buttons.push({
        label: "Disconnect",
        destructive: true,
        onClick: () => {
          void c.disconnectDrive().then(() => {
            this.notify("Google Drive disconnected.");
            this.update();
          });
        },
      });
    }

    return {
      type: "group",
      heading: "Google Drive",
      items: [
        {
          name: "Sync to Google Drive",
          desc: "Sync to your personal Google Drive. Works with any Google account.",
          control: { type: "toggle", key: "driveEnabled" },
        },
        {
          name: "Folder",
          desc: `Files sync under "${s.appFolderName || DEFAULT_APP_FOLDER}/${this.app.vault.getName()}" — the vault name is added automatically so multiple vaults never collide. Blank = "${DEFAULT_APP_FOLDER}".`,
          visible: () => s.driveEnabled,
          control: { type: "text", key: "appFolderName", placeholder: DEFAULT_APP_FOLDER },
        },
        { ...this.buttonRow("Connection", status, buttons), visible: () => s.driveEnabled },
        {
          name: "Backup mode (never delete local files)",
          desc: "Off (default): a true two-way sync — deletions sync across devices, but are recoverable (moved to your trash) and a mass deletion is halted for safety. On: a file missing on Drive is re-uploaded instead of deleted locally — choose this only for a one-way single-device → Drive backup.",
          visible: () => s.driveEnabled,
          control: { type: "toggle", key: "driveProtectLocal" },
        },
        {
          type: "page",
          name: "Advanced",
          desc: "Drive access scope.",
          visible: () => s.driveEnabled,
          items: [
            {
              name: "Scope",
              desc: "App files (drive.file) is least-privilege and needs no Google verification. Full Drive can target existing folders.",
              control: {
                type: "dropdown",
                key: "driveScopeLevel",
                options: { file: "App files (recommended)", full: "Full Drive" },
              },
            },
          ],
        },
      ],
    };
  }

  private gcsGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const c = this.plugin.controller;
    const base = s.gcsToken ? "✓ Connected (OAuth)." : s.gcsSecret ? "✓ Using an HMAC key." : "Not connected.";
    const status = (s.gcsToken || s.gcsSecret) && s.backendLastSync.gcs ? `${base} Last synced ${relativeTime(s.backendLastSync.gcs, Date.now())}.` : base;
    const buttons: { label: string; cta?: boolean; destructive?: boolean; onClick: () => void }[] = [
      { label: s.gcsToken ? "Reconnect" : "Connect Google Cloud", cta: true, onClick: () => this.connect("gcs") },
    ];
    if (s.gcsToken || s.gcsSecret) {
      buttons.push({
        label: "Disconnect",
        destructive: true,
        onClick: () => {
          void c.disconnectGcs().then(() => {
            this.notify("Google Cloud disconnected.");
            this.update();
          });
        },
      });
    }

    return {
      type: "group",
      heading: "Google Cloud Storage",
      items: [
        {
          name: "Sync to Google Cloud Storage",
          desc: "Sync to a bucket in your own Google Cloud project (requires a Google Cloud account).",
          control: { type: "toggle", key: "gcsEnabled" },
        },
        {
          name: "Bucket",
          desc: "Your Cloud Storage bucket name.",
          visible: () => s.gcsEnabled,
          control: { type: "text", key: "bucket" },
        },
        {
          name: "Prefix",
          desc: "Optional key prefix inside the bucket.",
          visible: () => s.gcsEnabled,
          control: { type: "text", key: "prefix" },
        },
        { ...this.buttonRow("Connection", status, buttons), visible: () => s.gcsEnabled },
        {
          name: "Backup mode (never delete local files)",
          desc: "Off (default): a true two-way sync — deletions sync across devices, but are recoverable (moved to your trash) and a mass deletion is halted for safety. On: a file missing in the bucket is re-uploaded instead of deleted locally — choose this only for a one-way single-device → bucket backup.",
          visible: () => s.gcsEnabled,
          control: { type: "toggle", key: "gcsProtectLocal" },
        },
        {
          type: "page",
          name: "Advanced",
          desc: "HMAC key (least privilege), region and service.",
          visible: () => s.gcsEnabled,
          items: [
            {
              name: "Why use an HMAC key",
              desc:
                "OAuth grants read/write to every bucket your Google account can access (GCS has no per-bucket OAuth scope). " +
                "For least privilege, use an HMAC key tied to a bucket-scoped service account instead.",
            },
            {
              name: "HMAC access ID",
              desc: "The access ID of your bucket-scoped service account's HMAC key.",
              render: (setting) => {
                setting.addText((t) => t.setValue(this.hmacAccessId || s.accessId).onChange((v) => (this.hmacAccessId = v)));
              },
            },
            this.passwordRow(
              "HMAC secret",
              "Held in memory until you save it below.",
              () => "",
              (v) => (this.hmacSecret = v)
            ),
            this.buttonRow("Save HMAC key", "Switches this backend to HMAC authentication.", [
              {
                label: "Save HMAC key",
                onClick: () => {
                  void c.saveGcsCredentials(this.hmacAccessId || s.accessId, this.hmacSecret).then(
                    () => {
                      this.hmacSecret = "";
                      this.notify("HMAC key saved.");
                      this.update();
                    },
                    (e: unknown) => this.notify(e instanceof Error ? e.message : String(e))
                  );
                },
              },
            ]),
            {
              name: "Region",
              desc: "SigV4 credential scope. Default: auto.",
              control: { type: "text", key: "region", placeholder: "auto" },
            },
            {
              name: "Service",
              desc: "SigV4 service name. Default: s3.",
              control: { type: "text", key: "service", placeholder: "s3" },
            },
          ],
        },
      ],
    };
  }

  private syncGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    return {
      type: "group",
      heading: "Sync",
      items: [
        this.buttonRow(
          "Sync now",
          `Last synced: ${s.lastSyncAt ? `${relativeTime(s.lastSyncAt, Date.now())} (${new Date(s.lastSyncAt).toLocaleString()})` : "never"}`,
          [
            {
              label: "Sync now",
              cta: true,
              onClick: () => {
                void this.plugin.runSync().then(() => this.update());
              },
            },
          ]
        ),
        {
          name: "Sync folder",
          desc: "Vault-relative folder to sync. Empty = whole vault.",
          control: { type: "text", key: "syncFolder" },
        },
        {
          name: "Auto-sync",
          desc: "Sync automatically in the background.",
          control: { type: "toggle", key: "autoSync" },
        },
        {
          name: "Auto-sync mode",
          desc: "Sync on a timer, or shortly after every change.",
          visible: () => s.autoSync,
          control: {
            type: "dropdown",
            key: "autoSyncMode",
            options: { interval: "Every X minutes", "on-change": "On every change" },
          },
        },
        {
          name: "Auto-sync interval",
          desc: "Minutes between automatic syncs.",
          visible: () => s.autoSync && s.autoSyncMode === "interval",
          control: {
            type: "number",
            key: "autoSyncIntervalMinutes",
            min: 1,
            step: 1,
            validate: (v) => (Number.isFinite(v) && v >= 1 ? undefined : "Enter a whole number of minutes, 1 or more."),
          },
        },
      ],
    };
  }

  private encryptionPage(): SettingDefinitionItem {
    const c = this.plugin.controller;
    return {
      type: "page",
      name: "End-to-end encryption",
      desc: "Optional. Encrypt note content before upload.",
      items: [
        {
          name: "About end-to-end encryption",
          desc:
            "Optional. Encrypts note content before upload (zero-knowledge) using a passphrase — off by default, and not needed just to connect. " +
            "If you lose the passphrase, encrypted content is unrecoverable.",
        },
        {
          name: "Encrypt content",
          desc: "Encrypt note content before it leaves this device.",
          aliases: ["e2ee", "encryption", "passphrase"],
          control: { type: "toggle", key: "e2ee" },
        },
        this.passwordRow(
          "Passphrase",
          "Held in memory only, never stored.",
          () => "",
          (v) => (this.passphrase = v)
        ),
        this.buttonRow("Unlock", "Derive the key from the passphrase above.", [
          {
            label: "Unlock",
            onClick: () => {
              void c.prepare(this.passphrase || undefined).then(
                () => this.notify(c.ready ? "unlocked." : "nothing to unlock yet."),
                (e: unknown) => this.notify(e instanceof Error ? e.message : String(e))
              );
            },
          },
        ]),
      ],
    };
  }
}
