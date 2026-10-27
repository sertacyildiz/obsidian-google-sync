# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories
(*Security → Report a vulnerability* on this repository) rather than opening a
public issue. You will get a response as soon as possible.

## Security model

- **Bring your own Google Cloud.** The plugin talks only to your own bucket /
  Drive with your own credentials. There is **no third-party server** and no
  shared OAuth app.
- **No credential is shipped in the plugin.** The build embeds no client id and
  no client secret: you register your own Google OAuth client and it is stored
  only in this vault's plugin data. Sign-in is the installed-app **PKCE** flow;
  the client secret is sent to Google's token endpoint only because Google
  requires it for "Desktop app" and "Web application" clients, and it is *your*
  secret, never ours. Google Cloud Storage can instead use an HMAC key you create.
- **Phone sign-in passes through a static page that learns nothing usable.** On
  mobile, Google redirects to `docs/oauth/` (served by GitHub Pages from this
  repository), which only hands the authorization code back to Obsidian through
  `obsidian://google-cloud-sync-auth`. That code is single-use, expires within
  minutes, and is bound by PKCE to a verifier that never leaves the device;
  redeeming it also takes your client secret. The page has no backend, loads
  nothing else, runs only its own script (pinned by hash in its CSP), sends no
  Referer and removes the code from the address bar. A random `state` ties each
  callback to the sign-in that started it, so a crafted `obsidian://` link is
  rejected rather than acted on. Like any web host, GitHub can see the request;
  if you would rather it didn't, host the page yourself and point
  *Redirect page (advanced)* at your copy.
- **Releases are reproducible.** Because nothing is injected at build time,
  `npm ci && npm run build` at a release tag reproduces the published `main.js`
  byte for byte, and each release asset carries a GitHub build-provenance
  attestation. You never have to trust that the uploaded bundle matches the
  source you can read.

  > Versions **0.6.2 and earlier** did not meet these two properties: they
  > shipped a shared OAuth client whose secret was injected at build time, so the
  > released `main.js` could not be reproduced from source and the credential was
  > distributed to every user. That client was removed in 0.7.0 and its secret
  > has since been revoked, so sign-ins issued by it no longer refresh. If you
  > are still on an earlier version, sync will fail with an authentication error
  > until you upgrade, register your own OAuth client, and reconnect.
- **Credentials are never synced or logged.** The plugin excludes its own
  config directory from the synced set and never logs secrets or signed
  material. OAuth scopes are kept narrow (`drive.file` / a single bucket) so a
  leak's blast radius is small.
- **Encryption at rest is optional (passphrase).** If you set a passphrase, the
  stored credential is sealed with AES-256-GCM (key derived via PBKDF2-SHA256;
  passphrase never stored). Without one, the credential is kept in the plugin's
  own (never-synced) config. We deliberately do **not** claim OS-keychain
  encryption: Obsidian's native SecretStorage stored secrets in plaintext in
  early 1.11.x and Electron `safeStorage` is not reliably reachable from a
  plugin — so we don't pretend a key is protected when it isn't. We will adopt
  SecretStorage once it is genuinely OS-encrypted.
- **End-to-end content encryption (optional, recommended).** With E2EE enabled,
  files are encrypted on-device before upload, so a credential or backend
  compromise does not expose note content. A forgotten passphrase means the
  content cannot be recovered — the inherent cost of true E2EE. The key is
  derived on each device from your passphrase (PBKDF2-SHA256) and a random salt
  kept in a small plaintext file at the remote folder's root
  (`.gsync-e2ee.json`), so every device derives the same key. That file holds no
  secret: the salt, the work factor, and a fixed string encrypted with the key,
  which lets a device reject a wrong passphrase before it syncs — and makes an
  edited header (say, a weaker work factor) fail to open rather than be trusted.
  The passphrase is asked twice when a folder is first encrypted. E2EE starts
  only on an empty remote folder; a device with E2EE switched off refuses to sync
  with an encrypted folder, and an unlocked device re-checks the folder's header
  before every sync, so it never writes with a key the folder no longer records.

## Supported versions

This is beta software; the latest release receives fixes.
