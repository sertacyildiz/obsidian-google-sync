/* Offline test: the static OAuth redirect page (docs/oauth/index.html) that
 * phone sign-in returns to. Google redirects to it with `?code&state` (or
 * `?error&state`); it must hand exactly those keys to Obsidian through
 * `obsidian://google-cloud-sync-auth`, drop everything else, strip the query
 * from the address bar/history, and run under a CSP that allows only its own
 * inline script (by hash) and sends no Referer. Run:
 *   sh scripts/run-pilot.sh scripts/redirect-page-test.ts
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

const html = readFileSync("docs/oauth/index.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const script = scripts[0] ?? "";

interface PageRun {
  navigatedTo: string | null;
  replacedWith: string | null;
  linkHref: string | null;
  linkHidden: boolean;
  status: string;
}

/** Execute the page's script against a fake browser for the given query string. */
function runPage(search: string): PageRun {
  const run: PageRun = { navigatedTo: null, replacedWith: null, linkHref: null, linkHidden: true, status: "" };
  const link = {
    set href(v: string) { run.linkHref = v; },
    set hidden(v: boolean) { run.linkHidden = v; },
  };
  const status = { set textContent(v: string) { run.status = v; } };
  const location = {
    search,
    pathname: "/obsidian-google-sync/oauth/",
    set href(v: string) { run.navigatedTo = v; },
  };
  runInNewContext(script, {
    location,
    URLSearchParams,
    history: { replaceState: (_s: unknown, _t: string, url: string) => { run.replacedWith = url; } },
    document: { getElementById: (id: string) => (id === "open" ? link : id === "status" ? status : null) },
  });
  return run;
}

function main(): void {
  console.log("Page structure");
  check("exactly one inline script", scripts.length === 1);
  check("no external resources (src= / href=http)", !/\ssrc=/.test(html) && !/href="https?:/.test(html));
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] ?? "";
  const hash = createHash("sha256").update(script, "utf8").digest("base64");
  check("CSP default-src 'none'", /default-src 'none'/.test(csp));
  check("CSP script-src is the inline script's own SHA-256", csp.includes(`script-src 'sha256-${hash}'`));
  check("referrer policy no-referrer", /<meta name="referrer" content="no-referrer">/.test(html));

  console.log("Callback hand-off");
  const ok = runPage("?code=4/abc&state=s1&scope=x");
  check("code+state → obsidian:// with only code and state", ok.navigatedTo === "obsidian://google-cloud-sync-auth?code=4%2Fabc&state=s1");
  check("the visible Open-Obsidian link carries the same href", ok.linkHref === ok.navigatedTo && ok.linkHidden === false);
  check("query stripped from the address bar / history", ok.replacedWith === "/obsidian-google-sync/oauth/");

  const denied = runPage("?error=access_denied&state=s1");
  check("error+state → obsidian:// with error and state", denied.navigatedTo === "obsidian://google-cloud-sync-auth?error=access_denied&state=s1");

  const empty = runPage("");
  check("no query → no navigation", empty.navigatedTo === null && empty.linkHidden === true);
  check("no query → 'Nothing to do here.'", empty.status === "Nothing to do here.");

  console.log(`\n=== redirect page: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass} passed) ===`);
  if (fail) process.exitCode = 1;
}

try {
  main();
} catch (e) {
  console.error("redirect page test crashed:", (e as Error).message);
  process.exitCode = 1;
}
