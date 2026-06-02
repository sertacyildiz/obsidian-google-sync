import https from "node:https";
import type { HttpResponse, HttpSend } from "../src/providers/RemoteProvider";

/** Node `https` transport for the dev pilots (full control of the Host header). */
export const nodeHttpSend: HttpSend = (method, url, headers, body) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            h[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v ?? "");
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: h,
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            text: async () => buf.toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(Buffer.from(body));
    req.end();
  });
