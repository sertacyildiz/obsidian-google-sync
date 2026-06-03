import { SyncStateData } from "./sync/types";

/**
 * A stored secret. `enc=false` → `data` is plaintext (kept in data.json, which
 * is never synced). `enc=true` → `data` is an AES-256-GCM blob that requires the
 * optional passphrase to open. Passphrase is opt-in; see THREAT-MODEL.md.
 */
export interface StoredSecret {
  enc: boolean;
  data: string;
}

export interface GoogleSyncSettings {
  provider: "drive" | "gcs";
  // GCS config (non-secret)
  bucket: string;
  prefix: string;
  region: string;
  service: string;
  /** GCS auth: HMAC SigV4 (recommended — tighter scope) or OAuth Bearer (convenience — account-wide). */
  gcsAuthMode: "hmac" | "oauth";
  // sync scope + behaviour
  syncFolder: string; // "" = whole vault
  autoSync: boolean;
  autoSyncMode: "on-change" | "interval";
  autoSyncIntervalMinutes: number;
  /** Optional content end-to-end encryption (requires a passphrase). Default off. */
  e2ee: boolean;
  // GCS HMAC credential — accessId is an identifier; the secret is a StoredSecret (plain or sealed)
  accessId: string;
  gcsSecret: StoredSecret | null;
  // GCS OAuth credential — refresh token (when gcsAuthMode === "oauth")
  gcsToken: StoredSecret | null;
  // OAuth client — public (PKCE); SHARED by the Drive + GCS "Connect" buttons. Refresh tokens are StoredSecrets.
  oauthClientId: string;
  driveScopeLevel: "file" | "full";
  appFolderName: string;
  driveToken: StoredSecret | null;
  // crypto — salt is set only once a passphrase is in use (non-secret)
  salt: string | null;
  // last-synced baseline
  state: SyncStateData;
}

export const DEFAULT_SETTINGS: GoogleSyncSettings = {
  provider: "drive",
  bucket: "",
  prefix: "",
  region: "auto",
  service: "s3",
  gcsAuthMode: "hmac",
  syncFolder: "",
  autoSync: false,
  autoSyncMode: "interval",
  autoSyncIntervalMinutes: 15,
  e2ee: false,
  accessId: "",
  gcsSecret: null,
  gcsToken: null,
  oauthClientId: "",
  driveScopeLevel: "file",
  appFolderName: "Obsidian (google-cloud-sync)",
  driveToken: null,
  salt: null,
  state: {},
};
