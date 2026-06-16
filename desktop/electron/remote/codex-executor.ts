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

/** The agent the executor factory should build (PRD §11 selector). */
export type AgentKind = 'claude' | 'codex'
