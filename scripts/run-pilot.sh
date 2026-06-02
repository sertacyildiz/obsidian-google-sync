#!/bin/sh
# Bundle a TS pilot (so it can import from src/) and run it on Node.
# Credentials/tokens are read from env by the pilot — never passed on the CLI.
# Usage: [env...] sh scripts/run-pilot.sh [scripts/pilot-gcs.ts]
set -e
cd "$(dirname "$0")/.."
ENTRY="${1:-scripts/pilot-gcs.ts}"
TMP="$(mktemp -t pilot.XXXXXX).cjs"
trap 'rm -f "$TMP"' EXIT
npx esbuild "$ENTRY" --bundle --platform=node --format=cjs --outfile="$TMP" --log-level=warning
node "$TMP"
