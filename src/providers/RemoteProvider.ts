/** A remote object the provider can store. `path` is sync-root-relative (POSIX). */
export interface RemoteObject {
  path: string;
  /** Opaque version (GCS generation / ETag) for change detection. */
  version: string;
  size: number;
}

export interface PutResult {
  version: string;
}

/** Minimal HTTP response shape (adapted from Obsidian `requestUrl` / Node fetch). */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/**
 * Transport seam (DIP). Obsidian wires `requestUrl` — it bypasses CORS and lets
 * us send the `Host` + `Authorization` headers SigV4 requires (browser `fetch`
 * cannot). The Node pilot wires its own fetch/https adapter.
 */
export type HttpSend = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: ArrayBuffer
) => Promise<HttpResponse>;

/**
 * Backend-agnostic contract the sync engine depends on.
 * Implementations MUST NOT log credentials, signing keys, or Authorization headers.
 */
export interface RemoteProvider {
  readonly id: string;
  /** Upload bytes at a sync-root-relative path. */
  put(path: string, data: ArrayBuffer, contentType?: string): Promise<PutResult>;
  /** Download bytes; `null` if the object does not exist. */
  get(path: string): Promise<ArrayBuffer | null>;
  /** Metadata only; `null` if absent. */
  head(path: string): Promise<RemoteObject | null>;
  /** Delete an object (idempotent — missing is success). */
  delete(path: string): Promise<void>;
  /** List objects under an optional prefix (handles pagination internally). */
  list(prefix?: string): Promise<RemoteObject[]>;
}
