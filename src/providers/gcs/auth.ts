import { signRequest, Sigv4Credentials, Sigv4Options } from "./sigv4";

/**
 * Produces the headers (including Authorization) to send for a GCS XML-API
 * request. The GCS XML API accepts two auth schemes; we model both as
 * authorizers so the provider's request/response code is auth-agnostic:
 *   - HMAC SigV4 (the normal user path),
 *   - OAuth2 Bearer (used by the dev pilot, and a valid alternative).
 * Authorizers MUST NOT log the credential, token, or produced headers.
 */
export type GcsAuthorizer = (
  method: string,
  url: URL,
  payload: ArrayBuffer | undefined,
  extraHeaders: Record<string, string>,
  now: Date
) => Promise<Record<string, string>>;

export function sigv4Authorizer(creds: Sigv4Credentials, opts: Sigv4Options): GcsAuthorizer {
  return async (method, url, payload, extra, now) =>
    (await signRequest(creds, opts, method, url, payload, extra, now)).headers;
}

export function bearerAuthorizer(getToken: () => Promise<string> | string): GcsAuthorizer {
  return async (_method, url, payload, extra) => {
    const headers: Record<string, string> = {
      host: url.host,
      authorization: `Bearer ${await getToken()}`,
    };
    for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
    if (payload !== undefined) headers["content-length"] = String(payload.byteLength);
    return headers;
  };
}
