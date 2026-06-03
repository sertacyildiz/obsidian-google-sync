/*
 * Offline tests for the Drive provider: PKCE (RFC 7636 vector), the OAuth
 * auth-URL builder, Drive `q` escaping, and a full put/list/get/delete
 * round-trip against an in-memory fake Drive that proves the vault's folder
 * structure is mirrored as real nested folders (not flattened). The live Drive
 * API + OAuth loopback need the Obsidian runtime and are verified there.
 * Run: sh scripts/run-pilot.sh scripts/drive-test.ts
 */
import { codeChallengeS256, generateCodeVerifier } from "../src/providers/google/pkce";
import { buildAuthUrl } from "../src/providers/google/oauth";
import { driveScope } from "../src/providers/drive/DriveAuth";
import { DriveProvider, escapeDriveQuery } from "../src/providers/drive/DriveProvider";
import { HttpResponse, HttpSend } from "../src/providers/RemoteProvider";

const FOLDER_MIME = "application/vnd.google-apps.folder";

let passed = 0,
  failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

const buf = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;

/** Minimal in-memory Google Drive: enough of files.list/create/upload/get/delete to exercise DriveProvider. */
class FakeDrive {
  private seq = 0;
  private files = new Map<string, { id: string; name: string; mimeType: string; parent: string; content?: ArrayBuffer }>();

  http: HttpSend = async (method, url, _headers, body) => {
    if (method === "PATCH" && url.includes("/upload/drive/v3/files/")) {
      const id = url.split("/upload/drive/v3/files/")[1].split("?")[0];
      const f = this.files.get(id);
      if (f) f.content = body;
      return this.ok({ md5Checksum: `m${body ? body.byteLength : 0}`, modifiedTime: "t" });
    }
    if (method === "GET" && /\/drive\/v3\/files\/[^/?]+\?alt=media/.test(url)) {
      const id = url.split("/files/")[1].split("?")[0];
      const f = this.files.get(id);
      return f?.content ? { status: 200, headers: {}, text: async () => "", arrayBuffer: async () => f.content as ArrayBuffer } : this.code(404);
    }
    if (method === "POST" && url.includes("/drive/v3/files?fields=id")) {
      const meta = JSON.parse(new TextDecoder().decode(body)) as { name: string; mimeType?: string; parents: string[] };
      const id = `id${++this.seq}`;
      this.files.set(id, { id, name: meta.name, mimeType: meta.mimeType ?? "application/octet-stream", parent: meta.parents[0] });
      return this.ok({ id });
    }
    if (method === "DELETE") {
      this.files.delete(url.split("/files/")[1]);
      return this.ok({});
    }
    // files.list (find / locate / walk) via the q parameter
    const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
    const parent = (q.match(/'([^']+)' in parents/) || [])[1];
    const nameM = q.match(/name='((?:[^'\\]|\\.)*)'/);
    const name = nameM ? nameM[1].replace(/\\(.)/g, "$1") : undefined;
    const wantFolder = q.includes(`mimeType='${FOLDER_MIME}'`);
    const wantFile = q.includes(`mimeType!='${FOLDER_MIME}'`);
    const files = [...this.files.values()]
      .filter((f) => (!parent || f.parent === parent) && (name === undefined || f.name === name))
      .filter((f) => (!wantFolder || f.mimeType === FOLDER_MIME) && (!wantFile || f.mimeType !== FOLDER_MIME))
      .map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, md5Checksum: f.content ? `m${f.content.byteLength}` : undefined, size: f.content ? String(f.content.byteLength) : "0" }));
    return this.ok({ files });
  };

  folderCount(name: string): number {
    return [...this.files.values()].filter((f) => f.mimeType === FOLDER_MIME && f.name === name).length;
  }
  private ok(obj: unknown): HttpResponse {
    const t = JSON.stringify(obj);
    return { status: 200, headers: {}, text: async () => t, arrayBuffer: async () => buf(t) };
  }
  private code(status: number): HttpResponse {
    return { status, headers: {}, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
  }
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

  const url = buildAuthUrl({ clientId: "cid.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:42813", scope: driveScope("file"), codeChallenge: c });
  const u = new URL(url);
  check("auth URL points at Google", u.origin + u.pathname === "https://accounts.google.com/o/oauth2/v2/auth");
  check("auth URL has PKCE S256 + offline", u.searchParams.get("code_challenge_method") === "S256" && u.searchParams.get("access_type") === "offline" && u.searchParams.get("code_challenge") === c);
  check("drive.file scope (not full) by default", u.searchParams.get("scope") === "https://www.googleapis.com/auth/drive.file");
  check("full scope option", driveScope("full") === "https://www.googleapis.com/auth/drive");

  check("escapeDriveQuery escapes quotes + backslash", escapeDriveQuery("a'b\\c") === "a\\'b\\\\c");

  // --- folder-mirroring round-trip against an in-memory Drive ---
  const drive = new FakeDrive();
  const p = new DriveProvider({ appFolderName: "Obsidian Sync/My Vault" }, async () => "tok", drive.http);
  await p.put("a.md", buf("A"));
  await p.put("notes/b.md", buf("B"));
  await p.put("notes/deep/c.md", buf("C"));

  const list = (await p.list()).map((o) => o.path).sort();
  check("mirrors nested folders — list reconstructs full paths", JSON.stringify(list) === JSON.stringify(["a.md", "notes/b.md", "notes/deep/c.md"]));
  check("real folders created (not a flat dump): 'notes' + 'deep' exist", drive.folderCount("notes") === 1 && drive.folderCount("deep") === 1);
  check("vault name nested under the base: 'My Vault' folder exists", drive.folderCount("My Vault") === 1);
  check("get round-trips content from a nested path", new TextDecoder().decode((await p.get("notes/deep/c.md")) as ArrayBuffer) === "C");
  check("re-put updates in place (no duplicate)", (await (async () => { await p.put("notes/b.md", buf("B2")); return (await p.list()).filter((o) => o.path === "notes/b.md").length; })()) === 1);

  await p.delete("notes/b.md");
  const list2 = (await p.list()).map((o) => o.path).sort();
  check("delete removes only the target file", JSON.stringify(list2) === JSON.stringify(["a.md", "notes/deep/c.md"]));
  check("list(prefix) is scoped to the subfolder", (await p.list("notes")).map((o) => o.path).join(",") === "notes/deep/c.md");

  console.log(`\n=== drive (logic + mirror round-trip): ${failed === 0 ? "ALL PASS" : failed + " FAILED"} (${passed} passed) ===`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("drive-test crashed:", (e as Error).message);
  process.exitCode = 1;
});
