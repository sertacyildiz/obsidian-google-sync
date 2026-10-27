import { requestUrl } from "obsidian";
import { HttpSend } from "../providers/RemoteProvider";

/**
 * Hard ceiling for a single request. Obsidian's `requestUrl` has no built-in
 * timeout, so a connection that opens but never responds (dead network, captive
 * portal, a stalled endpoint) would hang the awaited call forever — which leaves
 * the whole sync pending and the "a sync is already running" lock stuck until
 * Obsidian is reloaded. Bounding each request guarantees the sync always settles
 * (the lock clears) and the user sees an error they can retry. Generous enough
 * for a single file/list-page on a slow link; a stall past this is treated as
 * dead rather than waited on.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Headers the HTTP stack writes itself, and that desktop Obsidian refuses to
 * take from a caller: `requestUrl` hands the request to Electron's
 * `net.request`, whose network service fails a request carrying either one with
 * `net::ERR_INVALID_ARGUMENT` before anything is sent (issue #1; reproduced
 * against Electron 39.7.0, Obsidian 1.13.7's runtime). The GCS authorizers still
 * emit both — SigV4 has to sign them, and the Node transport the pilots use
 * needs an explicit length — so they are dropped here, at the one transport that
 * cannot carry them. The stack then sends the same host and body length that
 * were signed, so the signature stays valid.
 */
const STACK_OWNED_HEADERS = new Set(["host", "content-length"]);

function withoutStackOwnedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (!STACK_OWNED_HEADERS.has(k.toLowerCase())) out[k] = v;
  return out;
}

/**
 * Obsidian transport for providers. `requestUrl` runs in the main process, so it
 * bypasses CORS and lets us send the `Authorization` (and SigV4 `x-amz-*`)
 * headers browser `fetch` would preflight or refuse. `throw: false` → we handle
 * non-2xx ourselves.
 */
export const requestUrlHttp: HttpSend = async (method, url, headers, body) => {
  const res = await withTimeout(
    requestUrl({ url, method, headers: withoutStackOwnedHeaders(headers), body, throw: false }),
    REQUEST_TIMEOUT_MS,
    `${method} ${hostOf(url)} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
  );
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) h[k.toLowerCase()] = v;
  return {
    status: res.status,
    headers: h,
    arrayBuffer: async () => res.arrayBuffer,
    text: async () => res.text,
  };
};

/**
 * Reject with `msg` if `p` has not settled within `ms`; clears its timer either
 * way. Uses `window.setTimeout` so the timer belongs to the window the plugin is
 * running in — a bare `setTimeout` breaks in Obsidian's popout windows.
 */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(msg)), ms);
  });
  return (Promise.race([p, timeout]) as Promise<T>).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

/** Host only, for a privacy-safe timeout message (never the full URL with query). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "request";
  }
}
