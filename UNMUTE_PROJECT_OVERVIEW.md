# Unmute — Project Overview

> **Read this first.** This is the high-level map of the whole project — the
> *why*, the *shape*, and *where we stand*. It is deliberately not a manual.
> For depth on any subsystem, follow the pointers in
> [§7 Where to go for depth](#7-where-to-go-for-depth).

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
- **Skills are the unit of durable value.** If the agent is the primary surface
  for work, then *skills* (reusable procedures) are the software people
  accumulate and must maintain. Nobody maintains them. So we observe the work and
  turn the recurring, valuable parts into skills — **with a human accept/reject
  gate, never full automation. Not Jarvis.**
- **We sit above the executor (neutrality).** Claude Code today, anything
  tomorrow. Everything is built against a thin executor seam.
- **Hard invariants.** (1) *Billing isolation* — agent work always runs on the
  user's own subscription; every spawned process strips API-key env vars.
  (2) *Consent* — a persistent session is never hijacked by an ambiguous
  utterance. (3) *The user's files are sovereign* — only an explicit, consented
  action ever writes into `~/.claude/skills`.

## 3. How we got here (the layers, in order built)

Each layer is the same bet stated louder. They stack; none replaced the one below.

1. **Dictation** — the foundation and still the daily driver. Voice → text,
   pasted anywhere. Local (Parakeet) + cloud STT, heavy accuracy work.
2. **Unmute Remote** — fire off a Claude Code session by voice. No terminal, no
   typing `claude`. Born from: people on large plans leave tokens on the table
   and shouldn't have to manage terminals for one-off agent tasks.
3. **The Cockpit / Orchestrator** — voice as the primary interface for *long-lived*
   work across *many* agent sessions. The "whose move is it" wall, the crank, the
   doorbell, ready/done/failed, the shelf. This is where voice stops being a
   convenience and becomes the control plane.
4. **Computer Use (`unmute-computer`)** — our own hands for the agent, because the
   built-in options weren't good enough. Drives native apps and browsers **in the
   background** (no focus steal) so non-coding work (Notion, Slack, editors) is in
   reach. A four-lane router: CDP (browsers/Electron), Apple Events, cua
   accessibility, cua pixel.
5. **The Skills Observatory (Skill Curator)** — the long-term bet. Watches the
   user's sessions, notices recurring valuable work, and proposes skills to
   create / refine / retire. A human gates everything. Skills grow, age, and get
   pruned — so the curator is a *gardener*, not just an author.

## 4. Monetization

Managed cloud tier layered on the OSS engine. **BYOK and Local users never touch
our infrastructure — only Managed users do**, so free users cost us nothing.

The model has evolved: prepaid pay-per-use credits → **flat subscription**
(current: `dictation` and `unmute` plans) gated by a Supabase entitlement →
a hidden, notify-only **fair-use** cap. Auth is Supabase JWT; payments are Dodo;
the hot path is a Cloudflare Worker in front of the STT/LLM providers.

## 5. Repository shape (folder map)

```
unmute-cloud/
├── UNMUTE_PROJECT_OVERVIEW.md   ← you are here
├── PLAN.md                  original implementation plan (STALE — see §6)
├── README.md                original paywall README (STALE — see §6)
├── backend/
│   ├── cloudflare/          the managed hot path
│   │   ├── pipeline/         Worker: auth + entitlement gate + STT/LLM proxy
│   │   ├── payments/         Worker: Dodo checkout + webhook
│   │   └── shared/           auth, balance/entitlement, provider config, remote config
│   └── supabase/migrations/  the billing evolution, in order (005 → 013)
├── desktop/                 the shipped Electron app
│   ├── engine-overrides/     files copied over the pulled OSS engine at build time
│   │   └── electron/          dictation upgrades: Parakeet, STT arbiter, accuracy gates
│   ├── electron/             closed-source main-process glue
│   │   ├── (paywall-*, provider-router, managed-client, ...)  the managed tier
│   │   └── remote/           THE ORCHESTRATOR + computer-use + skill curator
│   │       ├── router / task-manager / pty-session / tmux / status-file / hooks
│   │       │                  voice → routed action → tracked agent sessions
│   │       ├── cua/ + ax/     computer-use lanes (CDP, AppleScript, cua driver)
│   │       └── curator-*      the skills observatory
│   ├── native-*/             in-process macOS addons (paste, key listener, AX)
│   ├── vendor/cua-driver/    pinned trycua binary (fetched, not committed)
│   └── build/wire-into-engine.sh   clones OSS engine, overlays, signs, ships DMG
└── docs/                    design docs & vision (the real depth — see §7)
```

**The build model:** the OSS `unmute-dictation` engine is **never forked**. The
build script clones a pinned tag, recursively copies `engine-overrides/` on top,
vendors the native addons, and produces one signed DMG. Overrides mirror the OSS
path structure so the copy just drops each patched file into place.

## 6. Where we stand (honest state)

- **`README.md` and `PLAN.md` are stale.** They describe the original
  dictation-paywall with prepaid credits and call the subscription model and the
  curator "out of scope / future work." The code has moved well past both. Trust
  the code and `docs/`, not those two files, until they're rewritten.
- **The routine/librarian memory system is PARKED** in favor of the Skill Curator
  (the curator supersedes it; some of its plumbing was reused). The
  `docs/memory-system/` design describes that superseded system.
- **Computer-use lanes are code-complete and wired**; the live signed-build smoke
  is the pending manual step, and off-Space scroll / arming focus-flash are the
  acknowledged frontier.
- **The Skill Curator is the most actively iterated subsystem** — it has run live
  and been re-aimed based on real runs (the "user-side reframe").
- Work happens across **many branches on one `main`**; the orchestrator and the
  pure modules (STT arbiter, correction gates, lanes, curator) carry heavy test
  coverage.

## 7. Where to go for depth

| Topic | Read |
|---|---|
| The cockpit vision, in the founder's words | `docs/ORCHESTRATE-VISION.md` |
| The skills thesis + "everything is a coding agent" | `desktop/docs/skill-curator/` (esp. `11-…hypothesis.md`, `README.md`) |
| Skill curator — the shipped design | `desktop/docs/superpowers/specs/2026-07-20-skill-curator-architecture.md` (note its §0 reframe) |
| Computer-use lanes & router | `desktop/docs/superpowers/specs/2026-07-22-computer-use-router-design.md` |
| The (parked) routine/memory system | `desktop/docs/memory-system/`, `desktop/docs/superpowers/plans/2026-06-27-unmute-memory-system.md` |
| Managed backend & deployment | `docs/DEPLOYMENT.md`, `backend/supabase/migrations/` (in order) |

## 8. Orientation for an agent working here

- **Voice-first is a constraint, not a feature.** Before adding any UI, ask
  whether it re-introduces a text/chat surface the philosophy rejects.
- **The executor is a seam.** Don't hard-couple to Claude Code; go through the
  executor interface.
- **Files are the control channel** in the orchestrator (router → `decision.json`,
  tasks → `status.json`). The terminal stream is display-only.
- **Never break the hard invariants** in §2 (billing isolation, consent, file
  sovereignty). They each exist because a real bug or a real principle demanded
  them.
- **Precision over recall for anything the user sees suggested.** A wrong
  suggestion is a broken promise of the exact thing we sell; a missed one is just
  a future cold start.
