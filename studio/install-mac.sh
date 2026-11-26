#!/bin/sh
# Installs or updates Patent Creator Studio on a Mac, with no Gatekeeper prompts.
# Paste into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/PatentCreatorStudio/Patent-Creator-Studio/main/studio/install-mac.sh | sh
#
# It downloads the newest release for this Mac from GitHub, checks the file
# against the SHA-256 checksum GitHub publishes for it, puts the app in
# Applications, and opens it. Nothing else on the computer is changed.
set -eu

REPO="PatentCreatorStudio/Patent-Creator-Studio"
APP="Patent Creator Studio.app"
DEST="/Applications"

say() { printf '%s\n' "$*"; }
fail() { say "Stopped: $*"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for a Mac."
case "$(uname -m)" in
  arm64) PATTERN='-arm64-mac\.zip$' ;;
  *) PATTERN='[0-9]-mac\.zip$' ;;
esac
[ -w "$DEST" ] || fail "can't write to $DEST. Sign in as an administrator, or drag the app in by hand."

say "Finding the newest Patent Creator Studio..."
JSON=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases?per_page=10") || fail "couldn't reach GitHub. Check your internet connection and try again."

# Newest release first (GitHub lists them that way); take the first matching Mac zip.
INFO=$(printf '%s' "$JSON" | /usr/bin/python3 -c '
import json, re, sys
pattern = re.compile(sys.argv[1])
for release in json.load(sys.stdin):
    if release.get("draft"):
        continue
    for asset in release.get("assets", []):
        if pattern.search(asset["name"]):
            print(release["tag_name"], asset.get("digest") or "-", asset["browser_download_url"])
            sys.exit(0)
sys.exit(1)
' "$PATTERN") || fail "no Mac download was found in the latest releases."

set -- $INFO
TAG=$1; DIGEST=$2; URL=$3
case "$DIGEST" in sha256:*) WANT=${DIGEST#sha256:} ;; *) fail "GitHub published no checksum for this download, so it can't be checked." ;; esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say "Downloading $TAG..."
curl -fL --progress-bar -o "$WORK/app.zip" "$URL" || fail "the download didn't finish. Try again."

GOT=$(shasum -a 256 "$WORK/app.zip" | cut -d' ' -f1)
[ "$GOT" = "$WANT" ] || fail "the downloaded file doesn't match GitHub's checksum, so it wasn't installed."
say "Checksum matches."

ditto -x -k "$WORK/app.zip" "$WORK/out"
[ -d "$WORK/out/$APP" ] || fail "the download didn't contain the app."

if pgrep -xq "Patent Creator Studio"; then
  say "Closing the open copy of Patent Creator Studio..."
  osascript -e 'quit app "Patent Creator Studio"' >/dev/null 2>&1 || true
  i=0
  while pgrep -xq "Patent Creator Studio"; do
    i=$((i + 1)); [ $i -gt 30 ] && fail "Patent Creator Studio is still open. Quit it and run this again."
    sleep 1
  done
fi

if [ -d "$DEST/$APP" ]; then
  mv "$DEST/$APP" "$WORK/old.app"
fi
if ! mv "$WORK/out/$APP" "$DEST/$APP"; then
  [ -d "$WORK/old.app" ] && mv "$WORK/old.app" "$DEST/$APP"
  fail "couldn't put the app in $DEST. Your previous copy is back in place."
fi
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

say "Installed $TAG in $DEST. Opening it now."
open "$DEST/$APP"
