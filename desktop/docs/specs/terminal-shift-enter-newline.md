# Spec: Shift+Enter should insert a newline in the orchestrator terminal

> **Status: IMPLEMENTED** (commit `8d7f01d`, spec Option A). Shift+Enter now
> injects `\x1b\r` via an xterm `attachCustomKeyEventHandler` in
> `LiveTerminal.tsx`. The §5 zero-regression guardrails were honored and the
> injected sequence (§6) is confirmed against Anthropic's terminal-config docs;
> typecheck passes. The one remaining check is a live keypress test in the
> running orchestrator (press Shift+Enter → newline, plain Enter → submit) — a
> ~10-second manual confirmation that can't be run headlessly.
>
> This document retains the full root-cause and options analysis for the record.
> **Hard requirement was zero regression** — see §5 for the guardrails the
> implementation satisfies.

## 1. Problem

In the Unmute orchestrator's live terminal (`LiveTerminal.tsx`, the xterm view in
the cockpit/OrchestrateWall), pressing **`Shift+Enter` submits the line just like
plain `Enter`** instead of inserting a soft newline. In a normal terminal running
Claude Code (or any REPL/TUI with multi-line input), `Enter` submits and
`Shift+Enter` adds a newline without submitting. Ours submits in both cases.

## 2. Root cause

The terminal is a stock `@xterm/xterm` (^5.5.0) instance wired as a **raw
passthrough**:

```ts
// desktop/engine-overrides/renderer/remote/LiveTerminal.tsx:105
term.onData((data) => api().remoteTerminalInput?.(taskId, data))
```

`onData` forwards whatever byte xterm produces straight to the PTY. **xterm emits
the identical byte — carriage return `\r` (0x0D) — for both `Enter` and
`Shift+Enter`.** By default xterm does not disambiguate modifier+Enter, and
`LiveTerminal.tsx`:
- installs **no** `attachCustomKeyEventHandler` and **no** `onKey` override, and
- enables **no** enhanced keyboard protocol (Kitty keyboard / CSI-u /
  `modifyOtherKeys`).

So both keystrokes reach Claude Code's TUI as the same `\r`, which the app treats
as "submit." Nothing downstream can tell them apart. **This is expected behavior
of the raw-passthrough design, not a regression** — the rawness that makes it a
faithful real terminal is exactly why the two keys collapse to one byte.

Why a "regular terminal" does it: terminals where `Shift+Enter` inserts a newline
are **configured to emit a distinct sequence** for it (iTerm2 / Terminal.app key
mappings, Claude Code's `/terminal-setup`, or a terminal that speaks the Kitty
keyboard protocol so the app receives a disambiguated key event). An unconfigured
terminal also just submits. Our xterm instance is that unconfigured case.

## 3. Scope of the gap (do NOT over-build)

The **only** keys that collapse to an ambiguous byte are the **Enter-modifier
family**, because plain Enter's `\r` is overloaded as "submit." Everything else
(Ctrl-combos, arrows, function keys) xterm already encodes correctly and the PTY
passes through. **The correct fix touches Enter only.** Do not add a grab-bag of
custom key handlers for keys no app consumes differently.

- **Primary:** `Shift+Enter` → soft newline. (The one users actually hit.)
- **Optional secondary:** `Option/Alt+Enter` → soft newline (some terminals /
  `/terminal-setup` map this too). Add only if desired; not required.

## 4. Fix options (pick one philosophy — do not accrete handlers)

### Option A — Targeted key handler (recommended for the immediate need)
Intercept just the Enter-modifier case before xterm encodes it, and inject the
sequence the app interprets as a soft newline instead of `\r`.

- Location: `LiveTerminal.tsx`, at terminal creation (near `:105`).
- Mechanism: `term.attachCustomKeyEventHandler((e) => { ... })` returning `false`
  to suppress xterm's default **only** for the exact matched case, plus writing
  the newline sequence to the PTY via `api().remoteTerminalInput?.(taskId, seq)`.
- Match condition MUST be exact: `e.type === 'keydown' && e.key === 'Enter' &&
  e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey`.
- **The sequence `seq` is app-defined and MUST be verified empirically** (§6).
  Candidates: `"\n"` (LF, 0x0A) or an escape-prefixed CR `"\x1b\r"`. This is the
  same sequence Claude Code's `/terminal-setup` configures other terminals to
  send. Sending the wrong bytes yields nothing or a stray character — verify
  before shipping.

### Option B — Enhanced keyboard protocol (general, future-proof)
Enable the Kitty keyboard protocol / CSI-u encoding on xterm so the terminal
reports all modified keys faithfully and each app negotiates what it wants — no
per-key handlers to maintain, covers `Shift+Enter` and anything future.

- Heavier: changes how ALL keys are encoded, so it carries **broader regression
  surface** (§5) and needs testing against the full TUI, not just Enter.
- Prefer Option A unless we specifically want general modern-terminal behavior.

## 5. Regression safety — MANDATORY constraints for any implementation

The user requirement is **zero regression**. Whatever is implemented MUST:

1. **Not alter plain `Enter`.** Plain Enter must still send `\r` and submit,
   unchanged. The handler fires only when `shiftKey` is true (and other modifiers
   are false).
2. **Fall through for every other key.** `attachCustomKeyEventHandler` must return
   `true` (let xterm handle it) for anything not the exact matched case. Never
   swallow keys broadly.
3. **Not double-send.** When the handler injects `seq` and returns `false`, xterm
   must NOT also emit `\r` for that event. Confirm exactly one write reaches the
   PTY per keystroke (no duplicate/newline-plus-submit).
4. **Not touch the PTY/backend or the output path.** Fix is renderer-only, input
   side only; the raw output stream, replay/reflow, and resize logic stay
   untouched.
5. **Preserve copy/paste and IME.** A pasted string containing newlines must keep
   flowing through `onData` unchanged (paste is not a keydown; the handler must
   not interfere with it).
6. **Prefer Option A** for a small, contained blast radius. Option B only with
   full-TUI regression testing since it re-encodes all keys.
7. **Verify against the real app** before merge (see §6) — do not ship on the
   assumption that a given sequence is correct.

## 6. Verification (before any implementation is merged)

Empirically confirm the exact soft-newline sequence Claude Code's TUI accepts:
1. In a known-good real terminal (or after `/terminal-setup`), capture what
   `Shift+Enter` actually sends to the PTY.
2. Reproduce that exact byte sequence from the custom handler.
3. Manually test in the orchestrator terminal: plain Enter still submits;
   Shift+Enter inserts a newline and does NOT submit; paste with embedded
   newlines is unaffected; arrows/Ctrl-combos unaffected.

## 7. Files involved

- `desktop/engine-overrides/renderer/remote/LiveTerminal.tsx` — the xterm setup
  and `onData` passthrough (`:105`); the sole change site for Option A.
- (Reminder) `engine-overrides/` is the source of truth; it is copied to
  `work/oss-engine/` at launch — relaunch after editing.

## 8. Recommendation

Implement **Option A**, `Shift+Enter` only, after verifying the sequence in §6,
under the §5 guardrails. Treat `Option/Alt+Enter` as an optional follow-up. Defer
Option B (keyboard protocol) unless we later want general modern-terminal
key fidelity across the board.
