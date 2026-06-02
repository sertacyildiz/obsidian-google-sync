/*
 * Offline correctness proof for our SigV4 signer: sign identical requests with
 * our implementation AND the battle-tested `aws4` library, then assert the
 * Authorization headers are byte-identical. No cloud credentials, no network.
 * Uses throwaway/dummy keys only.
 */
import aws4 from "aws4";
import { encodeKeyPath, signRequest } from "../src/providers/gcs/sigv4";

const creds = {
  accessId: "GOOG1EXAMPLEACCESSID0000000000000000000000000000000000000000000",
  secret: "EXAMPLEdummySecret/Key+abcdefghijklmnopqrstuvwx0123",
};
const region = "us-east-1";
const service = "s3";
const fixedDate = new Date("2026-01-01T00:00:00Z");
const amz = "20260101T000000Z";

async function check(
  label: string,
  method: string,
  rawUrl: string,
  body: ArrayBuffer | undefined,
  extra: Record<string, string>
): Promise<boolean> {
  const url = new URL(rawUrl);

  const ours = await signRequest(
    { accessId: creds.accessId, secret: creds.secret },
    { region, service },
    method,
    url,
    body,
    extra,
    fixedDate
  );

  const opts: aws4.Request = {
    host: url.host,
    method,
    path: url.pathname + url.search,
    service,
    region,
    headers: { "X-Amz-Date": amz, ...extra },
    body: body ? Buffer.from(body) : undefined,
  };
  aws4.sign(opts, { accessKeyId: creds.accessId, secretAccessKey: creds.secret });
  const theirs = (opts.headers as Record<string, string>)["Authorization"];

  const ok = ours.headers["authorization"] === theirs;
  console.log(`\n[${label}] ${ok ? "MATCH ✓" : "MISMATCH ✗"}`);
  if (!ok) {
    console.log("  ours  :", ours.headers["authorization"]);
    console.log("  aws4  :", theirs);
  }
  return ok;
}

async function main(): Promise<void> {
  const results = [
    await check("GET no body", "GET", "https://storage.googleapis.com/my-bucket/notes/hello.txt", undefined, {}),
    await check("GET list query", "GET", "https://storage.googleapis.com/my-bucket?prefix=notes/&marker=a", undefined, {}),
    await check(
      "PUT with body + content-type",
      "PUT",
      "https://storage.googleapis.com/my-bucket/notes/a.md",
      new TextEncoder().encode("# hello\nworld").buffer,
      { "content-type": "text/markdown" }
    ),
    await check(
      "GET key with spaces + unicode + specials (provider-encoded)",
      "GET",
      `https://storage.googleapis.com/my-bucket/${encodeKeyPath("My Notes/iş (a)b!.md")}`,
      undefined,
      {}
    ),
    await check("LIST query with spaces + specials", "GET", "https://storage.googleapis.com/my-bucket?prefix=My Notes/&x=a+b!", undefined, {}),
  ];
  const allOk = results.every(Boolean);
  console.log(`\n=== ${allOk ? "ALL MATCH — SigV4 implementation verified correct" : "FAILURES PRESENT"} ===`);
  if (!allOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error("difftest crashed:", (e as Error).message);
  process.exitCode = 1;
});
