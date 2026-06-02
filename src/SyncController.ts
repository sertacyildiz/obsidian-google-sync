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
import { GoogleSyncSettings } from "./settings";
import { deriveAesKey } from "./crypto/aesgcm";
import { PBKDF2_ITERATIONS, PassphraseCryptor, newSalt } from "./crypto/PassphraseCryptor";
import { openSecret, sealSecret } from "./crypto/secret";
import { base64Decode, base64Encode } from "./util/base64";

/**
 * Wires the verified core (SyncEngine + provider + Cryptor + ObsidianLocalStore)
 * to the plugin. One master passphrase (held in memory only) derives the AES key
 * that unseals each provider's credential AND powers content E2EE.
 */
export class SyncController {
  private key: CryptoKey | null = null;
  private secret: string | null = null; // GCS HMAC secret (unsealed)
  private driveRefresh: string | null = null; // Drive refresh token (unsealed)
  private driveAccess: { token: string; expiresAt: number } | null = null;
  /** Transient-failure resilient transport shared by all providers. */
  private readonly http: HttpSend = withRetry(requestUrlHttp);

  constructor(
    private readonly app: App,
    private readonly settings: GoogleSyncSettings,
    private readonly persist: () => Promise<void>
  ) {}

  get unlocked(): boolean {
    return this.key !== null;
  }

  private async ensureKey(passphrase: string): Promise<CryptoKey> {
    if (!passphrase) throw new Error("Passphrase required.");
    const salt = this.settings.salt ? base64Decode(this.settings.salt) : newSalt();
    if (!this.settings.salt) this.settings.salt = base64Encode(salt);
    this.key = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
    return this.key;
  }

  /** Re-derive the key from the stored salt and unseal whatever credentials exist. */
  async unlock(passphrase: string): Promise<void> {
    if (!this.settings.salt) throw new Error("No saved credentials yet — set up a provider first.");
    const key = await deriveAesKey(passphrase, base64Decode(this.settings.salt), PBKDF2_ITERATIONS);
    if (this.settings.sealedSecret) this.secret = await openSecret(key, this.settings.sealedSecret);
    if (this.settings.sealedRefreshToken) this.driveRefresh = await openSecret(key, this.settings.sealedRefreshToken);
    this.key = key;
  }

  lock(): void {
    this.key = null;
    this.secret = null;
    this.driveRefresh = null;
    this.driveAccess = null;
  }

  async saveGcsCredentials(passphrase: string, accessId: string, plaintextSecret: string): Promise<void> {
    const key = await this.ensureKey(passphrase);
    this.settings.accessId = accessId.trim();
    this.settings.sealedSecret = await sealSecret(key, plaintextSecret);
    this.secret = plaintextSecret;
    await this.persist();
  }

  async connectDrive(passphrase: string): Promise<void> {
    const key = await this.ensureKey(passphrase);
    if (!this.settings.driveClientId) throw new Error("Enter your Drive OAuth client ID first.");
    const tokens = await driveLoginLoopback({
      clientId: this.settings.driveClientId,
      scope: driveScope(this.settings.driveScopeLevel),
    });
    if (!tokens.refreshToken) {
      throw new Error("No refresh token returned — revoke the app at myaccount.google.com and reconnect.");
    }
    this.settings.sealedRefreshToken = await sealSecret(key, tokens.refreshToken);
    this.driveRefresh = tokens.refreshToken;
    this.driveAccess = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    await this.persist();
  }

  async sync(): Promise<SyncReport> {
    if (!this.unlocked) throw new Error("Locked — enter your passphrase to unlock first.");
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
      if (!this.driveRefresh && !this.driveAccess) {
        throw new Error("Connect Google Drive first (unlock, then Connect).");
      }
      return new DriveProvider({ appFolderName: this.settings.appFolderName }, () => this.getDriveToken(), this.http);
    }
    if (!this.secret || !this.settings.accessId || !this.settings.bucket) {
      throw new Error("Missing GCS bucket / access id / secret.");
    }
    return new GcsProvider(
      { bucket: this.settings.bucket, prefix: this.settings.prefix, endpoint: GCS_ENDPOINT },
      sigv4Authorizer(
        { accessId: this.settings.accessId, secret: this.secret },
        { region: this.settings.region || "auto", service: this.settings.service || "s3" }
      ),
      this.http
    );
  }

  private async getDriveToken(): Promise<string> {
    if (this.driveAccess && this.driveAccess.expiresAt > Date.now() + 60_000) return this.driveAccess.token;
    if (!this.driveRefresh) throw new Error("Connect Google Drive first (and unlock).");
    const t = await refreshAccessToken(this.http, { clientId: this.settings.driveClientId, refreshToken: this.driveRefresh }, Date.now());
    this.driveAccess = { token: t.accessToken, expiresAt: t.expiresAt };
    return t.accessToken;
  }

  private buildCryptor(): Cryptor {
    if (!this.settings.e2ee) return identityCryptor;
    if (!this.key) throw new Error("Unlock required for E2EE.");
    return PassphraseCryptor.fromKey(this.key);
  }
}
