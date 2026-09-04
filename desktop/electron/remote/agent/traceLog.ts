import { createLogger } from '../log'
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
  return {
    onSpawn: ({ argv, cwd, session }) => {
      // THE ARGV, EVERY TIME. `--resume` where `--session-id` belonged failed
      // every Agent turn for a day, and the difference was one token nobody
      // was writing down.
      log.event('spawn', {
        provider,
        session: session.kind,
        sessionId: session.id ?? null,
        cwd,
        argv: summariseArgv(argv).join(' '),
      })
    },
    onTrace: (trace) => {
      switch (trace.kind) {
        case 'session':
          log.event('session', {
            provider,
            sessionId: trace.sessionId,
            model: trace.model,
            tools: trace.tools,
            mcpServers: trace.mcpServers?.join(',') ?? null,
          })
          return
        case 'thinking':
          log.event('thinking', { chars: trace.chars, text: trace.text })
          return
        case 'says':
          log.event('says', { chars: trace.chars, text: trace.text })
          return
        case 'tool':
          // The name alone was all the activity event kept, and "using Read"
          // does not say which file, which is the whole question.
          log.event('tool-call', { tool: trace.tool, id: trace.id, input: trace.input })
          return
        case 'toolResult':
          log.event('tool-result', {
            id: trace.id, ok: trace.ok, chars: trace.chars, preview: trace.preview,
          })
          return
        case 'result':
          log.event('turn-result', {
            ok: trace.ok,
            subtype: trace.subtype,
            chars: trace.chars,
            text: trace.text,
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
