# ax-mcp — implementation shape (decided before build)

*Written 2026-07-13, before any implementation. This is the driver's blueprint:
what gets built, where it lives in THIS codebase, how it flows, and how we test it.
The brief is `docs/ax-mcp-brief.md`; the reference AX layer is `reference/main.swift`.*

---

## The one codebase fact that locks the architecture

`desktop/native-paste/README.md` records the exact trap the brief warns about, already
hit and solved in this repo:

> Every prior fast-paste attempt used a separate Mach-O binary as a child of the main
> process. macOS TCC checks the **child binary's** code identity for Accessibility, not
> the parent `.app`'s. … A Node native addon loaded via `require()` runs **in-process**
> — same PID, same code-signature identity as the `.app` bundle.

So the "daemon" in the brief's shim/daemon split is **not a separate Swift binary**.
It is the AX layer compiled as a **Node native addon** (ObjC++, same pattern as
`native-paste`), loaded in Unmute's Electron **main process**. Same PID as Unmute.app
⇒ the user's single Accessibility grant to Unmute covers all AX calls. Proven pattern,
already shipping in this app twice (`native-paste`, `native-fn-listener`).

## Components (4 pieces, one build)

```
Claude Code CLI ──stdio (MCP JSON-RPC)──▶ ax-shim ──unix socket──▶ Unmute main process
                                          (tiny Node script,        │ ax-native addon (ObjC++)
                                           zero AX, zero deps)      │ = main.swift's AX layer
                                                                    ▼
                                                          Notion, WhatsApp, Notes, …
```

1. **`desktop/native-ax/`** — Node native addon (mirror of `native-paste`'s layout:
   `binding.gyp`, `src/ax.mm`, `index.js`). Port of `reference/main.swift`'s AX core:
   enableAX (AXManualAccessibility + AXEnhancedUserInterface), window fallback chain,
   tree walk + pruning, find/press/set_value/fill_form/menu_action, per-window capture
   with 1400px downscale. Sync N-API calls; heavy walks run on a worker thread pool so
   the main process never blocks. All of the brief's gotchas (§9) live here.

2. **`desktop/engine-overrides/electron/ax/server.ts`** — the socket server in the main
   process. Listens on `~/.unmute/ax.sock` (0600). Speaks newline-delimited MCP JSON-RPC.
   Implements the MCP protocol (initialize / tools.list / tools.call), dispatches to the
   addon. Handles **N concurrent client connections** (one per Claude session) — requests
   are independent; per-app serialization only where AX requires it. Enforces the toggle
   (off ⇒ refuse with a clear message) and the allowlist (bundle-ID keyed, hot-reloaded
   from Unmute config on every call — no restarts).

3. **`desktop/engine-overrides/electron/ax/shim.cjs`** — the forwarder registered in
   `~/.claude.json`. ~60 lines, plain Node, zero dependencies, zero AX: pipe stdin→socket,
   socket→stdout. If the socket is absent (Unmute not running / toggle off) it answers
   MCP calls with a clear "Enable Computer Use in Unmute settings" error instead of dying.

4. **Settings UI + wiring** — a "Computer Use" section in Unmute settings
   (`engine-overrides/renderer/.../Settings`): master toggle, per-app allowlist picker
   (running apps list), separate screenshot toggle. Flipping the master toggle
   (a) starts/stops the socket server, (b) adds/removes the `ax-mcp` entry in
   `~/.claude.json` (user scope), (c) appends/removes the one-line CLAUDE.md steer.
   Menu-bar: activity indicator + kill switch (stops the server instantly).

## Decisions already made (final)

- **In-process addon, not a child daemon** — forced by the TCC lesson above.
- **Shim in plain Node** — Node ships with Claude Code's environment; zero-dep script
  is more auditable than another signed binary.
- **Allowlist keyed on bundle ID** (display name shown in UI, ID checked in the server).
- **Built-in mouse computer-use stays ON as automatic last-resort fallback** — worst
  case equals today's behavior; never worse. (Deliberate override of the README's
  "disable computer-use" advice.)
- **Typing = AXSetValue path only in v1**, with menu_action/press fallbacks; no synthetic
  key events (they need focus — reintroduces the problem).
- **Capture via CGWindowListCreateImage** (works today, macOS 13+); ScreenCaptureKit is
  a later swap behind the same tool.
- **No `activate_app` tool. No coordinates anywhere.**
- **`list_apps` must call enableAX before counting windows**, else Electron apps show
  0 windows and look identical to "on another Space" (reference bug, will fix).

## Test plan (how we know it's done)

1. **Unit-ish:** addon smoke tests against Notes + Notion (the AppKit and Electron
   extremes): tree readable, find returns labeled hits, press succeeds, focus unchanged
   (assert frontmost before == after — the axprobe check, automated).
2. **Protocol:** pipe scripted MCP JSON-RPC through the shim → socket → addon;
   assert initialize/tools.list/tools.call round-trips and image blocks decode.
3. **Enforcement:** toggle off ⇒ tools refuse; app not in allowlist ⇒ refused with
   the allowlist named; allowlist edit applies without restart.
4. **Concurrency:** two parallel scripted MCP clients driving two different apps
   simultaneously; both complete, no cross-talk, no lock.
5. **The Definition-of-Done demo (from the brief):** real Claude Code session,
   "Close the sidebar in Notion" while Chrome is frontmost playing a video —
   sidebar closes, frontmost never changes. Then two live sessions, two apps, at once.

## Honest risk register (known, accepted, with mitigations)

- **AX calls from an Electron main process** — same-PID AX client is the pattern
  native-paste proved for CGEvent; AXUIElement calls should behave the same (TCC checks
  the .app identity). First thing verified in the build (a 20-line addon spike: read
  Notes' tree from the main process). If macOS treats AXUIElementCreateApplication
  differently in-process vs axprobe, we find out in minutes, not days.
- **Main-process stalls** — AX walks of huge trees are slow; mitigation: worker threads
  in the addon + the 8s messaging timeout, so dictation latency (sacred) is untouched.
- **set_value silently no-ops on some apps** — known (brief §9.5); mitigated by
  menu_action fallback + honest tool-result text telling the model what to try next.
- **Apps on other Spaces are unreachable** — OS limit; surfaced in list_apps output.
