# unmute-native-fn-listener

In-process Fn / Caps Lock / Right Option modifier-key listener, loaded as a
Node native addon into the main Electron process.

## Why this exists

The OSS engine ships a Swift Mach-O child binary (`globe-listener`) that
Electron's main process spawns. macOS TCC keys Input Monitoring and
Accessibility grants by **per-binary code-signature identity** — and the
child has its own identity, separate from the `.app` bundle. ~50% of OSS
users report Fn-key detection silently fails: they grant permissions to
"unmute" in System Settings, but those grants don't extend to the child
binary the user has never seen.

This addon runs **in the main process** (same PID as the .app) so it
inherits whatever permissions the user grants the bundle. Same approach as
`unmute-native-paste`.

## API

```ts
const fn = require('unmute-native-fn-listener')

// One-time setup. Callback fires for every modifier transition.
fn.start((event: string) => {
  // event ∈ { 'fn-down', 'fn-up', 'caps-down', 'caps-up',
  //          'right-option-down', 'right-option-up' }
})

// Idempotent stop. Safe to call from app-quit handlers.
fn.stop()

// Quick diagnostic. Note: NSEvent monitors actually need Input Monitoring,
// not Accessibility — but the bundle's overall trust state is a reasonable
// proxy and matches what the user sees in System Settings.
const trusted: boolean = fn.isAccessibilityTrusted()
```

## Build

`node-gyp rebuild` produces `build/Release/native_fn_listener.node`. In
Electron apps, `@electron/rebuild` (or `electron-builder install-app-deps`
postinstall) compiles it against Electron's Node ABI.

## Permissions

The `flagsChanged` NSEvent monitors require **Input Monitoring** under
macOS 10.15+. The user grants it from:
System Settings → Privacy & Security → Input Monitoring → enable unmute.

`isAccessibilityTrusted()` is exposed for symmetry with native-paste but is
NOT a strict gate on whether modifier detection will work — Input Monitoring
is the correct permission category.
