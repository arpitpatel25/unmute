# unmute-native-paste

Native macOS CGEvent paste, loaded in-process from the main Electron process.

## Why this exists

Every prior fast-paste attempt in unmute used a separate Mach-O binary
(`key-poster`, `globe-listener`) as a child of the main process. macOS TCC
checks the **child binary's** code identity for Accessibility, not the parent
`.app`'s. The child has its own identity hash, isn't in the user's Accessibility
list, and `CGEventPost` silently drops the event (returns `void`, no error,
exit code 0).

A Node native addon loaded via `require()` runs **in-process** — same PID,
same code-signature identity as the `.app` bundle. TCC checks the `.app`'s
identity, which is what the user actually granted Accessibility to, and the
paste lands.

## API

```ts
const native = require('unmute-native-paste')

// Diagnostic: is THIS process trusted to post events?
const trusted: boolean = native.isAccessibilityTrusted()

// Diagnostic: dump process metadata (executable path, bundle ID, PID)
const info = native.processInfo()

// Actually paste. Returns a result object with one flag per step taken
// plus `ok` overall. Never throws.
const r = native.postCmdV()
// r = {
//   ax_trusted: bool,
//   source_created: bool,
//   events_created: bool,
//   posted: bool,
//   ok: bool,
//   stepFailed?: string,  // only when ok=false
//   error?: string,       // only when ok=false
// }

// Diagnostic/polling primitive: NSPasteboard.changeCount, a monotonic
// integer bumped on every clipboard write by any process. Reading it costs
// one property access — no decode, no allocation — so it's safe to poll on
// the main process WHILE RECORDING, where reading actual pasteboard
// contents corrupts the audio. It also identifies our own writes exactly:
// record the value right after an Unmute write and skip it. -1 on
// non-macOS (distinguishable from any real count).
const count: number = native.clipboardChangeCount()
```

## Build

`node-gyp rebuild` produces `build/Release/native_paste.node`. Requires
node-addon-api (a runtime dep). In Electron apps, run
`@electron/rebuild` (or the `electron-builder install-app-deps` postinstall
the OSS engine already has) so the binary matches Electron's Node ABI.

## Logging

Every step in `postCmdV` writes to the returned `result` object. The calling
JS code (`clipboard.ts`) logs the full object on each call. No silent failure
modes — if paste doesn't land, the log says exactly which step succeeded and
which one didn't.
