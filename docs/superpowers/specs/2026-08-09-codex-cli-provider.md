# Codex CLI as a first-class provider

**Branch:** `arpit/codex-cli` · **Worktree:** `.claude/worktrees/codex-cli`
**Goal:** Codex CLI behaves exactly as Claude Code CLI does — same card, same
terminal, same resume, same import rail — differing only where Codex genuinely
differs.

## What already exists (survey, 2026-08-09)

Less is missing than expected.

- `providers.ts` already registers **`codex`** as `surface: 'cli'`,
  `transport: 'pty'`, `hasTerminal: true`, `canResume: true`. The registry entry
  is real; the plumbing behind it is not.
- `CodexExecutor` (`codex-executor.ts`) exists and is a thin, correct wrapper:
  spawns `codex` in an owned PTY and strips `OPENAI_API_KEY` / `OPENAI_API_BASE`
  so work stays on the user's subscription rather than API billing.
- `electron/remote/codex/` already has `rollout.ts`, `hooks.ts` (the approval
  channel), `approval.ts`, `appserver.ts`, `driver.ts`, `reasoning.ts` — but
  these were built for **codex-desktop**. What is reusable and what is
  desktop-only has to be established per file, not assumed.

## What the real CLI gives us (verified against codex-cli 0.142.5)

```
codex [OPTIONS] [PROMPT]          # prompt is positional — dispatch has a home
codex resume <SESSION_ID> [PROMPT]  # by UUID. The analogue of claude --resume
codex resume --last
codex fork <SESSION_ID>           # branch instead of continue
codex -c model="o3"               # model override; -c is a TOML config path
codex exec                        # non-interactive. NOT our path.
```

Two things matter here:

1. **`codex resume <uuid>` exists**, so the resume story is the same shape as
   Claude's `--resume <id>` and can reuse `resolveSessionCwd`-style recovery.
2. **The model is set with `-c model=…`**, not a `--model` flag. Anything that
   builds Claude's argv will produce something Codex silently ignores or
   rejects — this is the most likely source of a quiet wrong-model bug.

Sessions are recorded on disk: `~/.codex/` holds `session_index.jsonl`,
`history.jsonl` and `archived_sessions/rollout-<ts>-<uuid>.jsonl`. 106 on this
machine. `rollout.ts` already parses this family for desktop.

## The gaps, in dependency order

1. **Dispatch.** `buildDispatch`/`dispatch-prompt.ts` is Claude-shaped. Codex
   takes the prompt positionally and its model via `-c`. Needs a Codex arm, not
   a reused one.

2. **Status observation — the hard part.** Claude Code works because Unmute
   installs hooks that write `status.json`, and the observer derives state from
   them. Codex CLI's equivalent must be established: `codex/hooks.ts` is the
   approval channel and may cover part of it, but *turn-ended*, *tool activity*
   and *result text* need a source. Candidates, in order of preference:
   rollout tailing (already parsed for desktop), then the app-server JSON-RPC,
   then polling the transcript. **Decide this before writing anything else** —
   every other piece hangs off how state arrives.

3. **Resume.** Wire `codex resume <id>` into `TaskManager.resume`, which already
   branches on provider. Must inherit the silent-resume rule (never prompt) and
   the cwd self-heal.

4. **Models.** A Codex model list, and `-c model=` plumbing. Where the list
   comes from is open — the desktop path reads it from the app; the CLI may
   expose it via `codex features` or config.

5. **Import rail.** `claude-cli-sessions.ts` is deliberately shaped to take
   another source. Add a Codex scanner over `~/.codex` reading the rollout
   index. Same bounds: recent, real projects, not already imported, not live.

6. **The picker / availability.** `agentAvailability()` must report Codex CLI
   separately from Codex desktop, or the router can promise a backend the user
   does not have.

## Rules this must not break

- **Billing isolation.** Work runs on the user's subscription; the executor
  already strips the API-key env vars. Do not widen that.
- **Resume never prompts.** Established 2026-08-09 for every backend.
- **Import starts nothing.** A card, not a process.
- **One derivation per pass** in the notch controller — do not add a second
  place that answers "what backend is this".

## Status

Worktree and branch created. Research done and recorded above. **No
implementation yet** — item 2 is a genuine unknown and deciding it wrongly
would mean rewriting everything downstream of it.
