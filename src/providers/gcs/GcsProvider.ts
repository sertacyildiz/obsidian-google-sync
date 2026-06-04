import { HttpResponse, HttpSend, PutResult, RemoteObject, RemoteProvider } from "../RemoteProvider";
import { GcsAuthorizer } from "./auth";
import { encodeKeyPath } from "./sigv4";

export const GCS_ENDPOINT = "https://storage.googleapis.com";

export interface GcsConfig {
  bucket: string;
  /** Optional key prefix within the bucket ("" = bucket root). */
  prefix: string;
  /** Default `GCS_ENDPOINT`. */
  endpoint: string;
}

/**
 * GCS provider over the S3-compatible XML API. Request construction + response
 * parsing live here; authentication is injected (`GcsAuthorizer`: HMAC SigV4 or
 * OAuth2 Bearer) and so is transport (`HttpSend`: Obsidian `requestUrl` in-app,
 * node `https` in the pilots).
 */
export class GcsProvider implements RemoteProvider {
  readonly id = "gcs";

  constructor(
    private readonly cfg: GcsConfig,
    private readonly authorize: GcsAuthorizer,
    private readonly http: HttpSend
  ) {}

  private keyFor(path: string): string {
    const pfx = this.cfg.prefix ? this.cfg.prefix.replace(/\/+$/, "") + "/" : "";
    return pfx + path.replace(/^\/+/, "");
  }

  private objectUrl(path: string): URL {
    return new URL(`${this.cfg.endpoint}/${this.cfg.bucket}/${encodeKeyPath(this.keyFor(path))}`);
  }

  private async send(
    method: string,
    url: URL,
    payload: ArrayBuffer | undefined,
    extraHeaders: Record<string, string>
  ): Promise<HttpResponse> {
    const headers = await this.authorize(method, url, payload, extraHeaders, new Date());
    return this.http(method, url.toString(), headers, payload);
  }

  async put(path: string, data: ArrayBuffer, contentType = "application/octet-stream"): Promise<PutResult> {
    const res = await this.send("PUT", this.objectUrl(path), data, { "content-type": contentType });
    if (res.status < 200 || res.status >= 300) throw await gcsError("PUT", path, res);
    return { version: versionOf(res) };
  }

  async get(path: string): Promise<ArrayBuffer | null> {
    const res = await this.send("GET", this.objectUrl(path), undefined, {});
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw await gcsError("GET", path, res);
    return res.arrayBuffer();
  }

  async head(path: string): Promise<RemoteObject | null> {
    const res = await this.send("HEAD", this.objectUrl(path), undefined, {});
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw await gcsError("HEAD", path, res);
    return { path, version: versionOf(res), size: Number(res.headers["content-length"] ?? "0"), mtime: msOf(res.headers["last-modified"]) };
  }

  async delete(path: string): Promise<void> {
    const res = await this.send("DELETE", this.objectUrl(path), undefined, {});
    if (res.status === 404 || (res.status >= 200 && res.status < 300)) return;
    throw await gcsError("DELETE", path, res);
  }

  async list(prefix = ""): Promise<RemoteObject[]> {
    const fullPrefix = this.keyFor(prefix);
    const out: RemoteObject[] = [];
    let marker: string | undefined;
    for (;;) {
      const url = new URL(`${this.cfg.endpoint}/${this.cfg.bucket}`);
      if (fullPrefix) url.searchParams.set("prefix", fullPrefix);
      if (marker) url.searchParams.set("marker", marker);
      const res = await this.send("GET", url, undefined, {});
      if (res.status < 200 || res.status >= 300) throw await gcsError("LIST", prefix, res);
      const xml = await res.text();
      out.push(...parseListXml(xml, this.cfg.prefix));
      if (matchTag(xml, "IsTruncated") !== "true") break;
      const last = lastKey(xml);
      if (!last) break;
      marker = last;
    }
    return out;
  }
}

/** Normalize an ETag for change detection — strip surrounding quotes. */
function etagOf(raw: string | undefined): string {
  return (raw ?? "").replace(/"/g, "");
}

/** `LastModified` (ISO8601) / `Last-Modified` (RFC1123) → epoch ms; `undefined` if absent/unparseable. */
function msOf(t?: string): number | undefined {
  if (!t) return undefined;
  const n = Date.parse(t);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Object version for change detection. MUST be sourced identically by put/head
 * and list — both use the ETag (list responses don't carry x-goog-generation),
 * so prefer ETag and only fall back to generation when no ETag is present.
 */
function versionOf(res: HttpResponse): string {
  return etagOf(res.headers["etag"]) || (res.headers["x-goog-generation"] ?? "");
}

async function gcsError(op: string, path: string, res: HttpResponse): Promise<Error> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* body unavailable */
  }
  return new Error(`GCS ${op} ${path || "/"} failed: ${res.status} ${detail}`.trim());
}

function matchTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : undefined;
}

function lastKey(xml: string): string | undefined {
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)];
  return keys.length ? keys[keys.length - 1][1] : undefined;
}

/** Parse an S3/GCS XML list response. Exported for testing against real GCS output. */
export function parseListXml(xml: string, stripPrefix: string): RemoteObject[] {
  const objects: RemoteObject[] = [];
  const pfx = stripPrefix ? stripPrefix.replace(/\/+$/, "") + "/" : "";
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const key = matchTag(block, "Key") ?? "";
    const path = pfx && key.startsWith(pfx) ? key.slice(pfx.length) : key;
    objects.push({ path, version: etagOf(matchTag(block, "ETag")), size: Number(matchTag(block, "Size") ?? "0"), mtime: msOf(matchTag(block, "LastModified")) });
  }
  return objects;
}
