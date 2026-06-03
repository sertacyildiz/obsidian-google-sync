import { App } from "obsidian";
import { GCS_ENDPOINT, GcsProvider } from "./providers/gcs/GcsProvider";
import { GCS_OAUTH_SCOPE, bearerAuthorizer, sigv4Authorizer } from "./providers/gcs/auth";
import { DriveProvider } from "./providers/drive/DriveProvider";
import { driveScope } from "./providers/drive/DriveAuth";
import { BUILTIN_OAUTH_CLIENT_ID, BUILTIN_OAUTH_CLIENT_SECRET, TokenSet, refreshAccessToken } from "./providers/google/oauth";
import { googleLoginLoopback } from "./obsidian/googleLogin";
import { HttpSend, RemoteProvider } from "./providers/RemoteProvider";
import { SyncEngine } from "./sync/SyncEngine";
import { Cryptor, identityCryptor } from "./sync/Cryptor";
import { SyncReport } from "./sync/types";
import { ObsidianLocalStore } from "./obsidian/ObsidianLocalStore";
import { requestUrlHttp } from "./obsidian/requestUrlHttp";
import { withRetry } from "./util/retry";
import { DEFAULT_APP_FOLDER, GoogleSyncSettings, StoredSecret } from "./settings";
import { deriveAesKey } from "./crypto/aesgcm";
import { PBKDF2_ITERATIONS, PassphraseCryptor, newSalt } from "./crypto/PassphraseCryptor";
import { openSecret, sealSecret } from "./crypto/secret";
import { base64Decode, base64Encode } from "./util/base64";

type BackendId = "drive" | "gcs";

/**
 * Wires the verified core to the plugin. Google Drive and Google Cloud Storage
 * are independent backends — each can be enabled on its own, and when both are
 * enabled the vault syncs to both at once (each keeps its own baseline).
 *
 * Credentials live in the plugin's own data.json, which is never synced. Content
 * E2EE (optional, passphrase) is the privacy layer; the passphrase is held in
 * memory only, never stored.
 */
export class SyncController {
  private key: CryptoKey | null = null;
  private gcsSecret: string | null = null; // unsealed HMAC secret
  private gcsRefresh: string | null = null; // unsealed GCS OAuth refresh token
  private gcsAccess: { token: string; expiresAt: number } | null = null;
  private driveRefresh: string | null = null; // unsealed Drive refresh token
  private driveAccess: { token: string; expiresAt: number } | null = null;
  private readonly http: HttpSend;

  constructor(
    private readonly app: App,
    private readonly settings: GoogleSyncSettings,
    private readonly persist: () => Promise<void>,
    http?: HttpSend
  ) {
    this.http = http ?? withRetry(requestUrlHttp);
  }

  /** The OAuth client id to use: the user's own (Advanced) or the built-in one. */
  private clientId(): string {
    return this.settings.oauthClientId || BUILTIN_OAUTH_CLIENT_ID;
  }

  /** The OAuth client secret to send, if the client requires one ("" = none / PKCE-only). */
  private clientSecret(): string {
    return this.settings.oauthClientSecret || BUILTIN_OAUTH_CLIENT_SECRET;
  }

  /** A passphrase is needed only for E2EE or to open a legacy encrypted credential. */
  get needsPassphrase(): boolean {
    return (
      this.settings.e2ee ||
      this.settings.gcsSecret?.enc === true ||
      this.settings.gcsToken?.enc === true ||
      this.settings.driveToken?.enc === true
    );
  }

  private driveConfigured(): boolean {
    return this.settings.driveEnabled && this.driveRefresh !== null;
  }

  private gcsConfigured(): boolean {
    if (!this.settings.gcsEnabled || !this.settings.bucket) return false;
    return this.settings.gcsAuthMode === "oauth"
      ? this.gcsRefresh !== null
      : this.gcsSecret !== null && !!this.settings.accessId;
  }

  /** Backends that are enabled AND have their credential loaded. */
  private activeBackends(): BackendId[] {
    const ids: BackendId[] = [];
    if (this.driveConfigured()) ids.push("drive");
    if (this.gcsConfigured()) ids.push("gcs");
    return ids;
  }

  /** Ready to sync: at least one backend is configured and E2EE (if on) is unlocked. */
  get ready(): boolean {
    return this.activeBackends().length > 0 && (!this.settings.e2ee || this.key !== null);
  }

  /**
   * Load stored secrets into memory. Plaintext secrets always load; encrypted
   * ones (legacy) load only when the passphrase is supplied. Called on plugin
   * load (no passphrase) and again from "Unlock" (with passphrase, for E2EE).
   */
  async prepare(passphrase?: string): Promise<void> {
    if (passphrase && this.settings.salt) {
      this.key = await deriveAesKey(passphrase, base64Decode(this.settings.salt), PBKDF2_ITERATIONS);
    }
    this.gcsSecret = await this.tryLoad(this.settings.gcsSecret);
    this.gcsRefresh = await this.tryLoad(this.settings.gcsToken);
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
    this.gcsRefresh = null;
    this.gcsAccess = null;
    this.driveRefresh = null;
    this.driveAccess = null;
  }

  disconnectDrive(): Promise<void> {
    this.settings.driveToken = null;
    this.driveRefresh = null;
    this.driveAccess = null;
    delete this.settings.syncState.drive;
    return this.persist();
  }

  disconnectGcs(): Promise<void> {
    this.settings.gcsToken = null;
    this.settings.gcsSecret = null;
    this.settings.accessId = "";
    this.gcsRefresh = null;
    this.gcsAccess = null;
    this.gcsSecret = null;
    delete this.settings.syncState.gcs;
    return this.persist();
  }

  async saveGcsCredentials(accessId: string, plaintextSecret: string, passphrase?: string): Promise<void> {
    this.settings.accessId = accessId.trim();
    this.settings.gcsSecret = await this.seal(plaintextSecret, passphrase);
    this.settings.gcsAuthMode = "hmac"; // saving an HMAC key selects the HMAC path
    this.gcsSecret = plaintextSecret;
    await this.persist();
  }

  async connectDrive(passphrase?: string): Promise<void> {
    const tokens = await this.login(driveScope(this.settings.driveScopeLevel), "Google Drive");
    this.settings.driveToken = await this.seal(tokens.refreshToken as string, passphrase);
    this.driveRefresh = tokens.refreshToken as string;
    this.driveAccess = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    await this.persist();
  }

  async connectGcs(passphrase?: string): Promise<void> {
    const tokens = await this.login(GCS_OAUTH_SCOPE, "Google Cloud Storage");
    this.settings.gcsToken = await this.seal(tokens.refreshToken as string, passphrase);
    this.settings.gcsAuthMode = "oauth"; // connecting via OAuth selects the OAuth path
    this.gcsRefresh = tokens.refreshToken as string;
    this.gcsAccess = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    await this.persist();
  }

  private async login(scope: string, label: string): Promise<TokenSet> {
    if (!this.clientId()) {
      throw new Error(
        "One-click sign-in isn't set up in this build yet — add your own OAuth Client ID under Advanced."
      );
    }
    const tokens = await googleLoginLoopback({ clientId: this.clientId(), clientSecret: this.clientSecret(), scope, label });
    if (!tokens.refreshToken) {
      throw new Error("No refresh token returned — revoke the app at myaccount.google.com and reconnect.");
    }
    return tokens;
  }

  async sync(): Promise<SyncReport> {
    const backends = this.activeBackends();
    if (backends.length === 0) {
      throw new Error(
        this.needsPassphrase && !this.key
          ? "Locked — enter your passphrase to unlock."
          : "Nothing to sync — enable and connect Google Drive or Google Cloud in settings."
      );
    }
    const cryptor = this.buildCryptor();
    const merged: SyncReport = {
      uploaded: [],
      downloaded: [],
      deletedLocal: [],
      deletedRemote: [],
      conflicts: [],
      errors: [],
    };
    for (const id of backends) {
      const engine = new SyncEngine(
        new ObsidianLocalStore(this.app, this.settings.syncFolder),
        this.buildProvider(id),
        cryptor,
        () => new Date(),
        this.settings.syncFolder
      );
      const { state, report } = await engine.sync(this.settings.syncState[id] ?? {});
      this.settings.syncState[id] = state;
      merged.uploaded.push(...report.uploaded);
      merged.downloaded.push(...report.downloaded);
      merged.deletedLocal.push(...report.deletedLocal);
      merged.deletedRemote.push(...report.deletedRemote);
      merged.conflicts.push(...report.conflicts);
      merged.errors.push(...report.errors);
    }
    this.settings.lastSyncAt = Date.now();
    await this.persist();
    return merged;
  }

  private buildProvider(id: BackendId): RemoteProvider {
    // Each vault syncs under its own name so multiple vaults never collide:
    // Drive → <base folder>/<vault>; GCS → <prefix>/<vault>.
    const vault = this.app.vault.getName().trim();
    if (id === "drive") {
      const base = this.settings.appFolderName || DEFAULT_APP_FOLDER;
      return new DriveProvider(
        { appFolderName: `${base}/${vault}` },
        () => this.getDriveToken(),
        this.http
      );
    }
    const prefix = [this.settings.prefix.replace(/^\/+|\/+$/g, ""), vault].filter(Boolean).join("/");
    const cfg = { bucket: this.settings.bucket, prefix, endpoint: GCS_ENDPOINT };
    if (this.settings.gcsAuthMode === "oauth") {
      return new GcsProvider(cfg, bearerAuthorizer(() => this.getGcsToken()), this.http);
    }
    return new GcsProvider(
      cfg,
      sigv4Authorizer(
        { accessId: this.settings.accessId, secret: this.gcsSecret as string },
        { region: this.settings.region || "auto", service: this.settings.service || "s3" }
      ),
      this.http
    );
  }

  private async getDriveToken(): Promise<string> {
    if (this.driveAccess && this.driveAccess.expiresAt > Date.now() + 60_000) return this.driveAccess.token;
    if (!this.driveRefresh) throw new Error("Connect Google Drive first.");
    const t = await refreshAccessToken(this.http, { clientId: this.clientId(), clientSecret: this.clientSecret(), refreshToken: this.driveRefresh }, Date.now());
    this.driveAccess = { token: t.accessToken, expiresAt: t.expiresAt };
    return t.accessToken;
  }

  private async getGcsToken(): Promise<string> {
    if (this.gcsAccess && this.gcsAccess.expiresAt > Date.now() + 60_000) return this.gcsAccess.token;
    if (!this.gcsRefresh) throw new Error("Connect Google Cloud Storage first.");
    const t = await refreshAccessToken(this.http, { clientId: this.clientId(), clientSecret: this.clientSecret(), refreshToken: this.gcsRefresh }, Date.now());
    this.gcsAccess = { token: t.accessToken, expiresAt: t.expiresAt };
    return t.accessToken;
  }

  private buildCryptor(): Cryptor {
    if (!this.settings.e2ee) return identityCryptor;
    if (!this.key) throw new Error("Unlock (passphrase) required for E2EE.");
    return PassphraseCryptor.fromKey(this.key);
  }
}
