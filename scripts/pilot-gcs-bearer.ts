/*
 * Phase-1 pilot (OAuth Bearer): exercise the real GcsProvider (URL construction,
 * methods, content handling, XML list parsing, pagination, 404) against REAL GCS
 * using a SHORT-LIVED OAuth access token — no long-lived HMAC secret is created
 * (org-policy friendly + minimal leak surface). Signing correctness is proven
 * separately by scripts/sigv4-difftest.ts.
 *
 * Run: GCS_BUCKET=.. GCS_BEARER=$(gcloud auth print-access-token) \
 *        sh scripts/run-pilot.sh scripts/pilot-gcs-bearer.ts
 */
import { GcsProvider, GCS_ENDPOINT } from "../src/providers/gcs/GcsProvider";
import { bearerAuthorizer } from "../src/providers/gcs/auth";
import { nodeHttpSend } from "./node-http";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const provider = new GcsProvider(
    { bucket: reqEnv("GCS_BUCKET"), prefix: "pilot-bearer", endpoint: GCS_ENDPOINT },
    bearerAuthorizer(() => reqEnv("GCS_BEARER")),
    nodeHttpSend
  );

  const a = "notes/a.md";
  const b = "notes/sub/b.md";
  const msgA = "# A\nalpha";
  let ok = true;
  const check = (label: string, cond: boolean) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
    ok = ok && cond;
  };

  await provider.put(a, new TextEncoder().encode(msgA).buffer, "text/markdown");
  await provider.put(b, new TextEncoder().encode("# B\nbeta").buffer, "text/markdown");

  const gotA = await provider.get(a);
  check("GET returns the bytes we PUT", !!gotA && new TextDecoder().decode(gotA) === msgA);

  const head = await provider.head(a);
  check("HEAD returns size + version", !!head && head.size === new TextEncoder().encode(msgA).length && !!head.version);

  const all = await provider.list();
  check("LIST sees both objects (real GCS XML parsed)", all.some((o) => o.path === a) && all.some((o) => o.path === b));

  const sub = await provider.list("notes/sub/");
  check("LIST honours prefix filter", sub.some((o) => o.path === b) && !sub.some((o) => o.path === a));

  check("GET missing object => null", (await provider.get("does/not/exist.md")) === null);

  await provider.delete(a);
  await provider.delete(b);
  check("after DELETE, GET => null", (await provider.get(a)) === null && (await provider.get(b)) === null);

  console.log(`\n=== BEARER GCS ROUND-TRIP: ${ok ? "PASS" : "FAIL"} ===`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error("bearer pilot crashed:", (e as Error).message);
  process.exitCode = 1;
});
