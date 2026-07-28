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
import { providerOf, type ProviderId } from './providers'

type NodePtyLoader = CliAgentConfig['ptyLoader']

export interface CodexExecutorOpts {
  codexBin?: string
  extraArgs?: string[]
  ptyLoader?: NodePtyLoader
}

export class CodexExecutor extends CliAgentExecutor {
  constructor(opts: CodexExecutorOpts = {}) {
    super({
      bin: opts.codexBin || 'codex',
      extraArgs: opts.extraArgs || [],
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
