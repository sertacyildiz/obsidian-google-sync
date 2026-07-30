import { TokenSet, buildAuthUrl, exchangeCode } from "../providers/google/oauth";
import { codeChallengeS256, generateCodeVerifier } from "../providers/google/pkce";
import { requestUrlHttp } from "./requestUrlHttp";

/**
 * The slices of Node's `http` module and Electron's `shell` that this flow uses,
 * declared locally rather than pulled from `@types/node`. Obsidian bundles no
 * Node typings into the plugin build and these objects arrive through the
 * renderer's `require`, so describing just the members we call keeps the whole
 * loopback flow type-checked instead of `any`.
 */
interface NodeHttpRequest {
  url?: string;
}

interface NodeHttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/**
 * `address()` is typed as the TCP shape only: this server is always started with
 * `listen(0, "127.0.0.1")`, so Node returns an `AddressInfo`, never a pipe name.
 */
interface NodeHttpServer {
  listen(port: number, host: string, onListening: () => void): void;
  close(): void;
  address(): { port: number } | null;
  on(event: "error", listener: (err: Error) => void): void;
}

interface NodeHttpModule {
  createServer(handler: (req: NodeHttpRequest, res: NodeHttpResponse) => void): NodeHttpServer;
}

interface ElectronModule {
  shell?: { openExternal?: (url: string) => Promise<void> };
}

/** Access Node/Electron via Obsidian's renderer `require` (desktop only). */
function nodeRequire<T>(mod: string): T {
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (!req) throw new Error("Node require unavailable — Google login is desktop-only.");
  return req(mod) as T;
}

function openExternal(url: string): void {
  try {
    const electron = nodeRequire<ElectronModule>("electron");
    const openInBrowser = electron.shell?.openExternal;
    if (openInBrowser) {
      void openInBrowser(url);
      return;
    }
  } catch {
    /* fall through to window.open */
  }
  window.open(url, "_blank");
}

/**
 * Installed-app OAuth via a 127.0.0.1 loopback (PKCE, no third-party server).
 * Opens the system browser, captures the redirect on a throwaway local port,
 * and exchanges the code for tokens. A clientSecret is forwarded only if the
 * client requires one. Provider-neutral: the caller supplies the scope and a
 * human label (Drive / Cloud Storage) used in the success page and error text.
 * Desktop only.
 */
export function googleLoginLoopback(opts: { clientId: string; clientSecret?: string; scope: string; label: string }): Promise<TokenSet> {
  const http = nodeRequire<NodeHttpModule>("http");
  return new Promise<TokenSet>((resolve, reject) => {
    let settled = false;
    let timer: number | undefined;
    /**
     * Settle exactly once and always drop the abort timer. Clearing it here (not
     * just on the timeout path) matters: without it a completed login would leave
     * a 5-minute timer pending in the renderer that later closes an already-closed
     * server.
     */
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      fn();
    };

    const verifier = generateCodeVerifier();

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (!code && !err) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><h3>${opts.label} connected — you can close this tab.</h3></body></html>`);
      const port = server.address()?.port;
      server.close();
      if (err || !code) {
        finish(() => reject(new Error(`OAuth error: ${err ?? "no authorization code"}`)));
        return;
      }
      exchangeCode(
        requestUrlHttp,
        { clientId: opts.clientId, clientSecret: opts.clientSecret, code, codeVerifier: verifier, redirectUri: `http://127.0.0.1:${port}` },
        Date.now()
      ).then(
        (tokens) => finish(() => resolve(tokens)),
        (e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e))))
      );
    });

    server.on("error", (e) => finish(() => reject(e)));

    // Abort if the user never completes consent.
    timer = window.setTimeout(() => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error(`${opts.label} login timed out (5 min).`)));
    }, 5 * 60_000);

    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port;
      codeChallengeS256(verifier).then(
        (challenge) => {
          openExternal(
            buildAuthUrl({
              clientId: opts.clientId,
              redirectUri: `http://127.0.0.1:${port}`,
              scope: opts.scope,
              codeChallenge: challenge,
            })
          );
        },
        (e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e))))
      );
    });
  });
}
