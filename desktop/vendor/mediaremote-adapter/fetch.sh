#!/usr/bin/env bash
# Fetch + build the PINNED mediaremote-adapter (pause background media).
#
# WHY THIS EXISTS AT ALL. macOS has no public way to pause another app's audio
# — Apple's own answer is ducking, not pausing — and in 15.4 it put the private
# MediaRemote framework behind an entitlement, so reading "what is playing"
# returns nil for an ordinary app (measured on 26.2: symbol resolves, callback
# answers nil). This adapter is how the category solves that: it runs the
# framework through /usr/bin/perl, a system binary macOS still permits, and
# speaks a small CLI. VoiceInk, FluidVoice and TypeWhisper all ship it.
#
# THE ALTERNATIVE WE REJECTED: simulating the play/pause media key. It is a
# TOGGLE with no way to know what is playing, and the failure mode is
# documented upstream and reproduced here — it starts Apple Music when nothing
# was playing. An adapter that reports state lets us send an explicit pause,
# and only resume what we actually paused.
#
# PINNED deliberately: this is a private-API workaround, so an upgrade is a
# decision (retest on the target macOS), never drift. Built from source because
# upstream publishes no binaries. NOT committed — this script is the source of
# truth, and wire-into-engine fails loudly if the output is missing.
set -euo pipefail

VERSION="v0.7.6"
REPO="https://github.com/ungive/mediaremote-adapter.git"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$DIR/MediaRemoteAdapter.framework" && -f "$DIR/mediaremote-adapter.pl" \
      && "$(cat "$DIR/.version" 2>/dev/null || true)" == "$VERSION" ]]; then
  echo "mediaremote-adapter $VERSION already present — nothing to do"
  exit 0
fi

command -v cmake >/dev/null || { echo "ERROR: cmake is required to build mediaremote-adapter" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Cloning mediaremote-adapter ${VERSION}…"
git clone --depth 1 --branch "$VERSION" "$REPO" "$tmp/src" >/dev/null 2>&1
( cd "$tmp/src" && mkdir -p build && cd build && cmake .. >/dev/null && cmake --build . >/dev/null )

rm -rf "$DIR/MediaRemoteAdapter.framework"
cp -R "$tmp/src/build/MediaRemoteAdapter.framework" "$DIR/"
cp "$tmp/src/bin/mediaremote-adapter.pl" "$DIR/"
cp "$tmp/src/LICENSE" "$DIR/LICENSE"
chmod +x "$DIR/mediaremote-adapter.pl"
echo "$VERSION" > "$DIR/.version"

# The adapter self-tests whether macOS still lets it through. A failure here is
# not fatal to the build — the feature degrades to doing nothing — but it is
# worth knowing at vendor time rather than in the field.
if [[ -x "$tmp/src/build/MediaRemoteAdapterTestClient" ]]; then
  cp "$tmp/src/build/MediaRemoteAdapterTestClient" "$DIR/"
  if /usr/bin/perl "$DIR/mediaremote-adapter.pl" "$DIR/MediaRemoteAdapter.framework" \
       "$DIR/MediaRemoteAdapterTestClient" test >/dev/null 2>&1; then
    echo "mediaremote-adapter $VERSION built — adapter is functional on this macOS"
  else
    echo "WARNING: mediaremote-adapter built, but its self-test FAILED on this macOS." >&2
    echo "         Pausing background media will no-op until this is resolved." >&2
  fi
else
  echo "mediaremote-adapter $VERSION built (no test client)"
fi
