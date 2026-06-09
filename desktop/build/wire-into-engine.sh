#!/usr/bin/env bash
# Build the closed-source unmute build by wiring the paywall layer on top
# of the OSS engine (unmute-dictation).
#
# Modes:
#   dev    — wire + electron-vite dev (live reload)
#   build  — wire + electron-vite build + electron-builder --mac (signed DMG)
#   sync   — pull latest OSS engine source only (no build)
#
# The paywall layer is "wired in" by:
#   1. Cloning unmute-dictation at a pinned tag into work/oss-engine/
#   2. Copying desktop/src/paywall/ → work/oss-engine/renderer/paywall/
#   3. Copying desktop/electron/ paywall files → work/oss-engine/electron/paywall/
#   4. Applying the small patches documented in PATCHES.md (markers in
#      OSS source files where paywall components are imported/mounted)
#   5. Running the standard OSS build pipeline
#
# Required env (for build mode):
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD
#   __SUPABASE_URL__, __SUPABASE_ANON_KEY__, __PIPELINE_URL__
#
# Usage:
#   ./build/wire-into-engine.sh build
#   ./build/wire-into-engine.sh build --no-sign  # skip notarization (faster local builds)
#   ./build/wire-into-engine.sh dev

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/work"
ENGINE_TAG="${ENGINE_TAG:-v1.3.6}"
OSS_REPO="${OSS_REPO:-https://github.com/arpitpatel25/unmute-dictation.git}"

MODE="${1:-build}"
NO_SIGN="${2:-}"

log()   { echo "[wire] $*" >&2; }
fatal() { log "ERROR: $*"; exit 1; }

# ─── Sanity ────────────────────────────────────────────────────
command -v git >/dev/null  || fatal "git required"
command -v npm >/dev/null  || fatal "npm required"

# ─── Stage 1: Pull OSS engine ───────────────────────────────────

sync_engine() {
  log "Syncing OSS engine at tag $ENGINE_TAG"
  rm -rf "$WORK/oss-engine"
  mkdir -p "$WORK"
  git clone --depth 1 --branch "$ENGINE_TAG" "$OSS_REPO" "$WORK/oss-engine"
  log "Engine synced to $WORK/oss-engine"
}

# ─── Stage 2: Wire paywall layer ────────────────────────────────

wire_paywall() {
  local engine="$WORK/oss-engine"
  [[ -d "$engine" ]] || fatal "Engine not synced — run with 'sync' first or set ENGINE_TAG"

  log "Wiring paywall layer"

  # Copy paywall renderer components
  mkdir -p "$engine/renderer/paywall"
  cp -R "$ROOT/src/paywall/." "$engine/renderer/paywall/"

  # Copy paywall main-process files
  mkdir -p "$engine/electron/paywall"
  cp -R "$ROOT/electron/." "$engine/electron/paywall/"

  # Copy the native-paste addon into the OSS engine so it can be added as a
  # path-based dep and built against Electron's Node ABI by
  # electron-builder's install-app-deps postinstall.
  if [[ -d "$ROOT/native-paste" ]]; then
    log "Copying native-paste addon"
    mkdir -p "$engine/native-paste"
    cp -R "$ROOT/native-paste/." "$engine/native-paste/"
  else
    log "WARN: $ROOT/native-paste not found — native paste will be unavailable"
  fi

  # Copy the native-fn-listener addon. Sibling of native-paste, same install
  # mechanism. Solves the TCC-identity-on-child-binary problem for Fn /
  # Caps Lock / Right Option modifier detection — by running NSEvent
  # monitors IN-PROCESS, the bundle's Input Monitoring grant covers the
  # listener instead of needing a separate grant for the spawned child.
  if [[ -d "$ROOT/native-fn-listener" ]]; then
    log "Copying native-fn-listener addon"
    mkdir -p "$engine/native-fn-listener"
    cp -R "$ROOT/native-fn-listener/." "$engine/native-fn-listener/"
  else
    log "WARN: $ROOT/native-fn-listener not found — Fn detection will fall back to child binary"
  fi

  # Patch engine package.json:
  #   * Add @supabase/supabase-js for the paywall layer
  #   * Pin electron-store to ^8 (CJS). v11+ is ESM-only and crashes our
  #     main process with "TypeError: Store is not a constructor".
  #   * Add unmute-native-paste as a file: dep so npm install + electron
  #     rebuild compiles it against Electron's Node ABI.
  #   * Override appId from PAYWALL_APP_ID env (lets us flip to a fresh
  #     bundle id for dev testing without re-poisoning TCC for the prod id).
  node -e "
    const fs = require('fs')
    const path = '$engine/package.json'
    const pkg = JSON.parse(fs.readFileSync(path, 'utf-8'))
    pkg.dependencies['@supabase/supabase-js'] = '^2.45.0'
    pkg.dependencies['electron-store'] = '^8.2.0'
    if (fs.existsSync('$engine/native-paste/package.json')) {
      pkg.dependencies['unmute-native-paste'] = 'file:./native-paste'
    }
    if (fs.existsSync('$engine/native-fn-listener/package.json')) {
      pkg.dependencies['unmute-native-fn-listener'] = 'file:./native-fn-listener'
    }
    if (process.env.PAYWALL_APP_ID) {
      pkg.build = pkg.build || {}
      pkg.build.appId = process.env.PAYWALL_APP_ID
    }
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2))
  "

  # Drop OSS engine's package-lock — it pins electron-store v11 which would
  # otherwise override our v8 pin during electron-builder's install-app-deps
  # postinstall step.
  rm -f "$engine/package-lock.json"

  # Apply engine-source overrides — full patched copies of OSS files that need
  # paywall integration (App.tsx, Settings.tsx, useAudioRecorder.ts, sessionManager.ts).
  # These live under desktop/engine-overrides/ mirroring the OSS path structure,
  # so a plain recursive copy puts each file in the right place. This replaces the
  # previous "hand-apply PATCHES.md" workflow that was vulnerable to sync_engine
  # wiping the working tree.
  if [[ -d "$ROOT/engine-overrides" ]]; then
    log "Applying engine-overrides"
    cp -R "$ROOT/engine-overrides/." "$engine/"
  else
    log "WARN: $ROOT/engine-overrides not found — UI integration patches will be missing"
  fi

  # Patch engine source — main.ts and preload.ts still get sed-patched (they only
  # need one-line inserts that are stable across OSS releases).
  patch_engine_sources "$engine"

  log "Paywall wired"
}

patch_engine_sources() {
  local engine="$1"

  # 1) main.ts: init paywall after windows are ready
  local main_ts="$engine/electron/main.ts"
  if ! grep -q 'initPaywall' "$main_ts"; then
    # Insert import near the top imports block
    sed -i.bak "/^import { setupAutoUpdater/a\\
import { initPaywall } from './paywall/main-extensions'
" "$main_ts"
    # Inject the import for buildOSSAdapter (engine-override at
    # engine/electron/buildOSSAdapter.ts that wraps OSS's whisperManager /
    # groqTranscribe / keyStore so the provider-router can call BYOK + Local
    # paths). This replaces the old `initPaywall(app, {} as any)` stub.
    sed -i.bak "/^import { initPaywall } from '\.\/paywall\/main-extensions'/a\\
import { buildOSSAdapter } from './buildOSSAdapter'
" "$main_ts"
    rm -f "$main_ts.bak"

    # Rewrite the activate handler AND inject initPaywall in one pass.
    #
    # Two bugs in the OSS default we fix here:
    #   (a) The activate handler's `getAllWindows().length === 0` branch is
    #       unreachable in our build: the widget window stays open for the
    #       life of the app, so length is never 0. Net effect: clicking the
    #       macOS Dock icon after the user closed the main window is a no-op.
    #       Replaced with the standard show-or-recreate pattern.
    #   (b) A naive `sed /createWidgetWindow()/a initPaywall(...)` matches
    #       BOTH the bootstrap and (pre-rewrite) the activate handler, which
    #       would double-register IPC handlers if activate ever fired.
    #       Rewriting the activate handler first removes the second match;
    #       the string replace below is then unambiguous.
    local patcher
    patcher="$(mktemp)"
    cat > "$patcher" <<'NODE_EOF'
const fs = require('fs')
const p = process.argv[2]
let src = fs.readFileSync(p, 'utf-8')

const ACTIVATE_RE = /app\.on\('activate',\s*\(\)\s*=>\s*\{[\s\S]*?\n  \}\)/
const ACTIVATE_NEW = `app.on('activate', () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) {
      createMainWindow()
    } else {
      win.show()
      win.focus()
    }
  })`
if (ACTIVATE_RE.test(src)) {
  src = src.replace(ACTIVATE_RE, ACTIVATE_NEW)
} else {
  console.error('[wire] WARN: activate handler not found in main.ts — Dock-click fix not applied')
}

if (!src.includes('initPaywall(app, buildOSSAdapter())')) {
  src = src.replace(
    'createWidgetWindow()\n',
    'createWidgetWindow()\n  initPaywall(app, buildOSSAdapter())\n'
  )
}

fs.writeFileSync(p, src)
NODE_EOF
    node "$patcher" "$main_ts"
    rm -f "$patcher"
  fi

  # 2) preload.ts: merge paywall API into electronAPI
  local preload="$engine/electron/preload.ts"
  if ! grep -q 'paywallPreloadExtensions' "$preload"; then
    sed -i.bak "/^const electronAPI = {/i\\
import { paywallPreloadExtensions } from './paywall/preload-extensions'
" "$preload"
    # Inject the spread into the electronAPI object literal
    sed -i.bak "/^const electronAPI = {/a\\
  ...paywallPreloadExtensions,
" "$preload"
    rm -f "$preload.bak"
  fi

  # 3) Verify the engine-overrides actually landed (paranoia — these used to be
  #    hand-applied and got destroyed by sync_engine's rm -rf).
  local app_tsx="$engine/renderer/app/App.tsx"
  if ! grep -q 'BalancePill' "$app_tsx"; then
    log "WARN: App.tsx missing BalancePill — engine-overrides may have failed to apply"
  fi
  if ! grep -q 'EngineSettings' "$engine/renderer/app/Settings.tsx"; then
    log "WARN: Settings.tsx missing EngineSettings — engine-overrides may have failed to apply"
  fi
  if ! grep -q 'paywallStreamChunk' "$engine/renderer/widget/useAudioRecorder.ts"; then
    log "WARN: useAudioRecorder.ts missing paywallStreamChunk — engine-overrides may have failed to apply"
  fi
  if ! grep -q 'tryManagedSTT' "$engine/electron/sessionManager.ts"; then
    log "WARN: sessionManager.ts missing tryManagedSTT — engine-overrides may have failed to apply"
  fi
  if ! grep -q 'unmute-native-fn-listener' "$engine/electron/keyListener.ts"; then
    log "WARN: keyListener.ts missing unmute-native-fn-listener — engine-overrides may have failed to apply"
  fi

  # ─── HUD/widget window tightening ─────────────────────────────
  # OSS widget window is 520×140 — the pill itself is only ~480×44 wide
  # so there's ~96px of vertical dead space below the visible pill. That
  # dead space still blocks clicks to apps underneath (Chrome tabs at
  # the top of the screen are the canonical victim). Shrink the window
  # height so it hugs the pill + just enough room for the drop shadow.
  local wm="$engine/electron/windowManager.ts"
  if [[ -f "$wm" ]]; then
    sed -i.bak 's/^const HUD_HEIGHT = 140$/const HUD_HEIGHT = 72  \/\/ patched: was 140, shrunk to kill click-blocking dead zone/' "$wm"
    rm -f "$wm.bak"
    if ! grep -q 'patched: was 140' "$wm"; then
      log "WARN: windowManager.ts HUD_HEIGHT patch did not apply"
    fi
  fi

  # ─── Pill white border ─────────────────────────────────────────
  # OSS pill border is nearly invisible (rgba 0.06). Bump it to a clean
  # thin white outline so the pill reads as a defined object against any
  # background.
  local css="$engine/renderer/styles.css"
  if [[ -f "$css" ]]; then
    sed -i.bak 's|border: 1px solid rgba(255, 255, 255, 0.06);|border: 1px solid rgba(255, 255, 255, 0.55);|' "$css"
    rm -f "$css.bak"
  fi
}

# ─── Stage 3: Build ─────────────────────────────────────────────

run_dev() {
  local engine="$WORK/oss-engine"
  cd "$engine"
  npm install
  npm run dev
}

run_build() {
  local engine="$WORK/oss-engine"
  cd "$engine"

  log "Installing engine deps"
  npm install

  log "Building unsigned bundles"
  npm run build

  if [[ "$NO_SIGN" == "--no-sign" ]]; then
    log "Skipping signing — local build only"
    # Override the production yml's identity + notarize on the CLI so dev
    # builds don't need APPLE_ID/cert and don't try to notarize.
    npx electron-builder --mac \
      --config.mac.identity=null \
      --config.mac.notarize=false
  else
    : "${APPLE_ID:?APPLE_ID required for signed build}"
    : "${APPLE_TEAM_ID:?APPLE_TEAM_ID required}"
    : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD required}"
    log "Signing + notarizing DMG (this can take 5-15 min for the Apple notary trip)"
    npx electron-builder --mac
  fi

  log "Build complete — output in $engine/release/"
  ls -la "$engine/release/" | grep -E '\.dmg$' || true
}

# ─── Dispatch ───────────────────────────────────────────────────

case "$MODE" in
  sync)
    sync_engine
    ;;
  dev)
    [[ -d "$WORK/oss-engine" ]] || sync_engine
    wire_paywall
    run_dev
    ;;
  build)
    sync_engine
    wire_paywall
    run_build
    ;;
  *)
    fatal "Unknown mode '$MODE' — use sync, dev, or build"
    ;;
esac
