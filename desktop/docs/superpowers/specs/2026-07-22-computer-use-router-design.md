# Unmute Computer-Use — Design Spec

**Goal:** Give unmute (Claude Code + voice) reliable "hands" to operate desktop apps for the user — quietly in the background wherever physically possible, and visibly-but-non-intrusively everywhere else — by routing each task to the strongest available control channel for that app.

**Architecture:** Claude Code is the brain (already exists). A **Computer-Use Router** (evolution of the existing `unmute-computer` / cua-driver, "v3") sits under it and, per target app, picks one of a small set of **lanes** (control channels), handles how the agent *sees* the app, and manages the one setup step CDP needs. Voice-triggered, quiet by default.

**Tech stack:** cua-driver (Rust; AX + pixel + agent-cursor + background delivery, already integrated), Chrome DevTools Protocol over a Node WebSocket client (dependency-free), macOS Apple Events / Accessibility (AXUIElement), ScreenCaptureKit for capture.

---

## 1. Context & the problem we're actually solving

"Computer use" = a **brain** (see the screen, decide the action) + **hands** (click/scroll/type). The brain is ~95% of the difficulty and unmute already *is* it (Claude Code). This spec is about the hands.

The naive dream — "drive **any** app, **fully hidden** on another desktop, **never** interrupt the user" — is physically impossible on macOS, and no shipping product (Codex included) actually has it. We proved the boundaries by hand (§2). The job is therefore **not** to find one magic mechanism; it is to **route** each task to the best real channel and degrade gracefully.

## 2. What we proved (the evidence base — 2026-07-22)

| Finding | Status |
|---|---|
| **CDP** (Chrome DevTools Protocol) drives any Electron/browser app end-to-end — scroll, click, navigate, type, screenshot — **off-Space, unfocused, no focus steal, reliably.** Proven on Notion (open sub-page → scroll → edit → return). | ✅ proven |
| CDP requires the app launched with `--remote-debugging-port`. You **cannot** attach to an already-open app that lacks it. | ✅ proven |
| CDP screenshot (`Page.captureScreenshot`) reflects true DOM/scroll state; **ScreenCaptureKit screenshots go stale** for an off-Space window (compositor doesn't update it). | ✅ proven |
| Notion's editor **silently discards `Input.insertText`** → must use **per-character key events** (`Input.dispatchKeyEvent`). | ✅ proven |
| **Input injection** (SkyLight `SLEventPostToPid` / `CGEvent.postToPid`): click + type **land** per-PID even off-Space; **wheel scroll is compositor-blocked off-Space** (8/8 dead) and per-PID wheel does **not** drive native `NSScrollView` at all. | ✅ proven |
| **Session HID-tap scroll** works on a native app **when it is on the active Space and focused/hovered** (moved TextEdit). It routes to the window under the point. | ✅ proven |
| **Apple Events** (AppleScript) drives scriptable native apps (Notes: create + append + read-back) **fully invisibly, zero focus.** | ✅ proven |
| Full-screen apps get their **own Space**; a target on a different Space is the failing case for every pixel/wheel method. | ✅ proven |
| Direct **AX scroll** (set an `AXScrollBar` value) off-Space — inconclusive; couldn't reach a scroll area via AX on an off-Space TextEdit in the one attempt. | ⚠️ open (§9) |

## 3. The core law (design principle)

> **No single channel is both universal and fully hidden.**
> - **Universal** (works on literally any app) ⟹ pixel/screenshot ⟹ needs the app **on the current Space and visible** (foreground-ish; you can watch, it doesn't steal focus).
> - **Fully hidden** (off-Space, occluded, no focus steal) ⟹ a **per-app inside channel** (CDP for Chromium, Apple Events for scriptable native) ⟹ **not** universal.

The router's whole job is to sit on top of this law and always pick the best channel a given app allows.

## 4. Architecture

```
  User (voice)
      │
  Claude Code  ── the brain: understands intent, plans, verifies
      │  (MCP tool calls)
  Computer-Use Router ──────────────────────────────────────────
      │  classify target app → pick lane → manage vision + arming
      ├── Lane A: CDP            (Chromium/Electron/browsers)   [hidden]
      ├── Lane B: Apple Events   (scriptable native apps)       [hidden]
      ├── Lane C: cua AX         (native apps with an AX tree)  [mostly hidden]
      └── Lane D: cua pixel      (anything else — universal)    [visible/on-Space]
```

The router is the productized `unmute-computer` MCP. Lanes A/B are added; C/D already exist in cua.

## 5. The lanes

### Lane A — CDP (primary; Chromium/Electron/browsers)
- **Covers:** Notion, Slack, Discord, VS Code, Obsidian, Linear, Figma-desktop, ChatGPT-desktop, **Chrome/Edge/Brave/Arc and every website in them** — the majority of daily software.
- **Mechanism:** connect to the app's `--remote-debugging-port`; drive the renderer directly. Scroll = set the scroller's `scrollTop`; navigate = `el.click()`; type = per-char `Input.dispatchKeyEvent` (fallback from `insertText`); see = `Page.captureScreenshot`; read/verify = query the DOM.
- **Properties:** fully background, off-Space, occluded-OK, no focus steal, deterministic (DOM, not pixel-guessing), cheap (read DOM instead of vision loop).
- **Cost:** requires arming (§7).
- **Artifacts already built:** `cdp.mjs` (driver), `cdp-launch.sh` (arming), `MECHANISM.md`.

### Lane B — Apple Events (scriptable native apps)
- **Covers:** Notes, Mail, Calendar, Music, Reminders, Finder, Terminal, and other scriptable apps.
- **Mechanism:** AppleScript / Apple Events (`osascript`) — tell the app to do the thing.
- **Properties:** fully invisible, zero focus, robust. **Limited** to what each app's dictionary exposes.

### Lane C — cua Accessibility (native apps with a usable AX tree)
- **Covers:** most native Cocoa apps (buttons, fields, menus).
- **Mechanism:** cua `element_index` — read the AX tree, `AXPress` / set `AXValue`, etc. No cursor move, no focus steal; works on backgrounded/hidden windows.
- **Properties:** mostly hidden. **Gap:** scroll via AX is unproven (§9); AX quality varies (empty for custom-drawn/WebGL/some Electron web content).

### Lane D — cua pixel (universal fallback; any app)
- **Covers:** literally anything that draws pixels — games, canvas apps, anything with no AX/CDP/scripting.
- **Mechanism:** screenshot → click/scroll/type at coordinates, via cua with its **agent-cursor overlay** (its own pointer; doesn't move the physical cursor or steal focus for click/type).
- **Properties:** **universal**, but per §3 the target must be **on the current Space and visible where we act** (scroll routes to the window under the point). This is the "visible operator" mode — the user can watch; it doesn't hijack focus.

## 6. Routing logic

Per task, the router classifies the front-most or named target and picks a lane:

```
is the target a browser or Electron app?
  └ yes → Lane A (CDP)   [arm if needed — §7]
  └ no  → is it scriptable (has an Apple Events dictionary for the needed action)?
            └ yes → Lane B (Apple Events)
            └ no  → does it expose a usable AX tree for the needed elements?
                      └ yes → Lane C (cua AX)   [scroll → §9 fallback]
                      └ no  → Lane D (cua pixel) [requires on-Space + visible; "assisted mode" — §8]
```

Classification signals: bundle id / framework (Electron detectable via `Electron Framework`), presence of a CDP port, Apple Events dictionary probe, AX-tree richness from a cheap `get_window_state`.

## 7. Arming policy (CDP)

CDP needs the debug port open **at launch**; you can't switch it on for a running process.

- **Pre-arm (preferred):** launch the user's common automatable apps with `--remote-debugging-port` from the start (wrapper / login item). Any task then lands instantly, no relaunch.
- **Relaunch-to-arm (fallback):** if the app is open without the port, quit + relaunch armed. **Cloud/stateless apps (Notion, Slack, Linear) restore the same view** — near-seamless. **Caveat (proven):** the relaunch **briefly grabs focus** on app launch; and apps with **unsaved local state** must not be silently relaunched → fall back to Lane C/D or ask.
- Each app carries a fixed debug port; the router tracks which apps are armed.

## 8. Modes

- **Background mode (default, quiet):** Lanes A/B (and C where it holds). Truly hidden, no focus steal — the everyday experience. Covers the majority.
- **Assisted mode (visible, universal):** Lane D. The router tells the user up front: "this one runs on your screen — you'll see it." The app is on the current Space; the agent operates it with its own cursor without stealing focus. This is the honest home for the long tail.

Claude Code announces which mode a task will use, so the user is never surprised.

## 9. Open questions to close before/while building

1. **AX scroll (Lane C):** can we scroll a background/off-Space native app by setting `AXScrollBar` value / `AXScrollToVisible` directly (space-independent)? If yes, Lane C becomes fully hidden for many native apps and shrinks Lane D's territory. One inconclusive attempt so far — needs a clean test on an on-Space vs off-Space native app.
2. **Arming focus-flash:** can the relaunch be made focus-neutral (e.g. `open -g` variations, LaunchServices flags, re-hiding immediately after launch)?
3. **Full-screen handling:** when the user is full-screen (own Space) and the target is elsewhere, Lane D can't reach it. Detect and either route to a hidden lane, or tell the user. Define the UX.
4. **Vision cost:** prefer DOM/AX reads over screenshots where possible to keep the loop cheap and fast.

## 10. Build phases

- **Phase 1 — CDP lane + router skeleton + arming.** Productize `cdp.mjs`/`cdp-launch.sh` into the MCP; classification + Lane A + pre-arm/relaunch-to-arm. **This alone covers ~80% of real tasks** (browsers + Electron). Ship-worthy on its own.
- **Phase 2 — Apple Events lane (B).** Scriptable-native coverage; invisible.
- **Phase 3 — cua AX/pixel lanes (C/D) + mode selection.** Wire the existing cua lanes under the router; resolve §9.1; implement background/assisted mode announcements.
- **Phase 4 — Voice + verification polish.** Voice triggering, per-step verification (DOM/AX/screenshot), "which mode" narration, failure/escalation handling.

## 11. Non-goals

- A single universal hidden mechanism (physically impossible — §3).
- Driving apps the user has explicitly asked to keep untouched.
- Beating the pixel-lane's inherent on-Space requirement (it's an OS constraint, not a bug).

## 12. Security note

`--remote-debugging-port` exposes **all** of an app's page content to any local process while open (we read live API keys out of a Notion page during testing). It is bound **loopback only** (`127.0.0.1`), so only same-machine processes can reach it.

**Accepted, documented posture (decided 2026-07-22):** once an app is armed, it keeps its loopback debug port for the **lifetime of that app** — including after Unmute itself quits. `Arming.disposeAll()` deliberately does **not** quit the user's apps on shutdown (quitting the user's Notion/Slack when Unmute closes is worse UX for a background driver, and re-arming without the port would need another focus-stealing relaunch). The residual exposure is: loopback-only, same-machine, only apps the user's own agent armed, only while those apps run, and only when the user enabled Computer Use — comparable to running VS Code / Chrome with a debug port. If a deployment needs the port closed on shutdown, the clean option is quit-on-dispose (quit the armed apps in `disposeAll()`) — a config choice, not the default. Surfaced to the user, not silent.
