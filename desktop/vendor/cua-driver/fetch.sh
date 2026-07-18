#!/usr/bin/env bash
# Fetch + verify the PINNED cua-driver release binary (Computer Use v2 engine).
#
# Pinned deliberately: the driver leans on private SkyLight APIs that are
# OS-coupled — upgrades are a decision (retest on target macOS), never drift.
# The binary is NOT committed (42 MB universal); this script is the source of
# truth. Run it once per checkout (wire-into-engine fails loudly if missing).
set -euo pipefail

VERSION="0.8.3"
SHA256="a2a29f3ccbd45989819df639d60fa68ac6f28b844f74d7d2b0a1495e4359c6a1"
URL="https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$DIR/cua-driver" && "$(cat "$DIR/.version" 2>/dev/null || true)" == "$VERSION" ]]; then
  echo "cua-driver $VERSION already present — nothing to do"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading cua-driver ${VERSION}…"
curl -fsSL -o "$tmp/cua.tar.gz" "$URL"
echo "$SHA256  $tmp/cua.tar.gz" | shasum -a 256 -c -
tar xzf "$tmp/cua.tar.gz" -C "$tmp"
mv "$tmp/cua-driver" "$DIR/cua-driver"
chmod +x "$DIR/cua-driver"
echo "$VERSION" > "$DIR/.version"
echo "cua-driver $VERSION fetched and sha256-verified"
