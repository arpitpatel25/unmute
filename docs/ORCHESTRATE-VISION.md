# Unmute Orchestrate — the vision, the day, and where we stand

*Written 2026-07-04, on `feat/orchestrator`. This is the north-star doc: the
user's day as they described it, the principles we derived from it, what's
built, and what's still open.*

---

## 1. The one-sentence thesis

Coding agents are becoming the universal executor. Unmute does not compete on
executing — it owns the **human interface and attention layer** on top of any
number of running agents, and **voice is the only interaction paradigm**
("press to unmute yourself"). The cockpit's job is not to show you everything;
it is to know **whose move it is** and to pull you in only when the move is
yours.

## 2. The day in the life (the founding walkthrough)

This is the day the product is designed against — as described by the founder,
lightly compressed:

You start your morning. Overnight or from yesterday, a handful of sessions
exist: a working session in the backend repo, a one-off that fetched
something, a research thread. You press the key and say what you want; you
never type into the cockpit.

Mid-morning, **your manager pings you: production RCA, now.** You speak one
sentence and a session starts digging through logs in the right repo. While it
grinds, you're **on-call and a page lands** — another session, another repo.
Meanwhile the **FIFA World Cup is on**; you asked a session to load the
stream. It loaded it. Is that task "done"? The video is playing — but from
*your* perspective this isn't finished, it's *ready*: the session did its
step and is waiting for what you want next. That's not the same state as an
errand that completed and closed, and it must not be the same state as a
session that hit an error.

Through the day you accumulate: sessions that need an answer from you,
sessions grinding away, one-offs that finished an hour ago, a research session
you want to keep *forever* but not look at *today*, and a wall of skills where
**only two of twelve are ones you actually use** — the good ones buried under
junk touched yesterday. Some cards carry mental context you keep re-deriving:
*which JIRA ticket was this for? what did I mean to do next here?*

The goal for the whole day: **minimal idle time for you**. Not maximal
information — minimal wasted attention. When you press "next", the cockpit
should hand you the one thing that needs you most; when nothing needs you, it
should say so and let you watch the match.

## 3. The principles derived (our take)

**Whose move is it (ball possession).** Every session is at any moment either
*our move* (agent working — leave it alone) or *your move* (blocked on you,
errored, or parked ready awaiting direction). The wall's ONLY prioritization
signal is this. From it falls the queue order: `errored → stuck → needs-user →
ready`, and the rule that `done` is information, never a pull.

**Three kinds of done.** (1) *done* — the errand is over, fades from the wall;
(2) *failed* — over, wrongly; (3) *ready* — the step is over but **the ball is
with you**: the video is loaded, the draft is written, the analysis is up. A
session must be able to say "ready" explicitly (status contract), it never
banners or rings the doorbell (calm), and an *ignored* ready one-off settles to
done after an hour (the decay valve) — a session's open loop stays open until
you close it.

**The crank ("next").** A TikTok-scroll for obligations: each press focuses the
top of the your-move queue. When the queue is empty it says **"✓ all clear —
nothing needs you"** — the honest end state, the moment you're free.

**Attention is pulled, never grabbed.** One spoken headline when a task
becomes actionable (the doorbell — one toggle from silent). Ready never
speaks. Nothing modal, nothing that steals focus.

**Consent policy.** A session you haven't spoken to in >10 minutes is *cold*:
the router may not inject into it; it is focus-only. Long-running work is
never terminated or hijacked by an ambiguous utterance. (Safety policy, three
enforcement layers.)

**Voice is the only paradigm — with bright lines.** No text input on the
stage. No chat-bubble transcript re-rendering. The moment we add those we are
rebuilding the Claude Code / Codex desktop app one abstraction up ("delete the
wall" test: if removing our surface loses nothing over the underlying app, we
built the wrong thing). The terminal is shown *raw* (tmux capture — the real
screen, not a reconstruction) precisely because we refuse to re-render
conversation.

**The wall shows NOW.** Present tense only: done one-offs fade in 15m,
attention states in 60m; the past lives in History. Sessions never fade.
**Shelved** is the deliberate third option: *keep it forever, stop showing it*
— hidden from the grid, exempt from purge, findable in the rail's Shelf.

**Signal over noise, everywhere the eye lands.** Skills ranked by *earned
trust* (pinned first, then confirmed runs, then recency), collapsed to a
trusted top-6. Cards carry your **note** (the JIRA link, the intent for
future-you) — annotation for you, never fed to the agent. Every card carries
its session's own rolling "**where you left off**" so re-entry never cold
starts.

**Neutrality.** Unmute sits above the executor. Claude Code today; anything
tomorrow. We own attention, not execution.

## 4. Where we stand (2026-07-04)

### Built and field-verified
- **Remote core**: voice → router (new / continue / resume / speak) → tasks
  with a status-file contract; session names as voice addresses; typed
  fallback everywhere the contract needs one.
- **The cockpit wall**: grid of session cards + focused stage with the REAL
  terminal (tmux capture-pane snapshot — the "looks like iTerm" fix);
  full/split; per-card queue positions; crank navigation + all-clear beat;
  while-you-were-away digest.
- **Whose-move-is-it shipped end to end**: the `ready` state (contract
  guidance, warm parking, silent resume, restart-safe, kill→failed, decay
  valve), queue ranks, ready never banners.
- **Consent + safety**: cold-session focus-only policy; failsafe never injects
  into RUNNING tasks; router self-heal; resume-routing revives recent
  one-offs; recall pointers (status + transcript paths) for context questions.
- **Attention channels**: doorbell headlines (deterministic TTS, no LLM in the
  speech path, silent-while-capturing); `speak` meta-verb; thread_context
  warm-up strip.
- **Signal over noise**: skills earned-trust ranking + ★ pin + top-6 collapse
  + hover cards; card notes (stage-editable, meta-persisted); the Shelf
  (purge-exempt, restart-safe).
- **Multimodal capture**: staging tray; utterance-scoped screenshot ledger
  with the baseline gate (a pre-dictation clipboard image can NEVER attach);
  verified image pastes; the audio path kept sacred (zero main-process work
  while recording).
- **The noisy-spot hint**: live raise/retract signal on the pill, calibrated
  against real captures.
- 176 automated tests; the meta.json write-race found by a test and fixed
  (serialized merges).

### Known gaps / not started
- **Voice coverage of new affordances**: pin/shelve/note are mouse-only; no
  "pin the changelog skill" / "shelve this" voice verbs yet.
- **History surface**: faded/pruned tasks live in the overlay list, but the
  full "History" browse the vision references is thin.
- **On-call/paging integration**: the day-in-the-life implies external pulls
  (a page arriving AS a card). Nothing exists; needs design (webhook →
  task? MCP?).
- **Skills `runs_confirmed`**: ranking reads it, but nothing *writes* it yet —
  the librarian/graduation pipeline should stamp confirmed runs.
- **Ready-state field validation**: shipped and unit-tested, but the contract
  guidance ("ready vs done") hasn't been observed across many real sessions;
  inflation risk is handled by the decay valve but watch it.
- **Shelf/notes discoverability**: no onboarding moment teaches shelve/note.
- **Multi-display + scaling polish** on the cockpit; the rail beyond ~30
  skills; queue behavior under dozens of simultaneous your-move tasks.
- **Cross-machine / away-from-desk** (the phone leg of the remote story) —
  out of scope for this branch, unforgotten.

### The bar we keep re-testing against
Would deleting the wall lose anything the Claude Code desktop app doesn't
already give? Today the honest answer: yes — the queue, the crank, ready, the
doorbell, voice routing with consent, the shelf, and the attention discipline
are all things no executor app does. Keep it that way.
