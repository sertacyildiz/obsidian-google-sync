import { requestUrl } from "obsidian";
import { HttpResponse, HttpSend } from "../providers/RemoteProvider";

/**
 * Obsidian transport for providers. `requestUrl` runs in the main process, so it
 * bypasses CORS and lets us send the `Host` + `Authorization` headers SigV4
 * needs (browser `fetch` cannot). `throw: false` → we handle non-2xx ourselves.
 */
export const requestUrlHttp: HttpSend = async (method, url, headers, body) => {
  const res = await requestUrl({ url, method, headers, body, throw: false });
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) h[k.toLowerCase()] = v as string;
  return {
    status: res.status,
    headers: h,
    arrayBuffer: async () => res.arrayBuffer,
    text: async () => res.text,
  };
};
