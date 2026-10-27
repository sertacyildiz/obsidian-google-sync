/* Offline test: the Obsidian transport (`requestUrlHttp`).
 *  - GCS requests must reach `requestUrl` WITHOUT `host` / `content-length`.
 *    Desktop Obsidian fails any request carrying either with
 *    `net::ERR_INVALID_ARGUMENT` (issue #1) — the mock enforces that rule — and
 *    both GCS authorizers (Bearer and SigV4) emit them.
 *  - Everything else (Authorization, x-amz-*, content-type) and the body must
 *    pass through untouched, so a SigV4 signature that covers `host` stays valid:
 *    the HTTP stack sends the same host / length values itself.
 * Run:
 *   npx esbuild scripts/requesturl-test.ts --bundle --platform=node --format=cjs \
 *     --alias:obsidian=./scripts/_mock-obsidian.ts --outfile=/tmp/ru.cjs && node /tmp/ru.cjs
 */
import { requestUrlCalls } from "obsidian";
import { requestUrlHttp } from "../src/obsidian/requestUrlHttp";
import { GcsProvider, GCS_ENDPOINT } from "../src/providers/gcs/GcsProvider";
import { bearerAuthorizer, sigv4Authorizer } from "../src/providers/gcs/auth";

(globalThis as unknown as { window: unknown }).window = { setTimeout, clearTimeout };

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer | undefined): string => (b ? new TextDecoder().decode(b) : "");
const lastCall = () => requestUrlCalls[requestUrlCalls.length - 1];
const lowerNames = (h: Record<string, string> | undefined): string[] => Object.keys(h ?? {}).map((k) => k.toLowerCase());

/** Run `op`; return its error message, or "" if it succeeded. */
async function errorOf(op: () => Promise<unknown>): Promise<string> {
  try {
    await op();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

const cfg = { bucket: "my-bucket", prefix: "Vault", endpoint: GCS_ENDPOINT };

async function main(): Promise<void> {
  console.log("GCS OAuth (Bearer) — the reported path");
  {
    const gcs = new GcsProvider(cfg, bearerAuthorizer(() => "tok"), requestUrlHttp);
    const err = await errorOf(() => gcs.put("Blog/note.md", enc("hello"), "text/markdown"));
    check("PUT succeeds (no net::ERR_INVALID_ARGUMENT)", err === "");
    const c = lastCall();
    check("PUT reaches requestUrl without host / content-length", !lowerNames(c.headers).some((n) => n === "host" || n === "content-length"));
    check("PUT keeps Authorization + content-type", c.headers?.authorization === "Bearer tok" && c.headers?.["content-type"] === "text/markdown");
    check("PUT body passes through byte-for-byte", dec(c.body) === "hello");
    check("LIST (first request of every sync) succeeds", (await errorOf(() => gcs.list(""))) === "");
  }

  console.log("GCS HMAC (SigV4) — same headers, same failure");
  {
    const gcs = new GcsProvider(
      cfg,
      sigv4Authorizer({ accessId: "GOOGTEST", secret: "secret" }, { region: "auto", service: "s3" }),
      requestUrlHttp
    );
    check("PUT succeeds", (await errorOf(() => gcs.put("Blog/note.md", enc("hello")))) === "");
    const c = lastCall();
    check("PUT reaches requestUrl without host / content-length", !lowerNames(c.headers).some((n) => n === "host" || n === "content-length"));
    check(
      "signature still covers host + content-length (the stack sends the same values)",
      /SignedHeaders=[^,]*\bcontent-length\b/.test(c.headers?.authorization ?? "") && /SignedHeaders=[^,]*\bhost\b/.test(c.headers?.authorization ?? "")
    );
    check("x-amz-date + x-amz-content-sha256 pass through", !!c.headers?.["x-amz-date"] && !!c.headers?.["x-amz-content-sha256"]);
    check("LIST succeeds", (await errorOf(() => gcs.list(""))) === "");
  }

  console.log("Transport — header names are case-insensitive");
  {
    const err = await errorOf(() =>
      requestUrlHttp("PUT", "https://example.test/x", { Host: "example.test", "Content-Length": "2", "X-Keep": "1" }, enc("ok"))
    );
    check("mixed-case Host / Content-Length are dropped too", err === "");
    check("unrelated headers are kept as sent", JSON.stringify(lastCall().headers) === JSON.stringify({ "X-Keep": "1" }));
  }

  console.log(`\n=== requestUrl transport: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("requestUrl test crashed:", (e as Error).message);
  process.exitCode = 1;
});
