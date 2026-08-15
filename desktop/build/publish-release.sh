#!/usr/bin/env bash
# Publish a built release to the update channel — and prove the website works.
#
# WHY THIS EXISTS. v1.4.29 was published by hand and shipped FIVE assets where
# every previous release shipped six. The missing one was `unmute-arm64.dmg`,
# the UNVERSIONED copy, which is the fixed URL every download button on the
# website points at:
#
#     https://github.com/arpitpatel25/unmute/releases/latest/download/unmute-arm64.dmg
#
# Auto-update kept working the whole time — it reads latest-mac.yml, which was
# present — so every check passed while new downloads returned 404 for fifteen
# hours. Inspecting the release is not the same as fetching what users fetch.
# This script does both, and refuses to leave a release half-published.
set -euo pipefail

VERSION="${1:?usage: publish-release.sh <x.y.z> [release-notes-file]}"
NOTES_FILE="${2:-}"
REPO="arpitpatel25/unmute"
TAG="v${VERSION}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/work/oss-engine/release"

# The six. The unversioned dmg is NOT redundant — see the header.
ASSETS=(
  "unmute-${VERSION}-arm64.dmg"
  "unmute-${VERSION}-arm64.dmg.blockmap"
  "unmute-${VERSION}-arm64.zip"
  "unmute-${VERSION}-arm64.zip.blockmap"
  "latest-mac.yml"
  "unmute-arm64.dmg"
)

cd "$DIR"
missing=0
for a in "${ASSETS[@]}"; do
  [[ -f "$a" ]] || { echo "MISSING BUILD ARTIFACT: $a" >&2; missing=1; }
done
[[ $missing -eq 0 ]] || { echo "Refusing to publish an incomplete release." >&2; exit 1; }

echo "Publishing $TAG with ${#ASSETS[@]} assets…"
if [[ -n "$NOTES_FILE" ]]; then
  gh release create "$TAG" -R "$REPO" --title "$VERSION" --notes-file "$NOTES_FILE" "${ASSETS[@]}"
else
  gh release create "$TAG" -R "$REPO" --title "$VERSION" --generate-notes "${ASSETS[@]}"
fi

# VERIFY WHAT USERS ACTUALLY FETCH, not what the API says exists. An asset can
# report state=uploaded while the download path still 404s — observed on
# v1.4.29, where it took a delete-and-reupload to serve.
echo "Verifying the published release…"
fail=0
check() { # url, label
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -L "$1?cb=$RANDOM")
  if [[ "$code" == "200" ]]; then echo "  OK   $2"; else echo "  FAIL $2 (HTTP $code)"; fail=1; fi
}
sleep 5
check "https://github.com/${REPO}/releases/latest/download/unmute-arm64.dmg"        "website download button"
check "https://github.com/${REPO}/releases/latest/download/latest-mac.yml"          "auto-updater feed"
check "https://github.com/${REPO}/releases/download/${TAG}/unmute-${VERSION}-arm64.zip" "updater payload (zip)"

served=$(curl -sL "https://github.com/${REPO}/releases/latest/download/latest-mac.yml" | sed -n 's/^version: //p')
if [[ "$served" == "$VERSION" ]]; then echo "  OK   updater feed serves $VERSION"; else echo "  FAIL updater feed serves '$served', expected $VERSION"; fail=1; fi

[[ $fail -eq 0 ]] || { echo "RELEASE IS PUBLISHED BUT NOT SERVING CORRECTLY — fix before announcing." >&2; exit 1; }
echo "$TAG published and verified."
