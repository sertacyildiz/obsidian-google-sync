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

/** Default Drive folder name when the user leaves the folder field blank. */
export const DEFAULT_APP_FOLDER = "Obsidian Sync";

export interface GoogleSyncSettings {
  // --- Google Drive backend (any Google account) ---
  driveEnabled: boolean;
  driveScopeLevel: "file" | "full";
  /** Drive folder to sync into; "" → DEFAULT_APP_FOLDER. */
  appFolderName: string;
  driveToken: StoredSecret | null;

  // --- Google Cloud Storage backend (your own GCP bucket) ---
  gcsEnabled: boolean;
  bucket: string;
  prefix: string;
  /** GCS auth: OAuth Bearer (one-click default) or HMAC SigV4 (advanced — tighter scope). */
  gcsAuthMode: "oauth" | "hmac";
  region: string;
  service: string;
  accessId: string; // HMAC access id
  gcsSecret: StoredSecret | null; // HMAC secret
  gcsToken: StoredSecret | null; // OAuth refresh token

  // --- shared OAuth client (public; PKCE). Empty → use the built-in client. ---
  oauthClientId: string;

  // --- sync behaviour ---
  syncFolder: string; // "" = whole vault
  autoSync: boolean;
  autoSyncMode: "on-change" | "interval";
  autoSyncIntervalMinutes: number;

  // --- optional content end-to-end encryption (advanced; default off) ---
  e2ee: boolean;
  salt: string | null; // set only once a passphrase is in use

  // --- per-backend last-synced baseline, keyed by backend id ("drive" | "gcs") ---
  syncState: Record<string, SyncStateData>;
}

export const DEFAULT_SETTINGS: GoogleSyncSettings = {
  driveEnabled: false,
  driveScopeLevel: "file",
  appFolderName: DEFAULT_APP_FOLDER,
  driveToken: null,

  gcsEnabled: false,
  bucket: "",
  prefix: "",
  gcsAuthMode: "oauth",
  region: "auto",
  service: "s3",
  accessId: "",
  gcsSecret: null,
  gcsToken: null,

  oauthClientId: "",

  syncFolder: "",
  autoSync: false,
  autoSyncMode: "interval",
  autoSyncIntervalMinutes: 15,

  e2ee: false,
  salt: null,

  syncState: {},
};
