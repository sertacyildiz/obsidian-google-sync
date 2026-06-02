/** A local file as seen by the sync engine (content-hashed for change detection). */
export interface LocalFile {
  path: string;
  hash: string;
  mtime: number;
}

/** Last-synced baseline for one path. Absence of a key = never synced. */
export interface FileState {
  localHash: string;
  remoteVersion: string;
}

export type SyncStateData = Record<string, FileState>;

/** What a sync run did, for UI notices and tests. */
export interface SyncReport {
  uploaded: string[];
  downloaded: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  conflicts: { path: string; conflictPath: string }[];
  errors: { path: string; error: string }[];
}
