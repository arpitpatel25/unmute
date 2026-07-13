# ax-mcp — implementation brief

You're building a macOS MCP server that lets Claude Code control desktop apps **in the
background**, without stealing focus. This doc is everything we learned getting here,
including the dead ends, because the dead ends are where the real constraints live.

Read the whole thing before you write code. Several "obvious" approaches are already
known-broken and you will waste hours rediscovering that.

---

## 1. The problem we're actually solving

Claude Code has a built-in computer use feature. It works like this: take a screenshot
of the display → send it to the model → model picks a coordinate → synthesize a mouse
click at (x, y).

That last step is the whole problem. **A synthetic click at a screen coordinate hits
whatever window is physically at that coordinate.** So the target app *must* be
frontmost and unoccluded. Claude Code therefore:

- brings the app to the front (interrupting you),
- **hides your other windows** while it works (this is documented and deliberate —
  there's even a "Unhide apps when Claude finishes" setting),
- holds a **machine-wide lock** — one session at a time, taken on first computer-use
  action and held until the session *exits* (not until the task finishes; they changed
  this in v2.1.195),
- and if you switch away mid-task, it re-screenshots, doesn't see the app anymore, and
  **yanks it back to the front again**.

Real transcript from the user's machine, Claude Code trying to open Notion:

> "Let me open Notion."
> "...isn't frontmost yet. Let me bring it forward again."
> "...its window isn't appearing. Let me click the Notion icon in the dock..."
> "...has no open window. Let me activate it and open a new window with Cmd+N."

It's chasing its own eyes. Meanwhile the user is trying to watch a YouTube video.

**OpenAI's Codex does not do this.** It reads the macOS accessibility tree (the same one
VoiceOver uses) and sends actions to *elements*, not coordinates. MacStories' Federico
Viticci confirmed this publicly: Codex "doesn't need to bring Mail to the front, which
means you can keep doing your actual work." The user watched Codex operate WhatsApp
while they browsed YouTube. That's the behavior we want.

Codex's own output, when asked how it did it, named its tools: `sky.get_app_state({app})`,
`sky.click(...)`, `sky.type_text(...)`, `sky.set_value(...)` — running through a Node REPL.
That's an AXUIElement wrapper. Nothing exotic.

**Goal: give Claude Code that same capability, as an MCP server we own.**

---

## 2. Why an MCP server is the right shape (and why this isn't fighting Anthropic)

Claude Code's documented tool routing, in priority order:

1. MCP server for the service, if one exists
2. Bash, if it's a shell task
3. Claude in Chrome, if it's browser work
4. **Computer use — last resort only**

Their docs literally say screen control is "reserved for things nothing else can reach."

So: **if our MCP tools exist, Claude Code prefers them and never reaches for screenshots.**
We don't patch anything, don't intercept anything, don't fight the built-in. We just
outrank it.

Also note: the built-in `computer-use` server is **off by default** in the CLI (user must
enable per-project via `/mcp`). So in the common case there's nothing to disable.

---

## 3. What we empirically proved (run on the user's Mac, 13 July)

This is not theory. We built a probe (`axprobe.swift`) and ran it. Findings:

### ✅ Background control works. Confirmed.

Read Notion's UI tree and pressed its "Close Sidebar" button **while iTerm was frontmost
and the user was in Chrome.** Notion never came forward. The sidebar closed.

```
target: AXButton | Close Sidebar
AXPress: success
FRONTMOST BEFORE: iTerm2
FRONTMOST AFTER:  iTerm2
✓ FOCUS UNCHANGED — background control WORKS
```

That's the entire thesis, proven.

### 🔑 `AXManualAccessibility` is the Electron unlock. THIS IS THE BIG ONE.

Chromium/Electron ships its accessibility tree **disabled by default** for performance.
Until a client sets `AXManualAccessibility = true` on the app element, Electron apps
expose **nothing**.

Before setting it, Notion returned zero windows and no tree. After:

```
[enableAX] manual=success enhanced=notImplemented
--- TREE ---
14  AXButton | Switch workspace: Arpit Patel's Notion | [AXPress]
15  AXButton | Close Sidebar | [AXPress]
17  AXButton | Back | [AXPress]
18  AXButton | Forward | [AXPress]
...
actionable: 34
```

Note `AXEnhancedUserInterface` (the AppKit flag) returns `notImplemented` on Electron.
**Set both, ignore failures.** Different app frameworks want different flags.

This single fact is why most existing tools in this space silently fail on Notion, Slack,
WhatsApp, Discord — i.e. every app people actually use.

### 🔑 Electron apps lie about `AXWindows`

Notion returns `AXWindows = []` (with `err=success`, not an error!) even with a window
wide open. But `AXMainWindow` and `AXFocusedWindow` both return the window fine.

**Always fall back:** `AXWindows[0]` → `AXMainWindow` → `AXFocusedWindow`.

### ❌ System Events / AppleScript is a dead end. Do not use it.

We tried `osascript` + `tell application "System Events"` first. It was a disaster:

- `process "Notes"` threw `-1728 "Can't get process"` intermittently — then the *very
  next call* to the same process succeeded. Non-deterministic.
- `count of windows` returned `1` while `window 1` returned `-1719 Invalid index`.
  Simultaneously. The window both exists and doesn't.
- **System Events cannot set `AXManualAccessibility`**, so it can never read Electron apps.

Go direct to `AXUIElementCreateApplication(pid)`. Native. No AppleScript anywhere in
this codebase.

(This matters because the existing open-source competitor, `entpnomad/mac-use`, is built
entirely on `osascript`. 3 stars, 13 commits. It cannot read Electron apps. It also ships
an `activate_app` tool that brings apps to the foreground — background isn't even a goal
for them. We are not reinventing their wheel; we're building the thing they didn't.)

### ⚠️ HARD CONSTRAINT: AX cannot see other macOS Spaces

This is the real limit and you need to design around it.

Empirically: with Notion/Claude/ChatGPT on a *different* Space, they all reported
`windows=0`. Dragged them onto the current Space → all reported `windows=1` immediately.
Nothing else changed.

**"Background" means "same Space, unfocused." It does NOT mean "another desktop."**
An app parked on another Space is unreachable. This is an OS limitation, not a bug, and
almost certainly applies to Codex too.

Surface this clearly in `list_apps` output so the model knows why an app is missing,
rather than flailing.

### ⚠️ Element IDs churn after every action

Tree indices shift as the UI updates. Codex's own explanation mentioned this — it
re-reads the tree after each action. So must we. Every action's success message should
tell the model to re-run `find` before the next step.

---

## 4. The three input paths, and which ones work in the background

| mechanism | background? | notes |
|---|---|---|
| `AXPress` / `AXSetValue` on an element | ✅ **yes** | this is the whole product |
| Per-window screenshot (ScreenCaptureKit / `CGWindowListCreateImage`) | ✅ **yes** | window-scoped, not display |
| Synthetic mouse click at (x,y) via CGEvent | ❌ **no** | one cursor, one screen — must be frontmost |

`CGEventPostToPid()` looks like it should let you send events to a specific process. It
is unreliable in practice — many apps ignore it, and it still contends over a single
shared cursor. **Do not build on it.**

**The design rule: act on elements, never on coordinates.** The moment you touch
coordinates you've reintroduced the exact problem we're solving.

### On screenshots — don't skip them

The user pushed back correctly here, and they're right: *both* Codex and Claude Code
request Screen Recording permission. Two independent teams converged on that. Pixels are
needed for:

- **Verification.** `AXPress: success` means the message was *delivered*, not that the app
  *did* the thing. During our test the user had to eyeball the sidebar to confirm. An
  agent can't eyeball.
- **Apps with no tree.** Canvas, Figma, games, iOS Simulator, custom-drawn UI.
- **Visual bugs.** "The modal is clipping" is invisible to AX.

So: **AX-first as the control path, per-window capture as a secondary sense.** The mistake
Claude Code makes isn't *having* pixels — it's making pixels the *control* path.

Key detail: **per-window capture does not require the window to be frontmost.** You pass
a window ID, you get that window's pixels even if it's behind three other windows. So
capture stays background-safe. It's only the *clicking* that ever forced foregrounding.

(macOS still calls the permission "Screen Recording" and still lights the purple menu bar
indicator, even for single-window capture. The TCC bucket is coarser than the capability.
That's fine — it's honest, and it's why capture should be its own toggle.)

---

## 5. Architecture

There's a permissions trap here, and it drives the design.

**Accessibility permission attaches to the *responsible process*.** A binary spawned by
`claude` inside iTerm is attributed to **iTerm**, not to our binary. So a naive install
means every user must grant Accessibility to whatever terminal they happen to use —
Ghostty today, Warp tomorrow, iTerm on their other machine. Fragile, and an awful
onboarding story.

**Fix: split into a shim and a daemon.**

```
Claude Code (CLI)
   │  stdio (MCP / JSON-RPC)
   ▼
ax-mcp shim          ← does NO AX calls. Pure forwarder.
   │  local unix socket
   ▼
Unmute.app           ← holds Accessibility permission. Signed + notarized.
   │                   Performs all AXUIElement work.
   ▼
Notion, WhatsApp, Xcode, …
```

Why:

- **One permission grant, forever.** Granted to Unmute during onboarding. Works from any
  terminal, any project, any machine state.
- **The toggle becomes enforcement, not config.** Unmute can hard-refuse when computer
  use is off. Not just a JSON entry the user could forget about.
- **Allowlist lives in Unmute's UI**, where users expect it.
- **Kill switch for free.** Unmute is already a menu bar app — it can show what's being
  driven and stop it mid-action.
- **The process holding accessibility rights is a signed app**, not a loose binary in
  `~/Downloads`. Much better security story, and we're going to open-source this, so the
  story matters.

A working single-binary version already exists (`main.swift`, attached) — it does the AX
work inline. Use it as the reference implementation for the AX layer, then lift that
layer into Unmute and leave a thin shim behind.

---

## 6. Tool surface

| tool | purpose | notes |
|---|---|---|
| `list_apps` | running apps + pid + window count | first call; also warns about other-Space apps |
| `find` | search elements by label/role → ids | **primary verb** — see context note below |
| `get_tree` | full tree, with `roles` + `max_depth` filters | noisy; discourage in the description |
| `press` | `AXPress` an element by id | background |
| `set_value` | write a text field | background; fails on some apps that need focus |
| `fill_form` | write N fields in one call | avoids N round-trips on forms |
| `menu_action` | `"File > Save"` via the AX menu bar | often the *cleanest* way to drive an app |
| `capture_window` | screenshot ONE window → MCP image block | background; needs Screen Recording |

**There is deliberately no `activate_app` tool.** Bringing apps forward is the thing this
exists to avoid. Don't add it "for convenience" — it will get used and the product
becomes pointless.

### Context management is the real engineering

The AX tree is *enormous* and mostly garbage. Our Notion window — nearly empty — produced
45 nodes of which ~80% were unlabeled `AXGroup` wrappers:

```
2   AXGroup | -
3     AXGroup | -
4       AXGroup | -
5         AXGroup | -      ← this is what a raw dump looks like
```

A real Notion page will be thousands of nodes. **Dumping that raw will destroy the
context window.** So:

- `find(label, role)` is the primary verb. Push the model toward it in the tool
  descriptions.
- Prune aggressively: drop nodes with no label *and* no actions. Collapse pass-through
  wrappers.
- Filter `AXShowMenu` and `AXScrollToVisible` out of the actions list — they're on
  everything and carry no signal.
- Support `roles=AXButton,AXTextField` filtering (the mac-use author notes a full Java
  Swing dump takes 10–30 seconds unfiltered).
- Truncate long labels (~120 chars).

MCP tool results support `image` content blocks (`{type: "image", data: <base64>,
mimeType: "image/png"}`), so `capture_window` returns a real image the model can see.
Downscale to ~1400px wide — Claude Code's own built-in downscales to roughly 1372px, so
that's a sane target.

---

## 7. Unmute integration

The toggle in Unmute settings, when flipped on, does three things:

1. **Registers the MCP server** in `~/.claude.json` under `mcpServers` (user scope → applies
   to all projects). Off = remove the entry.
2. **Writes the allowlist** (apps the user selected in Unmute's UI) into that entry's env,
   or better, into Unmute's own config which the daemon reads.
3. **Appends a line to `~/.claude/CLAUDE.md`**: *"For GUI tasks use the ax-mcp tools. Do
   not request computer use — it steals window focus."* Belt-and-braces on top of the
   routing priority.

No CLI flags, no wrapper binary, no interception. Claude Code reads these files at session
start.

**Why this matters for Orchestrator:** Claude Code's computer use holds a *machine-wide
lock* — one session at a time. That structurally kills parallel voice-dispatch the moment
any session touches a GUI. Element-based control has **no lock**, because there's no
shared cursor to contend over. N sessions can each drive a different app simultaneously.
That's the fan-out property the cockpit depends on.

---

## 8. Security posture (we're open-sourcing this — be able to defend it)

- **Zero network calls.** No HTTP client, no sockets outbound, nothing. Auditable in ~500
  lines.
- **Zero third-party dependencies.** Apple frameworks only.
- **Accessibility only by default.** Screen Recording is opt-in, gated behind the capture
  toggle. A user who doesn't want capture literally cannot be screenshotted by us.
- **Allowlist empty by default.** Nothing is touchable until the user names it.
- **Signed + notarized**, reproducible build.

**State the real risk honestly, don't bury it:** with Accessibility permission this can
read any allowed app's UI tree and act as the user. Prompt injection is the live threat —
text sitting in a Notion page or a WhatsApp message becomes model input, and the agent has
hands. The allowlist is the primary mitigation. Anthropic and OpenAI both landed on
per-app approval for exactly this reason.

The claim we can defend: **"Reads nothing off your machine, sends nothing off your
machine, and only touches apps you name."**

---

## 9. Gotchas, in the order you'll hit them

1. `AXIsProcessTrusted()` returning false → permission is on the *host* process. Grant to
   the terminal (dev) or to Unmute.app (prod). Requires a **full app restart** to take
   effect, not just a new window.
2. Set `AXUIElementSetMessagingTimeout(app, 8.0)`. Electron apps are slow to answer and
   will silently time out at the default.
3. `AXWindows = []` with `err=success` is **normal for Electron**. Don't treat empty as an
   error — fall back to `AXMainWindow`.
4. Call `enableAX()` (both flags) on **every** app resolution, not once at startup. It
   doesn't persist reliably.
5. `set_value` returns `success` but does nothing on some apps. Fall back to `menu_action`
   or a `press` + key sequence.
6. Re-walk the tree after every action. IDs are positional and they move.
7. Apps on other Spaces are invisible. Say so in the tool output rather than returning a
   confusing empty result.
8. `AXPress: success` ≠ the app did the thing. Consider auto-capturing the window after
   actions when the capture toggle is on, so the model can verify.

---

## 10. Definition of done

Open a Claude Code CLI session. Sit in Chrome watching a video. Say:

> "Close the sidebar in Notion."

Notion's sidebar closes. **Your screen does not move.** The video does not stutter.
Notion never comes forward.

Then run two Claude Code sessions at once, each driving a different app, simultaneously.
No lock, no contention, no stolen focus.

That's the product.
