import { createLogger } from '../log'
import { devFields } from '../curator-devlog'
import { classifyRetrieval } from './devlog'
import type { AgentTrace } from './trace'
import type { AgentProcessLaunch } from './provider'

/**
 * Where a turn's trace goes.
 *
 * Split from `trace.ts` so the translation stays pure and testable and only
 * this file knows about the logger. It is also the ONE place that decides how
 * much of a turn is worth a line, which is a judgement that will be tuned and
 * should therefore live somewhere findable.
 *
 * ONE COMPONENT, `agent:turn`, so the whole life of a turn can be read with a
 * single grep against the ordinary remote log — beside the key press that
 * started it and the surface that displayed it, which is exactly the
 * correlation a separate log file would destroy.
 */
const log = createLogger('agent:turn')

/**
 * ARGUMENTS ARE NOT SECRETS, BUT ONE OF THEM IS.
 *
 * `--append-system-prompt` carries the entire persona: twelve thousand
 * characters of prompt on every spawn line, which would bury the flags that
 * actually differ between a working turn and a broken one. It is summarised to
 * its length; everything else is kept verbatim, because "what exactly did we
 * run" was the question that took a CLI reproduction to answer.
 */
export function summariseArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--append-system-prompt' && typeof argv[i + 1] === 'string') {
      out.push('--append-system-prompt', `<${argv[i + 1].length} chars>`)
      i += 1
      continue
    }
    out.push(argv[i])
  }
  return out
}

export function agentTraceSinks(provider: string): {
  onTrace: (trace: AgentTrace) => void
  onSpawn: (info: { argv: string[]; cwd: string; session: AgentProcessLaunch['session'] }) => void
} {
  let sessionId: string | undefined
  return {
    onSpawn: ({ argv, cwd, session }) => {
      sessionId = session.id
      // Keep launch mode and flag names, not credential-bearing values.
      log.event('spawn', {
        provider,
        session: session.kind,
        sessionId: session.id ?? null,
        cwd,
        flags: argv.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]),
      })
    },
    onTrace: (trace) => {
      switch (trace.kind) {
        case 'session':
          sessionId = trace.sessionId
          log.event('session', {
            provider,
            sessionId: trace.sessionId,
            model: trace.model,
            tools: trace.tools,
            mcpServers: trace.mcpServers?.join(',') ?? null,
          })
          return
        case 'thinking':
          log.event('thinking', { provider, sessionId, chars: trace.chars })
          return
        case 'says':
          log.event('says', { provider, sessionId, chars: trace.chars })
          return
        case 'tool':
          // Trace every tool, including provider-native tools that bypass MCP.
          //
          // THE ARGUMENT IS THE DECISION. This logged only `inputChars` — that
          // a Grep happened, never what it searched for — and answering "why
          // did it go there instead of the index" then meant opening the
          // transcript every time. Which query, which path, which session id
          // IS the reasoning, as far as anything outside the model can see it.
          //
          // `trace.input` is already clipped to TRACE_INPUT_MAX and passed
          // through redactSecrets by trace.ts, so this carries an argument
          // summary rather than file contents or credentials. `inputChars`
          // stays alongside it, because the clip means length is no longer
          // recoverable from the value.
          log.event('tool-call', {
            provider, sessionId, tool: trace.tool, id: trace.id,
            inputChars: trace.input?.length, ...(trace.input ? { input: trace.input } : {}),
            // DEV-ONLY: which kind of lookup this was, and whether it could
            // only see part of what it asked for (see agent/devlog.ts).
            ...devFields({ retrieval: classifyRetrieval(trace.tool, trace.input ?? '') }),
          })
          return
        case 'toolResult':
          log.event('tool-result', {
            provider, sessionId, id: trace.id, ok: trace.ok, chars: trace.chars,
          })
          return
        case 'result':
          log.event('turn-result', {
            provider, sessionId,
            ok: trace.ok,
            subtype: trace.subtype,
            chars: trace.chars,
            durationMs: trace.durationMs,
            costUsd: trace.costUsd,
            turns: trace.turns,
            ...(trace.usage ?? {}),
          })
          return
        default:
          // Kept rather than dropped: an unrecognised line is how we learn the
          // CLI has started saying something new.
          log.debug('stream line', { type: trace.type })
      }
    },
  }
}
