# Pack C — decisions taken while implementing

**Branch:** `arpit/launch-orchestrator`
**Spec:** `../pack-c-orchestrator/SPEC.md` · **Verify:** `../pack-c-orchestrator/VERIFY.md`
**Overview decisions in play:** D1 (no memory section), D6 (model is a historical
fact), D7 (Suggestions removed, Skills read-only), D8 (control vocabulary)
**Depends on:** Pack F, merged — `RemoteTask.model` exists and was confirmed
present before anything rendered it.

This file is for someone who was not here. It records every call the SPEC did
not make for me, and the two places where I could not do what the SPEC asked.

---

## Files changed

Everything is under `desktop/engine-overrides/renderer/remote/`:

| File | What happened |
|---|---|
| `OrchestrateWall.tsx` | The bulk of the work — naming, the 24h window, the needs-you band, grid density, the rail, the ticket, registry-gated buttons |
| `RemoteSettings.tsx` | Rebuilt on `_shared` primitives; agent control; per-agent models; sandbox; no-agent state; **no page state of its own** |
| `RemoteSetup.tsx` | Self-contradiction resolved; two raw checkboxes → `Toggle`; Codex Connect now confirms before quitting the user's app |
| `RemoteHowItWorks.tsx` | Copy updated (not Claude-only any more; "Remote" → "Orchestrator"); `onOpenSetup` made optional |
| `RemoteSetupEntry.tsx` | Header comment only — it referenced a component this pack deleted |
| `ComputerUseSettings.tsx` | Raw checkbox → `SettingRow` + `Toggle` (it renders *inside* the settings panel) |
| `OverlayApp.tsx` | Two lines: the rendered string "in cockpit ↗", and the last legacy `agent !== 'codex-desktop'` capability check |
| `TaskPanel.tsx` | **Rewritten**, not deleted — see "Pack A landed mid-flight" below. The Tasks page of the Orchestrator tab: needs-you first, registry-gated buttons, agent · model · directory on every ticket, no internal page state |
| `taskFacts.ts` **(new)** | The facts a ticket owes the user and the questions its buttons ask, shared by the wall and the Tasks page so they cannot drift |
| `taskFacts.test.ts` **(new)** | 16 assertions: capability gating never consults an agent id, `model` is never invented, label and mark cannot disagree, every ticket names its directory |
| **Deleted** | `TaskRow.tsx`, `AmbientIndicator.tsx`, `SkillReviewPopup.tsx`, `Onboarding.tsx` |

Nothing outside that directory was touched. `useRemoteTasks.ts` is byte-identical
(Pack F owns it), and `App.tsx` was not opened.

**Measured against the real base**, `arpit/launch-readiness` — not `origin/main`,
which wrongly attributes every pack's spec files to whoever diffs last. The only
paths on this branch that predate my work are Pack F's four
(`electron/remote/init.ts`, `electron/remote/task-manager.ts`,
`renderer/remote/useRemoteTasks.ts`, and Pack F's decisions file).

---

## Pack A landed mid-flight, and changed three things

Pack A finished while this pack was in verification. It is **not merged into
this branch** — it lives on `arpit/launch-shell-onboarding` and will meet this
work in the coordinator's merge — but its `App.tsx` is now written, and it gives
the Orchestrator tab four segments (`tasks | how | setup | settings`) and
**mounts `TaskPanel` as the default `tasks` segment**
(`app/App.tsx:431`). Three consequences, all applied:

### 1. `TaskPanel.tsx` is no longer dead code, so it was rebuilt instead of deleted

SPEC §5 said to delete it as unreachable. That was true when the spec was
written and is now false — deleting it breaks the branch on merge. It is
rewritten to the new ticket design: needs-you lifted to the top, every ticket
naming its **agent · model · working directory**, and buttons that ask the
registry (`canResume`, `hasTerminal`, `canKill`) exactly as the wall does.

`TaskRow.tsx` and `AmbientIndicator.tsx` are still imported by nothing and are
still deleted; TaskRow's genuinely useful parts (the needs-user answer form, the
artifact buttons, the markdown result detail, the on-demand terminal) were
**folded into `TaskPanel` as a `Ticket` component** — the "fold it in and delete
the wrapper" branch SPEC §5 allows.

### 2. Two surfaces now render a ticket, so the facts moved into one module

`taskFacts.ts` is new. The wall and the Tasks page must answer "which agent,
which model, which directory" and "may this be resumed" **identically**, and the
four ad-hoc `agent !== 'codex-desktop'` checks that the provider registry
replaced are precisely what happens when two surfaces each keep a copy. It is
pure (no React, no electron) and `taskFacts.test.ts` covers the parts that would
fail silently:

- a Codex **id** with a PTY **provider** is still resumable — proving no id is
  consulted
- `model` absent → the agent stands **alone**, asserted against every plausible
  invented value (`sonnet`, `opus`, `default`, `unknown`, `—`)
- an empty-string model is absence, not a model
- label and colour mark cannot disagree for any agent value
- a scratch dir is shortened, never blank

Suite: **1416 pass / 0 fail** (1400 baseline + these 16).

### 3. The two-sources-of-truth bug is gone from BOTH panels, without touching `App.tsx`

`TaskPanel` carried its own `'tasks' | 'how' | 'setup'` state and its own buttons
into those pages. With Pack A's segmented control above it, that is two
navigations over one selection: enter How-it-works from inside the panel and the
segment above still reads "Tasks".

**The internal state is deleted.** `TaskPanel` accepts `page` and `onPageChange`
as props and renders only when `page === 'tasks'`; its in-panel links to How and
Setup are gone, because the segment above already offers them.

Both props are **optional**, and that is load-bearing: Pack A's call site is
`<TaskPanel />` with no props at all, so a required prop would break the file
this pack may not edit. I verified compatibility rather than assuming it — Pack
A's five call sites (`arpit/launch-shell-onboarding` `App.tsx:431-442`) were
reproduced in a throwaway probe inside this tsconfig and typechecked: **0
errors**, then deleted.

**`RemoteSettings` had the identical bug, and an earlier cut of this pack shipped
it.** That version kept `const [page, setPage] = useState<'settings' | 'how'>` and
`const openHow = onOpenHowItWorks ?? (() => setPage('how'))`, documented as "a
fallback for a caller with no sub-nav, one line for Pack A to wire". But Pack A's
call site is `<RemoteSettings />` **with no props** — so the fallback is not a
fallback, it is *the code that runs*: click "How it works →" and the panel swaps
itself for the trust page while the segmented control above it still reads
**Settings**. Shipping the exact bug this pack was told to remove, on the promise
of a wiring line in a file this pack may not edit, is not a fix.

**The state is deleted there too.** Both the "How it works →" link and the
no-agent screen's button are now drawn **only when `onOpenHowItWorks` is given**.
Unwired, nothing is drawn — which costs nothing, because the tab's own
`How it works` segment is the route in the shipped app, and Pack A imports and
routes `RemoteHowItWorks` itself (`App.tsx:27`, `:433`). One route, one selection,
no dead control and no stale segment in either configuration.

The visible consequence on **this branch in isolation**: `RemoteHowItWorks` no
longer has an importer here, exactly as `TaskPanel` does not. Both are Pack A's
to mount and both are mounted on Pack A's branch. That is the merge resolving,
not an orphan — see below.

**Two optional wirings are left for Pack A**, both already typechecked, neither
of which this pack may write:

```tsx
{page === 'tasks' && <TaskPanel page={page} onPageChange={onPageChange} />}
<RemoteSettings onOpenHowItWorks={() => onPageChange('how')} />
```

Both are now genuinely optional. Without the first, `TaskPanel` behaves correctly
(App only mounts it on the tasks segment, and it keeps no state to go stale) but
its setup nudge is not drawn, because it has no way to navigate and will not
render a dead button. Without the second, the settings panel simply carries no
shortcut to the trust page — the segment above it does.

### Copy and type scale, now that this copy is actually visible

Pack A mounting these files made their copy user-visible for the first time, and
it still said "Remote tasks", "Hold the Remote key", "How Remote works" — inside
a tab the spec insists is called Orchestrator. All gone.

Type in every **light-theme, main-window** file this pack owns is on the D8 scale
(`22 / 16 / 14 / 13 / 12.5 / 11 / 10`) and uses literal values, not Tailwind's
named sizes: `RemoteSettings`, `RemoteSetup`, `RemoteSetupEntry`,
`RemoteHowItWorks`, `TaskPanel`, `ComputerUseSettings`.

The two **dark** surfaces are deliberately off that scale and are not
main-window surfaces: `OverlayApp.tsx` (the floating translucent overlay) and
`OrchestrateWall.tsx` (the Ops Console wall, its own mono type ramp from 17 down
to 8.5). An earlier draft of this file named only `OverlayApp` — that was
incomplete, and anyone auditing by that sentence would have missed the wall.

### One thing that is now provably reachable

VERIFY §H37 and §H41–42 were written when nothing imported these components.
Both are now imported and routed by Pack A's `App.tsx` — `TaskPanel` at `:28`
mounted at `:431`, `RemoteHowItWorks` at `:27` mounted at `:433`.

**On *this* branch in isolation, neither has an importer.** That is the merge not
having happened, not an orphan: deleting either one breaks Pack A's file the day
the branches meet. `TaskPanel` is that way on the coordinator's direct
instruction; `RemoteHowItWorks` joined it when the settings panel's stale second
door was removed (above). Anyone running VERIFY §H37/§H40/§H41 against this
branch alone will see two files with no importer — check `App.tsx` on
`arpit/launch-shell-onboarding` before concluding anything, and do not "fix" it
by deleting them.

---

## Scope: two files the SPEC's ownership table does not name

The SPEC lists eight files. My instructions widened that to *everything* under
`renderer/remote/` except `useRemoteTasks.ts`, and I needed the wider grant twice:

- **`OverlayApp.tsx`** — VERIFY A1 greps `*.tsx` in this directory for
  "cockpit"; `OverlayApp.tsx:247` rendered the literal string `in cockpit ↗`. It
  also held the last surviving `task.agent !== 'codex-desktop'` gate on a Resume
  button, which VERIFY G35 calls a FAIL. Leaving either would have failed the
  pack's own checklist. Two lines changed.
- **`ComputerUseSettings.tsx`** — it renders inside `RemoteSettings` and was a
  raw `<input type="checkbox">`. SPEC §8 says *no raw checkbox survives*; a
  rebuilt settings panel with one un-rebuilt row inside it is not a rebuilt
  panel.

Both are unowned by any other pack, so there is no merge hazard.

---

## The wall

### The 24-hour window ate two other timers

`visibleOnWall` had **three** time rules, not one: `kind === 'session'` was
exempt forever (the 46-day card), and finished one-offs faded at 15 minutes
(`DONE_FADE_MS`) with errored/stuck at 60 (`ATTN_FADE_MS`).

I deleted both fade constants rather than keeping them under the new window.
They were a second, unlabelled time filter with no control attached — precisely
the silent truncation SPEC §3.2 forbids — and if they had stayed, the header's
"N older hidden" count would have been a lie for everything between 15 minutes
and 24 hours. **One window, one control, one honest count.** The visible
consequence is that finished errands now linger for a day where they used to
vanish in a quarter of an hour; SPEC §3.3's grid density is what handles the
resulting volume.

### "Live now" deliberately excludes `ready`

SPEC §3.2 says "live now, or updated within 24 hours" without defining live. I
defined it as `processing || needs-user || alive`.

`ready` is the interesting exclusion. It means "parked, the ball is with you" —
and it is exactly what the user's screenshot showed twelve of, including the
46-day-old one. Had I counted `ready` as live, the headline bug would have
survived the fix. A genuinely long-running session that nobody has touched today
is still kept, because `alive` is true for it.

### The band lifts, it does not copy

SPEC §3.1 says render a Needs-you band above every group and that "everything
else keeps its existing router-assigned group". I read that as *lift*: a
`needs-user` task appears in the band and **is removed from its group**, so it
renders exactly once. A card appearing twice on one wall would make the count in
the group header wrong and the Q-numbers ambiguous.

The band is drawn from everything **visible**, not just the grid. A `needs-user`
one-off would otherwise sit in the rail while the band above it was empty, which
defeats the entire point of the band.

### `+N more` is a per-group cap of 8

SPEC §3.3 says the per-group control is grid density — "items hidden because the
row is full". The grid is `auto-fill, minmax(248px, 1fr)`, so the real row count
depends on window width, which the render does not know. I picked a fixed
`GRID_ROW = 8`: one full row at the widest the Orchestrator window ever gets
(~70% of the display). A width-aware version would need a `ResizeObserver` and
would make the number jitter as the user resizes — worse, not better.

### Expand all is idempotent by construction

VERIFY D18 requires that pressing it twice neither collapses nor double-renders.
Rather than trusting a toggle to behave, `Expand all` **only ever sets** expanded
(`setExpandAll(true)`), so pressing it any number of times is the same as
pressing it once. Collapsing is a separate control that appears only once
something is expanded. It does not touch `allTime`, so the time filter is
untouched (VERIFY D17).

### The rail is exactly four sections, and they no longer disappear

Queue · One-offs · **Skills** · **Shelf**. Skills and Shelf used to render
nothing at all when empty, which meant the rail was two sections on a fresh
install. A fixed set of sections that vanish is not a fixed set, so both now
render with a quiet empty line.

There used to be *two* skills sections — "Unmute Skills" (curator-authored) and
"Skills". That would have made five. I merged them: with the curator off
(D7), which sweep wrote a skill is archive trivia, and it survives as a badge on
the row rather than as a section header. The badge's tooltip now says the curator
is switched off, so nothing implies the list still grows.

**Skills is read-only in the sense D7 means it** — nothing is *added*. Pin and
tap-to-invoke stayed, because SPEC §3.5 also says all four sections are
actionable, and both act on skills that already exist.

### Projects was removed from the rail and reappears in the sandbox

SPEC §3.5 removes Projects because it is "a directory list with no action
attached". Rather than orphan `remote:list-projects`, the same list now powers
one-tap folder choices in the sandbox control — where the action is obvious. See
the sandbox note below.

---

## The ticket

### The working directory is now shown for scratch dirs too

`dirLabel()` used to return `''` for any cwd containing `/.unmute/`, on the
reasoning that a one-off's isolated scratch directory is "machinery, not
information". SPEC §4.1/§4.2 says every ticket names its working directory. A
card that answers "where did this run?" for some tasks and not others is worse
than one that always answers, so the scratch path is now **shortened**
(`~/.unmute/…/3f2a1b`) rather than suppressed, with the full path on the
tooltip. This reverses an earlier deliberate decision; recorded so nobody
"re-fixes" it.

### Model: absent means absent

`t.model ? ` · ${t.model}` : ''` on the card, and a dim "not recorded" in the
expanded ticket. No settings read exists anywhere on the render path — grep
`remoteGetModel` in this directory and you will find nothing. Pack F's own
decision file explains why: a task dispatched on Sonnet must not start claiming
Opus the moment the picker moves, because that card would look exactly as
correct as a true one.

### Permissions is the one field that cannot be historical

SPEC §4.2 asks for four fields, always: Agent · Model · Working directory ·
**Permissions**. The first three are properties of the task, sent by main.

Permissions is not. `permissionMode` is a single global setting read by the
executor factory at spawn time (`init.ts:951`); it is not written to the task, is
not in `meta.json`, and is not on `RemoteTask`. There is no historical value to
show. Rather than invent one — the exact D6 sin, one layer down — the row shows
the **current setting** and its tooltip says so in as many words: *"The current
Orchestrator setting — permission mode is not recorded per task."*

**If someone wants this to be a real historical fact, it needs a Pack-F-shaped
change**: record `permissionMode` on the Task at dispatch, persist it in
`meta.json`, serialize it. That is a main-process change this pack does not own.

Both ticket surfaces carry the field, with the same words and the same tooltip.
The wall reads it inside `TicketFacts` (one stage is open at a time); the Tasks
page reads it **once for the page** and passes it down, because it is one global
setting and every ticket giving a different answer to the same question is not a
state that should be representable.

### Capability defaults name capabilities, not backends

VERIFY G35 forbids an `agent === 'codex-desktop'` comparison that decides a
button. The existing helpers used exactly that as a fallback for payloads written
before the provider registry existed. Rather than keep a documented-but-matching
literal, I stated the default as a capability:

```ts
const hasTerminal = (t) => t.provider?.hasTerminal ?? true
const canResume   = (t) => t.provider?.canResume   ?? true
const canKill     = (t) => t.provider?.transport !== 'driver'
```

`true` is right for the pre-registry payloads it covers: every one of them was a
Claude Code CLI PTY session. `isChat()` was deleted — `!hasTerminal(t)` says the
same thing in the registry's own vocabulary, and having both invited drift.

The only place an agent id survives on the wall is `LEGACY_AGENT`, a lookup
table describing a provider-less payload. It decides no behaviour, and it covers
`claude-code-desktop` — which Pack F flagged as missing from `RemoteTask.agent`'s
union. I did **not** widen that union: `useRemoteTasks.ts` is Pack F's file, and
the table is keyed by `string`, so it is correct without the union changing.

It holds the **label and the colour mark together** for a reason found in
verification: they were originally two separate fallbacks, and they disagreed —
`vendorMark` returned Claude terracotta for any provider-less task while
`providerLabel` would call that same card "Codex desktop". The path is
unreachable today (`init.ts:821` sets `provider` on every serialized task), but
one table cannot contradict itself, and two could.

### Vendor marks are the one exception to "colour = status"

The wall's rule R1 is that colour encodes exactly one variable: status. SPEC
§4.1 asks for a per-vendor colour mark. I kept the exception as narrow as it can
be: a 6px square in the dim footer, far from the status dot and its label. It is
resolved from `provider.vendor` + `provider.surface`, never from an id, so a new
backend gets a mark by adding one registry-keyed entry:

| Key | Colour |
|---|---|
| `Claude/cli` | `#D97757` terracotta |
| `Claude/desktop` | `#d2a8ff` violet |
| `Codex/cli` · `Codex/desktop` | `#3fb950` green |

An unknown vendor gets neutral grey rather than borrowing someone else's colour.

---

## The settings panel

### The agent control is not a `SegmentedControl`

D8 names `SegmentedControl` as part of the control vocabulary, and I used a
stack of selectable rows instead. SPEC §6 is explicit that Agent "is a proper
control showing what each backend is good at — not a bare dropdown", and a
segmented control has room for a label and nothing else. Each row carries the
backend's name, a live availability dot, and one sentence about what choosing it
actually means for the ticket (a terminal and a Resume, or a thread in another
app). The forbidden things — a raw checkbox, a native `<select>` — are gone.

### Model chips: a table, not an `=== 'codex-desktop'`

`FALLBACK_CATALOG` is deleted. The chips ask the selected backend.

There is a trap here worth writing down. `remote:model-options` looks like the
per-agent answer, and it is — for `claude-code-desktop`. For **every other id**,
including `codex-desktop`, it falls through to `getModelCatalog()`
(`init.ts:3703`), which is Claude Code's catalogue. Asking it about Codex returns
Haiku/Sonnet/Opus, which is the exact bug VERIFY I49 tests for.

My first cut guarded that with `const isCodex = agentId === 'codex-desktop'`.
**Independent verification called that a FAIL on assertion 35's intent, and was
right.** The dangerous default is not "ask Codex the wrong way" — it is *ask the
catalogue about a backend it knows nothing about, and render Claude's tiers under
that backend's name*. A single-id guard fixes that for one id and hands the next
backend the identical bug on the day it lands.

So the question is now "how does THIS backend report its models", asked of a
table:

```ts
const MODEL_SOURCE: Record<string, 'catalog' | 'own-app'> = {
  claude: 'catalog',
  'claude-code-desktop': 'catalog',
  'codex-desktop': 'own-app',
}
```

- `'own-app'` → `remote:codex-reasoning`: Codex's own Model / Effort / Speed
  axes, read from the running app (the same source the pill's chip uses).
  Nothing there → an honest line telling the user to open and connect Codex.
- `'catalog'` → `remote:model-options` for that id. An **empty list is a real
  answer** meaning "we cannot know what this app offers", and renders nothing
  selectable.
- **Absent is the entry that matters.** An unlisted backend has no known model
  source, so nothing is offered. Adding a provider should mean adding one line
  here; forgetting is visibly inert instead of quietly wrong.

The registry cannot answer this question today — `Provider` carries `vendor`,
`surface`, `transport`, `hasTerminal`, `canResume`, and none of those says where
a model list comes from. Adding a `modelSource` field to
`electron/remote/providers.ts` would let this table go away entirely, and that is
where it belongs; Pack C does not own that file.

### Removed outright

- **The Remote trigger toggle.** SPEC §6 keeps the Settings → Triggers one. Two
  switches on one gate is two places to disagree.
- **Unmute memory and its cleanup button** (D1).
- The overlay auto-present/dock toggles were already gone before this pack.

### No agent installed (§3.7)

Rendered instead of the settings panel — not above it — because SPEC §3.7 says
not to render controls for a thing that cannot run. It says what the Orchestrator
is, lists each backend with its real install command (from the `backend-*` steps
of `remote:get-setup-status`, so the copy is main's and cannot drift), links
"How it works", and states plainly that dictation is unaffected.

It renders only once the probe has actually answered. An empty picker before the
first reply means "not known yet", not "none" — flashing a first-run screen at
an existing user for 200ms would be worse than a moment of nothing.

---

## Two things the SPEC asked for that I could not deliver as written

### 1. The sandbox directory picker — not reachable from this pack

**SPEC §6: "Sandbox roots gets a directory picker."** A native picker needs
`dialog.showOpenDialog` in the main process. There is no such IPC:

- `desktop/electron/remote-preload.ts` — no dialog, no folder chooser (grepped)
- the OSS engine's `electron/preload.ts` @ `v1.3.6` — same, and no `webUtils`
- no `dialog.showOpenDialog` call anywhere in `desktop/electron/`

Pack C owns no main-process file, so it cannot add one. The renderer-only
substitute — `<input type="file" webkitdirectory>` plus `File.path` — does not
work either: the engine pins **Electron ^40**, and `File.path` was removed in
Electron 32. That button would open a chooser and then silently add nothing,
which is the dead control SPEC §4.3 explicitly calls worse than an absent one.

**What shipped instead**: real directories to *click*. `remote:list-projects`
returns the project directories Unmute already knows about on disk; each is a
one-tap chip. Typing a path is the fallback, not the primary control, and the
field's placeholder says what it wants (`Or type the full path to a folder`)
instead of the fictional `/Users/you/Downloads`.

**To finish this properly**, someone who owns `electron/` adds
`remote:pick-directory` → `dialog.showOpenDialog({ properties: ['openDirectory'] })`
and one preload line. It is a ten-line change in a file this pack may not touch.
VERIFY I50 should be read as an **ESCALATE**, not a PASS.

### 2. `npm run typecheck` cannot exit 0, and did not before this pack

**VERIFY L59** requires exit 0. **The coordinator has since corrected this
assertion**, and the correction matches what I measured independently.

On the base commit, before anything in this pack, `npm run typecheck` fails with
**three** errors — the same three Pack F recorded:

```
electron/remote/init.ts(3759,59)  TS2345  InstallResult index signature
electron/remote/init.ts(3799,23)  TS2339  ReasoningAxis 'Model'
electron/remote/notch/notch-controller.ts(34,18) TS2304 Cannot find name 'TurnP'
```

All three are in `electron/`, which this pack does not own. Worse, the script is
`tsc -p tsconfig.typecheck.json && tsc -p tsconfig.renderer.json`, so the `&&`
short-circuits and **the renderer stage — the only stage that checks this pack's
files — has never run under that command on this branch.**

So the renderer stage is measured directly, as the coordinator now instructs:

| | before | after |
|---|---|---|
| `npx tsc -p tsconfig.renderer.json` | **137** errors | **137** errors |
| …of those, under `renderer/remote/` | **0** | **0** |
| `npm run typecheck` (electron stage) | 3 errors, exit 2 | the same 3, exit 2 |
| `npm test` | 1400 pass / 0 fail | **1416** pass / 0 fail |

The 137 pre-existing renderer errors live in `app/`, `widget/` and
`useAudioRecorder.ts` — none in any file this pack touched, before or after.

---

## Smaller calls

- **The window title.** `document.title = 'Orchestrator'`, set by the wall on
  mount. The Orchestrator window is `frame: false`, so there is no title bar to
  read it — but the renderer is the only place inside this pack's boundary that
  can set it at all, and `orchestrate.ts` belongs to nobody here.
- **"How it works" is routed from Pack A's sub-nav, and from nowhere else.**
  SPEC §5 points at "the sub-nav slot Pack A defined", and that slot now exists
  (`App.tsx:423`). `onOpenSetup` on the trust page is **optional** for the same
  reason its sibling is: from a caller with no sub-nav there is no way to reach
  `RemoteSetup`, so the closing CTA is not drawn rather than being a dead button.
  `RemoteSetupEntry`, one component above, is the other door.
- **`Onboarding.tsx` (in `remote/`) was deleted — proven unreferenced, not
  assumed.** The whole desktop tree on the base branch contains exactly one
  import of anything called Onboarding:
  `git grep -n "Onboarding" arpit/launch-readiness -- desktop/engine-overrides`
  → `app/App.tsx:10: import Onboarding from './Onboarding'`, a **relative import
  inside `app/`** that resolves to `app/Onboarding.tsx`, a different file that
  survives untouched. Pack A's `App.tsx` imports the same `./Onboarding` and
  reaches `remote/` only for the five components it names explicitly
  (`RemoteSettings`, `RemoteSetup`, `RemoteSetupEntry`, `RemoteHowItWorks`,
  `TaskPanel`). No branch of this launch imports `remote/Onboarding`. It was an
  orphan duplicating `RemoteSetup`'s checklist, and VERIFY H40 forbids orphans.
- **`SkillReviewPopup.tsx` was deleted — same standard of proof.** Its only
  importer in the repo was `OrchestrateWall.tsx:26` (base branch), the file this
  pack rewrote; every other mention is in `docs/` or a Swift parity comment. Its
  entry point was a row in the curator's review-inbox rail section, which D7
  removes. I also checked the IPC it fed (VERIFY M66): `curator:conv-data` is
  broadcast from exactly one place, `init.ts:3340`, inside the
  `curator:converse-start` handler — and only that popup ever invoked it.
  Nothing in main is now broadcasting into the void. `curatorListProposals` is
  an invoke/handle pair, not a broadcast, so dropping the caller strands nothing.
- **`TaskRow.tsx` and `AmbientIndicator.tsx`** were checked the same way:
  `TaskRow`'s only importer was `TaskPanel` (base `TaskPanel.tsx:12`), and
  `AmbientIndicator` had none at all.
- **Codex "Connect" now asks first.** `setup-status.ts` already warns in the
  step's detail text, but quitting somebody's app on one unconfirmed tap is not
  something a warning paragraph should have to carry alone.
- **The empty wall reads the trigger key.** SPEC §3.6 gives the exact phrase
  *"Press ⌥ and say what you want done."* — which is right for a right-option
  setup and **wrong for an fn one**. It reads `remoteKey` and says `fn` when
  that is the truth. A first-run screen naming the wrong key is the worst
  possible first instruction.
- **"Remote key" is gone from `OverlayApp.tsx` too.** An earlier draft of this
  file left those two strings alone, on the reasoning that the trigger's
  user-facing name is Settings copy and Pack B owns it. **That was wrong, and
  checking cost one grep:** `git grep -in "remote key"` across every pack branch
  returns matches in `renderer/remote/` and nowhere else. No other pack names
  this key; Settings does not use the phrase at all. So the last two rendered
  "hold the Remote key" strings were this pack's own, in a file this pack owns,
  and they now say **Orchestrator key** — the same words `TaskPanel` and
  `RemoteHowItWorks` use. The word "Remote" no longer reaches a user from
  anywhere in this directory.
- **No new tests.** `visibleOnWall` stayed inside `OrchestrateWall.tsx` rather
  than moving to a pure module beside `groupSections.ts`, because VERIFY C7/C8
  grep for it *in that file*. `groupSections.test.ts` is untouched and passes;
  the suite is 1400 pass / 0 fail, identical to baseline.

---

## The second pass — six defects the first run left behind

The first run of this pack was cut off by a session limit mid-repair. Everything
above survived review; these six did not, and are fixed.

### 1. Explanatory comments were tripping the checklist's own greps

Five `[auto]` assertions are worded as *"grep X → **no matches**"* (E20
`suggestion`, E22 `unmute memory`, I45 `type="checkbox"`, I46 `<select`, I51
`Remote trigger`). The features were genuinely gone — but the comments recording
their removal quoted the forbidden strings verbatim, so every one of those greps
still matched, and a checker following the letter of the checklist would have
five FAILs on code that is correct.

Only A1 carves out "comments explicitly about the old name"; the other five do
not. Rather than argue the intent five times, the comments now **describe** what
was removed instead of **quoting** it ("raw HTML checkbox inputs", "a native
dropdown element", "the curator's review-inbox rail section", "the
memory-footprint readout", "the orchestrator trigger-key toggle"). Same
documentation, no false positive. Every one of the five greps is now empty, and
A1's single remaining match is the one comment the assertion explicitly permits.

### 2. `RemoteSetup.tsx` still contradicted itself, in a comment

The whole point of that file's rewrite (VERIFY J52) was that only an **agent** is
required and the Chrome extension buys one lane. The body copy and the badge both
said so — and the section above the extension was still headed
`{/* ─── Required: the Chrome extension ─── */}`. J52 says to read the
surrounding copy and judge; the surrounding copy disagreed with itself. The
heading now says what the section is actually for, and says explicitly that it is
not marked required.

### 3. `capitalize` title-cased a sentence

`TaskPanel`'s door into a driver-backed app rendered `openInLabel(t)` — "open in
Codex" — under Tailwind's `capitalize`, which capitalises **every word**: "Open
In Codex". VERIFY G36 expects "Open in Codex". `first-letter:uppercase` capitalises
the sentence instead. (The wall is fine: it is all-lowercase mono by design.)

### 4. The Tasks page showed three of the four facts

SPEC §4.2 asks for four fields **always**: Agent · Model · Working directory ·
Permissions. The wall's `TicketFacts` had all four; the Tasks page's ticket had
three. Two surfaces rendering a ticket is exactly the drift `taskFacts.ts` exists
to prevent, and "the wall is the real ticket" is not a defence when both are on
screen in the shipped app. Permissions is now on both, with identical words and
the identical "current setting, not recorded per task" tooltip.

### 5. Two off-scale type sizes

`RemoteSetup`'s page title was `text-lg` (18px) and `RemoteSetupEntry`'s gear
glyph `text-base`; the D8 scale is `22 / 16 / 14 / 13 / 12.5 / 11 / 10`. Both are
`text-[16px]` now — 18px is not on the scale at all, and `text-base` happens to
equal 16 but hides that fact from anyone auditing by grep. Every size in every
light-theme file this pack owns is now a literal scale value.

### 6. `RemoteSettings` still carried the very bug this pack removed from `TaskPanel`

Its internal `page: 'settings' | 'how'` fallback, and why "one line for Pack A to
wire" was not an answer: see *Pack A landed mid-flight → §3* above. The state is
gone; the links are drawn only when they can drive the real selection.

### 7. This file claimed three things that were not true

- It said the coordinator had **merged** Pack A into this branch. Pack A is
  written but **not merged here** — `git log arpit/launch-readiness..HEAD` is two
  commits, neither of them Pack A's. The consequences it drew were right (Pack A
  mounts `TaskPanel`, so `TaskPanel` must not be deleted); the premise was wrong,
  and someone reading it would have expected an importer on this branch.
- It said the two "hold the Remote key" strings in `OverlayApp.tsx` were Pack B's
  copy to rename. They are not — see the smaller call above.
- It said the only off-scale type left in the directory was in `OverlayApp.tsx`.
  `OrchestrateWall.tsx` is off-scale too, deliberately — see the type-scale note
  above. The conclusion (every light-theme file is on scale) held; the sentence
  supporting it did not.

---

## Found while verifying, NOT this pack's to fix

Independent verification of this diff surfaced five things outside
`renderer/remote/`. They are recorded here because nobody else is looking for
them, and left alone because Pack C does not own the files.

**The first two are consequences of this pack's own change and are the most
important items in this file.** `visibleOnWall` was never one function. It is
copied into the main process **twice**, and both copies say in their own comments
that they mirror the renderer's — which, as of this commit, they no longer do.

0a. **The voice router's wall snapshot is now a different set from the wall.**
   `desktop/electron/remote/init.ts:1942-1955`. Its comment reads *"THE WALL for
   curation: everything the user can currently SEE (mirrors the renderer's
   visibleOnWall)"*, and it still carries **all three** rules this pack deleted:
   `if (kind === 'session') return true`, `DONE_FADE_MS = 15m`, `ATTN_FADE_MS =
   60m`. So a 46-day-old session is off the wall and still in the router's view,
   and a one-off that finished 20 minutes ago is on the wall and *not* in it.

   This matters more than a stale readout: that snapshot is what curation
   commands resolve against, and the comment records that a router which could
   not see the wall caused a real field bug on 2026-07-16 (a curation command
   misrouted into a junk task). The two sets have now been pulled apart in both
   directions. **Whoever owns `electron/remote/init.ts` (Pack F) should replace
   that block with the same one sentence the renderer uses — live now, or updated
   within 24h — and, ideally, move the rule into one module both sides import so
   this cannot happen a fourth time.** Pack C owns no main-process file.

0b. **The notch keeps a third copy**, `notch-controller.ts:723-731`, with the
   same sessions-never-fade + 15m/60m rules and the same "the wall's
   visibleOnWall" comment. The notch and the Electron wall now disagree about
   which tasks exist. **Pack D.**

1. **"Cockpit" is still on screen — in the notch.**
   `desktop/native-notch/Sources/unmute-notch/WallView.swift:75` renders
   `SectionLabel(text: "Cockpit")`. SPEC §2 says the word is deleted **from the
   product**; VERIFY A1 only greps `renderer/remote/*.tsx`, so this pack passes
   its own test while the word ships. **Pack D owns `native-notch/**`.** The IPC
   spelling (`setCockpit` / `CockpitPayload` in `notch-client.ts` and
   `IPC.swift:247`) is internal and may stay, but the rendered label may not.

2. **Suggestions and Projects survive in the notch's own wall.**
   `WallView.swift:264-272` renders `railSection("Suggestions · …")`, fed from
   `this.proposals` at `notch-controller.ts:957`; Projects likewise. Decision D7
   removes Suggestions from the product because the curator is off — this pack
   removed it from the Electron wall only. **Pack D / whoever owns
   `notch-controller.ts`.**

3. **The notch still sends `modelLabel: t.codexModelLabel`**
   (`notch-controller.ts:815`) rather than the new persisted `model`, so the
   notch's Codex model label is still blank after a restart. Pack F flagged this
   as a one-line fix for whoever owns that file; it is still open, and it is the
   same D6 story this pack just told on the card.
