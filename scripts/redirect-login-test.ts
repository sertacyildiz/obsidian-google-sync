/* Offline test: phone sign-in via the redirect page (providers/google/redirectLogin).
 *  - startRedirectLogin builds the Google consent URL (exact redirect URI, a fresh
 *    state, a PKCE S256 challenge for a fresh verifier, offline access) and the
 *    PendingAuth that must be persisted before the browser opens.
 *  - acceptCallback admits only the callback that belongs to that pending sign-in:
 *    right state, not expired, not an error — and never echoes the code, state or
 *    verifier in what it throws (those messages reach a Notice).
 * Run:
 *   npx esbuild scripts/redirect-login-test.ts --bundle --platform=node --format=cjs \
 *     --alias:obsidian=./scripts/_mock-obsidian.ts --outfile=/tmp/rl.cjs && node /tmp/rl.cjs
 */
import {
  PENDING_AUTH_TTL_MS,
  PendingAuth,
  REDIRECT_PAGE_URL,
  acceptCallback,
  startRedirectLogin,
} from "../src/providers/google/redirectLogin";
import { codeChallengeS256 } from "../src/providers/google/pkce";
import { ControllerEnv, SyncController } from "../src/SyncController";
import { DEFAULT_SETTINGS, GoogleSyncSettings } from "../src/settings";
import { HttpSend } from "../src/providers/RemoteProvider";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

/** Run `op`; return its error message, or null if it did not throw. */
function thrown(op: () => unknown): string | null {
  try {
    op();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);

async function main(): Promise<void> {
  console.log("startRedirectLogin");
  const { pending, authUrl } = await startRedirectLogin({
    clientId: "cid.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.file",
    backend: "drive",
    redirectUri: REDIRECT_PAGE_URL,
    now: T0,
  });
  const u = new URL(authUrl);
  const q = u.searchParams;
  check("goes to Google's consent endpoint", u.origin + u.pathname === "https://accounts.google.com/o/oauth2/v2/auth");
  check("carries the client id", q.get("client_id") === "cid.apps.googleusercontent.com");
  check("carries the exact redirect URI (trailing slash kept)", q.get("redirect_uri") === "https://sertacyildiz.github.io/obsidian-google-sync/oauth/");
  check("state is a 43-char base64url token and matches pending.state", /^[A-Za-z0-9_-]{43}$/.test(q.get("state") ?? "") && q.get("state") === pending.state);
  check("code_challenge = S256(pending.verifier)", q.get("code_challenge") === (await codeChallengeS256(pending.verifier)) && q.get("code_challenge_method") === "S256");
  check("asks for offline access (a refresh token)", q.get("access_type") === "offline");
  check("pending records backend, scope, redirect URI and start time", pending.backend === "drive" && pending.scope.endsWith("drive.file") && pending.redirectUri === REDIRECT_PAGE_URL && pending.createdAt === T0);
  const again = await startRedirectLogin({ clientId: "cid", scope: "s", backend: "gcs", redirectUri: REDIRECT_PAGE_URL, now: T0 });
  check("every attempt gets a fresh state and verifier", again.pending.state !== pending.state && again.pending.verifier !== pending.verifier);

  console.log("acceptCallback");
  const p: PendingAuth = { ...pending };
  const good = { action: "google-cloud-sync-auth", code: "4/0AQSTgQ-secret-code", state: p.state };
  const okRun = thrown(() => {
    const r = acceptCallback(p, good, T0 + 30_000);
    if (r.code !== good.code || r.pending !== p) throw new Error("wrong result");
  });
  check("the matching callback yields its code (and the pending it belongs to)", okRun === null);

  const msgs: string[] = [];
  const expect = (label: string, msg: string | null, includes: string): void => {
    if (msg) msgs.push(msg);
    check(label, msg !== null && msg.includes(includes));
  };
  expect("no sign-in in progress → tap Connect again", thrown(() => acceptCallback(null, good, T0)), "No sign-in in progress");
  expect("state mismatch → another vault / earlier attempt", thrown(() => acceptCallback(p, { ...good, state: "x".repeat(43) }, T0)), "another vault");
  expect("older than the TTL → expired", thrown(() => acceptCallback(p, good, T0 + PENDING_AUTH_TTL_MS + 1)), "expired");
  check("exactly at the TTL is still accepted", thrown(() => acceptCallback(p, good, T0 + PENDING_AUTH_TTL_MS)) === null);
  expect("consent denied → cancelled (access_denied)", thrown(() => acceptCallback(p, { action: good.action, error: "access_denied", state: p.state }, T0)), "cancelled (access_denied)");
  const noCode = thrown(() => acceptCallback(p, { action: good.action, state: p.state }, T0));
  if (noCode) msgs.push(noCode);
  check("no code → throws", noCode !== null);
  check(
    "no message echoes the code, state or verifier",
    msgs.length >= 5 && msgs.every((m) => !m.includes(good.code) && !m.includes(p.state) && !m.includes(p.verifier))
  );

  console.log("SyncController — sign in on the phone");
  {
    const tokenPosts: Record<string, string>[] = [];
    const http: HttpSend = async (method, url, _h, body) => {
      if (method === "POST" && url === "https://oauth2.googleapis.com/token") {
        tokenPosts.push(Object.fromEntries(new URLSearchParams(new TextDecoder().decode(body))));
        const t = JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
        return { status: 200, headers: {}, text: async () => t, arrayBuffer: async () => new TextEncoder().encode(t).buffer };
      }
      return { status: 404, headers: {}, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const fresh = (): GoogleSyncSettings => ({ ...DEFAULT_SETTINGS, oauthClientId: "cid", oauthClientSecret: "csecret", syncState: {}, backendLastSync: {} });

    /** One phone: settings in memory, persist() writes data.json (a JSON copy), openUrl records the browser hand-off. */
    const device = (settings: GoogleSyncSettings) => {
      const disk: { saved: string | null } = { saved: null };
      const opened: { url: string; savedAtOpen: string | null }[] = [];
      const env: ControllerEnv = { mobile: true, openUrl: (url) => void opened.push({ url, savedAtOpen: disk.saved }) };
      const c = new SyncController({} as never, settings, async () => void (disk.saved = JSON.stringify(settings)), http, env);
      return { c, settings, disk, opened };
    };
    const stateOf = (url: string): string => new URL(url).searchParams.get("state") ?? "";

    const a = device(fresh());
    const r = await a.c.connect("drive");
    const savedAtOpen = JSON.parse(a.opened[0]?.savedAtOpen ?? "{}") as GoogleSyncSettings;
    check("connect on the phone → 'pending', browser opened once", r === "pending" && a.opened.length === 1);
    check("pendingAuth reached data.json BEFORE the browser opened", savedAtOpen.pendingAuth?.state === stateOf(a.opened[0].url));

    // Obsidian killed while the browser is in front: the callback cold-starts a NEW controller from data.json.
    const b = device(JSON.parse(a.disk.saved as string) as GoogleSyncSettings);
    const pending = b.settings.pendingAuth;
    const backend = await b.c.completeRedirectLogin({ action: "google-cloud-sync-auth", code: "4/the-code", state: pending?.state ?? "" });
    const post = tokenPosts[tokenPosts.length - 1];
    check("restart: completes and reports the backend", backend === "drive");
    check("restart: Drive refresh token stored, pendingAuth spent (and persisted)", b.settings.driveToken?.data === "rt-1" && b.settings.pendingAuth === null && JSON.parse(b.disk.saved as string).pendingAuth === null);
    check(
      "restart: token exchange used the page URL + the persisted verifier + the client secret",
      post?.redirect_uri === REDIRECT_PAGE_URL && post?.code_verifier === pending?.verifier && post?.code === "4/the-code" && post?.client_secret === "csecret" && post?.grant_type === "authorization_code"
    );

    const g = device(fresh());
    await g.c.connect("gcs");
    await g.c.completeRedirectLogin({ action: "google-cloud-sync-auth", code: "4/gcs", state: stateOf(g.opened[0].url) });
    check("gcs: refresh token stored and OAuth mode selected", g.settings.gcsToken?.data === "rt-1" && g.settings.gcsAuthMode === "oauth");

    const bad = device(fresh());
    await bad.c.connect("drive");
    const postsBefore = tokenPosts.length;
    const badMsg = await bad.c.completeRedirectLogin({ action: "google-cloud-sync-auth", code: "4/x", state: "x".repeat(43) }).then(() => null, (e: Error) => e.message);
    check("wrong state → rejected", badMsg !== null && badMsg.includes("another vault"));
    check("wrong state → pendingAuth spent and persisted, no token, no exchange", bad.settings.pendingAuth === null && JSON.parse(bad.disk.saved as string).pendingAuth === null && bad.settings.driveToken === null && tokenPosts.length === postsBefore);

    const own = device({ ...fresh(), oauthRedirectPage: "https://example.test/cb/" });
    await own.c.connect("drive");
    await own.c.completeRedirectLogin({ action: "google-cloud-sync-auth", code: "4/own", state: stateOf(own.opened[0].url) });
    check("self-hosted page: used in the consent URL and the exchange", new URL(own.opened[0].url).searchParams.get("redirect_uri") === "https://example.test/cb/" && tokenPosts[tokenPosts.length - 1]?.redirect_uri === "https://example.test/cb/");

    const none = device({ ...fresh(), oauthClientId: "" });
    const noneMsg = await none.c.connect("drive").then(() => null, (e: Error) => e.message);
    check("no OAuth client → the existing set-up message, browser not opened", (noneMsg ?? "").includes("No Google OAuth client configured") && none.opened.length === 0);
  }

  console.log(`\n=== redirect login: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("redirect login test crashed:", (e as Error).message);
  process.exitCode = 1;
});
