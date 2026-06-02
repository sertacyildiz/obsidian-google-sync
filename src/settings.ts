import { SyncStateData } from "./sync/types";

export interface GoogleSyncSettings {
  provider: "gcs" | "drive";
  // GCS config (non-secret)
  bucket: string;
  prefix: string;
  region: string;
  service: string;
  // sync scope + behaviour
  syncFolder: string; // "" = whole vault
  autoSync: boolean;
  autoSyncMode: "on-change" | "interval";
  autoSyncIntervalMinutes: number;
  e2ee: boolean;
  // GCS credential — accessId is an identifier; the secret is sealed (never plaintext)
  accessId: string;
  salt: string | null; // base64; non-secret
  sealedSecret: string | null; // AES-GCM sealed HMAC secret
  // Drive credential — clientId is public (installed-app PKCE); refresh token is sealed
  driveClientId: string;
  driveScopeLevel: "file" | "full";
  appFolderName: string;
  sealedRefreshToken: string | null;
  // last-synced baseline
  state: SyncStateData;
}

export const DEFAULT_SETTINGS: GoogleSyncSettings = {
  provider: "drive",
  bucket: "",
  prefix: "",
  region: "auto",
  service: "s3",
  syncFolder: "",
  autoSync: false,
  autoSyncMode: "interval",
  autoSyncIntervalMinutes: 15,
  e2ee: true,
  accessId: "",
  salt: null,
  sealedSecret: null,
  driveClientId: "",
  driveScopeLevel: "file",
  appFolderName: "Obsidian (google-sync)",
  sealedRefreshToken: null,
  state: {},
};
