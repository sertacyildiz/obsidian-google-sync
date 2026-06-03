import { App, Notice, Plugin, PluginSettingTab, Setting, debounce } from "obsidian";
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

class GoogleSyncSettingTab extends PluginSettingTab {
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
        this.display();
      },
      (e) => this.notify((e as Error).message)
    );
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const c = this.plugin.controller;
    containerEl.empty();

    new Setting(containerEl).setName("Google Sync").setHeading();
    if (!s.driveEnabled && !s.gcsEnabled) {
      containerEl.createEl("p", { text: "Turn on a backend below to get started. You can use Google Drive, Google Cloud Storage, or both at once." });
    }

    // ---------------- Google Drive ----------------
    new Setting(containerEl)
      .setName("Google Drive")
      .setDesc("Sync to your personal Google Drive. Works with any Google account — just sign in.")
      .addToggle((t) =>
        t.setValue(s.driveEnabled).onChange(async (v) => {
          s.driveEnabled = v;
          await this.plugin.saveSettings();
          this.display();
        })
      );
    if (s.driveEnabled) {
      new Setting(containerEl)
        .setName("Folder")
        .setDesc(`Files sync under "${s.appFolderName || DEFAULT_APP_FOLDER}/${this.app.vault.getName()}" — the vault name is added automatically so multiple vaults never collide. Blank = "${DEFAULT_APP_FOLDER}".`)
        .addText((t) =>
          t
            .setPlaceholder(DEFAULT_APP_FOLDER)
            .setValue(s.appFolderName === DEFAULT_APP_FOLDER ? "" : s.appFolderName)
            .onChange(async (v) => {
              s.appFolderName = v.trim() || DEFAULT_APP_FOLDER;
              await this.plugin.saveSettings();
            })
        );
      const drow = new Setting(containerEl)
        .setDesc(
          s.driveToken
            ? `✓ Connected.${s.backendLastSync.drive ? ` Last synced ${relativeTime(s.backendLastSync.drive, Date.now())}.` : ""}`
            : "Not connected."
        )
        .addButton((b) => b.setButtonText(s.driveToken ? "Reconnect" : "Connect Google Drive").setCta().onClick(() => this.connect("drive")));
      if (s.driveToken)
        drow.addButton((b) =>
          b.setButtonText("Disconnect").setWarning().onClick(async () => {
            await c.disconnectDrive();
            this.notify("Google Drive disconnected.");
            this.display();
          })
        );
      new Setting(containerEl)
        .setName("Backup mode (never delete local files)")
        .setDesc("Off (default): a true two-way sync — deletions sync across devices, but are recoverable (moved to your trash) and a mass deletion is halted for safety. On: a file missing on Drive is re-uploaded instead of deleted locally — choose this only for a one-way single-device → Drive backup.")
        .addToggle((t) =>
          t.setValue(s.driveProtectLocal).onChange(async (v) => {
            s.driveProtectLocal = v;
            await this.plugin.saveSettings();
          })
        );
      const dadv = containerEl.createEl("details");
      dadv.createEl("summary", { text: "Advanced" });
      new Setting(dadv)
        .setName("Scope")
        .setDesc("App files (drive.file) is least-privilege and needs no Google verification. Full Drive can target existing folders.")
        .addDropdown((d) =>
          d
            .addOption("file", "App files (recommended)")
            .addOption("full", "Full Drive")
            .setValue(s.driveScopeLevel)
            .onChange(async (v) => {
              s.driveScopeLevel = v as GoogleSyncSettings["driveScopeLevel"];
              await this.plugin.saveSettings();
            })
        );
      new Setting(dadv)
        .setName("OAuth client ID (optional)")
        .setDesc("Use your own Google OAuth client instead of the built-in one.")
        .addText((t) =>
          t.setValue(s.oauthClientId).onChange(async (v) => {
            s.oauthClientId = v.trim();
            await this.plugin.saveSettings();
          })
        );
      new Setting(dadv)
        .setName("OAuth client secret (optional)")
        .setDesc("Only if your OAuth client requires one (Google 'Desktop'/'Web' clients do). For a Desktop app it is non-confidential.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(s.oauthClientSecret).onChange(async (v) => {
            s.oauthClientSecret = v.trim();
            await this.plugin.saveSettings();
          });
        });
    }

    // ---------------- Google Cloud Storage ----------------
    new Setting(containerEl)
      .setName("Google Cloud Storage")
      .setDesc("Sync to a bucket in your own Google Cloud project (requires a Google Cloud account).")
      .addToggle((t) =>
        t.setValue(s.gcsEnabled).onChange(async (v) => {
          s.gcsEnabled = v;
          await this.plugin.saveSettings();
          this.display();
        })
      );
    if (s.gcsEnabled) {
      new Setting(containerEl).setName("Bucket").setDesc("Your Cloud Storage bucket name.").addText((t) =>
        t.setValue(s.bucket).onChange(async (v) => {
          s.bucket = v.trim();
          await this.plugin.saveSettings();
        })
      );
      new Setting(containerEl).setName("Prefix (optional)").setDesc("A key prefix inside the bucket.").addText((t) =>
        t.setValue(s.prefix).onChange(async (v) => {
          s.prefix = v.trim();
          await this.plugin.saveSettings();
        })
      );
      const gbase = s.gcsToken ? "✓ Connected (OAuth)." : s.gcsSecret ? "✓ Using an HMAC key." : "Not connected.";
      const gstatus = (s.gcsToken || s.gcsSecret) && s.backendLastSync.gcs ? `${gbase} Last synced ${relativeTime(s.backendLastSync.gcs, Date.now())}.` : gbase;
      const grow = new Setting(containerEl)
        .setDesc(gstatus)
        .addButton((b) => b.setButtonText(s.gcsToken ? "Reconnect" : "Connect Google Cloud").setCta().onClick(() => this.connect("gcs")));
      if (s.gcsToken || s.gcsSecret)
        grow.addButton((b) =>
          b.setButtonText("Disconnect").setWarning().onClick(async () => {
            await c.disconnectGcs();
            this.notify("Google Cloud disconnected.");
            this.display();
          })
        );
      new Setting(containerEl)
        .setName("Backup mode (never delete local files)")
        .setDesc("Off (default): a true two-way sync — deletions sync across devices, but are recoverable (moved to your trash) and a mass deletion is halted for safety. On: a file missing in the bucket is re-uploaded instead of deleted locally — choose this only for a one-way single-device → bucket backup.")
        .addToggle((t) =>
          t.setValue(s.gcsProtectLocal).onChange(async (v) => {
            s.gcsProtectLocal = v;
            await this.plugin.saveSettings();
          })
        );
      const gadv = containerEl.createEl("details");
      gadv.createEl("summary", { text: "Advanced — HMAC key (least privilege), region" });
      gadv.createEl("p", {
        text:
          "OAuth grants read/write to every bucket your Google account can access (GCS has no per-bucket OAuth scope). " +
          "For least privilege, use an HMAC key tied to a bucket-scoped service account instead.",
      });
      let accessId = s.accessId;
      let secret = "";
      new Setting(gadv).setName("HMAC Access ID").addText((t) => t.setValue(accessId).onChange((v) => (accessId = v)));
      new Setting(gadv).setName("HMAC Secret").addText((t) => {
        t.inputEl.type = "password";
        t.onChange((v) => (secret = v));
      });
      new Setting(gadv).addButton((b) =>
        b.setButtonText("Save HMAC key").onClick(async () => {
          try {
            await c.saveGcsCredentials(accessId, secret);
            this.notify("HMAC key saved.");
            this.display();
          } catch (e) {
            this.notify((e as Error).message);
          }
        })
      );
      new Setting(gadv)
        .setName("Region / service")
        .setDesc("SigV4 credential scope. Defaults: auto / s3.")
        .addText((t) =>
          t.setPlaceholder("auto").setValue(s.region).onChange(async (v) => {
            s.region = v.trim();
            await this.plugin.saveSettings();
          })
        )
        .addText((t) =>
          t.setPlaceholder("s3").setValue(s.service).onChange(async (v) => {
            s.service = v.trim();
            await this.plugin.saveSettings();
          })
        );
      new Setting(gadv)
        .setName("OAuth client ID (optional)")
        .setDesc("Use your own Google OAuth client instead of the built-in one.")
        .addText((t) =>
          t.setValue(s.oauthClientId).onChange(async (v) => {
            s.oauthClientId = v.trim();
            await this.plugin.saveSettings();
          })
        );
      new Setting(gadv)
        .setName("OAuth client secret (optional)")
        .setDesc("Only if your OAuth client requires one. For a Desktop app it is non-confidential.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(s.oauthClientSecret).onChange(async (v) => {
            s.oauthClientSecret = v.trim();
            await this.plugin.saveSettings();
          });
        });
    }

    // ---------------- Sync behaviour ----------------
    new Setting(containerEl).setName("Sync").setHeading();
    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(`Last synced: ${s.lastSyncAt ? `${relativeTime(s.lastSyncAt, Date.now())} (${new Date(s.lastSyncAt).toLocaleString()})` : "never"}`)
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            await this.plugin.runSync();
            this.display();
          })
      );
    new Setting(containerEl)
      .setName("Sync folder")
      .setDesc("Vault-relative folder to sync. Empty = whole vault.")
      .addText((t) =>
        t.setValue(s.syncFolder).onChange(async (v) => {
          s.syncFolder = v.trim();
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl).setName("Auto-sync").addToggle((t) =>
      t.setValue(s.autoSync).onChange(async (v) => {
        s.autoSync = v;
        await this.plugin.saveSettings();
        this.plugin.applyAutoSync();
      })
    );
    new Setting(containerEl).setName("Auto-sync mode").addDropdown((d) =>
      d
        .addOption("interval", "Every X minutes")
        .addOption("on-change", "On every change")
        .setValue(s.autoSyncMode)
        .onChange(async (v) => {
          s.autoSyncMode = v as GoogleSyncSettings["autoSyncMode"];
          await this.plugin.saveSettings();
          this.plugin.applyAutoSync();
        })
    );
    new Setting(containerEl).setName("Auto-sync interval (minutes)").addText((t) =>
      t.setValue(String(s.autoSyncIntervalMinutes)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) {
          s.autoSyncIntervalMinutes = n;
          await this.plugin.saveSettings();
          this.plugin.applyAutoSync();
        }
      })
    );

    // ---------------- Advanced: end-to-end encryption ----------------
    const enc = containerEl.createEl("details");
    enc.createEl("summary", { text: "Advanced: end-to-end encryption" });
    enc.createEl("p", {
      text:
        "Optional. Encrypts note content before upload (zero-knowledge) using a passphrase — off by default, and not needed just to connect. " +
        "If you lose the passphrase, encrypted content is unrecoverable.",
    });
    new Setting(enc).setName("Encrypt content (E2EE)").addToggle((t) =>
      t.setValue(s.e2ee).onChange(async (v) => {
        s.e2ee = v;
        await this.plugin.saveSettings();
      })
    );
    let passphrase = "";
    new Setting(enc).setName("Passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (passphrase = v));
    });
    new Setting(enc).addButton((b) =>
      b.setButtonText("Unlock").onClick(async () => {
        try {
          await c.prepare(passphrase || undefined);
          this.notify(c.ready ? "unlocked." : "nothing to unlock yet.");
        } catch (e) {
          this.notify((e as Error).message);
        }
      })
    );
  }
}
