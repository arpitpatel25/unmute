# Unmute — Project Overview

> **Read this first.** The high-level map of the whole project — the *why*, the
> *shape*, and *where we stand*. Deliberately not a manual. For depth on any
> subsystem, follow the pointers in [§7](#7-where-to-go-for-depth).
>
> **Getting it running on your machine:** [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).
>
> *Last substantive revision: 2026-08-31 (shipped v1.5.11). If you are reading this months later,
> run `git log -1 -- UNMUTE_PROJECT_OVERVIEW.md` before trusting §6.*

---

## 1. The one-sentence thesis

Coding agents (Claude Code, Codex) are becoming the **universal executor** — the
general "state intent in natural language → decompose → execute across any tool"
engine. That engine generalizes, but its native form — a terminal — is a
**power-user ceiling**. **Unmute owns the surface, not the executor: voice and
ambient attention on top of any number of running agents.** We do not compete on
executing. We own *the human interface and attention layer*.

The single most important nuance, and our entire reason to exist: the hypothesis
"everything becomes a coding agent" is **right about the engine and wrong about
the form**. The engine wins; the terminal doesn't. That gap is the opening.

## 2. The philosophy (the load-bearing beliefs)

- **Engine vs. surface.** Betting "coding agents win" is betting on the obvious.
  We bet on the corollary: the winning engine needs a non-terminal surface for
  everyone who isn't a terminal user. Voice is that surface.
- **Voice is the only paradigm — with bright lines.** No text input on the stage,
  no re-rendered chat transcript. If deleting our surface loses nothing over the
  underlying agent app, we built the wrong thing ("the delete-the-wall test").
  The terminal is shown *raw* precisely because we refuse to re-render the
  conversation.
- **Whose move is it.** Every session is at any moment either *our move* (the
  agent is working — leave it alone) or *your move* (blocked on you, errored, or
  a thread whose turn has just ended). The product's only prioritization signal
  is this. It is a **predicate evaluated fresh on every render, never a state
  stored on the task** — states record only what happened (`processing ·
  needs-user · done · failed`); see §6. The goal of a day is **minimal wasted
  human attention**, not maximal information.
- **Attention is pulled, never grabbed.** Nothing modal, nothing that steals
  focus, one calm spoken headline when — and only when — a task becomes yours.
- **We sit above the executor (neutrality).** Claude Code today, anything
  tomorrow. Everything is built against a thin executor seam.
- **Hard invariants.** (1) *Billing isolation* — agent work always runs on the
  user's own subscription; every spawned process strips API-key env vars.
  (2) *Consent* — a persistent session is never hijacked by an ambiguous
  utterance. (3) *The user's files are sovereign* — only an explicit, consented
  action ever writes into `~/.claude/skills`.
- **Skills are the unit of durable value** — the long-term bet, *currently
  parked*. See §6.

## 3. How we got here (the layers, in order built)

Each layer is the same bet stated louder. They stack; none replaced the one below.

1. **Dictation** — the foundation and still the daily driver. Voice → text,
   pasted anywhere. Local (Parakeet) + cloud STT, heavy accuracy work.
2. **Unmute Remote** — fire off a coding session by voice. No terminal, no
   typing `claude`. Born from: people on large plans leave tokens on the table
   and shouldn't have to manage terminals for one-off agent tasks.
3. **The Cockpit / Orchestrator** — voice as the primary interface for
   *long-lived* work across *many* sessions. The "whose move is it" wall, the
   crank, the doorbell, ready/done/failed, the shelf.
4. **Computer Use (`unmute-computer`)** — our own hands for the agent. Drives
   native apps and browsers **in the background** (no focus steal) so non-coding
   work is in reach. A four-lane router: CDP (browsers/Electron), Apple Events,
   cua accessibility, cua pixel.
5. **The notch** — a native Swift surface living in the menubar row and through
   the display cutout. It is now **the** attention surface: the pill, the wall,
   the rail, the task stage and the scratchpad all render there, driven over IPC
   from the Electron main process. One morphing surface, six states (`dormant ·
   idle · active · attention · task · cockpit`) plus **the pocket** — a
   bar-level glance at what your next words could land on. The older right-side
   overlay is retired behind `UNMUTE_NOTCH_ENABLED=0`.
6. **Universal capture / the scratchpad** — what you copy *while dictating* is
   held and composed into the delivery, instead of being lost to the clipboard.
   The pad is armed deliberately; an armed pad holds a capture rather than
   delivering it.
7. **The shell** — a four-destination app (History · Orchestrator · Account ·
   Settings), a nine-step onboarding, and seven settings sections each with a
   written explainer.
8. **The Unmute Agent** — a third key (**right Command**) that addresses *Unmute
   itself* rather than a session. It holds a memory, can find what you said and
   what you have worked on, reads your meetings, hands outside work to a new
   task, and reopens a past session as a card. It shows transient notch states
   and deliberately no card of its own — that separation is the point. Its whole
   capability surface is `electron/remote/agent/capabilities/`.
9. **The meeting notetaker** — a global system-audio tap (excluding Unmute
   itself) plus your microphone, double-tap **left Control** to start. Whisper
   transcribes, and the notes are written by **your own connected CLI** — never a
   cloud model, deliberately. Notes are the product: the transcript UI is
   withdrawn behind a one-line flag (`SHOW_TRANSCRIPT_UI`, renderer/notetaker),
   though transcripts are still generated, stored and fed to the notes agent.

## 4. Monetization

Managed cloud tier layered on the OSS engine. **BYOK and Local users never touch
our infrastructure — only Managed users do**, so free users cost us nothing.

The model has evolved: prepaid pay-per-use credits → **flat subscription**
(current: `dictation` and `unmute` plans) gated by a Supabase entitlement →
a hidden, notify-only **fair-use** cap. Auth is Supabase JWT; payments are Dodo;
the hot path is a Cloudflare Worker in front of the STT/LLM providers.
Migrations run `005 → 014`; read them in order.

## 5. Repository shape (folder map)

```
unmute-cloud/
├── UNMUTE_PROJECT_OVERVIEW.md   ← you are here
├── README.md                what this repo is, in a page
├── docs/
│   ├── ONBOARDING.md         get it running on your Mac — start here
│   ├── DEPLOYMENT.md         backend deploy steps
│   ├── ORCHESTRATE-VISION.md the cockpit vision, in the founder's words
│   └── superpowers/          design specs and plans, dated
├── backend/
│   ├── cloudflare/          the managed hot path
│   │   ├── pipeline/         Worker: auth + entitlement gate + STT/LLM proxy
│   │   ├── payments/         Worker: Dodo checkout + webhook
│   │   └── shared/           auth, entitlement, provider config, remote config
│   └── supabase/migrations/  the billing evolution, in order (005 → 014)
└── desktop/                 the shipped Electron app
    ├── engine-overrides/     files copied over the pulled OSS engine at build
    │   ├── electron/          dictation: Parakeet, STT arbiter, accuracy gates,
    │   │                      key listener, session manager
    │   └── renderer/          the shell (app/), the pill (widget/), the wall
    ├── electron/             closed-source main-process glue
    │   ├── (paywall-*, provider-router, managed-client, …)  the managed tier
    │   └── remote/           THE ORCHESTRATOR
    │       ├── router / task-manager / pty-session / tmux / status-file / hooks
    │       ├── notch/         controller + IPC client for the Swift surface
    │       ├── capture/       universal capture + the scratchpad
    │       ├── cua/ + ax/     computer-use lanes (CDP, AppleScript, cua driver)
    │       ├── agent/         THE UNMUTE AGENT — capabilities/ is its whole
    │       │                  tool surface; constitution.ts is what it is told
    │       ├── observer.ts    derives task state from what a session emits
    │       ├── session-policy.ts  the ONLY things Unmute adds to a session
    │       ├── transcript-locate.ts  find a session's transcript BY ID (§6)
    │       └── curator-*      the skills observatory (PARKED — see §6)
    ├── native-notch/         the Swift notch shell (SwiftUI + SwiftTerm)
    │                         Sources/ConversationSupport + ComposerSupport are
    │                         the PURE modules — that is where the tests live
    ├── native-*/             in-process macOS addons (paste, key listener, AX)
    ├── vendor/cua-driver/    pinned trycua binary (fetched, NOT committed)
    └── build/wire-into-engine.sh   clones OSS engine, overlays, signs, ships DMG
```

**The build model:** the OSS `unmute-dictation` engine is **never forked**. The
build script clones a pinned tag, recursively copies `engine-overrides/` on top,
vendors the native addons and the Swift notch shell, and produces one signed,
notarized DMG. Overrides mirror the OSS path structure so the copy just drops
each patched file into place.

## 6. Where we stand (honest state)

- **`PLAN.md` is gone.** It described the original prepaid-credits paywall and
  called the subscription model "future work". Two months stale and actively
  misleading. `git log` still has it.
- **`README.md` has been rewritten** and is current as of this revision.
- **The Skill Curator is PARKED for this release** (`CURATOR_PARKED`, 2026-08-03).
  This overview previously called it "the most actively iterated subsystem" —
  that is no longer true. Settings shows the switch off and disabled, and the
  Suggestions rail that was its only user-visible surface has been removed. The
  librarian is parked alongside it. `desktop/docs/skill-curator/` remains as the
  design record for when it comes back.
- **The routine/memory system stays parked** — superseded by the curator, whose
  plumbing reused parts of it. `desktop/docs/memory-system/` is history.
- **The session is now natural** (landed on main 2026-08-06, `b38f57c`). Unmute
  used to *modify* the Claude Code session it started, in eight ways — a
  244-line contract pasted as a user turn, `--model` pinned to our default,
  `--chrome` unconditionally, files written into the user's repo, a `Stop` hook
  that blocked the end of every turn. Two user complaints came out of it ("my
  terminal is full of your scaffolding", "Claude Code works worse under
  Unmute"), and both were fair. All of it is deleted: ~3,530 tokens of contract
  became ~200, in the system prompt rather than impersonating the user's
  request. State is now *observed* from five async report-OUT hooks plus the
  session's own transcript (`observer.ts`, `transcript.ts`), and the model's
  final reply IS `result.detail`, verbatim. `session-policy.ts` holds the whole
  policy and `ALLOWED_FLAGS` is enforced by a test. Design:
  `docs/superpowers/specs/2026-08-06-natural-session-design.md`.
- **The ask channel is real** (2026-08-06 → 08-07). `PreToolUse` is matched on
  `AskUserQuestion` and `ExitPlanMode`, plus `PermissionRequest` — so a picker
  open in the session is a modelled **interval keyed by `askId`**, not a guess
  from the last line of a reply. The honest limit: only a **single-select
  choice** can be answered from the card. Anything we cannot aim is marked
  `terminal_only` and the card offers **no input at all** rather than inviting a
  reply that would land somewhere unpredictable.
- **`ready` is retired as a state** (2026-08-08, `5baee2a`). It was a rendering
  decision stored as if it were history, decided by whether the last line ended
  in "?" — so a task that signed off with "Let me know" simply vanished. States
  now say only what happened — `processing · needs-user · done · failed` — and
  whether a finish wants you is the predicate `blocked | failed | (done && kind
  === 'session')`. Things move **down three tiers** rather than off a cliff:
  `demanding → reach (today, one arrow press) → dashboard`. `ready` is still
  accepted on the MCP wire and folded to `done`, for agents holding a cached
  copy of the old schema.
- **The notch is the attention surface.** Sizing, dormancy, escape/back/click-out
  and the "nub vs nameplate" resting states all shipped in the launch work. Note
  it has **distinct surfaces with different lifetimes** — the wall/dashboard,
  the rail (persists until cleared), the task stage, and now the **pocket** (a
  bar-level carousel of what you have actually worked in, bounded at 8 and 12h).
  They are not interchangeable, and confusing them is a repeat source of bugs.
  Recent: the dashboard gained a **Today** 24h filter (off by default; never
  hides anything waiting on you; no "show all" escape hatch inside it), and the
  expanded surfaces moved to true black so they share one material with the bar
  and the pocket.
- **One bright line was crossed deliberately:** the task stage now carries a
  text composer (`StageComposer`) alongside the terminal. "No text input on the
  stage" was a stated rule; the argument for extending it is that the line was
  already crossed for driven backends, where a composer was the only way in.
  Voice stays primary and the placeholder says so. Treat this as a decision on
  the record, not as permission to add the next one.
- **Computer-use lanes are code-complete and wired**; the live signed-build smoke
  is the pending manual step, and off-Space scroll / arming focus-flash are the
  acknowledged frontier.
- **The Unmute Agent SHIPPED** and is on `main` (§3.8). Its tools today:
  `memory_*` (store/search/link/keep-a-file), `unmute_history_search` +
  `unmute_history_copy` (what you dictated, the one place nothing else can
  look), `notetaker_*`, `task_create` / `task_status` for handing work out,
  `delivery_*`, and `session_resume`. It reads past sessions straight off disk
  — `~/.claude/projects` and `~/.codex/sessions` — rather than from any index.
- **The session-summary sweep was deleted** (2026-08-30, `cc48bbf`) and the
  reasoning is worth keeping: it re-derived summaries on a 60s timer over a
  rolling window, spawning one CLI per session. Measured on one machine over
  four days — ~44,000 Codex session files (3.2 GB), ~17,000 launches a day —
  and it discovered its own output as new work, on the user's own CLI plan. If
  that capability comes back, the shape is summarise-once-when-a-session-ends,
  never a window on a timer.
- Work happens across **many branches on one `main`**; the orchestrator and the
  pure modules (STT arbiter, correction gates, lanes, capture, grouping) carry
  heavy test coverage — **214 test files** at this revision.
- **`npm test` does not currently finish, and this section used to claim it
  did.** The old text — "1519 tests across 124 suites, ~2 minutes, green on
  `main`" — is the sentence someone trusts *instead of running it*, which is
  how it stayed wrong. Observed 2026-08-30: the full run exceeded 25 minutes
  twice without completing, including on a stashed clean tree, so it is not
  caused by any recent change. Per-area runs are fast and green and are what to
  use meanwhile (`--test electron/remote/agent/**/*.test.ts` → 391 pass,
  `task-manager.test.ts` → 108, `notch/` → 171, Swift `swift test` → 134).
  `provider-contract.test.ts` reports 13 *cancelled* on any tree; that is also
  pre-existing. Finding out why the whole suite hangs is open work.
- **The meeting notetaker shipped** (2026-08-23 → 08-29, PR #11 merged at
  `acf83e9`) — §3.9. Two corrections were made on the way in and both are
  policy, not preference: the managed cloud LLM was **removed** from the notes
  path (a third vendor receiving the full text of your meetings, and it sat in
  the automatic fallback list), and main's dictation pill was restored after the
  merge had silently reverted it. **Five known defects shipped with it** and are
  listed in the merge commit — crash-recovery retry cannot complete, an
  unfinished WAV reads as empty, a retry can replace a good transcript with an
  empty one, the whole-meeting mix runs on the main thread, and a throw out of
  `stop()` wedges the notes key until restart. They are still open.
- **A task's record is no longer disposable** (2026-08-30/31). A finished
  one-off used to be **fully erased 15 minutes** after its last turn — card,
  status and home directory, via `fs.rm`. Two numbers were one number: `warmMs`
  measures how long a *process* is worth keeping warm, and it was also deciding
  how long the *work* was worth keeping. It cost a user hours of real work.
  Now: the window is **12 hours** (`DEFAULT_WARM_MS`), expiry **stops the
  runtime and keeps the record**, and `purgeAgeMs` (24h) is the only thing that
  deletes. All three erase paths had to agree — the live timer, the maintenance
  sweep, and the lapsed-window check on relaunch — or the record simply died
  later instead. Two existing tests asserted the old contract and were reversed
  with their reasoning kept.
- **Graduation survives a restart.** A one-off becomes a session after two
  follow-ups, but `followUps` lived only in memory: `rehydrate` rebuilt tasks
  from `meta.json` without it, so every relaunch reset the count to zero and a
  task you had replied to for hours was still a one-off when the reaper came.
  The graduated *kind* was already durable, so a task was either safe or
  silently starting over — which is why nobody saw it. Now persisted and
  restored at all three reconstruction sites.
- **A transcript is found by its session id, not by its folder.** The filename
  is the id and never changes; the FOLDER is derived from the session's current
  working directory, and Claude moves the file when that changes (entering a git
  worktree, say). The old lookup derived one path and, on a miss, fell back to
  "newest `.jsonl` in the folder" — which is unique only for scratch one-offs.
  On a project-bound task it bound one card to **another live session's
  transcript** and followed it as it grew. Both halves are fixed: search by id
  (`transcript-locate.ts`), and the directory fallback runs only when
  `cwd === home`.
- **The Remote lane now reports that a capture finished.** Every terminal event
  the dictation widget listens for means "text was pasted", and a Remote capture
  dispatches to a task instead — so the widget sat at `processing` for the life
  of the app and any later state re-push put the pill back on screen with no
  keypress behind it. `sessionManager` had always sent `remote:dispatched`;
  nothing had ever listened.
- **Also on main since this section was last true:** persistent CLI runtimes
  across app restarts; a headless transport for both router lanes (a pipe and a
  schema, not a terminal); Codex one-offs made persistent like every other task;
  a **Surface tone** setting (Space Gray or black) with the expanded surfaces
  moved to true black; and the notch's *announce-then-stand-down* rule — an
  announceable rung says its piece for ~2s and rests, rather than parking a
  sentence over your screen for hours.
- **Known and unfixed:** the notch's **Kill** button is a full erase with no
  confirmation, sitting beside a separate **Stop** — 8 of 13 task removals on
  2026-08-30 went through it. `task-removed` still records no caller and no
  reason, which is why that took timestamp correlation to unpick. And
  `blocks.ts` carries a parallel `groupIntoTurns` with the old turn rule that
  nothing calls outside its own tests — a drift hazard someone should delete.

- **Resolved, so you do not go looking for it:** this section used to warn that
  the parked librarian still injected stale "memory leads" into task prompts.
  It does not — `b38f57c` deleted them along with the rest of the contract.
  `dispatch-prompt.ts` is now the intent and nothing else.

## 7. Where to go for depth

| Topic | Read |
|---|---|
| Getting a build running on your Mac | `docs/ONBOARDING.md` |
| The cockpit vision, in the founder's words | `docs/ORCHESTRATE-VISION.md` *(2026-07-04 snapshot — see its §3 note on `ready`)* |
| Why the session is left alone, and how state is observed | `docs/superpowers/specs/2026-08-06-natural-session-design.md` |
| The Unmute Agent (right Command — shipped) | `desktop/docs/superpowers/specs/2026-08-05-unmute-agent-SPEC.md` |
| Shipping a release end-to-end | `docs/DEPLOYMENT.md` (backend) · the build publishes a GitHub **draft** you then flip |
| The skills thesis + "everything is a coding agent" | `desktop/docs/skill-curator/` (esp. `11-…hypothesis.md`) |
| Skill curator — the shipped design (parked) | `desktop/docs/superpowers/specs/2026-07-20-skill-curator-architecture.md` (note its §0 reframe) |
| Computer-use lanes & router | `desktop/docs/superpowers/specs/2026-07-22-computer-use-router-design.md` |
| The notch redesign | `desktop/docs/superpowers/specs/2026-07-24-notch-ui-redesign-design.md` |
| What every task is told | `desktop/electron/remote/contract/contract.md` |
| The (parked) routine/memory system | `desktop/docs/memory-system/` |
| Managed backend & deployment | `docs/DEPLOYMENT.md`, `backend/supabase/migrations/` (in order) |

## 8. Orientation for an agent working here

- **Voice-first is a constraint, not a feature.** Before adding any UI, ask
  whether it re-introduces a text/chat surface the philosophy rejects.
- **The executor is a seam.** Don't hard-couple to Claude Code; go through the
  executor interface.
- **Files are the control channel** in the orchestrator (router → `decision.json`,
  tasks → `status.json`). The terminal stream is display-only.
- **Unmute OBSERVES a Claude Code session; it never modifies one.** Diff a session
  Unmute started against one the user started themselves: the only difference
  should be the task text. Task state is derived from lifecycle hooks and the
  session's own transcript (`observer.ts`), never demanded from the model. Before
  adding anything to a launch or a prompt, read `session-policy.ts` — the allowed
  flags are a list, and a test enforces it.
- **There is more than one renderer.** The wall exists in both React
  (`engine-overrides/renderer/remote/`) and Swift (`native-notch/`), and **the
  Swift one is the surface actually in use**. A UI change in one is not a UI
  change in the other — confirm which surface is meant before calling it done.
  The two have already drifted (the React wall carried a Last-24h filter for
  weeks before the Swift cockpit got one).
- **Never break the hard invariants** in §2 (billing isolation, consent, file
  sovereignty). They each exist because a real bug or a real principle demanded
  them.
- **Precision over recall for anything the user sees suggested.** A wrong
  suggestion is a broken promise of the exact thing we sell; a missed one is just
  a future cold start.
- **Never install an unsigned build.** macOS keys Keychain and Accessibility by
  code signature, so `--no-sign` produces an app that is signed out with dead
  auto-paste — and nothing reports why.
- **Identify by id, never by "the newest one in the folder".** A derived path is
  a guess that looks like a fact, and when it misses, a fallback that picks the
  freshest neighbour will confidently hand you someone else's data. This has now
  bitten twice — the transcript lookup (§6) and the session index before it.
  Prefer the exact identifier and return nothing when it is absent; an empty
  panel is correct, another session's conversation is not.
- **Deleting is not the same as finishing.** Two of this month's worst bugs came
  from one event settling both: a process stopping and a record ceasing to
  exist. Kill the runtime freely — it is a cache, and Resume respawns it. Erase
  the record only on an explicit user action or a long, separate backstop.
- **A counter that decides a lifecycle has to be persisted.** `followUps` was
  compared but never written down, so a relaunch reset it and the thing it
  guarded fired anyway. If losing a value would change what happens to a user's
  work, it belongs in `meta.json` and in `rehydrate`.
