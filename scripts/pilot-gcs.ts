/*
 * Phase-1 pilot (HMAC SigV4): prove our signer satisfies the GCS XML API against
 * a real bucket + HMAC key. DEV-ONLY. Credentials from env — never printed.
 * Run: GCS_BUCKET=.. GCS_ACCESS_ID=.. GCS_SECRET=.. sh scripts/run-pilot.sh
 * Optional: GCS_REGION, GCS_SERVICE, GCS_ENDPOINT
 */
import { GcsProvider, GCS_ENDPOINT } from "../src/providers/gcs/GcsProvider";
import { sigv4Authorizer } from "../src/providers/gcs/auth";
import { nodeHttpSend } from "./node-http";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function tryCombo(region: string, service: string): Promise<boolean> {
  const provider = new GcsProvider(
    { bucket: reqEnv("GCS_BUCKET"), prefix: "pilot", endpoint: process.env.GCS_ENDPOINT ?? GCS_ENDPOINT },
    sigv4Authorizer({ accessId: reqEnv("GCS_ACCESS_ID"), secret: reqEnv("GCS_SECRET") }, { region, service }),
    nodeHttpSend
  );

  const path = "hello.txt";
  const msg = `hello gcs ${region}/${service}`;
  try {
    await provider.put(path, new TextEncoder().encode(msg).buffer, "text/plain");
    const got = await provider.get(path);
    const gotText = got ? new TextDecoder().decode(got) : "(null)";
    const head = await provider.head(path);
    const list = await provider.list();
    const listed = list.some((o) => o.path === path);
    await provider.delete(path);
    const after = await provider.get(path);
    const ok = gotText === msg && !!head && listed && after === null;
    console.log(`[${region}/${service}] GET="${gotText}" HEAD.size=${head?.size} LIST.n=${list.length} hit=${listed} delGETnull=${after === null} => ${ok ? "PASS" : "FAIL"}`);
    return ok;
  } catch (e) {
    console.log(`[${region}/${service}] FAIL: ${(e as Error).message}`);
    return false;
  }
}

async function main(): Promise<void> {
  const combos: ReadonlyArray<readonly [string, string]> = process.env.GCS_REGION
    ? [[process.env.GCS_REGION, process.env.GCS_SERVICE ?? "s3"]]
    : [["auto", "s3"], ["us", "s3"], ["us-central1", "s3"], ["auto", "storage"]];
  for (const [region, service] of combos) {
    if (await tryCombo(region, service)) {
      console.log(`\nWORKING COMBO: region="${region}" service="${service}"`);
      return;
    }
  }
  console.log("\nNo combo worked — inspect errors above.");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("pilot crashed:", (e as Error).message);
  process.exitCode = 1;
});
