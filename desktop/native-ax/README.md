# unmute-native-ax

Background macOS app control via the Accessibility API, loaded **in-process** in
Unmute's Electron main process. This is the engine behind Unmute's Computer Use
(the `computer` MCP server) — it lets Claude Code operate desktop apps without
ever bringing them to the front.

## Why in-process (the whole reason this is a native addon)

macOS attaches the **Accessibility** TCC grant to the *responsible process*. A
separate helper binary spawned by a terminal gets its **own** code identity —
not in the user's Accessibility list — so its `AXUIElement` calls silently fail.
(This repo already learned that the hard way with `key-poster`/`globe-listener`;
see `../native-paste/README.md`.)

A Node addon loaded via `require()` runs in the **same PID** as the signed
`.app` bundle. TCC checks the bundle's identity — which the user granted — so AX
calls actually land. One permission grant to Unmute covers every app, from any
terminal, forever.

## The rules this engine follows

1. **Never raise, activate, or focus an app.** Background is the whole point.
2. **Direct `AXUIElementCreateApplication(pid)`.** No System Events / AppleScript
   (non-deterministic, and it cannot set `AXManualAccessibility`).
3. **Set `AXManualAccessibility` on every app.** Chromium/Electron ships its
   a11y tree disabled — without this, Notion/Slack/WhatsApp/Discord expose
   nothing. (`AXEnhancedUserInterface` is the AppKit equivalent; we set both.)
4. **Act on elements, never coordinates.** Coordinate clicks need the app
   frontmost — the exact problem we're avoiding.

## API

```js
const ax = require('unmute-native-ax')
ax.isTrusted()                       // AXIsProcessTrusted()
ax.listApps()                        // [{name, bundleId, pid, windowsHere, windowsAnywhere}]
ax.frontmostApp()                    // name (used to assert focus is unchanged)
ax.find(app, label, role)            // { app, nodes:[{id,role,label,actions}], total }
ax.getTree(app, win, rolesCsv, depth, all)
ax.press(app, id)                    // { ok, role, label } | { error }
ax.setValue(app, id, text)
ax.fillForm(app, { "12": "text" })
ax.menuAction(app, "File > Save")
ax.captureWindow(app, maxWidth)      // { ok, base64, width, height }  (per-window, background-safe)
```

Every result is a plain JSON object. Errors are returned as `{ error }`, never
thrown, so the MCP layer can turn them into instructive tool messages.

## Build

```bash
npm install            # node-gyp rebuild --release
```

Apple frameworks only (ApplicationServices, Cocoa, CoreGraphics, Foundation).
Zero third-party dependencies. Zero network calls.

## On-device smoke test

```bash
node smoke.js Notes    # reads the app's tree and asserts focus never changed
```

Grant Accessibility to the terminal (dev) or to Unmute.app (prod) first; the
grant needs a full app restart to take effect.

## Known limits (OS-level, not bugs)

- **Other Spaces are invisible.** "Background" = same Space, unfocused. An app on
  another desktop reports zero reachable windows. `listApps` distinguishes this
  (`windowsHere` vs `windowsAnywhere`).
- **Element ids shift after any action** (positional tree walk). Re-run `find`
  between steps.
- **`setValue` no-ops on some apps** that require a focused field — fall back to
  `menuAction` or `press`.
