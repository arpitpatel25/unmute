// Unmute Remote — Codex adapter (PRD §11 portability).
//
// The second CLI-agent adapter, proving the executor seam is a config change,
// not a rewrite (PRD §11.3). Same owned-PTY mechanism; the only differences are
// the binary and the billing-env guard (Codex bills via the user's OpenAI
// subscription/login, so we strip OPENAI_API_KEY analogously to how the Claude
// adapter strips ANTHROPIC_API_KEY).
//
// Portability target is OTHER CLI CODING AGENTS ONLY — explicitly NOT raw API
// billing (PRD §11.2). Codex is driven in its interactive REPL, never headless.

import { CliAgentExecutor, type CliAgentConfig } from './pty-session'
import type { SpawnOpts } from './executor'
import { providerOf, type ProviderId } from './providers'

type NodePtyLoader = CliAgentConfig['ptyLoader']

export interface CodexExecutorOpts {
  codexBin?: string
  /** Attach the TUI to an App Server thread instead of starting its own.
   *  `codex resume <threadId> --remote <url>` — the terminal view of a thread
   *  the protocol already owns. Without the thread id the TUI would open a
   *  SECOND conversation on the same server and the terminal would show a
   *  session unrelated to the card around it. */
  remote?: { url: string; threadId: string }
  extraArgs?: string[]
  ptyLoader?: NodePtyLoader
  /** Model to run on, e.g. 'gpt-5.6-terra'. Codex takes it as TOML config, not
   *  a flag. Verified against `codex config.toml`, key `model`. */
  model?: string
  /** Reasoning effort, as a WIRE value ('xhigh', not 'Extra High'). Codex's key
   *  is `model_reasoning_effort`, and it is a property OF the model — Sol and
   *  Terra offer six levels, Luna five — so it is only sent alongside one. */
  effort?: string
}

/**
 * CODEX'S ARGV, WHICH IS NOT CLAUDE'S.
 *
 * The same three ideas, spelled entirely differently (verified against
 * codex-cli 0.142.5):
 *
 *   fork   → codex fork <id>       Claude: --resume <id> --fork-session
 *   resume → codex resume <id>     Claude: --resume <id>
 *   fresh  → (nothing)             Claude: --session-id <id>
 *
 * SUBCOMMANDS, NOT FLAGS, and that distinction is the whole reason this exists.
 * Codex forwards unrecognised options to its interactive CLI rather than
 * failing, so feeding it `--resume <uuid>` does not error — it opens a FRESH
 * conversation and silently drops the context the resume was for. A resume that
 * looks like it worked and lost your history is worse than one that refuses.
 *
 * AND THE SESSION ID CANNOT BE PINNED. Claude accepts `--session-id` so we mint
 * the id and know it up front. Codex mints its own, so a fresh spawn passes
 * nothing and the id is learned afterwards from the rollout — which is where
 * every other fact about a Codex session comes from anyway (cli-observer.ts).
 *
 * The model is `-c model="…"`, a dotted TOML override matching the key in
 * ~/.codex/config.toml, with `-c model_reasoning_effort="…"` beside it. (0.147
 * does also accept `-m/--model`; the TOML form is used because it spells both
 * halves the same way and matches what the user's own config file holds.)
 *
 * THE IDS ARE NOT WRITTEN DOWN ANYWHERE IN UNMUTE. They come from Codex itself
 * at read time (codex/cli-models.ts) — a hardcoded list shipped once and every
 * id in it was wrong, which does not fail at the picker: `-c model="anything"`
 * is valid TOML, so the task starts and dies at the API.
 */
export function codexArgs(o: SpawnOpts, base: readonly string[]): string[] {
  if (o.forkFromSessionId) return ['fork', o.forkFromSessionId, ...base]
  if (o.resumeSessionId) return ['resume', o.resumeSessionId, ...base]
  return [...base]   // fresh: Codex mints the id itself
}

/** The model/effort overrides a PTY spawn carries. Skipped entirely when the
 *  TUI is attaching to an App Server thread: that thread was created WITH its
 *  model and posture, and repeating them on the client would be a second
 *  source of truth for a decision already made. */
function modelArgs(o: CodexExecutorOpts): string[] {
  if (o.remote) return []
  return [
    ...(o.model ? ['-c', `model="${o.model}"`] : []),
    ...(o.model && o.effort ? ['-c', `model_reasoning_effort="${o.effort}"`] : []),
  ]
}

export class CodexExecutor extends CliAgentExecutor {
  constructor(opts: CodexExecutorOpts = {}) {
    super({
      bin: opts.codexBin || 'codex',
      extraArgs: [
        // ATTACHED, NOT FRESH. Order matters: `resume <id>` is a subcommand, so
        // codexArgs puts it first and these follow as its options.
        ...(opts.remote ? ['--remote', opts.remote.url] : []),
        ...modelArgs(opts),
        ...(opts.extraArgs || []),
      ],
      buildArgs: codexArgs,
      // Keep Codex on the subscription/login pool, not API billing.
      stripEnvVars: ['OPENAI_API_KEY', 'OPENAI_API_BASE'],
      ptyLoader: opts.ptyLoader,
      label: 'codex',
    })
  }
}

/** The agent the executor factory should build (PRD §11 selector).
 *
 *  Now an alias of ProviderId: the registry in providers.ts is the source of
 *  truth for what each backend IS and what it can do. The name is kept because
 *  ~130 call sites and the persisted meta.json speak of `agent`.
 *
 *  'claude'        — Claude Code CLI in an Unmute-owned PTY (the default).
 *  'codex'         — Codex CLI in an Unmute-owned PTY (same mechanism).
 *  'codex-desktop' — the Codex DESKTOP app. Not an executor at all: Unmute owns
 *    no process, so there is no PTY to build. It is handled by the Codex driver
 *    (codex/driver.ts) — writes via CDP into the app the user actually sees,
 *    state read from the rollout files on disk. `executorFactory` is never
 *    called for it; `TaskManager.dispatch` branches before that point. */
export type AgentKind = ProviderId

/** True for backends Unmute drives as an external app rather than an owned PTY.
 *
 *  Reads the registry rather than naming Codex, so the answer stays right when a
 *  backend is added — the ~13 callers of this helper need no edit. */
export function isExternalAgent(agent: AgentKind | undefined): boolean {
  return providerOf(agent).transport === 'driver'
}
