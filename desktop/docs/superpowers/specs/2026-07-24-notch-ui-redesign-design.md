# Notch UI Redesign — Design Spec

**Status:** design, awaiting user review. No code yet.
**Date:** 2026-07-24
**Companions:** `docs/ORCHESTRATE-VISION.md` (the attention philosophy this
inherits), `2026-07-16-cockpit-grouping.md` (the cockpit content this re-homes).

---

## 1. Why

Today a single task's life is smeared across **three** surfaces: the main
Electron app, the cockpit wall (`#/orchestrate`), and the right-side overlay
(`#/overlay`, which itself has a docked pill + expanded panel). A user — and the
founder — never knows where to look for a given task. The surfaces overlap in
purpose and compete for the same corner of the screen.

**Goal: one home for all task/attention UI — the notch** — with a clean split of
*roles* so nothing competes:

> **Top-center = OUTPUT (status).** **Bottom-center = INPUT (voice).**

This is a **surface/window reorganization, not a behavior change.** Routing, the
status-file contract, task logging, the curator, billing, and computer-use lanes
are all untouched (see §9 Scope).

## 2. Surfaces: before → after

| Surface | Today | After |
|---|---|---|
| Main app (`#/`) | Settings/Account/Permissions + **task display** | **Same, minus tasks.** Dictation + settings + dictation history only. No task UI. |
| Dictation pill (`#/widget`) | Top-center HUD | **Moves to bottom-center** (input role). Otherwise unchanged. |
| Right overlay (`#/overlay`) | Docked pill ↔ expanded panel | **Removed.** Its job moves into the notch (peek + attention panel). |
| Cockpit (`#/orchestrate`) | Standalone window, ⌘⇧O | **Re-homed as the notch's full-expand ("dashboard").** No functional change. |
| Notch | — | **New primary surface.** The 4-state machine in §3. |

Net window/route count is unchanged in spirit (main app, a bottom input surface, a
top notch surface, and the notch's full-expand), but a task now lives in exactly
**one** place at each moment.

## 3. The notch — a 4-state machine

The notch is top-center. On a MacBook with a hardware notch it hugs it; on a
notch-less Mac we render a **small, unobtrusive dummy notch** in the same spot
(§7). Behavior is identical either way.

### State 1 — Idle (collapsed)
The resting state. When tasks are *working* (our-move), the notch shows at most a
**subtle glow / quiet indicator** — informative, never in motion, never a pull.
Nothing that needs you ⇒ nothing grabs you.

### State 2 — Peek (auto)
When a task becomes **your-move** (`needs-user / stuck / errored / ready`), the
notch **grows a little on its own** — "one thing's for you." Pulled, not modal: no
window takeover, no focus steal. The existing **doorbell** (spoken headline) stays
the audio channel and fires here. A `done` task does **not** peek (it isn't
your-move — see §4).

### State 3 — Attention panel (on tap)
Tapping the peek expands to a **task-sized medium panel (~30–50% of screen, sized
to the task)** — *not* the dashboard. It shows **exactly one task** at a time:

- Whatever the task's state needs: read the `ready` result, read + act on
  `needs-user` (tap the offered options), read a `stuck`/`errored` explanation and
  respond.
- **Live terminal: on-demand, sticky, state-aware.** A one-tap reveal grows the
  card to show the raw terminal (`LiveTerminal`). Once opened it **stays open**
  across "next" and future sessions (sticky preference). States that almost always
  need it (`stuck`/`errored`) **default open**; pure-read states default collapsed.
  A global setting — "always show the terminal in the attention panel" — exists for
  terminal-first users.
- **"Next" + a counter ("1 of 3")** cycles to the next your-move task **at the same
  size** — the panel never balloons into the dashboard.
- When the queue empties, the panel **closes** and you get the calm **all-clear**.

This single panel is where essentially all blocking/unblocking/reading happens. It
is the reincarnation of the old overlay *and* the crank, fused.

### State 4 — Full cockpit / dashboard (on demand)
An explicit "open dashboard" affordance on the notch expands to **~60–80%** (rarely
full-screen). This is today's `OrchestrateWall`, re-homed: **persistent sessions
highlighted**, one-offs + the skills rail on the right, skill-review popup, shelf,
notes, task history. Reached only when the user *wants* to survey everything — never
automatically. Plain `done` tasks are seen here (they are not in the crank).

### Transitions
```
        task→your-move                tap                "open dashboard"
Idle ──────────────────► Peek ──────────────► Attention panel ──────────────► Cockpit
  ▲                        │                       │  next (requeue)              │
  │  queue empties         │  no interaction        └───────── cycles ────────────┘
  └────────────────────────┴──────── all-clear / close ◄── collapse ──────────────┘
```

## 4. The crank / queue semantics

- **Queue membership = your-move only:** `needs-user`, `stuck`, `errored`, `ready`.
  A plain **`done`** (finished, nothing awaits you) is **not** in the crank — it is
  visible only in the cockpit. (Reconciliation: a result you must read is `ready`
  and is queued; a quietly-finished task is `done` and is not.)
- **Spans all task kinds** — one-offs *and* persistent sessions alike (a finished-but-
  unread one-off surfaces as `ready`, a stuck one-off, a session in `needs-user`,
  etc.). "Next" is not persistent-only.
- **Ordering:** keep current behavior for now (roughly: the task that most recently
  went your-move surfaces first). Not load-bearing; finalize later.
- **Skip = requeue to the back.** Pressing "next" on a still-blocked task moves it to
  the **end** of the queue so the others surface; it comes back around. Removal
  happens only by acting on it, or via the existing decay valve (an ignored `ready`
  one-off settles to `done` after ~1h).

## 5. Input model (bottom-center)

Two distinct affordances live at the bottom, above and clear of the macOS Dock
(floated slightly up so it never interferes):

1. **Dictation pill** — unchanged behavior, just relocated from top to bottom.
   Dictate → paste text into the focused app. Screenshots-during-capture continue to
   attach. (This is the existing `#/widget`.)
2. **Task-creation voice** — the Remote trigger: voice → create-or-route a task. Its
   routing depends on notch state:
   - **A task is open/focused in the attention panel** → the utterance **always lands
     on that task** (router bypassed; the visible task *is* the address). This reuses
     the existing focus short-circuit + consent machinery — cold sessions stay
     focus-only.
   - **Nothing is open (idle/peek)** → the utterance goes through the **router**,
     which decides new task vs. route-to-existing.

Multimodal (screenshots alongside a spoken task) is already supported; richer
attachment (copy/paste, images) can expand later — out of scope here.

## 6. Main app changes

The core Electron app (`#/`) is **untouched except that all task display is
removed.** It keeps dictation, Account/Permissions/Privacy/Language/Settings, and
**dictation history** (dictation history ≠ task history; it stays here). **Task /
remote history** moves into the cockpit (§3 State 4), hidden until the dashboard is
opened.

## 7. Notch-less Macs (dummy notch)

On a Mac without a hardware notch, render a **small top-center faux-notch** — minimal
footprint, does not occupy significant space — that behaves identically across all
four states. The only difference is cosmetic (no hardware cutout to hug).

## 8. Multi-display (recommended default — confirm)

The hardware notch exists only on the built-in display. Default: render the notch
(dummy or real) on the **active display**, and open the attention panel / cockpit on
the active display. (Flagged for confirmation; not blocking.)

## 9. Technical approach — native Swift notch shell (Option B, decided 2026-07-24)

**Decision: the live notch is a native Swift sidecar, not a pure-DOM Electron
window.** Rationale: the polished Dynamic-Island apps are all native SwiftUI with
physics-based spring/morph animation; Electron window-resize cannot hit the
"very live" bar. This follows the codebase's existing pattern of dropping to
native exactly where the web layer can't (`native-paste`, `native-fn-listener`,
`native-ax`, the vendored `cua-driver`).

**The split:**
- **Native (Swift/AppKit + SwiftUI/Core Animation)** owns the *little* notch: its
  own always-on-top, non-activating `NSWindow` pinned top-center that hugs the
  hardware notch (and renders the dummy notch on notch-less Macs), animating
  **idle → peek → attention panel** with spring/jelly morphing and synchronized
  content interpolation. This **replaces the role of today's `overlay.ts`
  window** (the window plumbing moves to Swift).
- **Web (Electron `BrowserWindow`)** keeps the **full cockpit** (`OrchestrateWall`)
  unchanged. The native shell shows/positions it on "open dashboard."
- **IPC bridge** between Electron main and the Swift helper (stdio or local
  socket): main → shell ("peek", "task X is your-move", "collapse", "expand to
  cockpit"); shell → main (taps, "next", gestures, "open dashboard"). **The task
  model + status contract stay in Electron main — the source of truth; the shell
  is only a view + input surface.**

**Not SwiftUI-inside-a-BrowserWindow** — impossible (Chromium renders only web).
The shell is a *separate* native window, bundled and signed as a helper like the
other native components. **No rewrite of the Electron app; this is additive.**

**New moving parts:** a Swift helper target, its IPC bridge, and packaging +
signing for it (`wire-into-engine.sh` already signs native addons + `cua-driver`).

## 10. Scope / blast radius / non-goals

**Non-goals (explicitly unchanged):** the router (new/continue/resume/speak), the
status-file contract and task state machine, task logging, the librarian/curator, the
provider router + billing, the computer-use lanes, the doorbell TTS path.

**Blast radius (renderer + window management only):**
- `desktop/electron/remote/overlay.ts` — **retired**; its window plumbing (always-on-top,
  all-Spaces, no-focus-steal, Escape ownership) moves into the native Swift shell (§9).
- **New: native Swift notch-shell helper + its IPC bridge** to Electron main (§9).
- `desktop/electron/remote/orchestrate.ts` — becomes the notch's full-expand rather
  than a standalone ⌘⇧O window (entry point changes; content re-used).
- The dictation/widget window — relocated top → bottom.
- `desktop/engine-overrides/renderer/main.tsx` — route wiring for the new notch
  surface; retire the `#/overlay` route.
- Wherever the **main app renders tasks** — removed.
- New renderer components for the notch shell + peek + attention panel; the cockpit
  wall (`OrchestrateWall`) and `LiveTerminal` are re-used largely as-is.

## 11. Open items (resolve via the spike / plan / review)

- **De-risking spike (recommended first build):** prove the native shell hits the
  quality bar — idle→peek→panel spring morph, notch-hug + dummy-notch fallback,
  no focus steal, and the Electron↔Swift IPC handshake — before the full plan.
- **IPC transport** — stdio vs. local socket for the main↔shell bridge.
- **Cockpit window ownership** — Electron-owned `BrowserWindow` positioned by the
  shell, vs. shell-managed. (Lean: Electron owns it, shell asks it to show.)
- **Notch detection** — `NSScreen.safeAreaInsets` / `auxiliaryTopLeftArea` for
  hardware-notch geometry; dummy-notch geometry for the rest.
- **Multi-display** default (§8) — confirm.
- **Idle indicator** exact form (glow only vs. glow + count) — cosmetic, defer.
- **Attention-panel layout** per state + exact peek→panel→cockpit sizes and the
  motion spec (spring params) — a visual/motion mockup pass nails these.
- **Rollout** — ship behind a feature flag so the old overlay/cockpit can be toggled
  back during field testing? (Recommended.)

## 12. The bar we keep re-testing

Every state must earn its place against the delete-the-wall test: does it give the
user something the underlying Claude Code app does not? Idle = calm; Peek = pulled-not-
grabbed attention; Attention panel = one-task unblock/read + the crank; Cockpit =
survey + persistent highlight + skills. If any state collapses into another (e.g. the
panel becoming the dashboard), the boundary — **scope: one task vs. all** — has been
violated and must be restored.
