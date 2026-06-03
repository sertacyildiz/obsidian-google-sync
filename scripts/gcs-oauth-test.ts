/* Offline tests for the GCS OAuth ("Connect") path: the scope is least-privilege,
 * the controller treats an OAuth refresh token like any other credential
 * (auto-load when plaintext, locked when encrypted), and an OAuth-mode sync
 * authenticates the GCS request with a freshly-refreshed Bearer token. The
 * consent loopback itself (browser + 127.0.0.1) is shared with Drive and is
 * runtime-verified in Obsidian (BRAT). Run:
 *   npx esbuild scripts/gcs-oauth-test.ts --bundle --platform=node --format=cjs \
 *     --alias:obsidian=./scripts/_mock-obsidian.ts --outfile=/tmp/gcs-oauth.cjs && node /tmp/gcs-oauth.cjs
 */
import { SyncController } from "../src/SyncController";
import { DEFAULT_SETTINGS, GoogleSyncSettings } from "../src/settings";
import { GCS_OAUTH_SCOPE } from "../src/providers/gcs/auth";
import { HttpResponse, HttpSend } from "../src/providers/RemoteProvider";
import { deriveAesKey } from "../src/crypto/aesgcm";
import { sealSecret } from "../src/crypto/secret";
import { newSalt, PBKDF2_ITERATIONS } from "../src/crypto/PassphraseCryptor";
import { base64Encode } from "../src/util/base64";

(globalThis as unknown as { window: unknown }).window = { setInterval: () => 1, clearInterval: () => {}, open: () => {} };

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

function makeApp(): never {
  return {
    vault: {
      configDir: ".obsidian",
      getFiles: () => [],
      adapter: {
        readBinary: async () => new ArrayBuffer(0),
        writeBinary: async () => {},
        exists: async () => true,
        mkdir: async () => {},
        remove: async () => {},
      },
      on: () => ({}),
    },
  } as never;
}

function oauthSettings(gcsToken: { data: string; enc: boolean }): GoogleSyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    gcsEnabled: true,
    gcsAuthMode: "oauth",
    bucket: "b",
    oauthClientId: "cid",
    gcsToken,
    gcsSecret: null,
    accessId: "",
    e2ee: false,
    salt: null,
    syncState: {},
  };
}

function resp(status: number, headers: Record<string, string>, body: string): HttpResponse {
  return {
    status,
    headers,
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

function makeFakeHttp(record: { method: string; url: string; headers: Record<string, string>; bodyStr: string }[]): HttpSend {
  return async (method, url, headers, body) => {
    record.push({ method, url, headers, bodyStr: body ? new TextDecoder().decode(body) : "" });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return resp(200, {}, JSON.stringify({ access_token: "ACCESS-XYZ", token_type: "Bearer", expires_in: 3600 }));
    }
    if (url.includes("storage.googleapis.com")) {
      return resp(200, { etag: '"x"' }, "<ListBucketResult></ListBucketResult>");
    }
    if (url.includes("googleapis.com/drive") || url.includes("googleapis.com/upload/drive")) {
      // find-folder / list → empty; create-folder (POST) → an id
      return method === "POST" ? resp(200, {}, JSON.stringify({ id: "drive-folder" })) : resp(200, {}, JSON.stringify({ files: [] }));
    }
    return resp(404, {}, "");
  };
}

async function main(): Promise<void> {
  // (1) least-privilege scope — a security guard, not a tautology: it must never
  // silently widen to full_control / cloud-platform.
  check(
    "GCS OAuth scope is devstorage.read_write (never broader)",
    GCS_OAUTH_SCOPE === "https://www.googleapis.com/auth/devstorage.read_write" &&
      !GCS_OAUTH_SCOPE.includes("full_control") &&
      !GCS_OAUTH_SCOPE.includes("cloud-platform")
  );

  // (2a) plaintext OAuth token auto-loads (no passphrase wall), reflects lock/ready
  {
    const c = new SyncController(makeApp(), oauthSettings({ data: "REFRESH-123", enc: false }), async () => {});
    await c.prepare();
    check("oauth-mode: plaintext refresh token auto-loads → ready", c.ready === true);
    check("oauth-mode: needsPassphrase is false for a plaintext token", c.needsPassphrase === false);
    c.lock();
    check("oauth-mode: after lock → not ready", c.ready === false);
  }

  // (2b) encrypted OAuth token stays locked until the passphrase unseals it
  {
    const salt = newSalt();
    const key = await deriveAesKey("pw-1", salt, PBKDF2_ITERATIONS);
    const blob = await sealSecret(key, "REFRESH-XYZ");
    const settings = oauthSettings({ data: blob, enc: true });
    settings.salt = base64Encode(salt);
    const c = new SyncController(makeApp(), settings, async () => {});
    await c.prepare();
    check("oauth-mode: encrypted token stays locked without passphrase", c.ready === false);
    check("oauth-mode: needsPassphrase is true for an encrypted token", c.needsPassphrase === true);
    await c.prepare("pw-1");
    check("oauth-mode: correct passphrase unseals the token → ready", c.ready === true);
  }

  // (3) an OAuth-mode sync refreshes the token and authenticates GCS with Bearer
  {
    const record: { method: string; url: string; headers: Record<string, string>; bodyStr: string }[] = [];
    const c = new SyncController(makeApp(), oauthSettings({ data: "REFRESH-123", enc: false }), async () => {}, makeFakeHttp(record));
    await c.prepare();
    await c.sync();
    const tokenCall = record.find((r) => r.url.startsWith("https://oauth2.googleapis.com/token"));
    check(
      "oauth sync refreshes with the stored refresh token",
      !!tokenCall && tokenCall.bodyStr.includes("refresh_token=REFRESH-123") && tokenCall.bodyStr.includes("grant_type=refresh_token")
    );
    const gcsCall = record.find((r) => r.url.includes("storage.googleapis.com"));
    check(
      "oauth sync authenticates the GCS request with the refreshed Bearer token",
      !!gcsCall && gcsCall.headers.authorization === "Bearer ACCESS-XYZ"
    );
    check("oauth sync does not leak an HMAC Authorization (Bearer only)", !!gcsCall && !/AWS4-HMAC/.test(gcsCall.headers.authorization ?? ""));
  }

  // (4) both backends enabled → a single sync() touches BOTH, each with its own baseline
  {
    const record: { method: string; url: string; headers: Record<string, string>; bodyStr: string }[] = [];
    const settings: GoogleSyncSettings = {
      ...DEFAULT_SETTINGS,
      driveEnabled: true,
      gcsEnabled: true,
      bucket: "b",
      oauthClientId: "cid",
      driveToken: { enc: false, data: "DRIVE-REFRESH" },
      gcsToken: { enc: false, data: "GCS-REFRESH" },
      gcsAuthMode: "oauth",
      syncState: {},
    };
    const c = new SyncController(makeApp(), settings, async () => {}, makeFakeHttp(record));
    await c.prepare();
    await c.sync();
    check(
      "both backends enabled → one sync hits BOTH Drive and GCS",
      record.some((r) => r.url.includes("googleapis.com/drive")) && record.some((r) => r.url.includes("storage.googleapis.com"))
    );
    check(
      "each backend keeps its own baseline (syncState has drive + gcs)",
      "drive" in settings.syncState && "gcs" in settings.syncState
    );
  }

  console.log(`\n=== gcs oauth: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("gcs-oauth test crashed:", (e as Error).message);
  process.exitCode = 1;
});
