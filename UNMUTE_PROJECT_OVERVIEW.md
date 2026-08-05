# Unmute — Project Overview

> **Read this first.** The high-level map of the whole project — the *why*, the
> *shape*, and *where we stand*. Deliberately not a manual. For depth on any
> subsystem, follow the pointers in [§7](#7-where-to-go-for-depth).
>
> **Getting it running on your machine:** [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).
>
> *Last substantive revision: 2026-08-05. If you are reading this months later,
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
  parked ready awaiting direction). The product's only prioritization signal is
  this. The goal of a day is **minimal wasted human attention**, not maximal
  information.
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
   from the Electron main process. The older right-side overlay is retired
   behind `UNMUTE_NOTCH_ENABLED=0`.
6. **Universal capture / the scratchpad** — what you copy *while dictating* is
   held and composed into the delivery, instead of being lost to the clipboard.
   The pad is armed deliberately; an armed pad holds a capture rather than
   delivering it.
7. **The shell** — a four-destination app (History · Orchestrator · Account ·
   Settings), a nine-step onboarding, and seven settings sections each with a
   written explainer.

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
    │       ├── observer.ts    derives task state from what a session emits
    │       ├── session-policy.ts  the ONLY things Unmute adds to a session
    │       └── curator-*      the skills observatory (PARKED — see §6)
    ├── native-notch/         the Swift notch shell (SwiftUI + SwiftTerm)
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
- **The notch is the attention surface.** Sizing, dormancy, escape/back/click-out
  and the "nub vs nameplate" resting states all shipped in the launch work.
  Note it has **three distinct surfaces** — the wall (fades finished one-offs
  after 15m), the rail (persists until cleared) and the task stage. They are not
  interchangeable, and confusing them is a repeat source of bugs.
- **Computer-use lanes are code-complete and wired**; the live signed-build smoke
  is the pending manual step, and off-Space scroll / arming focus-flash are the
  acknowledged frontier.
- **In flight, not on main:** `arpit/unmute-addressable` — the **Unmute agent**,
  a second key (Fn+Space) that addresses Unmute itself rather than a session, so
  it can keep things for you and manage sessions on your behalf. Built and
  field-tested; see
  `desktop/docs/superpowers/specs/2026-08-05-unmute-agent-SPEC.md` on that branch.
- Work happens across **many branches on one `main`**; the orchestrator and the
  pure modules (STT arbiter, correction gates, lanes, capture, grouping) carry
  heavy test coverage. `npm test` in `desktop/` is ~1400 tests, ~2 minutes.
- **Known non-blocking noise:** the parked librarian still injects stale,
  low-confidence "memory leads" into task prompts. Cosmetic, but it pollutes
  instruction packets.

## 7. Where to go for depth

| Topic | Read |
|---|---|
| Getting a build running on your Mac | `docs/ONBOARDING.md` |
| The cockpit vision, in the founder's words | `docs/ORCHESTRATE-VISION.md` |
| The Unmute agent (Fn+Space, in flight) | `desktop/docs/superpowers/specs/2026-08-05-unmute-agent-SPEC.md` *(on `arpit/unmute-addressable`)* |
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
  (`engine-overrides/renderer/remote/`) and Swift (`native-notch/`). A UI change
  in one is not a UI change in the other — confirm which surface is meant before
  calling it done.
- **Never break the hard invariants** in §2 (billing isolation, consent, file
  sovereignty). They each exist because a real bug or a real principle demanded
  them.
- **Precision over recall for anything the user sees suggested.** A wrong
  suggestion is a broken promise of the exact thing we sell; a missed one is just
  a future cold start.
- **Never install an unsigned build.** macOS keys Keychain and Accessibility by
  code signature, so `--no-sign` produces an app that is signed out with dead
  auto-paste — and nothing reports why.
