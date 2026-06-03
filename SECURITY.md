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
  content cannot be recovered — the inherent cost of true E2EE.

## Supported versions

This is beta software; the latest release receives fixes.
