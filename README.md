# Google Sync for Obsidian

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

- **Google Drive** — for everyone. Connect with your ordinary Google account;
  nothing else to set up.
- **Google Cloud Storage** — for those already on Google Cloud. Sync to your own
  bucket.

Use one, or set up both and choose which is active.

## Privacy & security

Security is the first priority, not an afterthought: credentials are never
synced and never logged, permission scopes are kept minimal, and content
encryption is available so a backend leak is never a content leak. Details in
[`SECURITY.md`](SECURITY.md).

## Status

Beta. Setup and usage documentation is on the way.

## License

[MIT](LICENSE).
