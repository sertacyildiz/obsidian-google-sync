# Google Sync for Obsidian

[![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22google-cloud-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=google-cloud-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Sync your Obsidian vault to a **Google backend you own** — your personal
**Google Drive**, or your own **Google Cloud Storage** bucket — privately, with
optional end-to-end encryption and **no third-party server**.

## Why this exists

Your notes are yours. Keeping them backed up and in sync across devices
shouldn't mean paying a subscription, routing your vault through someone else's
server, or letting a plugin rewrite your files.

Google Sync keeps everything on **infrastructure you already own and control**:

- **Your cloud, no middleman.** Your notes and credentials go straight to your
  own Google Drive or Cloud Storage — never through any relay or shared service.
- **Private by design.** Optional end-to-end encryption means even a leaked
  credential or a compromised bucket can't read your notes.
- **Never touches your notes.** Sync state is tracked out-of-band — the plugin
  never injects metadata or rewrites your Markdown.
- **Safe two-way sync.** Changes flow both ways, deletions propagate, and a
  conflict keeps *both* copies — it never silently loses data.
- **Built for real vaults.** Handles large vaults, attachments, and
  special-character / non-English filenames.

## Two ways to connect

- **Google Drive** — sync to your personal Drive with your ordinary Google
  account.
- **Google Cloud Storage** — for those already on Google Cloud. Sync to your own
  bucket.

Use one, or set up both and choose which is active.

## Installation

You can install Google Sync directly from the Obsidian Community Plugins directory:

1. Open Obsidian **Settings** -> **Community Plugins**.
2. Disable "Safe Mode" if it's currently enabled.
3. Click **Browse** and search for **Google Sync**.
4. Click **Install**, and once installed, click **Enable**.

*Requires Obsidian **1.13.0** or newer.*

## Configuration & Setup

This plugin ships with **no OAuth credentials of its own**. You create a Google
OAuth client once and paste it into settings; it then lives only in this vault's
plugin data. That means there is no shared credential bundled into the plugin
for anyone to extract, and every release can be rebuilt from source byte for
byte — see [`SECURITY.md`](SECURITY.md).

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
   and pick or create a project.
2. If you plan to sync to Drive, enable the **Google Drive API** for that project.
3. **Create credentials → OAuth client ID**, application type **Desktop app**.
4. In Obsidian, open **Settings → Google Sync** and paste the **client ID** and
   **client secret** under *Google OAuth client*.
5. Turn on Google Drive and/or Google Cloud Storage, then press **Connect**.

Sign-in uses the OAuth loopback flow (PKCE) against `127.0.0.1` — your browser
opens, you approve, and the token is captured locally. Desktop only.

> **Upgrading from 0.6.x or earlier?** Those versions signed in through a shared
> OAuth client that was bundled into the plugin. That client has been removed, so
> an existing sign-in can no longer be refreshed: create your own client as above
> and press **Connect** again. Your synced files are not affected.

## Privacy & security

Security is the first priority, not an afterthought: credentials are never
synced and never logged, permission scopes are kept minimal, and content
encryption is available so a backend leak is never a content leak. Details in
[`SECURITY.md`](SECURITY.md).

## Support & Feedback

If you encounter any issues or have feature requests, please check the [Issues](https://github.com/YOUR_GITHUB_NAME/YOUR_REPO_NAME/issues) page to report them or contribute. 

## License

[MIT](LICENSE).
