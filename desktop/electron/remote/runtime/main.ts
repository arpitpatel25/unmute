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
    if (method === 'runtime.info') return { version: 4, pid: process.pid, capabilities: ['codex.forkThread', 'codex.forkResult', 'codex.targetedSnapshot', 'codex.editLatestMessage', 'claude.resumeSessionAt'] }
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
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
