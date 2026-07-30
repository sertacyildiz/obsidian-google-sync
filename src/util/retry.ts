import { HttpResponse, HttpSend } from "../providers/RemoteProvider";

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
/** `window.setTimeout`, not the bare global — the bare one breaks in popout windows. */
const delay = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/**
 * Wrap an HttpSend with exponential backoff + jitter on transient statuses.
 * All wrapped operations (PUT/GET/HEAD/DELETE/LIST) are safe to retry.
 */
export function withRetry(http: HttpSend, retries = 3, baseMs = 600): HttpSend {
  return async (method, url, headers, body) => {
    let res: HttpResponse = await http(method, url, headers, body);
    for (let attempt = 0; attempt < retries && TRANSIENT.has(res.status); attempt++) {
      await delay(baseMs * 2 ** attempt + Math.floor(Math.random() * 200));
      res = await http(method, url, headers, body);
    }
    return res;
  };
}
