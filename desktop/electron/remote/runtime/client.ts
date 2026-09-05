import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeRpcClient } from './rpc'

export function runtimeSocket(root: string): string {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 20)
  return join(tmpdir(), `unmute-runtime-${process.getuid?.() ?? 'user'}-${key}`, 'rpc.sock')
}

/** A per-user-data daemon; dev worktrees do not attach to production runtimes. */
export class PersistentRuntimeClient extends RuntimeRpcClient {
  private starting?: Promise<void>
  constructor(private root: string, private entry: string, private executable = process.execPath) {
    super(runtimeSocket(root))
  }
  override connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    return this.starting ??= this.ensure().finally(() => { this.starting = undefined })
  }
  private async ensure(): Promise<void> {
    try { await super.connect(); return } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error
    }
    const child = spawn(this.executable, [this.entry, this.root], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let spawnError: Error | undefined
    child.once('error', error => { spawnError = error })
    child.unref()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      try { await super.connect(); return } catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Unmute background runtime did not start')
  }
}
