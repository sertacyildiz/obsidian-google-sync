# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories
(*Security → Report a vulnerability* on this repository) rather than opening a
public issue. You will get a response as soon as possible.

## Security model

- **Bring your own Google Cloud.** The plugin talks only to your own bucket /
  Drive with your own credentials. There is **no third-party server** and no
  shared OAuth app.
- **No shipped secret.** Google Drive uses the installed-app OAuth2 **PKCE**
  flow (no client secret). Google Cloud Storage uses an HMAC key you create.
- **Credentials encrypted at rest.** Your HMAC secret / Drive refresh token are
  sealed with AES-256-GCM using a key derived (PBKDF2-SHA256) from your
  passphrase. Plaintext secrets never touch disk, and the passphrase is never
  stored.
- **Credentials are never synced or logged.** The plugin excludes its own
  config directory from the synced set and never logs secrets or signed
  material.
- **End-to-end content encryption (optional, recommended).** With E2EE enabled,
  files are encrypted on-device before upload, so a credential or backend
  compromise does not expose note content. A forgotten passphrase means the
  content cannot be recovered — the inherent cost of true E2EE.

## Supported versions

This is beta software; the latest release receives fixes.
