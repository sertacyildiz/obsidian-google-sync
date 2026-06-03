import { TokenSet, buildAuthUrl, exchangeCode } from "../providers/google/oauth";
import { codeChallengeS256, generateCodeVerifier } from "../providers/google/pkce";
import { requestUrlHttp } from "./requestUrlHttp";

/** Access Node/Electron via Obsidian's renderer `require` (desktop only). */
function nodeRequire(mod: string): any {
  const req = (window as unknown as { require?: (m: string) => any }).require;
  if (!req) throw new Error("Node require unavailable — Google login is desktop-only.");
  return req(mod);
}

function openExternal(url: string): void {
  try {
    const electron = nodeRequire("electron");
    if (electron?.shell?.openExternal) {
      void electron.shell.openExternal(url);
      return;
    }
  } catch {
    /* fall through to window.open */
  }
  window.open(url, "_blank");
}

/**
 * Installed-app OAuth via a 127.0.0.1 loopback (PKCE, no client secret, no
 * third-party server). Opens the system browser, captures the redirect on a
 * throwaway local port, and exchanges the code for tokens. Provider-neutral:
 * the caller supplies the scope and a human label (Drive / Cloud Storage) used
 * in the success page and error text. Desktop only.
 */
export function googleLoginLoopback(opts: { clientId: string; scope: string; label: string }): Promise<TokenSet> {
  const http = nodeRequire("http");
  return new Promise<TokenSet>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const verifier = generateCodeVerifier();

    const server = http.createServer((req: any, res: any) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (!code && !err) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><h3>${opts.label} connected — you can close this tab.</h3></body></html>`);
      const port = server.address()?.port;
      server.close();
      if (err || !code) {
        finish(() => reject(new Error(`OAuth error: ${err ?? "no authorization code"}`)));
        return;
      }
      exchangeCode(
        requestUrlHttp,
        { clientId: opts.clientId, code, codeVerifier: verifier, redirectUri: `http://127.0.0.1:${port}` },
        Date.now()
      ).then(
        (tokens) => finish(() => resolve(tokens)),
        (e) => finish(() => reject(e as Error))
      );
    });

    server.on("error", (e: Error) => finish(() => reject(e)));

    // Abort if the user never completes consent.
    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error(`${opts.label} login timed out (5 min).`)));
    }, 5 * 60_000);
    if (typeof timer === "object" && "unref" in timer) (timer as { unref: () => void }).unref();

    server.listen(0, "127.0.0.1", async () => {
      const port = server.address()?.port;
      const challenge = await codeChallengeS256(verifier);
      openExternal(
        buildAuthUrl({
          clientId: opts.clientId,
          redirectUri: `http://127.0.0.1:${port}`,
          scope: opts.scope,
          codeChallenge: challenge,
        })
      );
    });
  });
}
