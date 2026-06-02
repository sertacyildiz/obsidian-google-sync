import { App, Notice, Plugin, PluginSettingTab, Setting, debounce } from "obsidian";
import { DEFAULT_SETTINGS, GoogleSyncSettings } from "./settings";
import { SyncController } from "./SyncController";

export default class GoogleSyncPlugin extends Plugin {
  settings: GoogleSyncSettings = DEFAULT_SETTINGS;
  controller!: SyncController;
  private intervalId: number | null = null;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.controller = new SyncController(this.app, this.settings, () => this.saveData(this.settings));

    this.addRibbonIcon("refresh-cw", "Google Cloud Sync: sync now", () => void this.runSync());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync() });
    this.addCommand({
      id: "lock",
      name: "Lock (forget passphrase)",
      callback: () => {
        this.controller.lock();
        new Notice("Google Cloud Sync: locked.");
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
    if (auto && !this.controller.unlocked) return; // don't nag while locked
    if (this.syncing) {
      new Notice("Google Cloud Sync: a sync is already running…");
      return;
    }
    this.syncing = true;
    try {
      const r = await this.controller.sync();
      const dels = r.deletedLocal.length + r.deletedRemote.length;
      new Notice(
        `Google Cloud Sync: ↑${r.uploaded.length} ↓${r.downloaded.length} ✗${dels} ⚠${r.conflicts.length}` +
          (r.errors.length ? ` — ${r.errors.length} error(s)` : "")
      );
    } catch (e) {
      new Notice(`Google Cloud Sync: ${(e as Error).message}`);
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class GoogleSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GoogleSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Google Cloud Sync").setHeading();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which Google backend to sync to.")
      .addDropdown((d) =>
        d
          .addOption("drive", "Google Drive")
          .addOption("gcs", "Google Cloud Storage")
          .setValue(s.provider)
          .onChange(async (v) => {
            s.provider = v as GoogleSyncSettings["provider"];
            await this.plugin.saveSettings();
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
    new Setting(containerEl)
      .setName("End-to-end encryption")
      .setDesc("Encrypt content before upload (recommended). Requires your passphrase to be unlocked.")
      .addToggle((t) =>
        t.setValue(s.e2ee).onChange(async (v) => {
          s.e2ee = v;
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

    // --- Unlock: shared passphrase (ephemeral, never persisted) ---
    new Setting(containerEl).setName("Unlock").setHeading();
    containerEl.createEl("p", {
      text: "Your passphrase derives the key that unseals stored credentials and powers E2EE. It is never stored.",
    });
    let passphrase = "";
    new Setting(containerEl).setName("Passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (passphrase = v));
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Unlock").onClick(async () => {
        try {
          await this.plugin.controller.unlock(passphrase);
          new Notice("Google Cloud Sync: unlocked.");
        } catch (e) {
          new Notice(`Google Cloud Sync: ${(e as Error).message}`);
        }
      })
    );

    // --- Google Drive ---
    new Setting(containerEl).setName("Google Drive").setHeading();
    new Setting(containerEl)
      .setName("OAuth client ID")
      .setDesc("Your own Desktop OAuth client (Google Cloud Console → Credentials). Public; PKCE, no secret.")
      .addText((t) =>
        t.setValue(s.driveClientId).onChange(async (v) => {
          s.driveClientId = v.trim();
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Scope")
      .setDesc("'App files' (drive.file) is least-privilege and needs no Google verification. 'Full Drive' can sync existing folders.")
      .addDropdown((d) =>
        d
          .addOption("file", "App files only (recommended)")
          .addOption("full", "Full Drive")
          .setValue(s.driveScopeLevel)
          .onChange(async (v) => {
            s.driveScopeLevel = v as GoogleSyncSettings["driveScopeLevel"];
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl).setName("App folder name").addText((t) =>
      t.setValue(s.appFolderName).onChange(async (v) => {
        s.appFolderName = v.trim() || "Obsidian (google-sync)";
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl)
      .setDesc(s.sealedRefreshToken ? "Connected. Re-connect to refresh consent." : "Not connected.")
      .addButton((b) =>
        b
          .setButtonText("Connect Google Drive")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.controller.connectDrive(passphrase);
              new Notice("Google Cloud Sync: Google Drive connected.");
              this.display();
            } catch (e) {
              new Notice(`Google Cloud Sync: ${(e as Error).message}`);
            }
          })
      );

    // --- Google Cloud Storage ---
    new Setting(containerEl).setName("Google Cloud Storage").setHeading();
    new Setting(containerEl).setName("Bucket").addText((t) =>
      t.setValue(s.bucket).onChange(async (v) => {
        s.bucket = v.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl)
      .setName("Prefix")
      .setDesc("Optional key prefix within the bucket.")
      .addText((t) =>
        t.setValue(s.prefix).onChange(async (v) => {
          s.prefix = v.trim();
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
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

    let accessId = s.accessId;
    let secret = "";
    new Setting(containerEl).setName("HMAC Access ID").addText((t) => t.setValue(accessId).onChange((v) => (accessId = v)));
    new Setting(containerEl).setName("HMAC Secret").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (secret = v));
    });
    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Save GCS credentials")
        .setCta()
        .onClick(async () => {
          try {
            await this.plugin.controller.saveGcsCredentials(passphrase, accessId, secret);
            new Notice("Google Cloud Sync: GCS credentials sealed + unlocked.");
            this.display();
          } catch (e) {
            new Notice(`Google Cloud Sync: ${(e as Error).message}`);
          }
        })
    );
  }
}
