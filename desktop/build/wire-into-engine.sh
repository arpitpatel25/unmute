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

# Inject the cloud env (Supabase / pipeline / payments URLs) into ALL builds —
# the same vars run-dev.sh loads. electron.vite.config.ts reads these from
# process.env at build time and bakes them into the renderer; WITHOUT them a
# production build ships empty/localhost URLs and sign-in (Supabase OAuth)
# breaks. Sourcing here makes `build` and `compile` correct by default instead
# of relying on the caller to export them.
ENV_DEV_FOUND=0
if [[ -f "$ROOT/.env.dev" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.dev"
  set +a
  ENV_DEV_FOUND=1
fi
ENGINE_TAG="${ENGINE_TAG:-v1.3.6}"
OSS_REPO="${OSS_REPO:-https://github.com/arpitpatel25/unmute-dictation.git}"

MODE="${1:-build}"
NO_SIGN="${2:-}"

log()   { echo "[wire] $*" >&2; }
fatal() { log "ERROR: $*"; exit 1; }

# ─── Sanity ────────────────────────────────────────────────────
command -v git >/dev/null  || fatal "git required"
command -v npm >/dev/null  || fatal "npm required"

# A packaged build with no .env.dev bakes localhost:54321 as the auth server.
# The app then installs, launches, looks completely normal — and cannot sign
# anyone in, because it is talking to a server that does not exist. Nothing in
# the build output says so, and the failure surfaces much later as "why am I
# signed out", which is exactly how it played out on 2026-08-01: three dev
# builds shipped from a worktree, each silently pointed at localhost.
#
# .env.dev is git-ignored, so it does NOT travel to a worktree — which makes
# building from one the normal way to hit this, not an exotic mistake.
#
# Fatal for `build` only. `compile` is a typecheck gate that never gets
# installed, so it has no auth to break.
if [[ "$MODE" == "build" && "$ENV_DEV_FOUND" == "0" ]]; then
  fatal "desktop/.env.dev not found — refusing to build.
    A packaged build without it bakes localhost:54321 as the auth server, so
    the installed app cannot sign in and NOTHING reports why.
    Building from a worktree? .env.dev is git-ignored and does not travel:
      cp <main-checkout>/desktop/.env.dev $ROOT/.env.dev"
fi

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

  # Copy the native-ax addon (Computer Use / ax-mcp). Same in-process pattern
  # as native-paste: AXUIElement control loaded into the main process so the
  # signed .app's Accessibility grant covers every AX call (a child binary
  # would get its own TCC identity and silently fail). Exclude the local dev
  # build/ + node_modules so electron-builder rebuilds it clean for the ABI.
  if [[ -d "$ROOT/native-ax" ]]; then
    log "Copying native-ax addon"
    mkdir -p "$engine/native-ax"
    rsync -a --exclude 'build' --exclude 'node_modules' "$ROOT/native-ax/" "$engine/native-ax/" 2>/dev/null \
      || cp -R "$ROOT/native-ax/." "$engine/native-ax/"
  else
    log "WARN: $ROOT/native-ax not found — Computer Use (ax-mcp) will be unavailable"
  fi

  # Copy the native-audio-tap addon (meeting notetaker system-audio capture).
  # Same in-process pattern as native-ax/native-fn-listener — see that
  # module's README for why. Exclude the local dev build/ + node_modules so
  # electron-builder rebuilds it clean for the ABI.
  if [[ -d "$ROOT/native-audio-tap" ]]; then
    log "Copying native-audio-tap addon"
    mkdir -p "$engine/native-audio-tap"
    rsync -a --exclude 'build' --exclude 'node_modules' "$ROOT/native-audio-tap/" "$engine/native-audio-tap/" 2>/dev/null \
      || cp -R "$ROOT/native-audio-tap/." "$engine/native-audio-tap/"
  else
    log "WARN: $ROOT/native-audio-tap not found — meeting notetaker will be unavailable"
  fi

  # Vendor the cua-driver embedded binary (Computer Use v2 engine). Unmute
  # spawns it as a DIRECT child so it runs inside the signed .app's TCC
  # responsibility chain (embedded mode). Fail LOUDLY if missing rather than
  # shipping an app whose Computer Use silently cannot work.
  if [[ -x "$ROOT/vendor/cua-driver/cua-driver" ]]; then
    log "Copying cua-driver binary (Computer Use v2)"
    mkdir -p "$engine/vendor/cua-driver"
    cp "$ROOT/vendor/cua-driver/cua-driver" "$engine/vendor/cua-driver/cua-driver"
    cp "$ROOT/vendor/cua-driver/NOTICE.md" "$engine/vendor/cua-driver/NOTICE.md"
  else
    log "ERROR: vendor/cua-driver/cua-driver missing — run desktop/vendor/cua-driver/fetch.sh first"
    exit 1
  fi

  # Vendor the mediaremote-adapter (pause background media while dictating).
  # FATAL IF MISSING, like cua-driver above. It used to be a warning, on the
  # reasoning that the feature is opt-in and degrades to doing nothing — which
  # is true at RUNTIME and wrong at BUILD time. The runtime is deliberately
  # silent about an absent adapter so a broken install never breaks dictation;
  # that same silence meant a build made in a fresh checkout shipped without it
  # and said nothing. Observed 19 August: every dev build for days had no media
  # pause, and it was found by a user noticing, not by any check.
  #
  # The artefacts are fetched, not committed (see the .gitignore beside
  # fetch.sh), so EVERY new clone and worktree starts without them. A warning
  # in a few hundred lines of build output is not a signal anyone reads.
  # macOS 15.4+ put MediaRemote behind an entitlement, and this adapter reaches
  # it through /usr/bin/perl — see fetch.sh for why the media key is not an
  # acceptable substitute.
  if [[ -d "$ROOT/vendor/mediaremote-adapter/MediaRemoteAdapter.framework" ]]; then
    log "Copying mediaremote-adapter (background media pause)"
    mkdir -p "$engine/vendor/mediaremote-adapter"
    cp -R "$ROOT/vendor/mediaremote-adapter/MediaRemoteAdapter.framework" "$engine/vendor/mediaremote-adapter/"
    cp "$ROOT/vendor/mediaremote-adapter/mediaremote-adapter.pl" "$engine/vendor/mediaremote-adapter/"
    cp "$ROOT/vendor/mediaremote-adapter/LICENSE" "$engine/vendor/mediaremote-adapter/LICENSE"
  else
    log "ERROR: vendor/mediaremote-adapter missing — background media pause would silently no-op."
    log "       Run: bash desktop/vendor/mediaremote-adapter/fetch.sh"
    exit 1
  fi

  # Build + vendor the native notch shell (spec 2026-07-24). Like cua-driver it
  # is spawned as a DIRECT child of the signed .app, so its NSPanel carries the
  # app's identity and never steals focus. Built from source here (Swift toolchain
  # is a build-machine dependency, same as node-gyp for the native addons).
  if [[ -d "$ROOT/native-notch" ]]; then
    log "Building native notch shell (swift build -c release)"
    if (cd "$ROOT/native-notch" && swift build -c release >/dev/null 2>&1); then
      notch_bin="$ROOT/native-notch/.build/release/unmute-notch"
      if [[ -x "$notch_bin" ]]; then
        mkdir -p "$engine/vendor/unmute-notch"
        cp "$notch_bin" "$engine/vendor/unmute-notch/unmute-notch"
        log "notch shell vendored"
      else
        log "ERROR: swift build succeeded but $notch_bin is missing"
        exit 1
      fi
    else
      log "ERROR: swift build failed for native-notch — is the Swift toolchain installed?"
      exit 1
    fi
  else
    log "WARN: $ROOT/native-notch not found — the notch UI will be unavailable"
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
    if (fs.existsSync('$engine/native-ax/package.json')) {
      pkg.dependencies['unmute-native-ax'] = 'file:./native-ax'
    }
    if (fs.existsSync('$engine/native-audio-tap/package.json')) {
      pkg.dependencies['unmute-native-audio-tap'] = 'file:./native-audio-tap'
    }
    // Unmute Remote: node-pty is the PTY backend for the owned interactive
    // claude session (PRD §4.1). It's a native module — electron-builder's
    // install-app-deps rebuilds it against Electron's ABI, and its .node
    // binary must be unpacked from the asar so it can be dlopen'd at runtime.
    pkg.dependencies['node-pty'] = '^1.1.0'
    // Personal Memory: SQLCipher-capable SQLite is the encrypted index. This
    // exact native binding is rebuilt against Electron's ABI; ordinary
    // better-sqlite3 is deliberately not a fallback.
    pkg.dependencies['better-sqlite3-multiple-ciphers'] = '12.11.1'
    // Unmute Remote: xterm.js renders the owned-PTY stream as a real terminal
    // in the render-on-demand live view (PRD §4.3) — faithful TUI + typeable —
    // instead of the old ANSI-stripped <pre>. Renderer deps (bundled by vite),
    // not native.
    pkg.dependencies['@xterm/xterm'] = '^5.5.0'
    pkg.dependencies['@xterm/addon-fit'] = '^0.10.0'
    // Parakeet on-device STT: the OSS engine doesn't depend on sherpa-onnx, so
    // declare it here. electron-builder's install-app-deps then installs it
    // (pulling the sherpa-onnx-darwin-arm64 optional-dep with the native addon
    // + dylibs) and bundles it into the app. Without this, a fresh sync_engine
    // re-clone wipes the dep and the whisper.ts→parakeet override's
    // require('sherpa-onnx-node') fails at runtime.
    pkg.dependencies['sherpa-onnx-node'] = '^1.13.3'
    // Agent answers arrive as ordinary markdown, and the dashboard used to
    // render it with a hand-rolled classifier that printed \`\`\` fences
    // literally. react-markdown + remark-gfm is the same class of engine the
    // notch now parses with (cmark-gfm), so the two surfaces agree on what the
    // text MEANS and differ only in how they paint it. Renderer deps, bundled
    // by vite — not native.
    pkg.dependencies['react-markdown'] = '^9.0.1'
    pkg.dependencies['remark-gfm'] = '^4.0.0'
    pkg.build = pkg.build || {}
    pkg.build.asarUnpack = pkg.build.asarUnpack || []
    if (!pkg.build.asarUnpack.includes('**/node_modules/node-pty/**')) {
      pkg.build.asarUnpack.push('**/node_modules/node-pty/**')
    }
    if (!pkg.build.asarUnpack.includes('**/node_modules/better-sqlite3-multiple-ciphers/**')) {
      pkg.build.asarUnpack.push('**/node_modules/better-sqlite3-multiple-ciphers/**')
    }
    // Parakeet on-device STT: sherpa-onnx ships native dylibs
    // (libsherpa-onnx-c-api.dylib, libsherpa-onnx-cxx-api.dylib,
    // libonnxruntime*.dylib) alongside the .node addon. The existing
    // '**/*.node' rule unpacks the addon but NOT the sibling dylibs, so they'd
    // stay inside the asar and fail to dlopen at runtime. Unpack both packages
    // wholesale; electron-builder's notarize:true then signs the unpacked
    // dylibs. Dedup so a re-wire doesn't push twice.
    for (const glob of [
      '**/node_modules/sherpa-onnx-darwin-arm64/**',
      '**/node_modules/sherpa-onnx-node/**',
    ]) {
      if (!pkg.build.asarUnpack.includes(glob)) pkg.build.asarUnpack.push(glob)
    }
    // Drop the unused faster-whisper extraResource. Parakeet replaced the
    // whisper engines; faster-whisper was never invoked. Leaving resources/bin
    // + resources/lib (whisper-cli/server + ggml dylibs) alone — harmless and
    // safer than risking a missing-resource build error.
    if (Array.isArray(pkg.build.extraResources)) {
      pkg.build.extraResources = pkg.build.extraResources.filter(
        (r) => !(r && typeof r === 'object' && /faster-whisper/.test(String(r.from)))
      )
    }
    // Computer Use v2: ship the vendored cua-driver into Resources/cua-driver/
    // so the packaged app resolves it at process.resourcesPath. electron-builder
    // signs bundle binaries during the deep sign; Task 7 verifies the identity.
    pkg.build.extraResources = pkg.build.extraResources || []
    if (!pkg.build.extraResources.some((r) => r && typeof r === 'object' && /cua-driver/.test(String(r.from)))) {
      pkg.build.extraResources.push({ from: 'vendor/cua-driver', to: 'cua-driver' })
    }
    // Notch UI: ship the Swift shell into Resources/unmute-notch/ so the packaged
    // app resolves it at process.resourcesPath (init.ts). Same deep-sign path as
    // cua-driver.
    if (!pkg.build.extraResources.some((r) => r && typeof r === 'object' && /unmute-notch/.test(String(r.from)))) {
      pkg.build.extraResources.push({ from: 'vendor/unmute-notch', to: 'unmute-notch' })
    }
    // Background-media pause: the adapter framework and its perl script are
    // BUNDLED, never linked — the script loads the framework itself.
    if (!pkg.build.extraResources.some((r) => r && typeof r === 'object' && /mediaremote-adapter/.test(String(r.from)))) {
      pkg.build.extraResources.push({ from: 'vendor/mediaremote-adapter', to: 'mediaremote-adapter' })
    }
    if (process.env.PAYWALL_APP_ID) {
      pkg.build = pkg.build || {}
      pkg.build.appId = process.env.PAYWALL_APP_ID
    }
    // Override the OSS publish target so electron-updater on installed
    // managed builds checks our release repo, not the OSS unmute-dictation
    // repo. Without this, the in-app auto-updater would silently look at
    // the wrong place and never find a newer version.
    pkg.build = pkg.build || {}
    pkg.build.publish = [{
      provider: 'github',
      owner: 'arpitpatel25',
      repo: 'unmute',
    }]
    // Auto-update artifacts: macOS electron-updater consumes a .zip + the
    // generated latest-mac.yml — the DMG is ONLY for first-install website
    // downloads, the updater can't read it. Build BOTH: dmg for the website,
    // zip (+ latest-mac.yml) for hands-free in-app updates. Without the zip
    // target there is nothing for installed apps to update from.
    pkg.build.mac = pkg.build.mac || {}
    pkg.build.mac.target = [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ]
    // Register the unmute:// URL scheme in the macOS Info.plist
    // (CFBundleURLTypes). WITHOUT this, a notarized app never receives the
    // unmute://auth/callback (sign-in) or unmute://payment-success (Dodo return)
    // deep links — app.setAsDefaultProtocolClient() at runtime is NOT enough for
    // a packaged macOS app, so sign-in can't complete and the payment-success
    // bounce is lost. electron-builder writes the plist entry from build.protocols.
    pkg.build.protocols = [{
      name: 'Unmute',
      schemes: ['unmute'],
      role: 'Viewer',
    }]
    // Bundle ONLY English. Electron ships ~50+ locale .lproj/.pak files; codesign
    // makes a separate Apple timestamp round-trip PER FILE, so signing fires
    // hundreds of network calls and a single drop aborts the whole sign (the
    // 'A timestamp was expected but was not found' failures). The app is
    // English-only, so pruning to en-US cuts those files to ~1 and makes signing
    // reliable. (Also shrinks the bundle a little.)
    pkg.build.electronLanguages = ['en-US']
    // Version bump from env. Required for electron-updater to recognize
    // releases as newer than what the user has installed; the OSS
    // package.json stays on 1.3.6 and DMG names follow it unless we
    // bump explicitly here.
    if (process.env.PAYWALL_VERSION) {
      pkg.version = process.env.PAYWALL_VERSION
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

  # ─── Unmute Remote: init wiring (INDEPENDENT of the initPaywall guard) ───
  # Must run even when main.ts was already paywall-patched by a prior wire,
  # otherwise initRemote never lands and Remote silently never starts.
  # Anchors on the buildOSSAdapter import + the initPaywall(...) call, both of
  # which the paywall patch guarantees. ADDITIVE — dictation init untouched.
  if ! grep -q 'initRemote' "$main_ts"; then
    sed -i.bak "/^import { buildOSSAdapter } from '\.\/buildOSSAdapter'/a\\
import { initRemote } from './paywall/remote/init'
" "$main_ts"
    rm -f "$main_ts.bak"
    node -e "
      const fs = require('fs'); const p = '$main_ts'; let s = fs.readFileSync(p, 'utf-8')
      if (!s.includes('initRemote({')) {
        s = s.replace(
          'initPaywall(app, buildOSSAdapter())\n',
          'initPaywall(app, buildOSSAdapter())\n  initRemote({ sessionManager, keyboardManager })\n'
        )
      }
      fs.writeFileSync(p, s)
    "
    if ! grep -q 'initRemote({' "$main_ts"; then
      log "WARN: initRemote call injection did not land in main.ts"
    fi
  fi

  # ─── Meeting Notetaker: init wiring (INDEPENDENT of the initPaywall guard,
  # same reasoning as initRemote just above) ───
  #
  # notetakerInit.ts (engine-overrides/electron/, landed at the OSS engine's
  # electron ROOT by the engine-overrides copy above) owns MeetingWatcher +
  # NotetakerSession + NotetakerController + the keyboard chord wiring; it
  # cannot reach the floating widget itself (a closed-source paywall-tree
  # file, desktop/electron/remote/notetakerWidget.ts — which the `cp -R
  # $ROOT/electron/. $engine/electron/paywall/` step above lands at
  # $engine/electron/paywall/remote/notetakerWidget.ts, note the extra
  # `remote/` — SAME directory `desktop/electron/remote/init.ts` lands in,
  # which is exactly why the sibling `initRemote` import just above this one
  # reads './paywall/remote/init', not './paywall/init') so its show()/hide()
  # are injected here as hooks — see notetakerInit.ts's own file header for
  # why this lives in main.ts rather than in paywall/remote/init.ts.
  if ! grep -q 'initNotetaker' "$main_ts"; then
    sed -i.bak "/^import { initRemote } from '\.\/paywall\/remote\/init'/a\\
import { initNotetaker } from './notetakerInit'\\
import { showNotetakerWidget, hideNotetakerWidget } from './paywall/remote/notetakerWidget'
" "$main_ts"
    rm -f "$main_ts.bak"
    node -e "
      const fs = require('fs'); const p = '$main_ts'; let s = fs.readFileSync(p, 'utf-8')
      if (!s.includes('initNotetaker({')) {
        s = s.replace(
          'initRemote({ sessionManager, keyboardManager })\n',
          'initRemote({ sessionManager, keyboardManager })\n  initNotetaker({ onSessionStart: showNotetakerWidget, onSessionStop: hideNotetakerWidget })\n'
        )
      }
      fs.writeFileSync(p, s)
    "
    if ! grep -q 'initNotetaker({' "$main_ts"; then
      log "WARN: initNotetaker call injection did not land in main.ts"
    fi
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

  # 2b) preload.ts: merge the Unmute Remote API into electronAPI (ADDITIVE).
  if ! grep -q 'remotePreloadExtensions' "$preload"; then
    sed -i.bak "/^const electronAPI = {/i\\
import { remotePreloadExtensions } from './paywall/remote-preload'
" "$preload"
    sed -i.bak "/^const electronAPI = {/a\\
  ...remotePreloadExtensions,
" "$preload"
    rm -f "$preload.bak"
  fi

  # 3) Verify the engine-overrides actually landed (paranoia — these used to be
  #    hand-applied and got destroyed by sync_engine's rm -rf).
  local app_tsx="$engine/renderer/app/App.tsx"
  if ! grep -q 'BalancePill' "$app_tsx"; then
    log "WARN: App.tsx missing BalancePill — engine-overrides may have failed to apply"
  fi
  # Settings was split into Account/Permissions/Settings tabs (abd38ed), so the
  # old EngineSettings marker no longer exists anywhere. Check a marker that is
  # actually present, or this warns on every healthy build and trains everyone
  # to ignore it (it did — it masked a real missing-import bug for a day).
  if ! grep -q 'onDictationKeyChange' "$engine/renderer/app/Settings.tsx"; then
    log "WARN: Settings.tsx missing onDictationKeyChange — engine-overrides may have failed to apply"
  fi
  if ! grep -q 'RemoteSettings' "$engine/renderer/app/App.tsx"; then
    log "WARN: App.tsx missing the Remote tab — engine-overrides may have failed to apply"
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
  # ─── Unmute Remote wiring checks (ADDITIVE) ───
  if ! grep -q 'remote-start' "$engine/electron/keyboard.ts"; then
    log "WARN: keyboard.ts missing Remote-key seam — engine-overrides may have failed to apply"
  fi
  # `remoteCaptureActive` was renamed away; the load-bearing marker is the
  # capture KIND that startSession threads through to the widget.
  if ! grep -q "startSession('dictation', 'remote')" "$engine/electron/sessionManager.ts"; then
    log "WARN: sessionManager.ts missing the Remote capture branch — engine-overrides may have failed to apply"
  fi
  if [[ ! -f "$engine/electron/paywall/remote/init.ts" ]]; then
    log "WARN: remote/init.ts not copied into engine — Remote will not initialise"
  fi
  if ! grep -q 'OverlayApp' "$engine/renderer/main.tsx"; then
    log "WARN: main.tsx missing OverlayApp route — Remote overlay window will be blank"
  fi
  if ! grep -q 'initRemote' "$engine/electron/main.ts"; then
    log "WARN: main.ts missing initRemote — Remote will not start"
  fi
  if ! grep -q 'remotePreloadExtensions' "$engine/electron/preload.ts"; then
    log "WARN: preload.ts missing remotePreloadExtensions — renderer Remote API absent"
  fi
  # ─── Meeting Notetaker wiring checks (ADDITIVE) ───
  if [[ ! -f "$engine/electron/notetakerInit.ts" ]]; then
    log "WARN: notetakerInit.ts not copied into engine — meeting notetaker will not initialise"
  fi
  # Two SEPARATE checks on purpose: the first matches even when only the
  # IMPORT line landed (e.g. the call-injection step above silently failed to
  # find its anchor) — that alone leaves onSessionStart/onSessionStop
  # undefined and the widget never appears, so it must fail loudly, not just
  # the import.
  if ! grep -q 'initNotetaker' "$engine/electron/main.ts"; then
    log "WARN: main.ts missing initNotetaker — meeting notetaker will not start"
  fi
  if ! grep -q 'initNotetaker(' "$engine/electron/main.ts"; then
    log "WARN: main.ts has the initNotetaker import but never CALLS it — meeting notetaker will not start"
  fi
  # Widget lands at electron/paywall/remote/, not electron/paywall/ — same
  # directory desktop/electron/remote/init.ts lands in (see the comment on
  # the injection above this block). Checking the file's presence there AND
  # that main.ts's import specifier actually points at it catches both a
  # copy failure and a stale/wrong import path landing silently.
  if [[ ! -f "$engine/electron/paywall/remote/notetakerWidget.ts" ]]; then
    log "WARN: notetakerWidget.ts not copied into engine — meeting notetaker widget will not initialise"
  fi
  if ! grep -q "from './paywall/remote/notetakerWidget'" "$engine/electron/main.ts"; then
    log "WARN: main.ts missing the correct notetakerWidget import path — widget show/hide will be undefined"
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
    # ─── Bundled-library permissions (THE broken-auto-update fix) ───
    # The 0.9.7 ggml dylibs entered resources/lib with r--r--r-- modes
    # (2026-06-30). Squirrel/ShipIt must strip the quarantine xattr from every
    # file of a downloaded update before swapping it in — a read-only file
    # makes that a Permission-denied, ShipIt aborts the ENTIRE install and
    # silently relaunches the old version. Every auto-update since has failed
    # this way ('restart to update' → same version, prompt forever). Writable
    # modes in the PACKAGE are what heal it — including for users stuck on old
    # versions, since ShipIt checks the NEW package's files.
    if [[ -d "$engine/resources/lib" ]]; then
      chmod -R u+w "$engine/resources/lib"
      if find "$engine/resources/lib" -type f ! -perm -u+w | grep -q .; then
        log "WARN: read-only files remain in resources/lib — auto-update will fail"
      else
        log "resources/lib permissions normalized (auto-update installability)"
      fi
    fi

    # HUD above NATIVE FULLSCREEN: the window already joins fullscreen Spaces
    # (visibleOnFullScreen), but level 'floating' orders BELOW a native-
    # fullscreen app's window — the pill showed over Chrome-style fullscreen
    # yet vanished over a fullscreen terminal. 'screen-saver' is the level
    # macOS HUD utilities use: above fullscreen windows, everywhere.
    sed -i.bak "s/setAlwaysOnTop(true, 'floating')/setAlwaysOnTop(true, 'screen-saver')/g" "$wm"
    rm -f "$wm.bak"
    if grep -q "setAlwaysOnTop(true, 'floating')" "$wm"; then
      log "WARN: HUD window-level patch did not fully apply — pill may hide over fullscreen apps"
    fi

    # WIDEN the HUD: the pill row grew a family (model badge, RAW toggle,
    # staged-images chip, mic-source chip, hint/status text chips) and 520px
    # clips the row's ends — chips vanished at the invisible window edge.
    # 900px fits the full ensemble; the window is click-through by default,
    # so the extra invisible width blocks nothing.
    sed -i.bak 's/^const HUD_WIDTH = 520$/const HUD_WIDTH = 900  \/\/ patched: was 520 — the chip row outgrew it/' "$wm"
    rm -f "$wm.bak"
    if ! grep -q 'patched: was 520' "$wm"; then
      log "WARN: windowManager.ts HUD_WIDTH patch did not apply"
    fi
    # Make the HUD click-through by DEFAULT so the empty area around the pill
    # never blocks clicks to the apps behind it. The renderer flips it interactive
    # (hud:set-interactive, wired in main-extensions) only while the cursor is
    # actually over the pill/badge/card. forward:true keeps mousemove flowing so
    # the renderer can hit-test.
    sed -i.bak 's/hudWindow.setIgnoreMouseEvents(false)/hudWindow.setIgnoreMouseEvents(true, { forward: true }) \/\/ patched: click-through; renderer toggles/' "$wm"
    rm -f "$wm.bak"
    if ! grep -q 'patched: click-through' "$wm"; then
      log "WARN: windowManager.ts HUD click-through patch did not apply"
    fi

    # MOVE THE DICTATION PILL TO THE BOTTOM (notch UI redesign, spec 2026-07-24).
    # The redesign splits the screen by ROLE: top-center = status OUTPUT (the
    # notch shell owns it), bottom-center = voice INPUT (this pill). Leaving the
    # pill at the top would collide with the notch — they'd fight for the same
    # strip. workArea already excludes the Dock, so anchoring to its bottom edge
    # floats the pill just above the Dock without ever interfering with it.
    sed -i.bak 's|^  const y = workArea.y + 6.*$|  const y = workArea.y + workArea.height - HUD_HEIGHT + 16 // patched: bottom-anchored, Wispr-style — the renderer scales the pill to 0.62 top-anchored, so the window dips 16px lower to keep the pill hugging the usable bottom|' "$wm"
    rm -f "$wm.bak"
    if ! grep -q 'patched: bottom-anchored' "$wm"; then
      log "WARN: windowManager.ts HUD bottom-anchor patch did not apply — dictation pill will collide with the notch"
    fi

    # LIVE reposition (Wispr parity): the show path already recomputes bounds,
    # but if the Dock hides/shows or the display changes WHILE the pill is up,
    # follow it. Appended at module scope (same file ⇒ sees hudWindow/getHUDBounds).
    cat >> "$wm" <<'EOF'

// patched: Wispr-style adaptive pill — live reposition while visible when the
// Dock hides/shows or display metrics change (show-time recompute covers the rest).
// MUST wait for app-ready: Electron's `screen` module throws if touched before
// ready, and this module is imported at startup (dev.23 hang, 2026-07-24).
app.whenReady().then(() => {
  screen.on('display-metrics-changed', () => {
    if (hudWindow?.isVisible()) hudWindow.setBounds(getHUDBounds())
  })
})
EOF
    if ! grep -q 'Wispr-style adaptive pill' "$wm"; then
      log "WARN: windowManager.ts pill live-reposition append did not apply"
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
    # Zero shadow on the recording pill (user request). Appended last so it wins
    # over the base .unmute-pill box-shadow; idempotent (only add once).
    if ! grep -q 'unmute: recording pill — no drop shadow' "$css"; then
      printf '\n/* unmute: recording pill — no drop shadow */\n.unmute-pill { box-shadow: none; }\n' >> "$css"
    fi
  fi

  # ─── Dictation crash-recovery wiring (main.ts) ─────────────────
  # The module ships via engine-overrides (cp -R, above). Here we import it and
  # call it from app.whenReady, right after initDB(), so any dictation whose audio
  # was saved but never transcribed (app died mid-flight) is recovered into
  # History on launch. Fail-open; never touches the live recording path.
  local mainf="$engine/electron/main.ts"
  if [[ -f "$mainf" ]] && ! grep -q 'recoverOrphanDictations' "$mainf"; then
    perl -0pi -e "s/(import \{ initDB[^\n]*from '\.\/db';?)/\$1\nimport { recoverOrphanDictations } from '.\/dictation-recovery';/" "$mainf"
    perl -0pi -e "s/(\n[ \t]*initDB\(\);?)/\$1\n  void recoverOrphanDictations();/" "$mainf"
    if ! grep -q 'recoverOrphanDictations' "$mainf"; then
      log "WARN: main.ts dictation-recovery wiring did not apply"
    fi
  fi
}

# ─── Stage 3: Build ─────────────────────────────────────────────

# node-pty (Unmute Remote PTY backend) ships prebuilt spawn-helper binaries that
# can land WITHOUT the executable bit, causing `posix_spawnp failed` at runtime
# (confirmed on macOS/arm64). Ensure +x after install. Harmless if already set.
fix_node_pty_helper() {
  local engine="$1"
  local helpers
  helpers=$(find "$engine/node_modules/node-pty" -name 'spawn-helper' 2>/dev/null || true)
  if [[ -n "$helpers" ]]; then
    echo "$helpers" | while read -r h; do chmod +x "$h" 2>/dev/null || true; done
    log "Ensured +x on node-pty spawn-helper"
  fi
}

run_dev() {
  local engine="$WORK/oss-engine"
  # Source dev env (Supabase URL/keys) so the renderer's supabase client gets a
  # real URL — without this createClient("") throws and the renderer is blank.
  if [[ -f "$ROOT/.env.dev" ]]; then
    log "Sourcing .env.dev for dev paywall vars"
    set -a; source "$ROOT/.env.dev"; set +a
  else
    log "WARN: no desktop/.env.dev — cloud sign-in disabled in dev (Local/BYOK/Remote still work)"
  fi
  cd "$engine"
  npm install
  fix_node_pty_helper "$engine"
  npm run dev
}

run_build() {
  local engine="$WORK/oss-engine"
  cd "$engine"

  log "Installing engine deps"
  npm install
  fix_node_pty_helper "$engine"

  log "Building unsigned bundles"
  npm run build

  # ─── Bundled-library permissions, THE effective pass (auto-update fix) ───
  # The engine's build re-copies the ggml dylibs FROM HOMEBREW (download-
  # whisper.js copyFileSync, no chmod) — and brew keeps its files r--r--r--,
  # recreating the bad modes AFTER any earlier normalization. Read-only files
  # in the package make Squirrel/ShipIt's quarantine-strip fail with
  # Permission-denied on user machines → every auto-update since 2026-06-30
  # silently aborted and relaunched the old version. This pass runs AFTER the
  # engine build (nothing rewrites the libs past this point) and BEFORE
  # electron-builder packages them.
  if [[ -d "$engine/resources" ]]; then
    chmod -R u+w "$engine/resources"
    if find "$engine/resources" -type f ! -perm -u+w | grep -q .; then
      fatal "read-only files remain in resources/ — packaging would ship a broken auto-update"
    fi
    log "resources/ permissions normalized post-build (auto-update installability)"
  fi

  if [[ "$NO_SIGN" == "--no-sign" ]]; then
    log "Skipping signing — local build only"
    # Override the production yml's identity + notarize on the CLI so dev
    # builds don't need APPLE_ID/cert and don't try to notarize.
    npx electron-builder --mac \
      --config.mac.identity=null \
      --config.mac.notarize=false \
      --publish never
  else
    : "${APPLE_ID:?APPLE_ID required for signed build}"
    : "${APPLE_TEAM_ID:?APPLE_TEAM_ID required}"
    : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD required}"
    log "Signing + notarizing the app (Apple notary trip, 5-15 min)"
    # Build LOCALLY only — do NOT let electron-builder publish yet. electron-builder
    # notarizes + staples the .app, but it leaves the DMG itself UN-notarized. A bare
    # DMG is an untrusted download: the stapled app runs fine FROM the DMG, but once
    # dragged into /Applications macOS flags it "damaged". So we notarize + staple the
    # DMG ourselves below, THEN publish the stapled artifacts.
    npx electron-builder --mac --publish never

    local rel="$engine/release"
    # A stale alias from a previous run must never be mistaken for this build's
    # output — it is a copy of the PREVIOUS version's DMG under a name that
    # sorts adjacent to the real one.
    rm -f "$rel/unmute-arm64.dmg"
    local dmg; dmg="$(ls "$rel"/*.dmg | head -1)"
    log "Notarizing + stapling the DMG itself (second notary trip) — so downloads aren't flagged 'damaged'"
    xcrun notarytool submit "$dmg" \
      --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"  # aborts loudly (set -e) if the ticket didn't attach

    # The landing page links at a VERSION-LESS asset name so the site never
    # needs editing per release:
    #   /releases/latest/download/unmute-arm64.dmg
    # electron-builder only emits the versioned name, so ship a copy under the
    # stable one as well. Without it, every "Get unmute" button on the site 404s
    # the instant this release becomes `latest` — the site is fine, the asset it
    # names simply isn't there. Copied AFTER stapling so the alias carries the
    # notarization ticket, and re-validated because a download that skips the
    # ticket is exactly the "unmute is damaged" report we staple to avoid.
    # The publish globs below are *.dmg, so this uploads with everything else.
    cp "$dmg" "$rel/unmute-arm64.dmg"
    xcrun stapler validate "$rel/unmute-arm64.dmg"

    # Publish the STAPLED artifacts ourselves as a single draft. Doing it via gh
    # (instead of electron-builder --publish) also avoids electron-builder's parallel
    # dmg/zip upload racing into two duplicate drafts. PAYWALL_PUBLISH=skip|never
    # builds + staples locally without uploading.
    local pub_flag="${PAYWALL_PUBLISH:-always}"
    if [[ "$pub_flag" != "skip" && "$pub_flag" != "never" ]]; then
      : "${GH_TOKEN:?GH_TOKEN required to publish (export GH_TOKEN=\"\$(gh auth token)\")}"
      local ver; ver="$(node -p "require('$engine/package.json').version")"
      log "Publishing v$ver to GitHub as a DRAFT (stapled DMG + zip + latest-mac.yml)"
      gh release create "v$ver" \
        "$rel"/*.dmg "$rel"/*.zip "$rel"/*.blockmap "$rel/latest-mac.yml" \
        --repo arpitpatel25/unmute --draft --title "$ver" --notes "Automated release $ver." \
      || gh release upload "v$ver" \
        "$rel"/*.dmg "$rel"/*.zip "$rel"/*.blockmap "$rel/latest-mac.yml" \
        --clobber --repo arpitpatel25/unmute
      log "Draft v$ver is up. VERIFY then go live: gh release edit v$ver --draft=false --latest --repo arpitpatel25/unmute"
    fi
  fi

  # Remove the unpacked .app once the DMG/zip exist — Spotlight indexes stray
  # .app bundles and users end up with three 'unmute's in search, risking
  # launches of stale builds. The DMG/zip are the artifacts; the dir is scrap.
  rm -rf "$engine/release/mac-arm64"
  log "Build complete — output in $engine/release/ (unpacked .app cleaned)"
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
  compile)
    # Wire + typecheck/compile only (no sign, no launch). Verifies the engine
    # integration compiles against the real engine + renderer. Reuses an
    # existing engine checkout if present (skips the re-clone).
    [[ -d "$WORK/oss-engine" ]] || sync_engine
    wire_paywall
    cd "$WORK/oss-engine"
    # The SQLCipher-capable SQLite binding is a hard security dependency. Keep
    # this install unsuppressed so an install/rebuild/ABI failure stops compile
    # mode rather than silently leaving Personal Memory without encryption.
    npm install better-sqlite3-multiple-ciphers@12.11.1 --no-save
    # node-pty (PTY backend) + xterm (live-terminal renderer dep) + the markdown
    # renderer's engine so the integrated build resolves them. These mirror the
    # deps wire_paywall adds to package.json; a name missing here fails ONLY in
    # compile mode, which is the mode whose whole job is catching that class of
    # mistake.
    npm install node-pty @xterm/xterm @xterm/addon-fit react-markdown remark-gfm --no-save >/dev/null 2>&1 || true
    # Targeted `npm install` compiles native addons for the host Node ABI and
    # does not run the engine root's postinstall. Force the memory binding onto
    # the pinned Electron ABI, then load it with that Electron runtime so a
    # skipped/incompatible rebuild cannot hide behind a successful Vite build.
    log "Rebuilding SQLCipher binding for Electron"
    npx electron-rebuild --force --only better-sqlite3-multiple-ciphers
    ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "
      const Database = require('better-sqlite3-multiple-ciphers')
      const db = new Database(':memory:')
      db.prepare('SELECT 1').get()
      db.close()
    "
    log "SQLCipher binding loaded under Electron"
    fix_node_pty_helper "$WORK/oss-engine"
    log "Compiling (electron-vite build)…"
    npx electron-vite build
    ;;
  *)
    fatal "Unknown mode '$MODE' — use sync, dev, build, or compile"
    ;;
esac
