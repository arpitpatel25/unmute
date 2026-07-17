# Skill Curator — design spec

> **Status: DESIGN APPROVED IN DISCUSSION — awaiting written review.**
> Branch: `arpit/skills-surfacing`. Supersedes the thinking record in
> `desktop/docs/skill-curator/` (docs 00–11) wherever they disagree; that
> directory remains as history, this document is the build contract.
>
> **One version. Production-ready. End to end.** There is no v1/v2 feature
> split. Every component below ships together. Some components (update
> detection, retirement data) start cold because their input data does not
> exist on day one — that is a warm-up, not a version boundary. The librarian
> shipped "complete" with a structurally dead promotion tier that nobody
> noticed for a month because the loop was never exercised end to end; this
> project does not repeat that.

---

## 1. What this is

An **observation layer over the user's Unmute-spawned Claude Code sessions**
that notices when a reusable procedure is worth keeping, drafts it as a real
Agent Skill, and **suggests** it. The user converses with the suggestion —
asks why, challenges it, edits it — and accepts or rejects. Accepted skills
land in the user's real library, invocable by name, **never auto-invoked**.
The curator then keeps its own skills current: it watches how they get used,
proposes updates when evidence accumulates, and records everything in a
changelog the user can always inspect.

**Skills are software for Claude Code.** Software rots without maintenance,
and nobody maintains skills because nobody is watching the sessions where the
evidence lives. Unmute is the watcher. That is the product.

### What it is NOT

- **Not the librarian.** The librarian caches app-operation paths (recipes)
  and auto-injects them into the doer — Unmute pulls the trigger. The curator
  produces user-facing skills the user pulls the trigger on. Opposite control
  models; they never merge. The librarian is **parked** by this project
  (§ 12), its code retained as reference.
- **Not an auto-executor.** The curator never invokes a skill, never lets the
  model auto-fire one it authored, and never edits a skill without the user
  accepting the edit.
- **Not a monitor of the user's own terminal work.** Signal source is
  Unmute-spawned sessions only (revisitable later; deliberately scoped).

---

## 2. Decisions of record

Settled in the 2026-07-17 design discussion. Each is a commitment; changing
one reopens the design.

| # | Decision |
| - | -------- |
| D1 | Signal = Unmute-spawned Claude Code sessions with `kind: 'session'` (persistent working sessions), any domain — code, media, Jira, docs. One-off errands are out: too small to yield a method. |
| D2 | Occurrences are counted per **pattern instance**, not per session. One long session may contain many occurrences; usage styles vary (many short sessions vs. few recycled ones) and must not skew detection. |
| D3 | Definition of a skill = **widened official**: a multi-step *procedure* that is (a) repeated, per the Claude Code docs' "keep pasting" criterion, **or** (b) a one-off that cost real exploration, per the engineering blog's "capability gaps" criterion. Both criteria are Anthropic's own; we adopt the union. |
| D4 | **Facts and preferences are not skills** (official: "a procedure rather than a fact") and are out of scope entirely. |
| D5 | **No confidence score.** Confidence exists to answer "may I act without asking?" — the curator always asks, so there is nothing to protect. What is tracked instead: invocation counts (usefulness), rejections (never re-offer), full per-skill usage data (enables future retirement). |
| D6 | Restraint = **deterministic cost triage (generous) → LLM judgment (strict)**. The gate controls cost, never precision; precision is the model's job, using the librarian's battle-tested filter language. |
| D7 | Skills land in **global** `~/.claude/skills/<name>/SKILL.md`. Never project-level — a repo's `.claude/skills/` is inside the user's git working tree, and Unmute must never write into their source. Global is user config: unversioned, invisible to repos, and it covers scratch-dir sessions that have no repo at all. |
| D8 | Every curated skill carries **`disable-model-invocation: true`**: present, listed, invocable by `/name` — and the model can never auto-fire it, its description is never loaded into context (zero context cost at any library size). User/plugin/built-in skills are untouched and keep both invocation paths. |
| D9 | **Clean names, no prefix.** Provenance and changelog live in an Unmute-owned ledger; a name can carry a label but never a history. |
| D10 | **The curator touches only skills it authored.** It never reads-to-judge, edits, proposes edits to, overwrites, or collides with any skill it did not create. Enforced by ledger lookup, not by naming convention. |
| D11 | Sweep cadence: **twice-daily ceiling, configurable from day one**, material-gated (fires only when new checkpointed work cleared triage), **catch-up-on-wake** (persisted `lastSweepAt`, checked at launch + short interval) — never a naive `setInterval` (the gardening timer's exact bug: resets on relaunch, never fires unless the app stays up 24 h). |
| D12 | Suggestion surface = **inbox sections in the existing skill rail** (`OrchestrateWall.tsx`) + **center popup** for review. The popup is a conversation (terminal-backed), not a yes/no dialog. |
| D13 | Proposals are **evidence-carrying from day one** (§ 7). The conversation surface is only buildable if evidence is captured at detection time; retrofitting it means rebuilding the detector. |
| D14 | Tap-to-invoke: only into an **open running task's terminal**, and it **writes `/name` without pressing Enter**. No open task → no tap-invoke. The user always submits. |
| D15 | **No retirement action yet** — but all data retirement will need (runs, lastUsed, full history) is recorded from day one. |
| D16 | Build order (not release order): **detector first**, tuned against ~341 MB of historical Unmute sessions via a dev-only calibration harness, then the loop outward. The deliverable is the complete system. |

---

## 3. Architecture

```
                     ┌─ Unmute main process ────────────────────────────────┐
                     │                                                      │
 session transcripts │  Curator (curator.ts)                                │
 ~/.claude/projects/ │  ├─ scheduler: catch-up-on-wake + interval check     │
        │            │  ├─ TRIAGE      deterministic, no LLM   (curator-triage.ts)
        ▼            │  ├─ REDUCE      trace-reducer → file per delta       │
   [sweep fires]     │  ├─ DISTILL     one CC session per session-delta     │
                     │  ├─ ACCUMULATE  candidates.json  (cross-sweep memory)│
                     │  ├─ SYNTHESIZE  one CC session, sees everything      │
                     │  └─ proposals/  evidence-carrying JSON               │
                     │                                                      │
                     │  Curator store  ~/.unmute/remote/curator/            │
                     │  ├─ cursor.json      per-session sweep watermarks    │
                     │  ├─ candidates.json  accumulated pattern occurrences │
                     │  ├─ proposals/       pending + resolved proposals    │
                     │  ├─ ledger.json      provenance + full changelog     │
                     │  ├─ rejections.json  what was declined, and why      │
                     │  ├─ feedback.json    user voice feedback on skills   │
                     │  └─ traces/          reduced transcripts (pointers)  │
                     │                                                      │
                     │  Writer (curator-writer.ts)                          │
                     │  └─ accept → ~/.claude/skills/<name>/SKILL.md        │
                     │       (collision-guarded, ledger-first)              │
                     └──────────────────────────────────────────────────────┘
                                ▲                          │
                                │ accept / reject / edit   │ sections + popup
                     ┌──────────┴──────────────────────────▼───────────────┐
                     │  Rail (OrchestrateWall.tsx)                          │
                     │  ├─ SUGGESTIONS section  (new skill / skill edit)    │
                     │  ├─ UNMUTE SKILLS section (curated, accepted)        │
                     │  └─ existing skills list (user/plugin — read-only)   │
                     └──────────────────────────────────────────────────────┘
```

All LLM stages are **one-shot interactive Claude Code sessions on the user's
subscription** — the librarian/router billing model. No API keys, no managed
LLM spend, no per-token cost. Curator sessions are invisible workers like the
librarian and router: they never appear on the wall and never touch the wall
(the MCP invariant — sessions may ADD work to the wall, never TOUCH it — is
preserved because curator sessions are host-spawned analysis sessions, not
wall tasks, and hold no wall-mutating capability).

---

## 4. The detection pipeline

### 4.1 Scheduler (D11)

- Persist `lastSweepAt` in the curator store. On app launch and on a cheap
  interval check: if `now - lastSweepAt ≥ sweepIntervalMs` (default 12 h,
  a runtime-config knob) **and** the material gate passes, fire a sweep.
- **Material gate:** at least one `kind: 'session'` task has, since its last
  sweep watermark, (a) reached a checkpoint — `ready`, parked warm, `done`,
  or killed — and (b) grown its transcript past the triage bar for the new
  delta. No material → no sweep, at any interval. A quiet day costs nothing.
- Single-flighted; a sweep never overlaps another. Never blocks the UI, a
  session, or an utterance. Skipped while an utterance is in flight.

### 4.2 Cursor + delta (the "live session" problem)

Persistent sessions may live for days and never end. Therefore:

- Per session, `cursor.json` records: transcript path, **line offset** swept
  through, `lastSweptAt`, sweep count. Transcripts are append-only JSONL, so
  a line offset is a stable watermark.
- A sweep processes the **delta** (offset → current end) plus a **lookback
  overlap** (a bounded tail of already-swept lines, default ~200) so a
  procedure straddling the boundary is not cut in half. The accumulator
  dedupes occurrences that appear in two sweeps' overlap via occurrence keys
  (§ 4.5).
- **The cursor advances only on sweep success.** A crashed sweep re-reads its
  delta; it never silently skips work.
- Sessions with in-flight work are swept only up to their last checkpoint's
  transcript position — work in progress is not evidence yet (the librarian's
  rule: never store a procedure from an incomplete run).

### 4.3 Triage (deterministic, no LLM)

Answers one dumb question: **"is this delta worth an LLM's attention?"**
Computed directly from the JSONL, no model:

- wall-clock span of the delta
- tool-call count and distinct-tool count
- error count, and **error→recovery pairs** (the struggle tell)
- user-turn count (corrections imply iteration)
- terminal outcome of the covered span (checkpointed success vs. abandoned)

A delta clears if it was *expensive and reached a working state*. Thresholds
are code constants tuned by the calibration harness (§ 10).

Two rules, in the spec on purpose:

1. **Over-inclusive by design.** A stingy gate silently destroys real skills
   and the failure is invisible. When in doubt, pass it through.
2. **Triage controls cost, never merit.** It must never encode "is this
   skill-worthy" heuristics. Merit is the model's job, always.

### 4.4 Reduce

`reduceTranscript` (trace-reducer.ts) already produces the right narrative:
tool-call story, errors always kept, empty-ok results dropped, repeats
collapsed to `(xN)` — repetition inside a session is visible for free. One
change of use: **the reduced trace is written to a file**
(`curator/traces/<taskId>-<sweepId>.txt`) **and passed by pointer**, never
inlined. The 8 000-char inline cap is fine for grading an errand and far too
lossy for extracting a method from a 44 MB session; the distill session
`Read`s what it needs (progressive disclosure).

### 4.5 Distill (per-session LLM stage)

One Claude Code one-shot per session-delta that cleared triage. Parallelable,
cacheable, idempotent per (session, delta). Its job, and only its job:

> Read this reduced trace. Report every **multi-step procedure** that
> occurred: what it accomplishes, its semantic skeleton (preconditions →
> ordered steps by intent → definition of done → gotchas discovered), how
> many times it occurred in this delta, and whether it involved visible
> struggle (errors, backtracking, re-derivation). Report facts/preferences
> **nowhere** — they are not skills (D4).

Output: structured JSON per procedure, with an **occurrence key** — a stable,
content-derived slug (e.g. normalized verb-object of the skeleton) that lets
the accumulator match "the same procedure" across sweeps and sessions without
an LLM. Also reported per procedure: any invocation of a curated skill
adjacent to it (evidence for the update detector, § 8).

### 4.6 Accumulate (cross-sweep memory)

`candidates.json`: per occurrence key — total occurrences, per-session
break-down `{taskId, sweepId, count, at, tracePointer}`, first/last seen.
Monday's sighting plus Thursday's sighting equals two occurrences **only
because this file remembers Monday**. Without it, repetition detection would
be confined to a single sweep window and the "keep pasting" criterion would
effectively never fire. Repetition becomes ledger arithmetic, not something a
model rediscovers from scratch each run.

### 4.7 Synthesize (the judge — one LLM stage per sweep)

One Claude Code one-shot that sees, together:

- all distill outputs from this sweep,
- the full accumulator (cross-session, cross-sweep counts),
- the **curated-library index** (names + descriptions of skills the curator
  authored — so it can say *covered → no-op* or *covered-but-incomplete →
  update proposal*),
- `rejections.json` **with reasons** (never re-offer what was declined; a
  reasoned rejection also teaches the bar),
- `feedback.json` (user voice feedback awaiting action, § 8).

It applies the librarian's proven filter, inherited nearly verbatim because
it produced 22 sane artifacts and zero junk: capture only what is
**CONSEQUENTIAL + NON-OBVIOUS + DURABLE**; *"the default is NO change; bloat
is the enemy; when unsure, DON'T."* Then the two admission criteria (D3):
repetition (accumulator count ≥ threshold) **or** expensive one-off (distill
reported real struggle and the accumulator confirms it was not trivial).
Repetition is also a **queue booster**: a repeated procedure outranks a
single expensive one.

Output: zero or more **proposals** (§ 7). Zero is the expected common case.

---

## 5. The artifact

### 5.1 SKILL.md template (the curator's authoring contract)

```markdown
---
name: <verb-object, 2-4 words, clean, no prefix>            # D9
description: <what it does + when to reach for it, 1-2 sentences>
disable-model-invocation: true                              # D8 — always
origin: unmute                                              # pending the unknown-key test (§ 11)
---

# <Name>

**Goal** — what "done" means, in one line.

**When to use** — the situations that call for this skill.

**Preconditions** — what must be true before starting (accounts, tools,
MCPs, state). Semantic, never environmental one-offs.

**Steps** — ordered, by intent ("open compose → paste → verify recipient"),
never raw coordinates/tab-ids/pixel positions (the librarian's distill rule).

**Verify** — how to confirm it worked.

**Gotchas** — the non-obvious traps this procedure was observed hitting,
each with its workaround. This section is where updates usually land.
```

Rules: under 500 lines (official guidance); long reference material goes in
sibling files loaded on demand (progressive disclosure); the body is written
to be *executed by Claude Code*, not read by a human — utilitarian, no prose
padding. The template is versionable: an update proposal may touch any
section, and Gotchas is expected to grow.

### 5.2 The writer (collision-guarded, ledger-first)

On accept:

1. Validate the name against **both** the curator ledger and a filesystem
   check of `~/.claude/skills/`. A name that exists and is **not** in our
   ledger is a hard stop — never overwrite, never "merge", surface the
   conflict in the popup for a rename (D10).
2. Append the ledger entry **first**, then write
   `~/.claude/skills/<name>/SKILL.md` atomically (tmp + rename). Record a
   **content hash** in the ledger.
3. If the user edited the draft before accepting, the ledger records
   **co-authorship** (`user-edited-accept`), and the stored diff is
   proposed-vs-accepted.

Hand-edit drift: whenever the curator later reads one of its own skills, it
re-hashes. Hash mismatch ⇒ the user modified it by hand ⇒ the ledger marks it
`user-modified`; future update proposals diff against the *current* content
and say so. The curator never reverts a hand edit.

### 5.3 Provenance ledger + changelog (`ledger.json`)

Append-only entries:

```
{ at, skill, action: proposed | created | updated | user-edited-accept |
  rejected | user-modified-detected,
  proposalId?, sweepId?, contentHash?, diff? }
```

This is the answer to "what did Unmute suggest, create, update, and what
changed, when" — the user's stated control-and-visibility requirement. The
rail reads it for origin badges; the popup reads it for history.

---

## 6. Surfaces & interaction

### 6.1 The rail (OrchestrateWall.tsx)

The skill rail already renders (top-5 + expander, tooltips, pinning, fed by
`remote:list-skills`). It gains two sections, always glanceable in cockpit
view and split view, hidden only in a task's full view:

- **SUGGESTIONS** — pending proposals, each labeled `new skill` or
  `skill edit`, with a count badge so the section is a presence signal, not a
  destination you must remember (an inbox, not doc 03's dead-on-arrival
  dashboard). Empty section collapses to nothing.
- **UNMUTE SKILLS** — curated, accepted skills, ranked by the existing
  earned-trust sort (runs → recency), origin-badged from the ledger. The
  existing user/plugin skill list stays as is, read-only to the curator.

`remote:list-skills` gains provenance awareness: entries matching the curator
ledger are flagged so the renderer can section them.

### 6.2 The review popup (the conversation, D12/D13)

Tapping a suggestion opens a **center popup**:

- Renders the draft SKILL.md (or, for an edit: the diff, the rationale, the
  triggering evidence, and **affected sessions** — who invoked the old
  version, from the usage ledger: the user's "what are the consequences").
- **Evidence panel**: occurrence count, contributing sessions (name/intent/
  when), rationale — all from the proposal, loadable down to trace excerpts
  via pointers.
- **A terminal-backed conversation**: the popup attaches a Claude Code
  session primed with the proposal + evidence pointers. The user asks *why
  this skill*, *why this edit*, *what happens if I reject*, or instructs
  *make it stricter about X* — and the session revises the draft in place.
- Buttons: **Accept** (write it — § 5.2), **Reject** (requires-nothing, but
  captures an optional reason into `rejections.json`), **Cancel** (close,
  proposal stays pending). A proposal leaves the inbox only by accept or
  reject.

### 6.3 Invocation (three paths, user always pulls the trigger)

- **Typed**: `/name` in any Claude Code session — native, free (D8).
- **Tap** (D14): only when a running task's terminal is open in the cockpit;
  tapping a skill writes `/name` into that terminal **without Enter**. The
  user submits. No open terminal → skills are not tappable.
- **Voice**: "use my PR-review skill …" — the router resolves the fuzzy
  spoken name against the rail vocabulary (the decision gains an optional
  `skill` field, validated at parse against the known list exactly like
  `surface`/`dir`; an unknown or fuzzy-miss resolves to no skill, never a
  guess). The dispatch payload for the target task then leads with the
  resolved `/name` invocation. The router only ever *names* a skill the user
  asked for — Unmute still never chooses one unprompted.

### 6.4 Voice feedback (update trigger #3)

"The PR-review skill keeps missing X" is not work, meta, or wall curation —
the router's species ladder gains a **SKILL-FEEDBACK** route: nothing is
spawned; the utterance (with the resolved skill name) is appended to
`feedback.json`. The next sweep's synthesize stage sees it as first-class
update evidence. Feedback on a skill the curator does not own is
acknowledged to the user but never acted on (D10).

---

## 7. Proposal format (the contract everything hangs on)

```jsonc
{
  "id": "prop_…", "sweepId": "sweep_…", "proposedAt": "…",
  "kind": "create" | "update",
  "draft": { "name": "…", "description": "…", "body": "<full SKILL.md body>" },
  "evidence": {
    "occurrences": 3,
    "sessions": [ { "id": "…", "intent": "…", "at": "…",
                    "tracePointer": "traces/<file>#<offset>" } ],
    "firstSeen": "…", "lastSeen": "…",
    "struggle": { "errors": 14, "recoveries": 5, "wallClockMin": 96 }
  },
  "rationale": "why the judge believes this clears the bar",
  // update only:
  "targetSkill": "…", "diff": "<unified>", 
  "triggeringEvidence": [ "…pointers…" ],
  "affectedSessions": [ { "id": "…", "invokedAt": "…" } ],
  "resolution": null | { "action": "accepted"|"rejected", "at": "…",
                         "userEdited": true|false, "reason": "…" }
}
```

Evidence is captured **at detection time** and stored by **pointer**, not
inline — proposals stay small, and the conversation loads receipts on demand.
This format is deliberately richer than accept/reject needs today, because
the conversation surface consumes it and cannot be retrofitted (D13).

---

## 8. Update detection (built now, fires when material exists)

Three triggers, three detectors, one output shape (an `update` proposal):

1. **Post-invocation friction** — `skill-usage.ts` already extracts every
   `Skill` tool_use per transcript, so sweeps know which sessions invoked a
   curated skill. Distill flags what happened *around* the invocation: extra
   steps appended, corrections, failure. Accumulated friction ⇒ the skill has
   a gap or went stale.
2. **New findings** — synthesize matches new candidate procedures against the
   curated-library index; overlap-but-better ⇒ propose the diff rather than a
   duplicate (this is also the anti-sprawl valve).
3. **User voice feedback** — § 6.4, first-class evidence, no observation
   needed.

Cold start is expected and honest: on day one no curated skills exist, so
this subsystem idles — fully built, warm the moment the first skill lands.
Same for retirement data (D15): runs/lastUsed accrue from the first
invocation via the existing ledger; the retire *action* is future work, its
data is not.

---

## 9. Errors & invariants

- Fire-and-forget everywhere: the curator never blocks the UI, a session, an
  utterance, or app shutdown. Any failure ⇒ zero proposals + a log line.
  Never a partial or corrupt proposal.
- Single-writer: one sweep at a time; all store writes are serialized
  (`skill-usage.ts`'s write-chain pattern) and atomic (tmp + rename).
- Cursor advances only on success (§ 4.2). Malformed JSONL lines are skipped
  (transcripts can be mid-write; the reducer already tolerates this).
- The writer's hard invariants: never write a name not in our ledger (D10);
  never write outside `~/.claude/skills/<name>/`; ledger-first, then file;
  every write carries `disable-model-invocation: true` (D8).
- The wall is never touched; curator sessions never appear on it (§ 3).

## 10. Testing & calibration

- **Unit tests** (node:test, matching `skill-usage.test.ts` conventions):
  triage metrics over fixture transcripts; cursor/delta arithmetic incl.
  lookback overlap and dedup; accumulator counting across simulated sweeps;
  occurrence-key stability; proposal validation; writer collision guard +
  atomicity + ledger-first ordering; scheduler catch-up logic with a fake
  clock.
- **Calibration harness** (dev-only script, never ships): runs
  triage→reduce→distill→synthesize over the ~239 historical Unmute session
  dirs in `~/.claude/projects` (excluding the 189 `*-librarian` dirs;
  missing `meta.json` on purged tasks ⇒ duration/size proxy for the
  session-kind filter), writing proposals to a file and touching nothing
  else. This is where triage thresholds and the judge prompt get tuned until
  the proposal log reads "yes, I'd take these" — before any suggestion ever
  reaches the inbox. The detector is the only component that can fail
  subtly; it is validated before the loop is assembled around it (D16).
- **End-to-end proof before ship**: at least one real accept must travel the
  whole loop — sweep → proposal → popup → edit → accept → file on disk →
  `/name` invocation in a real session → invocation credited in the ledger.
  (The librarian lesson: a loop never exercised is a loop that hides its
  dead tier.)

## 11. Pre-build verifications (cheap, do first)

1. **Unknown frontmatter key**: create a local skill with `origin: unmute`,
   confirm Claude Code parses/lists/invokes it. Docs are silent on unknown
   keys. If it breaks: provenance stays ledger-only (content hash still
   covers drift detection); the design does not depend on the stamp.
2. **`disable-model-invocation` end-to-end**: confirm a flagged skill is
   absent from model context, absent from auto-selection, and still invocable
   via `/name` — on the Claude Code version Unmute actually spawns.
3. **`/name` via injected text**: confirm writing `/name …` into a running
   session's PTY (without Enter, then user-Enter) actually triggers the
   skill, not a literal text paste. (D14 depends on it.)

## 12. Librarian parking (part of this project)

- The task→librarian handoff and the gardening sweep are disabled behind the
  existing settings gate (`librarianWriteEnabled: false` + no handoff spawn),
  so no librarian sessions are spawned at all. Code, recipes, and prompts
  stay on disk untouched — the reference implementation. One setting
  reverses it.
- Recorded for honesty: the librarian's graduated tier was structurally dead
  (skills copied as loose `.md`; Claude Code only discovers
  `<name>/SKILL.md` directories) — its "0 invocations" was a broken socket,
  not a verdict on the idea. Its founding premise (cache expensive
  exploration) is exactly what the curator generalizes.

## 13. File map

| File | Role |
| ---- | ---- |
| `electron/remote/curator.ts` | scheduler, sweep orchestration, store I/O |
| `electron/remote/curator-triage.ts` | deterministic metrics + gate (pure, tested) |
| `electron/remote/curator-prompts.ts` | distill + synthesize prompt builders (pure) |
| `electron/remote/curator-writer.ts` | accept path: collision guard, ledger, SKILL.md write |
| `electron/remote/curator-store.ts` | cursor/candidates/proposals/ledger/rejections/feedback (pure, tested) |
| `electron/remote/router.ts` | `skill` field on decisions; SKILL-FEEDBACK species |
| `electron/remote/init.ts` | wiring: curator init, IPC (`curator:*`), rail provenance |
| `renderer/remote/OrchestrateWall.tsx` | SUGGESTIONS + UNMUTE SKILLS sections |
| `renderer/remote/SkillReviewPopup.tsx` | the center popup: draft/diff/evidence/conversation |
| `scripts/curator-calibrate.ts` | dev-only harness (never ships) |

## 14. Out of scope (explicit)

- The user's own terminal sessions as signal (D1 — revisit deliberately).
- Facts/preferences → CLAUDE.md suggestions (D4 — a different product).
- Retirement *action* (D15 — data collected, action deferred).
- Editing/curating skills the curator did not author (D10 — never).
- Any auto-invocation of curated skills, by any component, ever.
