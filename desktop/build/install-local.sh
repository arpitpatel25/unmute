#!/usr/bin/env bash
#
# INSTALL A LOCAL DEV BUILD INTO /Applications — THE ONLY SUPPORTED WAY.
#
# WHY THIS SCRIPT EXISTS. On 2026-09-08 a dev build was installed by running
# `build:fast` (which is `--no-sign`, i.e. `--config.mac.identity=null`) and
# then ad-hoc signing the result with `codesign --sign -`. That silently reset
# every macOS permission the app had — Microphone, Accessibility, Screen
# Recording — and broke the "unmute Safe Storage" Keychain item, which then
# prompted for the login password.
#
# THE MECHANISM, because it is not obvious and it will bite again otherwise.
# TCC does not remember an app by name or by bundle id. It keys each grant to
# the app's DESIGNATED REQUIREMENT. For a Developer-ID-signed build that is:
#
#   identifier "com.arpitpatel.unmute" and anchor apple generic
#     and certificate leaf[subject.OU] = D8ZHT5S2XQ
#
# which is byte-identical across every rebuild — that is precisely why grants
# have always survived reinstalls. An unsigned or ad-hoc bundle has no
# certificate anchor, so TCC falls back to pinning the raw CDHash, and a CDHash
# changes on every single build AND on every re-sign. macOS then sees a
# different application that happens to share a name, and voids everything.
# The Keychain ACL stores the same requirement, hence the password prompt.
#
# Ad-hoc signing without `--entitlements` also STRIPS the entitlements. Paste
# broke two ways at once that day: the Apple Events grant was voided and
# `com.apple.security.automation.apple-events` was gone from the binary, so
# re-granting the permission could not have fixed it.
#
# SO: sign locally with the real Developer ID. Only NOTARIZATION is safe to
# skip for a local install — it costs minutes and Gatekeeper is not in the path
# for an app you built yourself and never downloaded.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$HERE/work/oss-engine"
ENT="$ENGINE/build/entitlements.mac.plist"
IDENTITY="${UNMUTE_SIGN_IDENTITY:-Developer ID Application: Arpit Patel (D8ZHT5S2XQ)}"
TEAM_OU="${UNMUTE_TEAM_OU:-D8ZHT5S2XQ}"
DEST="/Applications/unmute.app"
RESET_ONBOARDING="${1:-}"

: "${PAYWALL_VERSION:?PAYWALL_VERSION required, e.g. PAYWALL_VERSION=1.5.23-dev.13 $0}"

# The default `python3` here is homebrew python@3.14, whose pyexpat is broken,
# and node-gyp then cannot compile better-sqlite3. See the publish notes.
if [[ -x /opt/homebrew/opt/python@3.12/bin/python3.12 ]]; then
  export PYTHON=/opt/homebrew/opt/python@3.12/bin/python3.12
  export npm_config_python="$PYTHON"
fi

if ! security find-identity -v -p codesigning | grep -q "$TEAM_OU"; then
  echo "FATAL: no codesigning identity for team $TEAM_OU in the keychain." >&2
  echo "       Refusing to install — an unsigned install resets every TCC grant." >&2
  exit 1
fi

echo "==> building $PAYWALL_VERSION (signed, NOT notarized)"
# Signed exactly as a release is, minus notarization and minus publishing.
# `identity` is left at the package.json default so electron-builder picks the
# Developer ID cert; only `notarize` and `publish` are overridden.
# `--no-sign` here buys the FAST packaging path (no notarization round-trip); it
# is not how the installed artifact ends up signed. We re-sign the packaged
# bundle below with the real identity, which is what makes the requirement
# stable — the designated requirement is a property of the signature, not of the
# build that produced the bundle.
#
# Output is NOT swallowed and the exit code is NOT ignored. `npm run build` in
# this repo is known to exit 0 on a hard failure (see the publish notes), so the
# real check is the DMG existence test immediately after.
( cd "$HERE" && ./build/wire-into-engine.sh build --no-sign )

DMG="$(ls -t "$ENGINE"/release/unmute-"$PAYWALL_VERSION"-arm64.dmg 2>/dev/null | head -1)"
[[ -f "$DMG" ]] || { echo "FATAL: no DMG for $PAYWALL_VERSION in $ENGINE/release" >&2; exit 1; }

MP="$(hdiutil attach "$DMG" -nobrowse -noverify | grep -o '/Volumes/.*' | tail -1)"
trap 'hdiutil detach "$MP" -quiet 2>/dev/null || true' EXIT

STAGE="$(mktemp -d)/unmute.app"
mkdir -p "$(dirname "$STAGE")"
cp -R "$MP/unmute.app" "$STAGE"
hdiutil detach "$MP" -quiet; trap - EXIT

echo "==> signing inner-to-outer with: $IDENTITY"
sign() { codesign --force --timestamp=none --options runtime \
                  --entitlements "$ENT" --sign "$IDENTITY" "$@" 2>&1 \
         | grep -v "replacing existing signature" || true; }

# ORDER MATTERS. Nested Mach-O first, then frameworks, then helper apps, then
# the bundle. Signing the outside first seals hashes that the inner signatures
# then invalidate. `--deep` is deprecated and would apply one entitlements file
# to every helper by accident; here that happens to be correct (the project sets
# `entitlements` and `entitlementsInherit` to the same plist) but it is spelled
# out rather than relied on.
while IFS= read -r f; do sign "$f"; done < <(
  find "$STAGE" \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \) -type f
  find "$STAGE/Contents/Resources" -type f -perm +111 2>/dev/null \
    | while read -r f; do file "$f" | grep -q "Mach-O" && echo "$f"; done
)
for f in "$STAGE"/Contents/Frameworks/*.framework \
         "$STAGE"/Contents/Resources/*/*.framework; do
  [[ -d "$f" ]] && sign "$f"
done
for h in "$STAGE"/Contents/Frameworks/*.app; do [[ -d "$h" ]] && sign "$h"; done
sign "$STAGE"

# THE GATE. Nothing touches /Applications until the requirement is proven to be
# the stable Developer-ID one. This is the check whose absence caused the
# incident: an ad-hoc bundle verifies fine and installs fine, and the damage is
# only visible later as a permission prompt.
REQ="$(codesign -d -r- "$STAGE" 2>&1 | grep '^designated' || true)"
if [[ "$REQ" != *"subject.OU] = $TEAM_OU"* ]]; then
  echo "FATAL: designated requirement is not the Developer ID one:" >&2
  echo "       $REQ" >&2
  echo "       Refusing to install — this would reset every TCC grant." >&2
  exit 1
fi
codesign --verify --deep --strict "$STAGE"

echo "==> installing"
osascript -e 'tell application "unmute" to quit' 2>/dev/null || true
sleep 3; pkill -f "unmute.app/Contents/MacOS/unmute" 2>/dev/null || true; sleep 1
rm -rf "$DEST"; cp -R "$STAGE" "$DEST"; rm -rf "$(dirname "$STAGE")"

if [[ "$RESET_ONBOARDING" == "--reset-onboarding" ]]; then
  USER_HOME_DIR="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')"
  ONBOARDING_STATE="$USER_HOME_DIR/Library/Application Support/unmute/onboarding"
  if [[ "$USER_HOME_DIR" == /Users/* && "$ONBOARDING_STATE" == /Users/*/Library/Application\ Support/unmute/onboarding ]]; then
    echo "==> clearing onboarding test state"
    rm -rf "$ONBOARDING_STATE"
  else
    echo "FATAL: refusing to clear unexpected onboarding path: $ONBOARDING_STATE" >&2
    exit 1
  fi
elif [[ -n "$RESET_ONBOARDING" ]]; then
  echo "FATAL: unknown option '$RESET_ONBOARDING' (supported: --reset-onboarding)" >&2
  exit 1
fi

echo "==> installed:"
codesign -d -r- "$DEST" 2>&1 | grep '^designated'
open -a "$DEST"
