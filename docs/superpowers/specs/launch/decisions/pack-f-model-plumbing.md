# Pack F — decisions taken while implementing

**Branch:** `arpit/launch-model-plumbing`
**Spec:** `../pack-f-model-plumbing/SPEC.md` · **Decision:** overview D6
**Files changed:** `desktop/electron/remote/task-manager.ts`, `desktop/electron/remote/init.ts`, `desktop/engine-overrides/renderer/remote/useRemoteTasks.ts` (+ this file)

---

## The shape of the change

`RemoteTask.model` now exists. `Task.model` is written once at creation, persisted
into `meta.json` beside `agent`, read back by `rehydrate()`, and passed to the
renderer by `serializeTask` as a plain read of `t.model`.

There is exactly one write path per backend and no second one anywhere. Nothing
downstream of creation recomputes it: `serializeTask` does not call `settings`,
`getModels()`, `getModelCatalog()`, `readCatalog()` or `listCodexModels()`, and
the renderer is given the value rather than a way to derive one.

## Where the model comes from, per backend

### `claude` (Claude Code CLI) — high confidence

`init.ts` gained `doerModel()`, which is the *extracted* body of the line
`executorFactory` already used to compute `--model`:

```ts
function doerModel(): string {
  return settings.get('model') || getModels().doerDefault
}
```

`executorFactory` now calls it, and so does the dispatch wrapper. This is the
strongest available answer to VERIFY B9 ("the model actually passed as
`--model`, not a separately-read setting") under this pack's file ownership.

**The judgement call.** The *ideal* would be for the executor to report the model
it was constructed with, so there is literally one read. That is not reachable
from here: `ExecutorFactory`'s signature lives in `executor.ts`, which this pack
does not own, and `executorFactory` is invoked *inside* `TaskManager.dispatch()`
— after `meta.json` has already been written. Extracting the resolution into one
function is the closest reachable equivalent: the two call sites cannot drift in
*logic*, only in *time*.

**The residual window, stated honestly.** The wrapper reads the setting at
dispatch entry; the factory reads it again a few hundred milliseconds later,
after `scaffoldStatusFile` / `installContract` / `installHooks` / the memory
injection have awaited. A user who moves the model picker inside that window
would get a task recorded with the value at dispatch *initiation* and run with
the value at *spawn*. I chose not to close this with a pinning mechanism (a
module-level "model for the dispatch in flight") because concurrent dispatches
would then have to be keyed and unkeyed correctly, and a real interleaving bug is
worse than a sub-second race that requires the user to change a setting mid-flight.
It is recorded here rather than left to be discovered.

### `codex-desktop` — medium-high confidence

Two sources, both belonging to Codex, resolved by `codexDesktopModel()` in
`init.ts`:

1. **The pick we are about to apply.** `dispatchCodexDesktop` passes the user's
   `codexModel` / `codexEffort` straight into `driver.createTask`, so when the
   user has chosen, that *is* what the thread runs on. Confidence: high.
2. **Otherwise, what Codex is already set to.** The thread inherits it, and the
   reasoning button's own label — cached verbatim in `codexReasoningCache.label`
   from a CDP read of Codex's UI — is the only thing that reports it. Confidence:
   medium. It is Codex's own words, but it can be *stale* (written by the last
   read, not by this dispatch) or *absent* (never read). Stale is possible;
   absent is handled by recording nothing.

The label is then canonicalised through the app-server: `listCodexModels()`
(`model/list`) + `matchCurrent()`, which is the same pairing `pushPillChips`
already uses.

**Why the app-server is used for canonicalisation and not as the primary source.**
The spec says "read the active model at task creation" from `model/list`.
`model/list` does not expose an active model — it is a catalogue (`hidden`,
`supportedReasoningEfforts`, `defaultReasoningEffort`) with no "current" field.
The codebase's own comment on `matchCurrent` says as much: the live model is
"read from the reasoning button's own label". So the protocol is used for what it
actually is — the catalogue that validates the label and normalises its spelling
("GPT-5.6-Sol" vs "5.6 Sol") — and the button's label is the source of truth for
*which*. This is a deliberate deviation from a literal reading of SPEC §3, and it
is the honest one.

**Non-blocking (VERIFY #38).** `listCodexModels` is bounded at
`CODEX_MODEL_READ_MS = 1500` (down from its 8s default) and wrapped in `.catch`.
It already resolves `[]` — never rejects — on a missing app, a spawn failure, a
timeout or a protocol change; `matchCurrent([])` then returns `{}` and the raw
label is recorded instead. **A closed Codex cannot fail or hang a dispatch**; it
costs at most one bounded spawn attempt. It is also not a new class of latency on
this path, which already awaits `ensureApprovalHook` and a multi-second CDP
`createTask`.

**Nothing was awaited before it needs to be.** The resolution is only awaited for
`codex-desktop`; the `claude` branch returns a plain string.

### `claude-code-desktop` — high confidence, and sourced differently from the spec

The model comes from **Claude Desktop's own session store**
(`ClaudeDesktopTask.model`, e.g. `claude-opus-4-5-20251101`), read in
`adoptClaudeDesktop`, and turned into the app's own label via
`readCatalog()` + `labelFor()` from `claude-desktop/catalog.ts` (`Opus 4.5`).
When the catalogue cannot be read or does not know the id, the **raw id** is
recorded rather than a prettified guess; when the store names no model, **nothing**
is recorded.

**Why not the AX composer, which SPEC §3 points at.** `readComposerSettings`
carries an explicit warning in its own doc comment:

> these belong to the conversation Claude Desktop currently has OPEN … That
> makes them right for "what will a NEW task start on" and **wrong for a per-card
> chip — a card's own model comes from the session store instead**. Attributing
> the focused conversation's model to every card is the same mistake as
> attributing its permission prompt.

Following the spec literally would have reintroduced exactly the class of bug D6
exists to prevent, one layer down: a per-card value read from a global live
control. The session store is *already* the historical fact, per conversation,
written by the app itself.

**It also covers both entry points.** `createClaudeDesktop` does not build the
Task — it delegates to `adoptClaudeDesktop`. Sourcing the model there means a
conversation Unmute starts and a conversation Unmute adopts are handled by one
piece of code, and `init.ts` correctly resolves `undefined` for this backend
(`modelForDispatch`), because anything it resolved would be the composer's
current value.

The catalogue read is lazy and memoised per sweep — a 37MB archive must not be
touched at all by a store full of model-less tasks. `readCatalog` returns `[]`
rather than throwing, and is itself cached on `(path, mtime, size)`.

### `codex` (Codex CLI) — no path, deliberately

`isDispatchable()` excludes it and it has no creation path. `modelForDispatch`
returns `undefined` for it via the `default` arm of the switch, which is a
non-decision rather than a path.

## Judgement calls worth flagging

**`modelForDispatch` keys off `opts.agent ?? 'claude'`, never `settings.get('agent')`.**
This mirrors `TaskManager.dispatch`'s own default exactly. It matters: two live
call sites (`init.ts` ~2119, ~2127 — the router-failure fallback and the
no-routing path) dispatch with no `agent` at all, so they land on Claude Code
regardless of the picker. Reading the picker here would have stamped a Codex
model on a task that ran on Claude — the plausible lie in its purest form.

**Absence is expressed as an absent key, not `undefined` or `null`.** Every write
uses a conditional spread (`...(model ? { model } : {})`) so `meta.json` has no
`model` key at all when there is none. Proven: `assert.ok(!('model' in meta))`.
`serializeTask` sends `model: t.model` (i.e. `undefined`), matching
`RemoteTask.model?: string`, rather than the `?? null` used by fields the
renderer types as nullable.

**`codexModelLabel` was left exactly as it was.** It already existed on `Task`,
is populated from the same explicit pick, and is not persisted. Repurposing or
removing it was out of scope; `model` is added alongside it. `dispatchCodexDesktop`
prefers `opts.model` and falls back to `modelLabel`, so a `TaskManager` driven
directly (tests, or any future caller without the init wrapper) still records a
correct value instead of nothing.

**No `meta.json` key was renamed, removed or repurposed.** The change is purely
additive; an older engine reading a newer receipt ignores an unknown key.

## Two things I found and deliberately did NOT fix

1. **`rehydrate()` does not restore `agent` on the PTY path.** The
   `claude-code-desktop` and `codex-desktop` branches set it; the general branch
   (task-manager.ts, the third `Task` literal in `rehydrate`) does not, so a
   rehydrated `agent: 'codex'` CLI task comes back as an implicit `'claude'`.
   Pre-existing, unrelated to the model, and adding `agent: meta.agent` would
   change `resume()` behaviour for such tasks (it would start throwing
   `CODEX_CLI_RESUME_UNSUPPORTED` instead of spawning Claude). That is arguably
   more correct but is a behaviour change this pack has no mandate for.
   **Consequence for VERIFY #37:** a rehydrated task keeps its *model* on all
   three paths; it keeps its *agent* on the two driven paths only, and that gap
   predates this branch.
2. **`RemoteTask.agent` in `useRemoteTasks.ts` is missing `'claude-code-desktop'`**
   from its union. Pre-existing; the renderer reads `provider` rather than
   `agent` for every decision that matters, and widening the union is a
   renderer-typing change Pack C is better placed to make with its consumers in
   front of it.

## Raised by independent verification, and left for Pack C

- **`notch-controller.ts:815` still sends `modelLabel: t.codexModelLabel`**, the
  older non-persisted field, rather than the new `model`. Consequence: the
  notch's Codex model label is still blank after a restart. Pre-existing, and
  `notch-controller.ts` is not this pack's file — but it is now a one-line fix
  that someone who owns that file should make.
- **Nothing renders `RemoteTask.model` yet.** No renderer component reads it;
  that is Pack C's work and is exactly why Pack C was blocked on this pack. It
  is also why VERIFY C16/C17/D19 cannot be performed until Pack C lands: there
  is no card showing a model to check. The plumbing is proven by the round-trip
  test below; the lie-detection test is deferred, not passed.
- **VERIFY #38, precisely.** The verifier's reading is that the Codex
  app-server call *is* serially awaited before `origDispatch`, so "not awaited
  in a way that delays task creation" is literally false even though the
  substantive clause — a failure must not hang or fail the dispatch — holds
  (bounded at 1500ms, `listCodexModels` never rejects, `.catch` at the call
  site, and skipped entirely when there is no label to canonicalise). Recorded
  rather than argued away.

## Verification

`npm run typecheck`: the **same three** pre-existing errors as on `origin/main`
(`init.ts` InstallResult index signature, `init.ts` ReasoningAxis `Model`,
`notch-controller.ts` `TurnP`). No new ones.

`npm test`: **1400 pass / 0 fail**, identical to baseline. The four named files
pass individually: `providers.test.ts`, `codex/lifecycle.test.ts`,
`claude-desktop/lifecycle.test.ts`, `codex/separation.test.ts` (+
`task-manager.test.ts`) = 149 pass / 0 fail.

**End-to-end proof, run out of tree.** Five assertions were written and run
against this branch, then removed rather than committed, because VERIFY §E23
requires the diff to contain only the three owned files. All five passed:

1. `dispatch(..., { model: 'sonnet' })` → `task.model === 'sonnet'`,
   `meta.json.model === 'sonnet'`, and a **fresh `TaskManager` over the same
   disk** rehydrates it back to `'sonnet'`.
2. `dispatch()` with no model → `task.model === undefined` and **`'model' in meta`
   is false** — the key is absent, not null.
3. A hand-written pre-change `meta.json` (no `model` key) rehydrates without
   error, keeps its intent, and carries `model === undefined`.
4. `codex-desktop` records `'5.6 Luna Ultra'` from the applied pick, persists it,
   survives a restart, and lets an explicitly resolved `'5.6 Sol High'` win.
5. Claude Desktop adoption of two conversations — one with
   `model: 'claude-opus-4-5-20251101'`, one with `model: null` — records
   **`'Opus 4.5'`** for the first (resolved against the real Claude.app bundle on
   this machine, i.e. the catalogue read genuinely worked) and **nothing** for
   the second, in both the task and `meta.json`.

The source of that throwaway file is preserved in the session scratchpad. **A
follow-up should land these as real tests** in `task-manager.test.ts` /
`claude-desktop/lifecycle.test.ts` — files this pack does not own.

**Not run: the decisive Sonnet→Opus test (VERIFY C16/C17).** It requires a built
app, a live dispatch, moving the picker, and a restart. Proof #1 above establishes
the mechanism (the value round-trips through disk and is replayed by a manager
that never saw the dispatch) and code inspection establishes that no settings read
exists on the render path, but the `[eye]` check itself is **escalated to the
user, not self-certified**.
