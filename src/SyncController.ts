import { App, Platform } from "obsidian";
import { GCS_ENDPOINT, GcsProvider } from "./providers/gcs/GcsProvider";
import { GCS_OAUTH_SCOPE, bearerAuthorizer, sigv4Authorizer } from "./providers/gcs/auth";
import { DriveProvider } from "./providers/drive/DriveProvider";
import { driveScope } from "./providers/drive/DriveAuth";
import { TokenSet, exchangeCode, refreshAccessToken } from "./providers/google/oauth";
import { OAuthBackend, REDIRECT_PAGE_URL, acceptCallback, startRedirectLogin } from "./providers/google/redirectLogin";
import { googleLoginLoopback } from "./obsidian/googleLogin";
import { HttpSend, RemoteProvider } from "./providers/RemoteProvider";
import { SyncEngine } from "./sync/SyncEngine";
import { Cryptor, identityCryptor } from "./sync/Cryptor";
import { SyncReport } from "./sync/types";
import { ObsidianLocalStore } from "./obsidian/ObsidianLocalStore";
import { HashCache } from "./obsidian/HashCache";
import { requestUrlHttp } from "./obsidian/requestUrlHttp";
import { withRetry } from "./util/retry";
import { DEFAULT_APP_FOLDER, GoogleSyncSettings, StoredSecret } from "./settings";
import { deriveAesKey } from "./crypto/aesgcm";
import { PBKDF2_ITERATIONS, PassphraseCryptor, newSalt } from "./crypto/PassphraseCryptor";
import { openSecret, sealSecret } from "./crypto/secret";
import { E2EE_HEADER_PATH, readHeader, unlockRemote } from "./crypto/e2eeHeader";
import { base64Decode, base64Encode } from "./util/base64";

type BackendId = OAuthBackend;

const BACKEND_LABEL: Record<BackendId, string> = { drive: "Google Drive", gcs: "Google Cloud Storage" };

/**
 * What differs between desktop and the mobile app for sign-in. Injected so the
 * phone path can be exercised offline; the plugin uses the default.
 */
export interface ControllerEnv {
  /** Mobile app: sign in through the browser + redirect page instead of the loopback. */
  mobile: boolean;
  /** Open a URL in the system browser. */
  openUrl: (url: string) => void;
}

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
  /** Seals/opens credentials stored with a passphrase (device-local salt, `settings.salt`). */
  private key: CryptoKey | null = null;
  /**
   * E2EE content keys, one per remote folder (see {@link folderKey}), each with the
   * header salt it was derived from — a key is only ever used for that folder, and
   * only while the folder's header still names that salt.
   */
  private contentKeys = new Map<string, { key: CryptoKey; salt: string }>();
  private gcsSecret: string | null = null; // unsealed HMAC secret
  private gcsRefresh: string | null = null; // unsealed GCS OAuth refresh token
  private gcsAccess: { token: string; expiresAt: number } | null = null;
  private driveRefresh: string | null = null; // unsealed Drive refresh token
  private driveAccess: { token: string; expiresAt: number } | null = null;
  private readonly http: HttpSend;
  private readonly env: ControllerEnv;
  /** Mobile only: lets the local listing skip re-reading unchanged files (set by the plugin). */
  hashCache?: HashCache;
  /** Mobile only: caps how many files the local listing reads at once (set by the plugin). */
  maxConcurrentReads?: number;

  constructor(
    private readonly app: App,
    private readonly settings: GoogleSyncSettings,
    private readonly persist: () => Promise<void>,
    http?: HttpSend,
    env?: ControllerEnv
  ) {
    this.http = http ?? withRetry(requestUrlHttp);
    this.env = env ?? { mobile: Platform.isMobileApp, openUrl: (url) => void window.open(url) };
  }

  /** Where Google sends the phone sign-in back to — the redirect URI the user registers on their Web client. */
  get redirectUri(): string {
    return this.settings.oauthRedirectPage.trim() || REDIRECT_PAGE_URL;
  }

  /** The user's own OAuth client id ("" = not configured yet). */
  private clientId(): string {
    return this.settings.oauthClientId.trim();
  }

  /** The OAuth client secret to send, if the client requires one ("" = none / PKCE-only). */
  private clientSecret(): string {
    return this.settings.oauthClientSecret.trim();
  }

  /** True once the user has supplied their own OAuth client id. */
  get hasOAuthClient(): boolean {
    return this.clientId() !== "";
  }

  /**
   * An OAuth refresh token is stored, but no client id is configured — i.e. the
   * token was issued by the built-in client that older versions shipped. Google
   * ties a refresh token to the client that issued it, so such a token can no
   * longer be refreshed and the user has to reconnect with their own client.
   * Surfaced in settings so this shows up as an instruction, not a sync error.
   */
  get needsReconnectForOwnClient(): boolean {
    return !this.hasOAuthClient && (this.settings.driveToken !== null || this.settings.gcsToken !== null);
  }

  /**
   * Every OAuth call needs the user's own client. Thrown as one actionable
   * message rather than letting Google reject the request with `invalid_client`.
   */
  private requireOAuthClient(): void {
    if (this.hasOAuthClient) return;
    throw new Error(
      "No Google OAuth client configured — add your own client ID and secret in settings under the backend's \"OAuth client\" rows, then reconnect."
    );
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
    const backends = this.activeBackends();
    return backends.length > 0 && (!this.settings.e2ee || backends.every((id) => this.contentKeys.has(this.folderKey(id))));
  }

  /**
   * Load stored secrets into memory. Plaintext secrets always load; encrypted
   * ones (legacy) load only when the passphrase is supplied. Called on plugin
   * load (no passphrase) and again from "Unlock" (with passphrase, for E2EE).
   */
  async prepare(passphrase?: string, confirm?: string): Promise<void> {
    if (passphrase && this.settings.salt) {
      this.key = await deriveAesKey(passphrase, base64Decode(this.settings.salt), PBKDF2_ITERATIONS);
    }
    this.gcsSecret = await this.tryLoad(this.settings.gcsSecret);
    this.gcsRefresh = await this.tryLoad(this.settings.gcsToken);
    this.driveRefresh = await this.tryLoad(this.settings.driveToken);
    if (passphrase && this.settings.e2ee) await this.unlockContent(passphrase, confirm);
  }

  /**
   * E2EE: derive each active backend's content key from the salt in its remote
   * header — the same on every device, so the same passphrase opens the same
   * files everywhere. The header is created on first use (see e2eeHeader.ts); a
   * wrong passphrase, a folder that cannot be taken over, or a damaged header is
   * refused and leaves E2EE locked. Each folder's header is kept locally too, to
   * restore it if it goes missing. Keys are swapped in only when every backend
   * unlocked, so a sync already running keeps the keys it started with.
   */
  private async unlockContent(passphrase: string, confirm?: string): Promise<void> {
    const legacySalt = this.settings.salt ? base64Decode(this.settings.salt) : null;
    const keys = new Map<string, { key: CryptoKey; salt: string }>();
    try {
      for (const id of this.activeBackends()) {
        const folder = this.folderKey(id);
        const u = await unlockRemote(this.buildProvider(id), passphrase, { legacySalt, confirm, localCopy: this.settings.e2eeHeaders[folder] ?? null });
        keys.set(folder, { key: u.key, salt: u.salt });
        this.settings.e2eeHeaders[folder] = u.header;
      }
    } catch (e) {
      this.contentKeys = new Map();
      throw e;
    }
    this.contentKeys = keys;
    await this.persist();
  }

  /** Identifies a remote folder: backend, bucket (GCS) and remote root. */
  private folderKey(id: BackendId): string {
    return `${id}:${id === "gcs" ? `${this.settings.bucket}:` : ""}${this.remoteRoot(id)}`;
  }

  /**
   * Before anything syncs, check each backend's folder against the E2EE state.
   * E2EE off: a folder with a header is encrypted — refuse it rather than upload
   * plaintext into it or write its ciphertext into the vault. E2EE on: the key must
   * be for this folder, and the folder's header must still name its salt (another
   * device may have re-initialised it, or it may have been deleted); otherwise the
   * key is dropped and the user unlocks again.
   */
  private async checkFolders(backends: BackendId[]): Promise<Map<BackendId, Cryptor>> {
    const cryptors = new Map<BackendId, Cryptor>();
    for (const id of backends) {
      const remote = this.buildProvider(id);
      if (!this.settings.e2ee) {
        if (await remote.head(E2EE_HEADER_PATH)) {
          throw new Error("This folder is end-to-end encrypted — turn on Encrypt content in settings and unlock with its passphrase.");
        }
        cryptors.set(id, identityCryptor);
        continue;
      }
      const folder = this.folderKey(id);
      const entry = this.contentKeys.get(folder);
      if (!entry) throw new Error("Unlock (passphrase) required for E2EE.");
      const current = await readHeader(remote).catch(() => null);
      if (!current || current.header.salt !== entry.salt) {
        this.contentKeys.delete(folder);
        throw new Error("This folder's encryption header has changed or is missing — Unlock again.");
      }
      cryptors.set(id, PassphraseCryptor.fromKey(entry.key));
    }
    return cryptors;
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
    this.contentKeys.clear();
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
    for (const k of Object.keys(this.settings.syncState)) if (k.startsWith("drive/")) delete this.settings.syncState[k];
    return this.persist();
  }

  disconnectGcs(): Promise<void> {
    this.settings.gcsToken = null;
    this.settings.gcsSecret = null;
    this.settings.accessId = "";
    this.gcsRefresh = null;
    this.gcsAccess = null;
    this.gcsSecret = null;
    for (const k of Object.keys(this.settings.syncState)) if (k.startsWith("gcs/")) delete this.settings.syncState[k];
    return this.persist();
  }

  async saveGcsCredentials(accessId: string, plaintextSecret: string, passphrase?: string): Promise<void> {
    this.settings.accessId = accessId.trim();
    this.settings.gcsSecret = await this.seal(plaintextSecret, passphrase);
    this.settings.gcsAuthMode = "hmac"; // saving an HMAC key selects the HMAC path
    this.gcsSecret = plaintextSecret;
    await this.persist();
  }

  /**
   * Connect a backend with Google OAuth. Desktop: the loopback sign-in, done when
   * this resolves ("connected"). Mobile app: opens the browser and resolves
   * "pending" — the redirect page brings the code back through
   * `obsidian://google-cloud-sync-auth`, and {@link completeRedirectLogin} finishes.
   */
  async connect(backend: BackendId): Promise<"connected" | "pending"> {
    this.requireOAuthClient();
    const scope = backend === "drive" ? driveScope(this.settings.driveScopeLevel) : GCS_OAUTH_SCOPE;
    if (!this.env.mobile) {
      const tokens = await googleLoginLoopback({ clientId: this.clientId(), clientSecret: this.clientSecret(), scope, label: BACKEND_LABEL[backend] });
      await this.storeTokens(backend, tokens);
      return "connected";
    }
    const { pending, authUrl } = await startRedirectLogin({ clientId: this.clientId(), scope, backend, redirectUri: this.redirectUri, now: Date.now() });
    this.settings.pendingAuth = pending;
    // Persist before the browser opens: the OS may kill Obsidian while the browser
    // is in front, and the callback then cold-starts it with only data.json to go on.
    await this.persist();
    this.env.openUrl(authUrl);
    return "pending";
  }

  /**
   * Finish a phone sign-in from its `obsidian://` callback. The pending attempt is
   * spent whatever happens — a rejected or failed callback means tapping Connect
   * again — so a callback link can never be replayed.
   */
  async completeRedirectLogin(params: Record<string, string>): Promise<BackendId> {
    const pending = this.settings.pendingAuth;
    this.settings.pendingAuth = null;
    let accepted: ReturnType<typeof acceptCallback>;
    try {
      accepted = acceptCallback(pending, params, Date.now());
    } finally {
      await this.persist();
    }
    this.requireOAuthClient();
    const tokens = await exchangeCode(
      this.http,
      {
        clientId: this.clientId(),
        clientSecret: this.clientSecret(),
        code: accepted.code,
        codeVerifier: accepted.pending.verifier,
        redirectUri: accepted.pending.redirectUri,
      },
      Date.now()
    );
    await this.storeTokens(accepted.pending.backend, tokens);
    return accepted.pending.backend;
  }

  private async storeTokens(backend: BackendId, tokens: TokenSet): Promise<void> {
    if (!tokens.refreshToken) {
      throw new Error("No refresh token returned — revoke the app at myaccount.google.com and reconnect.");
    }
    const access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    if (backend === "drive") {
      this.settings.driveToken = await this.seal(tokens.refreshToken);
      this.driveRefresh = tokens.refreshToken;
      this.driveAccess = access;
    } else {
      this.settings.gcsToken = await this.seal(tokens.refreshToken);
      this.settings.gcsAuthMode = "oauth"; // connecting via OAuth selects the OAuth path
      this.gcsRefresh = tokens.refreshToken;
      this.gcsAccess = access;
    }
    await this.persist();
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
    const cryptors = await this.checkFolders(backends); // before any backend syncs
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
        new ObsidianLocalStore(this.app, this.settings.syncFolder, this.hashCache, this.maxConcurrentReads),
        this.buildProvider(id),
        cryptors.get(id) as Cryptor,
        () => new Date(),
        this.settings.syncFolder,
        id === "drive" ? this.settings.driveProtectLocal : this.settings.gcsProtectLocal
      );
      // Baseline key = backend + (Drive only) a layout marker + remote root.
      // Drive's on-remote layout changed in 0.4.6 (flat → mirrored folders), so its
      // marker bumps the key: the upgrade starts from an empty baseline and UPLOADS
      // rather than reading the old flat baseline against the new layout and
      // mass-deleting. GCS layout (object keys) is unchanged.
      const stateKey = `${id}${id === "drive" ? "/mirror" : ""}/${this.remoteRoot(id)}`;
      const { state, report } = await engine.sync(this.settings.syncState[stateKey] ?? {}, async (partial) => {
        this.settings.syncState[stateKey] = partial;
        await this.persist();
      });
      this.settings.syncState[stateKey] = state;
      this.settings.backendLastSync[id] = Date.now(); // info only (settings display)
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

  /**
   * The effective remote root for a backend — always ending with the vault name
   * so multiple vaults never collide (Drive: <base folder>/<vault>; GCS:
   * <prefix>/<vault>). The sync baseline is keyed by this, so if it changes
   * (vault rename, folder/prefix change) the next sync starts fresh and UPLOADS,
   * instead of seeing an empty new location as "everything was deleted" and
   * wiping the local vault.
   */
  private remoteRoot(id: BackendId): string {
    const vault = this.app.vault.getName().trim();
    if (id === "drive") return `${this.settings.appFolderName || DEFAULT_APP_FOLDER}/${vault}`;
    return [this.settings.prefix.replace(/^\/+|\/+$/g, ""), vault].filter(Boolean).join("/");
  }

  private buildProvider(id: BackendId): RemoteProvider {
    if (id === "drive") {
      return new DriveProvider({ appFolderName: this.remoteRoot("drive") }, () => this.getDriveToken(), this.http);
    }
    const cfg = { bucket: this.settings.bucket, prefix: this.remoteRoot("gcs"), endpoint: GCS_ENDPOINT };
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
    this.requireOAuthClient();
    const t = await refreshAccessToken(this.http, { clientId: this.clientId(), clientSecret: this.clientSecret(), refreshToken: this.driveRefresh }, Date.now());
    this.driveAccess = { token: t.accessToken, expiresAt: t.expiresAt };
    return t.accessToken;
  }

  private async getGcsToken(): Promise<string> {
    if (this.gcsAccess && this.gcsAccess.expiresAt > Date.now() + 60_000) return this.gcsAccess.token;
    if (!this.gcsRefresh) throw new Error("Connect Google Cloud Storage first.");
    this.requireOAuthClient();
    const t = await refreshAccessToken(this.http, { clientId: this.clientId(), clientSecret: this.clientSecret(), refreshToken: this.gcsRefresh }, Date.now());
    this.gcsAccess = { token: t.accessToken, expiresAt: t.expiresAt };
    return t.accessToken;
  }

}
