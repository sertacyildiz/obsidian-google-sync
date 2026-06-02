/*
 * Offline tests for the verifiable parts of the Drive provider: PKCE (RFC 7636
 * test vector), the OAuth auth-URL builder, Drive `q` escaping, and parsing a
 * real-shaped files.list response. The live Drive API calls + OAuth loopback
 * need the Obsidian runtime + an OAuth client and are verified there.
 * Run: sh scripts/run-pilot.sh scripts/drive-test.ts
 */
import { codeChallengeS256, generateCodeVerifier } from "../src/providers/drive/pkce";
import { buildAuthUrl, driveScope } from "../src/providers/drive/DriveAuth";
import { escapeDriveQuery, parseDriveList } from "../src/providers/drive/DriveProvider";

let passed = 0, failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

async function main(): Promise<void> {
  // PKCE — RFC 7636 Appendix B test vector
  const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  check("PKCE S256 matches RFC 7636 vector", (await codeChallengeS256(RFC_VERIFIER)) === RFC_CHALLENGE);

  const v = generateCodeVerifier();
  check("generated verifier is 43+ chars, url-safe", v.length >= 43 && /^[A-Za-z0-9\-_]+$/.test(v));
  const c = await codeChallengeS256(v);
  check("generated challenge is url-safe base64 (no padding)", /^[A-Za-z0-9\-_]+$/.test(c) && !c.includes("="));

  // auth URL
  const url = buildAuthUrl({ clientId: "cid.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:42813", scope: driveScope("file"), codeChallenge: c });
  const u = new URL(url);
  check("auth URL points at Google", u.origin + u.pathname === "https://accounts.google.com/o/oauth2/v2/auth");
  check("auth URL has PKCE S256 + offline", u.searchParams.get("code_challenge_method") === "S256" && u.searchParams.get("access_type") === "offline" && u.searchParams.get("code_challenge") === c);
  check("drive.file scope (not full) by default", u.searchParams.get("scope") === "https://www.googleapis.com/auth/drive.file");
  check("full scope option", driveScope("full") === "https://www.googleapis.com/auth/drive");

  // query escaping
  check("escapeDriveQuery escapes quotes + backslash", escapeDriveQuery("a'b\\c") === "a\\'b\\\\c");

  // list parsing (real-shaped Drive files.list response)
  const sample = {
    nextPageToken: undefined,
    files: [
      { id: "1", appProperties: { gsPath: "Notes/a.md" }, md5Checksum: "abc", size: "10", modifiedTime: "2026-01-01T00:00:00Z" },
      { id: "2", appProperties: { gsPath: "Notes/sub/b.md" }, md5Checksum: "def", size: "20", modifiedTime: "2026-01-02T00:00:00Z" },
      { id: "3", name: "not-ours.txt", size: "5" }, // no appProperties.gsPath -> ignored
    ],
  };
  const all = parseDriveList(sample);
  check("parseDriveList maps only app-owned files", all.length === 2 && all[0].path === "Notes/a.md" && all[0].version === "abc" && all[0].size === 10);
  const sub = parseDriveList(sample, "Notes/sub/");
  check("parseDriveList honours prefix", sub.length === 1 && sub[0].path === "Notes/sub/b.md");

  console.log(`\n=== drive (pure logic): ${failed === 0 ? "ALL PASS" : failed + " FAILED"} (${passed} passed) ===`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("drive-test crashed:", (e as Error).message);
  process.exitCode = 1;
});
