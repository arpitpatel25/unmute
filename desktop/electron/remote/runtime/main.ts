import { join, isAbsolute } from 'node:path'
import { RuntimeRpcServer } from './rpc'
import { runtimeSocket } from './client'
import { ClaudeRuntimeService } from './claude-service'
import { CodexRuntimeService } from './codex-service'
import { ComputerRuntimeService } from './computer-service'
import { RuntimeHostBridge } from './host-bridge'
import { AgentRuntimeService } from './agent-service'
import { RuntimeTaskIntercom } from './task-intercom'
import { configureRemoteLogging, setConsoleMirror } from '../log'
import { diagnostic, diagnosticError } from '../diagnostics'

async function main(): Promise<void> {
  const root = process.argv[2]
  if (!root || !isAbsolute(root)) throw new Error('Runtime requires an absolute storage root')
  // Detached workers have ignored stdio. Their own sink must exist before any
  // provider or tool starts, independently of the GUI's logging lifetime.
  configureRemoteLogging({ dir: join(root, 'logs'), runId: `runtime-${process.pid}-${Date.now()}`, synchronous: true })
  setConsoleMirror(false)
  diagnostic('runtime-started', { root, protocolVersion: 3 })
  process.on('uncaughtExceptionMonitor', error => diagnostic('runtime-uncaught-exception', diagnosticError(error)))
  process.on('exit', code => diagnostic('runtime-exit', { code }))
  // Providers are created lazily after the exclusive listening socket is held.
  let claude: ClaudeRuntimeService | undefined
  let codex: CodexRuntimeService | undefined
  let agent: AgentRuntimeService | undefined
  const host = new RuntimeHostBridge(request => server.emit('host.request', request))
  const intercom = new RuntimeTaskIntercom((method, args) => host.call(method, args))
  const computer = new ComputerRuntimeService(event => server.emit('computer.activity', event))
  const server = new RuntimeRpcServer(runtimeSocket(root), async (method, args) => {
    if (method === 'runtime.info') return { version: 4, pid: process.pid, capabilities: ['codex.forkThread', 'codex.forkResult', 'codex.targetedSnapshot', 'codex.identity', 'codex.releaseIdle', 'claude.resumeSessionAt'] }
    if (method === 'hello') { host.connected(); return { version: 1, pid: process.pid } }
    if (method === 'host.accept') return host.accept(String(args[0]))
    if (method === 'host.response') return host.response(String(args[0]), args[1], args[2] as string | undefined)
    if (method === 'task.register') return intercom.register(String(args[0]), String(args[1]))
    if (method.startsWith('agent.')) {
      agent ??= new AgentRuntimeService(join(root, '..', 'unmute-agent'), event => server.emit('agent.event', event), (method, args) => host.call(method, args))
      return agent.invoke(method.slice('agent.'.length), args)
    }
    if (method === 'computer.configure') return computer.configure(args[0] as Parameters<ComputerRuntimeService['configure']>[0])
    if (method.startsWith('codex.')) {
      codex ??= new CodexRuntimeService(join(root, 'codex'), event => server.emit('codex.event', event))
      return codex.invoke(method.slice('codex.'.length), args)
    }
    if (method.startsWith('claude.')) {
      claude ??= new ClaudeRuntimeService(join(root, 'claude'), event => server.emit('claude.event', event))
      return claude.invoke(method.slice('claude.'.length), args)
    }
    throw new Error('Unknown runtime command')
  })
  await server.listen()
  const shutdown = () => {
    diagnostic('runtime-shutdown-started', {})
    claude?.close(); codex?.close(); computer.close(); intercom.close()
    void Promise.resolve(agent?.close()).finally(() => server.close()).finally(() => process.exit(0))
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  // A DAEMON THAT HOLDS NOTHING SHOULD NOT BE RUNNING.
  //
  // Once the session reaper has let go of everything, this process is an empty
  // shell that outlives every app launch — and there is one per runtime ROLE,
  // so they accumulate quietly over months. Six were found alive on 2026-09-09,
  // the oldest twenty hours old, still holding finished conversations.
  //
  // SAFE BY CONSTRUCTION, because the client already handles our absence: a
  // connect that fails with ENOENT/ECONNREFUSED spawns a fresh runtime (see
  // runtime/client.ts). Exiting therefore costs a cold start on the next
  // message and nothing else — no lost work, no lost conversation.
  //
  // CONSERVATIVE ON PURPOSE. It exits only when Claude has no sessions AND
  // nothing is mid-turn AND no other provider was ever asked for. A runtime
  // that has done Codex or Agent work stays up: those services keep state this
  // check cannot see, and guessing wrong there would interrupt real work to
  // save a few megabytes.
  let emptySince = Date.now()
  const idleExit = setInterval(() => {
    const holding = (claude?.sessionCount ?? 0) > 0 || claude?.busy === true
      || codex !== undefined || agent !== undefined
    if (holding) { emptySince = Date.now(); return }
    const emptyFor = Date.now() - emptySince
    if (emptyFor < IDLE_EXIT_MS) return
    diagnostic('runtime-idle-exit', { emptyMs: emptyFor })
    shutdown()
  }, 5 * 60_000)
  ;(idleExit as { unref?: () => void }).unref?.()
}

/**
 * How long a runtime may sit holding nothing before it stands down. Generous:
 * the cost of being wrong is a cold start, but the cost of thrashing is a
 * respawn on every message, so this wants to be well past any normal gap
 * between turns.
 */
const IDLE_EXIT_MS = 30 * 60_000
void main().catch(error => { console.error(error); process.exitCode = 1 })
