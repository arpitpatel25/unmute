# Notch UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans or
> subagent-driven-development. Steps use `- [ ]` for tracking.

**Goal:** Collapse the three scattered task surfaces into one — a live macOS
notch — driven by a native Swift/SwiftUI helper that Electron main spawns and
controls over JSON stdio.

**Architecture:** A standalone Swift executable (`unmute-notch`) owns an
always-on-top, non-activating `NSPanel` pinned at the notch and renders the
4-state shell (idle → peek → attention panel → cockpit-trigger) with SwiftUI
spring animation. Electron main runs a `notch/` client (modeled on
`cua/driver-client.ts` + `driver-manager.ts`) that spawns the helper, pushes
state, and receives taps/gestures. The task model + status contract stay in
Electron main (source of truth); the helper is a view + input surface. The full
cockpit stays an Electron `BrowserWindow` (`OrchestrateWall`), shown on demand.

**Tech Stack:** Swift 6.2 + SwiftUI + AppKit (`NSPanel`, `NSHostingView`); Node
`child_process` + line-delimited JSON; existing Electron/TS remote runtime;
`node --test` + `tsx` for the TS side.

## Global Constraints (verbatim from the spec)

- **Surface reorg, not behavior change.** Untouched: router, status-file
  contract, task logging, curator, provider router + billing, computer-use lanes,
  doorbell TTS path.
- **Top-center = OUTPUT (status/notch). Bottom-center = INPUT (voice).**
- **Queue = your-move only** (`needs-user/stuck/errored/ready`); plain `done`
  is cockpit-only. Skip = requeue to the back. Spans one-offs AND sessions.
- **No focus steal, ever** — the panel is non-activating (`NSPanel` + Spaces
  join-all + `.screenSaver` level), matching today's `overlay.ts`.
- **Notch-less Macs get a small dummy notch**; behavior identical.
- **Native helper is bundled + signed** like the other native components in
  `wire-into-engine.sh`.

---

## The IPC protocol (the load-bearing contract)

Line-delimited JSON, one object per line. Electron main ⇄ `unmute-notch`.

**main → helper (commands):**
```jsonc
{ "type": "setState", "state": "idle" | "peek" | "panel",
  "attention": <int>,            // your-move queue depth (drives the counter)
  "working": <int> }             // our-move count (drives the idle glow)
{ "type": "showTask", "task": {  // the task currently fronted in the panel
    "id": "…", "title": "…", "state": "needs-user"|"stuck"|"errored"|"ready",
    "summary": "…",              // warm-up / where-you-left-off
    "options": ["…"],            // tappable choices, if any
    "terminalHint": "open"|"collapsed" } }
{ "type": "notchGeometry", "hasNotch": bool, "x": n, "y": n, "w": n, "h": n }
{ "type": "collapse" }           // → idle
{ "type": "quit" }
```

**helper → main (events):**
```jsonc
{ "type": "ready" }                              // handshake, sent once on boot
{ "type": "tap" }                                // peek tapped → open panel
{ "type": "next" }                               // crank advance
{ "type": "openDashboard" }                      // user asked for full cockpit
{ "type": "chooseOption", "index": n }           // tapped a needs-user option
{ "type": "toggleTerminal", "open": bool }       // terminal reveal in the panel
{ "type": "collapsed" }                          // panel/peek dismissed by user
```

The Electron `BrowserWindow` cockpit and the raw `LiveTerminal` are NOT rendered
by the helper — `openDashboard` makes Electron show its own window. (Terminal
inside the panel is deferred; see Stage 6.)

---

## File structure

```
desktop/
  native-notch/                         # NEW — the Swift helper (Swift Package)
    Package.swift
    Sources/unmute-notch/
      main.swift                        # run loop + stdin reader + stdout writer
      IPC.swift                         # Codable command/event structs + framing
      NotchWindow.swift                 # NSPanel: level, Spaces, non-activating
      NotchGeometry.swift               # NSScreen safeAreaInsets / dummy-notch calc
      NotchView.swift                   # SwiftUI root: idle/peek/panel morph
      PanelView.swift                   # attention-panel content (one task + next)
      Theme.swift                       # monochrome tokens + spring params
    README.md
  electron/remote/notch/                # NEW — Electron-side client
    notch-client.ts                     # spawn + JSON framing (like driver-client)
    notch-controller.ts                 # task-manager events → setState/showTask
    notch-client.test.ts
    notch-controller.test.ts
  electron/remote/overlay.ts            # RETIRE (replaced by notch)
  electron/remote/orchestrate.ts        # MODIFY: shown via openDashboard, not ⌘⇧O only
  engine-overrides/renderer/main.tsx    # MODIFY: drop #/overlay route
  engine-overrides/renderer/<mainapp>   # MODIFY: remove task rendering
  build/wire-into-engine.sh             # MODIFY: build+sign native-notch into bundle
```

---

## Stage 1 — Swift helper foundation (compiles, shows a notch, speaks JSON)

Deliverable: `swift build` produces `unmute-notch`; run it, it prints
`{"type":"ready"}`, shows a black rounded notch panel at top-center, and on
receiving `{"type":"setState","state":"peek",...}` on stdin it grows. Verified by
running the binary manually.

### Task 1.1: Swift package skeleton + IPC framing
**Files:** Create `native-notch/Package.swift`, `Sources/unmute-notch/IPC.swift`,
`Sources/unmute-notch/main.swift`.
- [ ] Package.swift: executable target `unmute-notch`, macOS 13 platform.
- [ ] IPC.swift: `Codable` `Command` (enum by `type`) + `Event` structs; a
      `readLoop` that reads stdin line-by-line → decodes `Command`; `emit(Event)`
      that writes one JSON line to stdout + flush.
- [ ] main.swift: create `NSApplication` (`.accessory` activation policy so it
      never appears in the Dock / never takes focus), start the stdin read loop on
      a background thread, `emit(.ready)`, run `NSApp.run()`.
- [ ] Build: `cd native-notch && swift build`. Expected: builds clean.
- [ ] Smoke: `echo '{"type":"quit"}' | .build/debug/unmute-notch` prints
      `{"type":"ready"}` then exits.
- [ ] Commit.

### Task 1.2: The notch NSPanel (level, Spaces, non-activating)
**Files:** Create `NotchWindow.swift`, `NotchGeometry.swift`; modify `main.swift`.
- [ ] NotchGeometry: compute top-center frame from `NSScreen.main`. If
      `safeAreaInsets.top > 0` → hardware notch (use `auxiliaryTopLeftArea`
      width); else dummy-notch constants. Expose `idleFrame` / `peekFrame` /
      `panelFrame`.
- [ ] NotchWindow: `NSPanel` with `.nonactivatingPanel`, `styleMask` borderless,
      `level = .screenSaver`, `collectionBehavior = [.canJoinAllSpaces,
      .stationary, .fullScreenAuxiliary]`, `isOpaque=false`, clear background,
      `hidesOnDeactivate=false`, `ignoresMouseEvents` toggled by state.
- [ ] main.swift: create the panel on launch, order front with
      `orderFrontRegardless()` (never `makeKeyAndOrderFront`).
- [ ] Smoke: run the binary; a small shape sits under the notch, does not steal
      focus from the active app, survives Space switches.
- [ ] Commit.

### Task 1.3: SwiftUI root + idle→peek morph
**Files:** Create `NotchView.swift`, `Theme.swift`; host it via `NSHostingView`
in NotchWindow.
- [ ] Theme: monochrome tokens (near-black fill, hairline border, one amber
      accent), corner radii, and a shared `Animation.spring` (response ~0.35,
      damping ~0.8) — the "live" feel lives here.
- [ ] NotchView: `@State var state` driving a shape that morphs size/cornerRadius
      between idle and peek with the spring; idle shows the glow when `working>0`,
      peek shows the attention count.
- [ ] Wire `setState` command → update the hosted view's state → animate; resize
      the NSPanel frame inside the same `withAnimation` (or animate the content
      and keep the panel at panelFrame — decide by smoke test).
- [ ] Smoke: `echo '{"type":"setState","state":"peek","attention":2,"working":1}'`
      into the running binary → the notch springs open to a peek with "2".
- [ ] Commit.

## Stage 2 — Electron client + controller (main drives the helper)

Deliverable: Electron main spawns the helper, forwards task-state changes to it,
and receives its events. Unit-tested with a fake helper (mirror
`cua/fake-driver.mjs`).

### Task 2.1: `notch-client.ts` — spawn + JSON framing
- [ ] Modeled on `cua/driver-client.ts`: spawn the resolved binary, buffer stdout
      by lines, parse JSON, emit typed events; `send(cmd)` writes a JSON line;
      handle crash/respawn + a `fake` binary path override for tests.
- [ ] Test (`notch-client.test.ts`) against a `fake-notch.mjs`: send a command →
      assert the fake received it; fake emits an event → assert client surfaces it.
- [ ] Commit.

### Task 2.2: `notch-controller.ts` — task events → helper state
- [ ] Subscribe to `TaskManager` events (`needs-user`, `ready`, `done`, state
      transitions). Maintain the **your-move queue** (your-move only; skip =
      requeue to back). Derive `setState`/`showTask`/counts and push to the client.
- [ ] Map helper events back: `tap`→open panel (focus fronted task), `next`→
      advance queue, `chooseOption`→`manager.answer`, `openDashboard`→show cockpit
      window, `collapsed`→idle.
- [ ] Test (`notch-controller.test.ts`): feed synthetic task transitions, assert
      the emitted commands + queue ordering + requeue-on-skip.
- [ ] Commit.

### Task 2.3: Wire into `init.ts`
- [ ] Resolve the helper path (`resourcesPath/unmute-notch` packaged /
      `native-notch/.build/...` dev), construct client + controller, push
      `notchGeometry` once, dispose on shutdown. Gate behind
      `UNMUTE_NOTCH_ENABLED` (default on in dev) so the old overlay can be toggled
      back during field testing.
- [ ] Commit.

## Stage 3 — Retire the overlay + relocate the dictation pill

- [ ] Remove `#/overlay` route in `main.tsx`; retire `overlay.ts` (guarded by the
      feature flag so it can flip back).
- [ ] Relocate the dictation widget window from top-center to bottom-center,
      floated above the Dock (adjust its window bounds; no renderer change to the
      pill itself).
- [ ] Smoke: dictation still records/pastes from the bottom; no right overlay
      appears; task status shows only in the notch.
- [ ] Commit.

## Stage 4 — Re-home the cockpit under the notch

- [ ] `orchestrate.ts`: keep the `#/orchestrate` `BrowserWindow`, but its show
      trigger becomes the helper's `openDashboard` event (keep ⌘⇧O as a fallback).
      Position/size to ~60–80% top-center-hanging; Escape collapses back to idle.
- [ ] Ensure the cockpit remains the ONLY place plain-`done` tasks + task history
      appear.
- [ ] Commit.

## Stage 5 — Remove tasks from the main app

- [ ] In the main renderer app, remove task list/status UI; keep dictation +
      settings + dictation history. Verify no task IPC remains wired to the main
      window.
- [ ] Commit.

## Stage 6 — Attention-panel depth + terminal (iterative, post-mechanism)

- [ ] `PanelView.swift`: full one-task layout per state (read `ready`, tappable
      `needs-user` options, `stuck`/`errored` + respond), `next` + "1 of N"
      counter, all at panel size (never dashboard).
- [ ] Terminal-in-panel: on-demand, sticky, state-aware (`stuck`/`errored` default
      open). DECISION during build: render a live terminal inside the Swift panel
      (hard — needs a PTY view) vs. "open in cockpit" button. Default to the
      button; revisit only if the button feels wrong. Log whichever cap we take.
- [ ] Motion polish pass against real hardware (spring params, jelly morph).
- [ ] Commit.

## Stage 7 — Build/packaging + signing

- [ ] `wire-into-engine.sh`: add a step to `swift build -c release` the helper and
      copy `unmute-notch` into the app bundle resources; codesign it with the app
      identity (mirror the cua-driver / native-addon signing); ensure hardened
      runtime + notarization cover it.
- [ ] Verify a signed build launches the notch with correct TCC (no focus steal).
- [ ] Commit.

---

## Self-review notes

- **Spec coverage:** §3 states → Stages 1,3,4,6; §4 crank → Task 2.2; §5 input
  split → Stage 3; §6 main app → Stage 5; §7 dummy notch → Task 1.2; §9 native
  approach → Stages 1–2,7; §10 blast radius → Stages 3–5; §11 open items →
  Task 2.3 (flag), Stage 6 (terminal/layout), Stage 7 (multi-display verify).
- **Honest caps:** Swift GUI/animation quality and the in-panel-terminal decision
  are inherently iterative against a running build (Stage 6) — those tasks are
  milestone-level by necessity, not fictional bite-sized code. Everything on the
  TS side is unit-testable and specified concretely.
- **Reused precedents:** `cua/driver-client.ts` (spawn+JSON), `cua/fake-driver.mjs`
  (test double), `overlay.ts` (panel level/Spaces/no-focus-steal constants).
