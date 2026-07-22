# Background-driving an Electron app (Notion) — the proven mechanism

Goal: drive a desktop Electron app end-to-end (navigate, scroll, edit, verify)
while it stays on another Space / behind other windows, never stealing the
user's keyboard focus or moving their windows. "Codex-parity" background control.

## What does NOT work (proven, this session)

- **Wheel scroll on an off-Space window is compositor-blocked.** SkyLight
  `SLEventPostToPid`, public `CGEvent.postToPid`, and the session HID tap — line
  units and pixel units, with focus-without-raise applied — all deliver the
  wheel event but the viewport never moves (8/8). Scrolling is run by the
  Space's active compositor, which macOS does not run for an off-Space window.
  (cua hard-guards Electron scroll for the same reason.)
- **Keyboard scroll (PageDown) off-Space:** also dead.
- **SCK screenshot of an off-Space window is STALE for scroll.** A held
  ScreenCaptureKit stream keeps the window *rendered* (purple icon) and its
  screenshots are real — but the *composited surface* does not update when you
  scroll off-Space, so SCK shows the old top-of-page.
- **The "Codex" reference app has no magic input channel.** ChatGPT.app (the
  Codex host) is itself Electron; its "work with apps" uses Apple Events
  automation + Accessibility on scriptable dev tools. It does not generically
  drive-and-scroll an app like Notion.

Click and type *do* land off-Space (Chromium hit-tests them directly), but
without scroll + reliable vision that isn't enough.

## What DOES work — CDP (Chrome DevTools Protocol)

Launch the Electron app with `--remote-debugging-port=PORT` (we control the
background launch). Then everything goes through the **renderer**, which is
immune to Space / focus / compositor:

- **scroll:** `Runtime.evaluate` set `scroller.scrollTop` → actually scrolls.
- **vision:** `Page.captureScreenshot` renders from the renderer → reflects the
  true scrolled/edited state (unlike SCK). Retina, full quality.
- **navigate:** `el.click()` on a link (Notion SPA) — target id follows the tab.
- **read:** query the DOM directly (find the last sub-page, verify text, etc.).
- **edit:** see gotcha below.

### Gotcha: Notion discards `Input.insertText`

Notion's rich-text editor (Lexical/Slate-style) silently drops one-shot DOM
writes / `Input.insertText`. **Fix: send real per-character key events**
(`Input.dispatchKeyEvent` keyDown+keyUp per char). Focus the last
`[contenteditable=true]`, collapse the selection to its end, then typekeys.

## Files

- `cdp-launch.sh <App> [port]` — background-relaunch an Electron app with the port.
- `cdp.mjs <titleOrTargetId> <cmd> [arg]` — dependency-free CDP driver
  (Node ≥22 built-in WebSocket). Commands: `scroll bottom|top|<px>`,
  `clicktext "<text>"`, `focusend`, `typekeys "<text>"`, `type`, `key <Key>`,
  `eval "<js>"`, `shot <out.png>`.
  Match by target **id** (not title) so it follows in-tab navigation.

## Proven run (this session)

Notion off-Space (`onScreen=false`), front app never Notion:
open Calorify AI → scroll bottom → open last sub-page "Codex Computer Use" →
scroll bottom → append a signature line (typekeys) → navigate back to Calorify AI.
Every step verified by CDP DOM read + CDP screenshot.

## Caveat

`--remote-debugging-port` opens a localhost CDP port any local process can
connect to while the app runs. Fine for personal automation; note it for
anything security-sensitive.
