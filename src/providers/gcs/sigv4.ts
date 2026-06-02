/**
 * Minimal AWS Signature Version 4 signer for the Google Cloud Storage XML API,
 * implemented with Web Crypto only (no Node APIs, no AWS SDK). This is deliberate:
 * the AWS SDK's modern default integrity headers (`x-amz-checksum-*`, chunked
 * `STREAMING-…` payload signing) are REJECTED by GCS with `SignatureDoesNotMatch`.
 * We emit a single-shot `x-amz-content-sha256: <hex>`, which GCS accepts.
 *
 * SECURITY: never log the secret, the derived signing key, or the produced
 * Authorization header.
 */

export interface Sigv4Credentials {
  /** GCS HMAC access ID. */
  accessId: string;
  /** GCS HMAC secret. Held in memory only; never logged. */
  secret: string;
}

export interface Sigv4Options {
  /**
   * Credential-scope region. GCS S3-interop typically accepts "auto"; the
   * Phase-1 pilot confirms the exact accepted value empirically.
   */
  region: string;
  /** Credential-scope service. S3-style interop uses "s3". */
  service: string;
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmacSha256(key: Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/** RFC3986 encoding: encodeURIComponent plus the chars it leaves unescaped. */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Encode an object key into a URL path: strict RFC3986 per segment, preserving
 * "/". The provider builds request URLs with this so the wire path and the
 * signed canonical URI (`url.pathname`) are byte-identical and unambiguous
 * (notably for spaces, unicode, and `+`).
 */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(rfc3986).join("/");
}

function formatAmzDate(now: Date): { amzDate: string; dateStamp: string } {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const y = now.getUTCFullYear();
  const mo = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const h = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const s = pad(now.getUTCSeconds());
  return { amzDate: `${y}${mo}${d}T${h}${mi}${s}Z`, dateStamp: `${y}${mo}${d}` };
}

function lowercaseKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Sign a request for the GCS XML API and return the headers to send.
 * @param payload request body for PUT; `undefined` for GET/HEAD/DELETE/LIST.
 * @param now injectable clock (testability + determinism).
 */
export async function signRequest(
  creds: Sigv4Credentials,
  opts: Sigv4Options,
  method: string,
  url: URL,
  payload: ArrayBuffer | undefined,
  extraHeaders: Record<string, string>,
  now: Date
): Promise<SignedRequest> {
  const { amzDate, dateStamp } = formatAmzDate(now);
  const payloadHash = await sha256Hex(payload ?? "");

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...lowercaseKeys(extraHeaders),
  };
  // Match standard S3 clients (e.g. aws4): when there is a body, include and
  // sign Content-Length. GCS/S3 honour the SignedHeaders list, so binding it
  // is the stricter, safer choice.
  if (payload !== undefined) {
    headers["content-length"] = String(payload.byteLength);
  }

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n].trim()}`).join("\n") + "\n";
  const signedHeaders = sortedNames.join(";");

  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");

  const canonicalRequest = [
    method,
    // S3/GCS canonical URI is the path exactly as sent on the wire (already
    // percent-encoded by the URL parser) — do NOT decode-then-re-encode, which
    // diverges from the reference signer (and the request) on spaces/unicode.
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmacSha256(encoder.encode("AWS4" + creds.secret), dateStamp);
  const kRegion = await hmacSha256(new Uint8Array(kDate), opts.region);
  const kService = await hmacSha256(new Uint8Array(kRegion), opts.service);
  const kSigning = await hmacSha256(new Uint8Array(kService), "aws4_request");
  const signature = toHex(await hmacSha256(new Uint8Array(kSigning), stringToSign));

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${creds.accessId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: url.toString(), method, headers };
}
