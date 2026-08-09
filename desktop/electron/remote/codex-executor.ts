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
  extraArgs?: string[]
  ptyLoader?: NodePtyLoader
  /** Model to run on, e.g. 'o3'. Codex takes it as TOML config, not a flag. */
  model?: string
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
 * The model is `-c model="…"`, a dotted TOML override, NOT `--model`. Same
 * failure mode: pass `--model o3` and Codex takes it as a prompt, so the task
 * runs on the default model and appears to have worked.
 */
export function codexArgs(o: SpawnOpts, base: readonly string[]): string[] {
  if (o.forkFromSessionId) return ['fork', o.forkFromSessionId, ...base]
  if (o.resumeSessionId) return ['resume', o.resumeSessionId, ...base]
  return [...base]   // fresh: Codex mints the id itself
}

export class CodexExecutor extends CliAgentExecutor {
  constructor(opts: CodexExecutorOpts = {}) {
    super({
      bin: opts.codexBin || 'codex',
      extraArgs: [
        ...(opts.model ? ['-c', `model="${opts.model}"`] : []),
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
