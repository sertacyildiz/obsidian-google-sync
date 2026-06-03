import { App } from "obsidian";
import { GCS_ENDPOINT, GcsProvider } from "./providers/gcs/GcsProvider";
import { sigv4Authorizer } from "./providers/gcs/auth";
import { DriveProvider } from "./providers/drive/DriveProvider";
import { driveScope, refreshAccessToken } from "./providers/drive/DriveAuth";
import { driveLoginLoopback } from "./obsidian/driveLogin";
import { HttpSend, RemoteProvider } from "./providers/RemoteProvider";
import { SyncEngine } from "./sync/SyncEngine";
import { Cryptor, identityCryptor } from "./sync/Cryptor";
import { SyncReport } from "./sync/types";
import { ObsidianLocalStore } from "./obsidian/ObsidianLocalStore";
import { requestUrlHttp } from "./obsidian/requestUrlHttp";
import { withRetry } from "./util/retry";
import { GoogleSyncSettings, StoredSecret } from "./settings";
import { deriveAesKey } from "./crypto/aesgcm";
import { PBKDF2_ITERATIONS, PassphraseCryptor, newSalt } from "./crypto/PassphraseCryptor";
import { openSecret, sealSecret } from "./crypto/secret";
import { base64Decode, base64Encode } from "./util/base64";

/**
 * Wires the verified core to the plugin. The passphrase is OPTIONAL:
 *  - no passphrase → credentials are stored as plaintext in data.json (which is
 *    never synced) and load automatically; OAuth scopes are narrow so the leak
 *    blast-radius is small.
 *  - passphrase set → the credential is AES-256-GCM-sealed at rest, and content
 *    E2EE becomes available. The passphrase is held in memory only, never stored.
 */
export class SyncController {
  private key: CryptoKey | null = null;
  private gcsSecret: string | null = null; // unsealed HMAC secret
  private driveRefresh: string | null = null; // unsealed Drive refresh token
  private driveAccess: { token: string; expiresAt: number } | null = null;
  private readonly http: HttpSend = withRetry(requestUrlHttp);

  constructor(
    private readonly app: App,
    private readonly settings: GoogleSyncSettings,
    private readonly persist: () => Promise<void>
  ) {}

  /** A passphrase is required only if E2EE is on or some stored secret is encrypted. */
  get needsPassphrase(): boolean {
    return this.settings.e2ee || this.settings.gcsSecret?.enc === true || this.settings.driveToken?.enc === true;
  }

  /** Ready to sync: the active provider's credential is loaded and E2EE (if on) is unlocked. */
  get ready(): boolean {
    const providerOk =
      this.settings.provider === "drive"
        ? this.driveRefresh !== null
        : this.gcsSecret !== null && !!this.settings.accessId;
    return providerOk && (!this.settings.e2ee || this.key !== null);
  }

  /**
   * Load stored secrets into memory. Plaintext secrets always load; encrypted
   * ones load only when the passphrase is supplied. Call on plugin load (no
   * passphrase) and again from "Unlock" (with passphrase).
   */
  async prepare(passphrase?: string): Promise<void> {
    if (passphrase && this.settings.salt) {
      this.key = await deriveAesKey(passphrase, base64Decode(this.settings.salt), PBKDF2_ITERATIONS);
    }
    this.gcsSecret = await this.tryLoad(this.settings.gcsSecret);
    this.driveRefresh = await this.tryLoad(this.settings.driveToken);
  }

  private async tryLoad(store: StoredSecret | null): Promise<string | null> {
    if (!store) return null;
    if (!store.enc) return store.data;
    if (!this.key) return null; // encrypted but still locked
    return openSecret(this.key, store.data);
  }

  private async seal(value: string, passphrase?: string): Promise<StoredSecret> {
    if (!passphrase) return { enc: false, data: value };
    const salt = this.settings.salt ? base64Decode(this.settings.salt) : newSalt();
    if (!this.settings.salt) this.settings.salt = base64Encode(salt);
    this.key = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
    return { enc: true, data: await sealSecret(this.key, value) };
  }

  lock(): void {
    this.key = null;
    this.gcsSecret = null;
    this.driveRefresh = null;
    this.driveAccess = null;
  }

  async saveGcsCredentials(accessId: string, plaintextSecret: string, passphrase?: string): Promise<void> {
    this.settings.accessId = accessId.trim();
    this.settings.gcsSecret = await this.seal(plaintextSecret, passphrase);
    this.gcsSecret = plaintextSecret;
    await this.persist();
  }

  async connectDrive(passphrase?: string): Promise<void> {
    if (!this.settings.driveClientId) throw new Error("Enter your Drive OAuth client ID first.");
    const tokens = await driveLoginLoopback({
      clientId: this.settings.driveClientId,
      scope: driveScope(this.settings.driveScopeLevel),
    });
    if (!tokens.refreshToken) {
      throw new Error("No refresh token returned — revoke the app at myaccount.google.com and reconnect.");
    }
    this.settings.driveToken = await this.seal(tokens.refreshToken, passphrase);
    this.driveRefresh = tokens.refreshToken;
    this.driveAccess = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    await this.persist();
  }

  async sync(): Promise<SyncReport> {
    if (!this.ready) {
      throw new Error(
        this.needsPassphrase && !this.key
          ? "Locked — enter your passphrase to unlock."
          : "Not configured — connect a provider in settings first."
      );
    }
    const engine = new SyncEngine(
      new ObsidianLocalStore(this.app, this.settings.syncFolder),
      this.buildProvider(),
      this.buildCryptor(),
      () => new Date(),
      this.settings.syncFolder
    );
    const { state, report } = await engine.sync(this.settings.state);
    this.settings.state = state;
    await this.persist();
    return report;
  }

  private buildProvider(): RemoteProvider {
    if (this.settings.provider === "drive") {
      if (!this.driveRefresh && !this.driveAccess) throw new Error("Connect Google Drive first.");
      return new DriveProvider({ appFolderName: this.settings.appFolderName }, () => this.getDriveToken(), this.http);
    }
    if (!this.gcsSecret || !this.settings.accessId || !this.settings.bucket) {
      throw new Error("Missing GCS bucket / access id / secret.");
    }
    return new GcsProvider(
      { bucket: this.settings.bucket, prefix: this.settings.prefix, endpoint: GCS_ENDPOINT },
      sigv4Authorizer(
        { accessId: this.settings.accessId, secret: this.gcsSecret },
        { region: this.settings.region || "auto", service: this.settings.service || "s3" }
      ),
      this.http
    );
  }

  private async getDriveToken(): Promise<string> {
    if (this.driveAccess && this.driveAccess.expiresAt > Date.now() + 60_000) return this.driveAccess.token;
    if (!this.driveRefresh) throw new Error("Connect Google Drive first.");
    const t = await refreshAccessToken(this.http, { clientId: this.settings.driveClientId, refreshToken: this.driveRefresh }, Date.now());
    this.driveAccess = { token: t.accessToken, expiresAt: t.expiresAt };
    return t.accessToken;
  }

  private buildCryptor(): Cryptor {
    if (!this.settings.e2ee) return identityCryptor;
    if (!this.key) throw new Error("Unlock (passphrase) required for E2EE.");
    return PassphraseCryptor.fromKey(this.key);
  }
}
