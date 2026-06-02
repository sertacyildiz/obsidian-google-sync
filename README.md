# Google Sync for Obsidian

Sync your Obsidian vault to a **Google backend you own** — **Google Drive** or **Google Cloud Storage** — with **end-to-end encryption** and **no third-party server**. You bring your own Google Cloud; your notes and credentials never pass through anyone else's infrastructure.

> **Status: beta.** The Google Cloud Storage path is verified end-to-end (real two-device sync, including encrypted content, nested folders, and special-character / unicode filenames). The Google Drive path is built and unit-tested; please beta-test it with your own OAuth client and report issues. Use a **throwaway vault** first and keep backups.

## Why

- **Your infrastructure, not ours.** No hosted relay and no shared app — you supply your own Google credentials (`drive.file` scope, or a user-account HMAC key for GCS).
- **End-to-end encryption.** Content is encrypted on your device before upload (AES-256-GCM, key derived from your passphrase via PBKDF2). A leaked credential or bucket never exposes your notes.
- **Credentials stay safe.** Secrets are encrypted at rest, never written in plaintext, never synced, never logged.
- **Two providers, one plugin.** Google Drive (OAuth2 PKCE) and Google Cloud Storage (HMAC + correct SigV4 signing that sidesteps the AWS-SDK incompatibilities most S3-interop tools hit against GCS).

## Install (beta, via BRAT)

1. Install the **BRAT** community plugin.
2. BRAT → *Add beta plugin* → `sertacyildiz/obsidian-google-sync`.
3. Enable **Google Sync** under *Community plugins*.

(Or build from source — see below.)

## Setup

Open **Settings → Google Sync**. Set a **passphrase** (it powers E2EE and unseals your stored credential; it is never saved), choose a **sync folder** (or the whole vault), then configure a provider.

### Google Drive
1. In the [Google Cloud Console](https://console.cloud.google.com/): create a project, enable the **Drive API**, configure the **OAuth consent screen** (add yourself as a test user), and create an **OAuth client ID** of type **Desktop app**.
2. Paste the **client ID**, choose a scope (**App files** = `drive.file`, recommended; or **Full Drive**), then **Connect Google Drive** and approve in your browser.

### Google Cloud Storage
1. Create a bucket (uniform bucket-level access; public access prevented).
2. Console → *Cloud Storage → Settings → Interoperability* → create a **user-account HMAC key**.
3. Paste the **bucket**, **Access ID**, and **Secret**, then **Save GCS credentials**.

Then **Sync now** (ribbon icon or command palette). Optionally enable **auto-sync** — on every change, or every N minutes.

## How sync works

- **Two-way** sync between your chosen folder and the remote, tracked by a local state file.
- **Conflicts never lose data:** if a file changed on both sides, both are kept (the remote copy is saved as `<name>.conflict-<timestamp>`).
- **Deletions propagate** in both directions.
- The plugin's own config (including the encrypted credential) is **never** part of the synced set.

## Security

See [`SECURITY.md`](SECURITY.md). In short: bring-your-own-cloud, no third-party server, credentials encrypted at rest and never synced, and optional end-to-end content encryption.

## Build from source

```bash
npm install
npm run build   # type-checks, then bundles to main.js
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/google-sync/`.

## License

[MIT](LICENSE).
