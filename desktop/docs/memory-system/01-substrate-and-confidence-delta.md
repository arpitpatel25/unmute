# Memory System — Delta Doc 1: Substrate & Confidence Layer (Build Steps 1–2)

> **Status:** working document. Companion to the *Conversation Handoff* (the reasoning)
> and the *Complete Specification* (the resolved design). This doc is the **seam**: for
> every existing mechanism it states *stay / change / replace / extend*, **how**, and
> **which currently-provided guarantee must survive the change**. Every claim is cited to
> `file:line` in the real source as of this branch (`arpit/unmute-memory-system`).
>
> **Scope:** build steps **1 (substrate + injection)** and **2 (librarian read-only)** only.
> Router-mode, freshness, and gardening are stubbed in §9 and fleshed out when we reach them.
> Numbers (thresholds, windows) are starting values to calibrate in step 2, not constants.

All paths below are under `desktop/electron/remote/` unless noted.

---

## 0. The single most important finding

**This is not greenfield.** A production-grade skeleton of all three components already
exists: executor (`pty-session.ts`), a serialized single-writer librarian (`librarian.ts`),
an LLM new-vs-continue router (`router.ts`), a universal status-file state machine
(`status-file.ts`), and dispatch-time injection of skills + profile (`skills.ts`,
`task-manager.ts`). The memory spec is therefore **additive** — confidence metadata, a
nursery/skills split, surface namespacing, a JSONL-reduced trace, and a constitution —
layered onto a proven base. The architecture is the same shape the spec describes, which is
strong confirmation the design is right.

Two reframes the real code forces on our earlier "settled" conclusions (flagged honestly):

1. **Auto-fire is achieved by *copying* skills into each task's `cwd/.claude/skills/`
   (`skills.ts:36-58`), NOT by living in `~/.claude/skills/`.** Our earlier idea of making
   the memory-root `~/.claude/` is **obsolete and should be dropped.** Memory-root stays at
   `~/.unmute/remote/`. The nursery-vs-graduated distinction maps cleanly onto *"is it copied
   into `.claude/skills/` (auto-fires) or injected deliberately as hedged text (does not)."*

2. **The JSONL transcript is resolvable without capturing a session-id**, because each task
   runs in its **own unique cwd** (`task-manager.ts:223`) with exactly one session
   (`init.ts:383-386`). The per-task isolation already solved the plumbing problem we feared.

---

## 1. Executive delta summary

| # | Spec concept | Today (cited) | Delta type | Lands in |
|---|---|---|---|---|
| A | Confidence gradient (nursery vs graduated, frontmatter counters, phrasing-by-confidence) | Flat shared `skills/`, all equal, all copied in (`skills.ts:1-13,36-58`) | **NEW** (core) | 1–3 |
| B | Surface namespacing (`recipes/gmail/…`) | Single flat folder, no surfaces (`skills.ts:23-25`) | **NEW** (additive convention) | 1 |
| C | Nursery deliberate hedged injection | Only auto-fire copy of all skills (`skills.ts:36-58`) | **EXTEND** dispatch | 1 |
| D | Librarian reads reduced JSONL + recipe-vs-trace divergence → promote/demote | Reads 4000-char **PTY tail** (`task-manager.ts:146-155,489`), autonomous curate, **no** confidence movement (`librarian.ts:195-262`) | **REPLACE** feed + **EXTEND** logic | 2 |
| E | Reducer over JSONL | `cleanTranscriptTail()` exists for PTY only (`task-manager.ts:146-155`) | **NEW** | 2 |
| F | Trigger on done **OR** failure-with-recipe | Triggers on `done` **only** (`task-manager.ts:479-491`); `failed` never submits (`task-manager.ts:506-519`) | **CHANGE** | 2 |
| G | Injected-recipe list recorded per run | Not tracked | **NEW** (Task field) | 1 |
| H | Divergence inferred, not self-reported | Doer writes optional `recipe.json` hint the librarian may read (`dispatch-prompt.ts:36-38`, `contract-text.ts:171-175`) | **DEPRECATE-to-soft** | 2 |
| I | Managed vs raw mode | No mode; all tasks identical | **NEW** | 4 (stub §9) |
| J | Freshness + gardening | None | **NEW** | post-3 (stub §9) |

---

## 2. Ground truth — what exists today

### 2.1 On-disk stores & layout

- Shared library: `sharedSkillsDir()` → `~/.unmute/remote/skills/` (`skills.ts:23-25`). The
  **single source of truth**, librarian is the only writer.
- Auto-discovery sink: `sessionSkillsDir(cwd)` → `cwd/.claude/skills/` (`skills.ts:28-30`).
- `installSkillsIntoCwd()` copies **every** entry of the shared dir into the task's
  `.claude/skills/` at dispatch (`skills.ts:36-58`) — flat, all-or-nothing, **no surface or
  relevance filtering.**
- Profile: `userProfilePath()` → `~/.unmute/remote/profile.md` (`skills.ts:77-79`);
  `installProfileIntoCwd()` writes `cwd/PROFILE.md` only if non-empty (`skills.ts:92-103`).
- `skillsIndex()` parses only `name` + `description` from frontmatter via
  `/^description:\s*(.+)$/m`, tolerating both a `SKILL.md`-in-dir and a flat `.md`
  (`skills.ts:108-126`).
- Per-task scratch tree: `~/.unmute/remote/<userKey>/<taskId>/` holding `status.json`,
  `recipe.json`, `meta.json`, `CLAUDE.md`, `.claude/skills/`, hook markers, and a
  `librarian/` subdir (`task-manager.ts:223-255`, `librarian.ts:127-130`).
- Design note in source: *"recipes ARE skills (one system) … retrieved by Claude Code's
  native skill auto-discovery"* (`skills.ts:1-13`). **This is exactly the assumption the
  confidence layer changes:** not all recipes should auto-fire.

### 2.2 Dispatch / injection path (`task-manager.ts:221-327`)

Ordered sequence inside `dispatch()`:
1. mint `id = randomUUID()`; `dir = baseDir/userKey/id`; `statusPath = dir/status.json`;
   `recipeScratchPath = dir/recipe.json` (`:222-225`).
2. `scaffoldStatusFile` (`:240`) → `meta.json` receipt (`:244`) → seed heartbeat (`:247`).
3. `installContract(dir)` (`:248`) → `installHooks(dir)` (`:253`) →
   **`installSkillsIntoCwd(dir)` (`:254`)** → **`installProfileIntoCwd(dir)` (`:255`)**.
4. `executorFactory()` spawn (`:257-269`), `isReady()` (`:270`), `settleRepl` past
   folder-trust (`:285-292`).
5. **`buildDispatch({ intent, statusPath, recipeScratchPath })` typed to stdin (`:295-297`)**
   — the terse per-task payload (`dispatch-prompt.ts:30-43`); the stable contract is the
   auto-loaded `CLAUDE.md`, never re-typed.
6. submit-confirm Enter (`:305-309`) → `startPolling` (`:311`) → `verifyDispatch` self-heal
   (`:321`).

**Injection today = steps 3 (copy skills + profile into cwd) + 5 (typed payload).** There is
no surface scoping, no confidence hedging, and no record of *what* was injected.

### 2.3 Librarian (`librarian.ts`)

- Entry `submit(RecipeSuggestion)` (`:94-98`); serialized `drain()` single-writer
  (`:101-116`) — race-free by construction.
- `runOne()` (`:119-190`): own `cwd/librarian` working dir + status file (`:127-130`),
  `installContract` (`:130`), loads `skillsIndex` + `readUserProfile` (`:132-133`), spawns its
  **own** executor (pinned **opus**, `--dangerously-skip-permissions`, **no** chrome, no
  sandbox — `init.ts:516-529`), `settleRepl`, types `buildPrompt`, polls its own status until
  `done|failed` with a 20s nudge and a 5-min backstop (`:169-187`).
- `RecipeSuggestion` shape (`:27-45`): `taskId, intent, scratchPath?, cwd, summary?, detail?,
  category?, transcript?`.
- The fed `transcript` is `cleanTranscriptTail(outputBuffers)` — **ANSI-stripped last 4000
  chars of PTY scrollback** (`task-manager.ts:146-155, 489`).
- `buildPrompt()` charter (`:195-262`): two stores (profile + skills); capture only durable
  knowledge; hard bias to no-op; consolidate over fragment; write status `done` with a
  one-line summary. **No confidence, no nursery, no promotion/demotion, no per-surface
  placement.**

### 2.4 Status & trigger

- `StatusPayload` (`status-file.ts:64-75`): `schema_version, state, updated_at, step,
  category, result, error, question, recipe_suggestion`. `recipe_suggestion` is a pointer
  `{present, scratch_path}` (`:59-62`).
- `TaskState = processing|needs-user|done|failed` (`:27`); UI adds `stuck`
  (`task-manager.ts:46`).
- **Librarian fires only on `done`** (`task-manager.ts:467-491`). The `failed` branch
  (`:506-519`) parks warm and detects MCP gaps but **never submits to the librarian** — so a
  task that **failed *because* an injected recipe was wrong is invisible to memory today.**
  This is the single most important behavioral gap for the confidence loop (delta F).

### 2.5 Transcript / JSONL reality

- No session-id capture anywhere; resume is cwd-scoped `--continue` (`init.ts:383-388`,
  `task-manager.ts:795-798`).
- Each task owns one cwd with one session ⇒ exactly one JSONL in that project bucket.
- The librarian is fed PTY scrollback, **not** the structured JSONL. The lossy 4000-char tail
  is the weakest link for divergence inference (delta D/E).
- Source explicitly avoids touching `~/.claude` (`task-manager.ts:126`); Claude manages its own
  transcript lifecycle (so we *read* it fresh at done-time, never depend on old traces).

### 2.6 Spec invariants the existing system ALREADY satisfies (must not regress)

These are wins to **preserve**, not build:
- **Single-writer librarian, race-free** (`librarian.ts:101-116`). → Spec §10 "Only the
  librarian writes."
- **Off the critical path / fire-and-forget** — user has `done` before curation runs
  (`task-manager.ts:479-491`). → Spec §3.
- **Conservative, bias-to-no-op** charter (`librarian.ts:210-211,246-247`). → Spec §5.1(1).
- **Orchestration always-on & mode-agnostic** — registry, status, overlay, router treat all
  tasks identically (`task-manager.ts`, `init.ts:594-625`). → Spec §0a (already half-true).
- **Billing guard** — `ANTHROPIC_*` env stripped on every spawn (`pty-session.ts`, per
  agent analysis) so it stays on the subscription, never API keys. → hard product invariant.
- **Idempotent contract upsert** via BEGIN/END markers (`contract-text.ts:9-10`).
- **Atomic status writes + tolerant reader** (`status-file.ts:46-51 contract, 107-127 read`).

---

## 3. Target substrate (steps 1–2)

### 3.1 New on-disk layout (memory-root stays `~/.unmute/remote/`)

```
~/.unmute/remote/
  profile.md                      # unchanged location; cross-surface USER facts only
  recipes/                        # NURSERY — low/medium confidence. NEVER copied to cwd.
    gmail/
      inbox-sweep.md              #   injected deliberately, hedged, into the dispatch payload
    google-sheets/
  skills/                         # GRADUATED — high confidence. Copied to cwd/.claude/skills (auto-fires).
    gmail/
    google-sheets/
  <userKey>/<taskId>/             # unchanged per-task scratch tree
```

- **Flat by surface**, one level. Surface = the app/tool operated on (`gmail`, not
  `browser`/`google-suite`). Depth appears only on demonstrated folder overflow (gardening,
  §9) — never designed up front.
- **`skills/` keeps the existing semantics** (copied in → native auto-fire) but gains a
  surface subfolder and confidence frontmatter.
- **`recipes/` is new**: the nursery. It is **never** copied into `.claude/skills/` (so it
  can't auto-fire with unearned authority); it is injected as hedged text by the dispatch
  step (§4.2).
- **Migration of today's flat `~/.unmute/remote/skills/*.md`** → see Open Decision OD-1.

### 3.2 Recipe frontmatter schema (every recipe, both tiers)

```markdown
---
name: gmail-inbox-sweep
surface: gmail                     # the flat namespace; matches the folder
description: >                     # WHEN to load — literal trigger phrases. Drives auto-fire
  check my email for events, scan my inboxes, any replies about X
confidence: low                    # low | medium | high. MUST mirror folder (low/med⇒recipes/, high⇒skills/)
runs_confirmed: 0
runs_contradicted: 0
created: 2026-06-27T00:00:00Z
last_used: 2026-06-27T00:00:00Z
last_verified: 2026-06-27T00:00:00Z
---

## Invariants (hard — never skip)        # durable structural facts (eligible to capture)
## Defaults (soft — override w/ reason)   # priors
## Procedure (stable spine — adapt)       # exploration skeleton, NOT a script
## Definition of done                      # incl. forced coverage reporting ("checked N/N")
## Known failure modes
```

- **`description`** is the only field the current `skillsIndex()` reads (`skills.ts:108-126`);
  it keeps working unchanged for auto-fire. New fields (`confidence`, counters, `surface`,
  timestamps) are **additive** and ignored by anything that doesn't look for them.
- **Confidence lives in two places by design:** the `confidence` field (system bookkeeping —
  folder, thresholds, gardening) and the **prose stance** of the body (executor comprehension).
  The librarian keeps them in sync (§5).
- **`name` + `description`** preserve the OpenClaw format Claude already auto-discovers
  (`skills.ts:1-13, 236` per agent analysis).

### 3.3 The nursery-vs-graduated injection mechanic (the key reframe)

| Tier | Folder | How it reaches the executor | Auto-fires? | Authority |
|---|---|---|---|---|
| Graduated | `skills/<surface>/` | **copied** into `cwd/.claude/skills/` at dispatch (existing `installSkillsIntoCwd`, extended to read the surface subtree) | Yes (native) | Earned |
| Nursery | `recipes/<surface>/` | **body text prepended** to the dispatch payload, prefixed with a confidence stance | No | Quarantined |

Promotion = **`mv recipes/<surface>/x.md → skills/<surface>/x.md`** + rewrite phrasing to an
invariant stance + set `confidence: high`. Demotion = the reverse `mv` + re-hedge. Confidence
change is a file moving between two folders. (Mechanism in step 3; steps 1–2 only *read* and,
in step 2, *log* the intended move.)

---

## 4. Per-subsystem deltas

Format per row: **Preserve** (the guarantee that must survive) · **Change/Add** (exact
mechanic) · **Touch** (file:line).

### 4.1 `skills.ts` — store + injection helpers

- **Add** `recipesDir(baseDir)` → `~/.unmute/remote/recipes/` and surface-aware variants
  (`skills/<surface>/`, `recipes/<surface>/`). *Touch:* new exports beside `sharedSkillsDir`
  (`skills.ts:23-25`).
- **Change** `installSkillsIntoCwd()` to walk **`skills/<surface>/`** subfolders (recurse one
  level) instead of a flat dir. **Preserve:** best-effort semantics (missing dir ⇒ 0 copied,
  no throw — `skills.ts:40-45`); preserve copying into `cwd/.claude/skills/` so native
  auto-fire is unchanged. **Open question OD-2:** copy *all* surfaces or only the task's
  detected surface (dilution vs simplicity).
- **Add** `readNurseryRecipes(surface, baseDir)` → returns parsed `{name, confidence, body}`
  for `recipes/<surface>/*.md`, for the deliberate injector (§4.2). **Does NOT** copy them
  anywhere.
- **Extend** `skillsIndex()` to also parse `confidence`, `runs_confirmed`,
  `runs_contradicted`, `last_verified` (additive regex/parse; keep the `name`+`description`
  path intact). **Preserve:** bounded context (name+meta only, never bodies —
  `skills.ts:105-126`).
- **Preserve** `installProfileIntoCwd()` and `profile.md` location verbatim
  (`skills.ts:77-103`). Profile is unchanged in steps 1–2.

### 4.2 Dispatch path — nursery injection (`task-manager.ts:dispatch`, `dispatch-prompt.ts`)

- **Add** a surface-detection step before injection. **Step-1 simplest form:** detect surface
  cheaply (keyword map over the cleaned intent) **or** inject all nursery recipes if the
  folder is tiny — spec §2 explicitly allows "inject all" while folders are small. Harden to
  router-emitted surface in step 4. *Touch:* new code in `dispatch()` between
  `installProfileIntoCwd` (`:255`) and `executorFactory()` (`:257`).
- **Extend** `buildDispatch()` to accept an optional `nurseryRecipes` block and render it
  **after** the task line, each recipe prefixed by a confidence stance, e.g.:
  *"Unverified lead from a past run (treat skeptically, derive independently if it fails): …"*.
  **Preserve:** terseness rationale — the stable contract stays in the auto-loaded file; only
  per-task hedged leads are typed (`dispatch-prompt.ts:1-11`). *Touch:* `dispatch-prompt.ts:30-43`.
- **Record** the injected set (graduated names that matched + nursery names) on the `Task`
  (delta G, §4.3). This is the one piece of state the pre-step must hand forward — the
  librarian grades the trace against it.
- **Raw mode:** when a task is raw (step 4), this entire injection step is skipped. For steps
  1–2 all tasks are managed (status quo), so no gate yet — but structure the injector so a
  later `if (mode === 'raw') return` is a one-line addition. **Preserve §10 invariant:** even
  raw tasks keep the repo's own native `.claude/` context — we only suppress *Unmute's*
  injection, which is already true since we inject into Unmute's own per-task cwd.

### 4.3 `Task` model — injected-recipe state (delta G)

- **Add** to `Task` (`task-manager.ts:48-78`): `injectedRecipes?: Array<{ name: string;
  tier: 'nursery' | 'skill'; surface: string }>`. Set at dispatch; read at the librarian
  handoff. **Preserve:** in-memory-only Task model + crash rehydrate from disk
  (`task-manager.ts:605-644`) — injectedRecipes is ephemeral (a re-dispatch recomputes it), so
  it does **not** need to be persisted to `meta.json`.

### 4.4 `librarian.ts` — trigger, input, constitution

- **Change trigger (delta F):** also hand off on `failed` **when `injectedRecipes` is
  non-empty** (a wrong injected recipe is exactly a contradiction signal). Always hand off on
  `done`. **Open OD-3:** whether `stuck` also hands off (a stuck task may have a partial,
  resolvable trace). *Touch:* add a submit in the `failed` branch (`task-manager.ts:506-519`)
  mirroring the `done` branch (`:479-491`). **Preserve:** fire-and-forget + serialized queue
  (the failed-path submit must also be `void … .catch()` so it never blocks the UI).
- **Change input (delta D/E):** add `injectedRecipes` and a `reducedTrace` (from §4.6) to
  `RecipeSuggestion` (`librarian.ts:27-45`). **Keep `transcript` (PTY tail) as a labeled
  fallback** when the JSONL can't be resolved — never regress below today's behavior.
- **Replace charter (delta A/D):** `buildPrompt()` (`:195-262`) becomes the §5 constitution
  diff. **Preserve:** the autonomous-no-questions framing (`:213-217`) and the
  write-status-when-done close (`:258-260`) verbatim — those are hard-won (a librarian that
  asks a question hangs forever, `init.ts:508-515`).
- **Step-2 safety (read-only):** gate every *write* the new constitution would make behind a
  `LIBRARIAN_WRITE_ENABLED` flag (default **off** in step 2). When off, the librarian session
  is instructed to **emit its intended action** (promote/demote/create/no-op + target path)
  into its own status `result.detail` and **make no change to `recipes/`, `skills/`, or
  `profile.md`.** We read those logged intents to calibrate thresholds before granting the pen
  in step 3. **This is how we honor "the librarian earns the pen last" without forking the
  code path.**

### 4.5 Status / trigger plumbing

- **Preserve** the entire status schema and tolerant reader (`status-file.ts`) unchanged —
  the confidence layer rides on top, it does not alter the wire protocol.
- **Note (delta H):** the doer's `recipe.json` scratch hint (`dispatch-prompt.ts:36-38`,
  `contract-text.ts:171-175`) is **demoted to a soft, optional signal**, not removed. The
  librarian now infers divergence from the trace; the scratch hint, if present, is just one
  more input. No contract rewrite needed in steps 1–2 (the §7 wording already says "optional …
  never required").

### 4.6 The trace pipeline — JSONL resolution + reducer (delta E, NEW)

**Resolution (deterministic, no session-id needed):**
- The executor ran in `task.cwd = ~/.unmute/remote/<userKey>/<taskId>/` (`task-manager.ts:223,
  269`). Claude wrote its transcript to `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.
- **Robust resolver:** glob `~/.claude/projects/*<taskId>*/` (the taskId UUID is unique and
  appears in the encoded path), then take the single `*.jsonl` (or newest by mtime if
  `--continue`/follow-ups produced more than one). This sidesteps any path-encoding subtlety.
- **Fast path / cross-check:** the encoding replaces `/` and `.` with `-` (so
  `/Users/u/.unmute/remote/local/<id>` → `-Users-u--unmute-remote-local-<id>`). We can compute
  it directly, but the glob is the resolver and the computed path is only an assertion. *(The
  exact encoding is the one empirical thing to confirm on a real run in step 1 — but it is
  **not load-bearing** because the glob doesn't depend on it.)*
- **Guard:** the executor must run with transcript persistence **on** — i.e. we must **not**
  pass `--no-session-persistence`/`persistSession:false` and must **not** set
  `CLAUDE_CODE_SKIP_PROMPT_HISTORY`. Today none of these are passed (`init.ts:369-399`,
  `pty-session.ts` args per agent analysis) — so we are persistence-on by default. Add a
  one-line assertion/test so a future flag change can't silently blind the loop.

**Reducer (deterministic code, NOT a model — judgment stays in the librarian):**
- Input: the resolved JSONL. Output: a compact markdown "action trace."
- **Extract, in order:** `tool_use` blocks (tool name + key inputs), `tool_result` blocks
  (ok/error + brief outcome), final outcome (status + last assistant turn), optionally
  thinking spans that reference an injected recipe (the *why* behind a divergence).
- **Drop:** system prompts, the echoed-back recipe/contract, verbose intermediate content,
  token/usage metadata.
- **Reuse:** `cleanTranscriptTail()` (`task-manager.ts:146-155`) is the starting point for the
  text-cleaning half; the new work is JSONL parsing + selection. Existing OSS tools that
  condense Claude transcripts to LLM-reviewable markdown are viable to reuse (per research) —
  **OD-4.**
- **Preserve the dilution discipline:** never hand the librarian raw JSONL; the reduced trace
  is bounded, mirroring the existing "bounded context" intent of `skillsIndex`
  (`skills.ts:105-107`).
- **New file:** `trace-reducer.ts` (+ `trace-reducer.test.ts`). Pure function over a JSONL
  string → markdown; fully unit-testable with a captured fixture transcript.

---

## 5. The librarian constitution — as a diff against the existing charter

The existing `buildPrompt()` (`librarian.ts:195-262`) already encodes ~half the constitution.
The diff:

**Keep verbatim (already correct):**
- "You are the ONLY writer … be conservative … when in doubt, NO-OP" (`:210-211`).
- Autonomous, never-ask, never-block framing (`:213-217`).
- "Capture only DURABLE knowledge … NEVER store brittle UI steps" (`:243-245`) — this *is*
  the discover-not-decide line.
- "CONSOLIDATE, don't fragment … one skill per task-CLASS" (`:248-249`).
- Profile-vs-skill split (`:251`).
- Write-status-done-with-one-line-summary close (`:258-260`).

**Add (new constitution clauses, spec §5):**
1. **Inputs now include** the injected recipe(s) and the reduced trace. Instruction: *judge
   whether each injected recipe's specific claims were **corroborated or contradicted by the
   trace** — NOT whether the task merely succeeded.* (Kills the false-positive trap: success
   with a wrong recipe, failure with a right one.)
2. **Per-run decision procedure** (verbatim from spec §5.2): no-recipe→create-low-or-no-op;
   recipe-corroborated→`runs_confirmed++`, stamp, promote-if-threshold; recipe-contradicted→
   demote one tier, `runs_contradicted++`, rewrite the contradicted part as a fresh low-conf
   claim, re-hedge; ambiguous→no-op (at most stamp `last_used`).
3. **Phrase by confidence + keep the `confidence` field in sync with folder + phrasing**
   (spec §5.1(3)).
4. **Never harden on one run; new knowledge enters as low-confidence nursery only; never
   create directly in `skills/`** (spec §5.1(4), §5.4).
5. **Down fast, up slow** — one clear contradiction demotes; promotion needs repetition
   (spec §5.1(5), §5.3 starting thresholds: low→med 2 confirmations; med→high 3 + fresh; any
   tier −1 on one contradiction).
6. **Never persist transient state; never merge two surfaces** (spec §5.4).
7. **Output target = a folder/file move + frontmatter counter update**, not free-form skill
   authoring. In **step 2 (read-only)** it instead *logs the intended move* (gate, §4.4).

### 5.1 Decided calibration dials (DECIDED — starting rules, calibrated in read-only)

These two dials set "how harsh" the librarian is. They are decided now (not deferred); the
read-only phase tunes the wording, not the principle.

**Dial 1 — contradiction vs corroboration vs ambiguous. The line is the recipe's own
section structure** — only the *hard* sections can move confidence:

- Governing sections: `Invariants`, `Definition of done`, and named **structural facts**
  (an enumeration like "4 profiles," a location, a stable identifier, a documented gotcha).
- **CORROBORATED** (`runs_confirmed++`, stamp, promote-if-threshold): the trace exercised a
  hard claim and it held; task succeeded.
- **CONTRADICTED** (demote one tier, `runs_contradicted++`, rewrite the wrong part as a fresh
  low-confidence claim, re-hedge): the trace shows a hard claim was **false** — a named fact
  didn't hold and the model had to discover a different one to proceed, or a Definition-of-done
  invariant failed.
- **AMBIGUOUS → no-op** (at most stamp `last_used`): the deviation was in a **soft** section
  (`Defaults`/`Procedure` are *designed* to be adapted — a deviation there is **never** a
  contradiction); OR the recipe wasn't really exercised; OR the task failed for reasons
  unrelated to the recipe's claims (auth, rate limit, network, a genuinely novel sub-task).

  *Why mechanical:* hard sections govern confidence, soft sections never do — so the
  classifier keys off *which section* a deviation touches, not a vibe.

**Dial 2 — create-worthiness bar (deliberately HIGH).** Create a nursery recipe only if
**all three** hold: (a) the run surfaced at least one **durable, environmental** fact worth a
real `Invariant` or `Known failure mode` (not transient, not situation-specific reasoning);
(b) it cost **non-trivial exploration** the model would otherwise redo; (c) the surface is
**plausibly recurring** (email, sheets, a tool — not a literal one-off). If the task was
trivial, any competent model one-shots it next time, or nothing non-obvious surfaced →
**no create.** (Consistent with the existing charter's "if nothing was non-obvious … NO-OP,"
`librarian.ts:246-247`.)

**Overall posture & tie-breakers:** lenient about **creating** (high bar — bloat is the
enemy), **slow** to promote (needs repetition, §5.3), **fast** to demote (one proven hard-fact
contradiction). Unsure whether to create → **don't**. Unsure whether a deviation is a
contradiction or noise → **ambiguous/no-op**, *unless* a named hard fact provably failed →
then demote. Rationale (the asymmetry that runs through the whole design): a missed harvest is
just a future cold-start; an over-eager write is active pollution.

**Preserved guarantee:** the new prompt must remain a *tight* charter — longer, but still
no-op-by-default. A trigger-happy librarian is worse than none (spec §9 throughline).

---

## 6. Cutover plan — sequencing 1→2→3 against the *existing writing* librarian

The existing librarian **already writes** profile + flat skills. Our steps must not create a
window where it writes the *old* flat format into the *new* layout. Sequencing:

- **Step 1 (substrate + injection):**
  - Add `recipes/` + `skills/<surface>/` layout, frontmatter parsing, nursery injection,
    `injectedRecipes` recording.
  - **Clean slate (OD-1 resolved):** abandon the old flat `skills/*.md` entirely — `recipes/`
    and `skills/<surface>/` start empty. The existing librarian's flat-curation write path is
    disabled in step 1 (it would write the old format into the new world); the new
    confidence-aware writes arrive gated-off in step 2 and live in step 3. Net for step 1:
    new substrate + nursery injection live, no librarian writes at all.
- **Step 2 (librarian read-only):**
  - Swap the librarian feed to the reduced JSONL trace (+ PTY fallback), install the §5
    constitution, but **gate writes off** (`LIBRARIAN_WRITE_ENABLED=false`). It logs intended
    promote/demote/create/no-op. Calibrate §5.3 thresholds against real logged intents.
- **Step 3 (librarian writes):** flip the gate on; the librarian now performs the `mv` +
  counter updates. Old flat-curation path retired here.

This keeps "the only writer earns the pen last" literally true while never dropping below the
current floor.

---

## 7. Open decisions (need your ruling before/within implementation)

- **OD-1 — Existing flat skills migration. RESOLVED: clean slate.** We do **not** migrate or
  read any existing `~/.unmute/remote/skills/*.md`. `recipes/` and `skills/` start empty and
  accrue from scratch. No back-compat path; the old flat library is abandoned. (Owner ruling.)
- **OD-2 — Injection breadth.** Copy *all* surfaces' graduated skills into each task's
  `.claude/skills/` (today's behavior, max recall, more dilution) or only the detected
  surface's (less dilution, risk of a missed surface)? *Recommendation: detected surface +
  a small always-on "general" set, once surface detection exists; until then keep all.*
- **OD-3 — Trigger on `stuck`.** Hand off to the librarian on `stuck` too, or only `done`
  and recipe-bearing `failed`? *Recommendation: not `stuck` initially* (its trace is partial
  and noisy; failure already covers contradiction).
- **OD-4 — Reducer build vs reuse.** Build `trace-reducer.ts` ourselves or wrap an existing
  OSS transcript-condenser? *Recommendation: build the thin extractor ourselves* (no
  dependency, full control over what's dropped) — it's a small pure function.
- **OD-5 — Surface taxonomy seed.** Do we predefine any surface folders, or let them be
  created lazily by first write? *Recommendation: lazy* (harvested-not-declared — spec §3.1),
  with `gmail` likely first given the canonical bug.

---

## 8. Two-sided completeness check

**Existing-side (nothing the product does today silently vanishes):** walked every file in
`remote/` touched by this layer — `skills.ts`, `dispatch-prompt.ts`, `task-manager.ts`,
`status-file.ts`, `librarian.ts`, `init.ts`, `contract-text.ts`. Each capability is accounted
for as preserve/change/replace/extend above. Specifically preserved: single-writer race
safety, fire-and-forget, billing-env strip, atomic status, idempotent contract, crash
rehydrate, auto-fire via cwd-copy, bounded librarian context, terse dispatch.

**New-side (no spec concept hand-waved, for steps 1–2 scope):**
- §0a orchestration/memory split → §4.2 (injection is the only memory gate; orchestration
  untouched). §0b raw mode → stub §9 (structured for a one-line gate now).
- §0/§1 recipe format + two stores → §3.1–3.2.
- §2 matching/injection → §4.1–4.2 (auto-fire copy + nursery hedged inject).
- §3 librarian trigger plumbing → §4.4 + §4.6 (handoff + JSONL resolution).
- §4 reducer → §4.6.
- §5 constitution + thresholds → §5.
- §10 invariants → §2.6 (existing) + carried per-row.
- §6 freshness, §7 gardening, §8 router → **deferred by design** (stub §9).

---

## 9. Deferred stubs (specified when we reach them)

- **Router mode (spec §0b, §8) — step 4.** Add `mode ∈ {managed, raw}` emitted by the
  existing router (`router.ts`, `init.ts:416-465`), defaulting managed for short dictated
  tasks / raw for "open me a session to work in," user toggle overrides, ambiguous→raw. Gates
  exactly two things: the §4.2 injection step and arming the librarian handoff. Registry,
  status, overlay already mode-agnostic (no change). One-line `if (raw)` skips at both gates.
- **Freshness (spec §6) — post-3.** `last_verified` + a 30-day window flags `stale-high`;
  injector prepends a "confirm before relying" stance; no auto-demote (first run back
  re-verifies). Confidence gains a freshness dimension alongside height.
- **Gardening (spec §7) — post-3.** Periodic dedupe / prune / stale-flag / split-on-overflow.
  Independent of the per-run path; conservative, proposes before destroying. This is what
  keeps harvested structure from rotting (emergent ≠ unsupervised).

---

## 10. New/changed files at a glance (steps 1–2)

| File | Change |
|---|---|
| `skills.ts` | +`recipesDir`/surface helpers, +`readNurseryRecipes`, change `installSkillsIntoCwd` to surface subtree, extend `skillsIndex` frontmatter parse |
| `dispatch-prompt.ts` | extend `buildDispatch` with hedged nursery block |
| `task-manager.ts` | surface-detect + nursery inject in `dispatch()`, +`injectedRecipes` on `Task`, +librarian handoff on recipe-bearing `failed` |
| `librarian.ts` | new input fields, §5 constitution prompt, write-gate flag, JSONL feed (+PTY fallback) |
| `trace-reducer.ts` (new) | deterministic JSONL → reduced markdown trace (+ test) |
| `init.ts` | wire `LIBRARIAN_WRITE_ENABLED` gate; (no mode yet) |
| frontmatter convention | new fields, ignored by legacy readers |

Nothing above touches the wire protocol, the billing path, the overlay, or the router's
new-vs-continue logic. The blast radius is the memory layer only.
