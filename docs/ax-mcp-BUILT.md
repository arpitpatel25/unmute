# ax-mcp — built (2026-07-13)

End-to-end implementation of Computer Use for Unmute, built in one pass on
`feat/computer-use-mcp`. Lets Claude Code operate macOS apps in the BACKGROUND
(no stolen focus, no window hiding, no machine-wide lock) via the Accessibility
API, exposed as an MCP server Claude Code prefers over the built-in computer-use.

## What shipped

| Piece | Path | What it is |
|---|---|---|
| Native AX engine | `desktop/native-ax/` | In-process Node addon (ObjC++). All ops: list_apps, find, get_tree, press, set_value, fill_form, menu_action, capture_window. Electron unlock (`AXManualAccessibility`), window fallback, tree pruning, per-window capture w/ downscale, Space detection. |
| MCP server | `desktop/electron/remote/ax/server.ts` | In-process HTTP MCP (JSON-RPC), 8 tools, live policy enforcement. Sibling of the existing `unmute` intercom. |
| AX bridge | `desktop/electron/remote/ax/ax-bridge.ts` | Runs AX calls on a worker thread (keeps the main thread / dictation latency clear), main-thread fallback. |
| Policy | `desktop/electron/remote/ax/policy.ts` | enabled / screenshotEnabled / allowAll (default) / allowlist. |
| Registration | `desktop/electron/remote/ax/register.ts` | `claude mcp add-json computer` + CLAUDE.md steer, applied/removed on toggle. |
| Wiring | `desktop/electron/remote/init.ts`, `remote-preload.ts` | Server start, IPC, activity broadcast (kill-switch affordance), settings. |
| Settings UI | `desktop/engine-overrides/renderer/remote/ComputerUseSettings.tsx` | Master toggle, Accessibility hint, allow-all vs restrict + app picker, screenshot toggle. Mounted in `RemoteSettings.tsx`. |
| Build wiring | `desktop/build/wire-into-engine.sh` | Copies + registers the addon as a `file:` dep for the ABI rebuild. |
| Tests | `desktop/electron/remote/ax/*.test.ts`, `desktop/native-ax/smoke.js` | 17 unit/protocol/enforcement/concurrency + on-device focus-unchanged smoke. |

## Key decisions (driver's calls)

- **In-process HTTP MCP, not the brief's shim+unix-socket.** Unmute already runs
  an in-process HTTP MCP server Claude registers via `claude mcp add-json`, and
  the AX addon runs in that same permission-holding process. So a second HTTP
  MCP server is simpler, needs nothing signed/distributed separately, and works
  from any terminal — while achieving the brief's goal (one grant, Unmute-owned
  enforcement + kill switch).
- **Allow-all by default** (per the user's "whole computer" direction). The
  allowlist is an optional restriction, not a gate.
- **Built-in mouse computer-use left ON** as an automatic last-resort fallback —
  worst case equals today's behavior, never worse. We do NOT disable it.
- **All-Swift/ObjC++ native, zero deps, zero network.** Typing is AXSetValue with
  menu_action/press fallbacks (no focus-stealing synthetic keys).

## Verified

- ✅ Native addon compiles + runs; **background control proven live** — read
  Notes' 97-node tree with focus unchanged (`node native-ax/smoke.js`).
- ✅ 250/250 tests pass (17 new); both typechecks clean.
- ✅ Full engine integration compile (`wire-into-engine.sh compile`) succeeds;
  the feature is present in all three built bundles (main / preload / renderer).

## Remaining: live DoD demo (do together)

The brief's definition of done — a REAL Claude Code session closing Notion's
sidebar while a video plays, then two sessions on two apps — should be run on a
full signed `build` with Accessibility granted to the new bundle, with the user
present (it drives their actual desktop apps). Everything up to that point is
built and verified.

Steps:
1. `./build/wire-into-engine.sh build` (signed; rebuilds the addon for Electron's ABI).
2. Launch the built app; grant it Accessibility (System Settings → Privacy → Accessibility); restart it.
3. Turn on Computer Use in Unmute settings (leave allow-all on).
4. In a Claude Code session: "close the sidebar in Notion" while watching a video — sidebar closes, screen never moves. Then two sessions, two apps.
