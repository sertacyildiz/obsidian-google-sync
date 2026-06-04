import { requestUrl } from "obsidian";
import { HttpResponse, HttpSend } from "../providers/RemoteProvider";

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
 * Obsidian transport for providers. `requestUrl` runs in the main process, so it
 * bypasses CORS and lets us send the `Host` + `Authorization` headers SigV4
 * needs (browser `fetch` cannot). `throw: false` → we handle non-2xx ourselves.
 */
export const requestUrlHttp: HttpSend = async (method, url, headers, body) => {
  const res = await withTimeout(
    requestUrl({ url, method, headers, body, throw: false }),
    REQUEST_TIMEOUT_MS,
    `${method} ${hostOf(url)} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
  );
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) h[k.toLowerCase()] = v as string;
  return {
    status: res.status,
    headers: h,
    arrayBuffer: async () => res.arrayBuffer,
    text: async () => res.text,
  };
};

/** Reject with `msg` if `p` has not settled within `ms`; clears its timer either way. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return (Promise.race([p, timeout]) as Promise<T>).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
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
