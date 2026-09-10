import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from '../task-manager'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'
import { CompatibleCodexRuntime } from './codex-routing'
import { fileOwnershipStore } from './codex-ownership'
import { PersistentCodexHub } from './codex-client'
import { codexIdentityFile } from './codex-identity'

for (const staleBinding of [false, true]) test(`verified job recovery without replay (stale binding: ${staleBinding})`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-job-'))
  const id = 'old-job', home = join(root, 'local', id)
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'meta.json'), JSON.stringify({ id, intent: 'Original job request', name: 'Job listing',
    cwd: root, agent: 'codex', sessionId: 'parent', codexRolloutId: 'parent', state: 'failed', kind: 'session',
    sessionOwnership: 'unmute', chatUnstarted: false,
    codexSessionSettings: { cwd: root, approvalPolicy: 'on-request', sandbox: 'workspace-write' } }))
  const receipts = join(root, 'runtime', 'continuity-v4', 'codex')
  await mkdir(receipts, { recursive: true })
  await writeFile(join(receipts, `${'1'.repeat(64)}.json`), JSON.stringify({ threadId: 'child', forkedFromId: 'parent' }))
  // Explicitly verified migration of the old operation. Anonymous receipts
  // alone are insufficient to associate a child with this task.
  await writeFile(codexIdentityFile(receipts, id), JSON.stringify({ taskId: id, threadId: 'child', forkedFromId: 'parent' }))
  const store = fileOwnershipStore(join(root, 'runtime'), 'continuity-v4')
  store.remember(id)
  let bound = staleBinding ? 'parent' : ''
  let released = false
  const resumed: string[] = []
  const old = new RuntimeRpcServer(join(root, 'old.sock'), async method => {
    if (method === 'codex.snapshot') return { running: true, url: '', tasks: [] }
    throw new Error(`Wrong worker: ${method}`)
  })
  const survivor = new RuntimeRpcServer(join(root, 'survivor.sock'), async (method, args) => {
    if (method === 'codex.identity') throw new Error('Unknown Codex runtime command')
    if (method === 'codex.releaseIdle' && staleBinding) { assert.equal(args[1], bound); released = true; bound = ''; return true }
    if (method === 'codex.prepare') return true
    if (method === 'codex.resumeThread') {
      // Old hub shortcut: an existing mapping acknowledges ANY thread unless forced.
      if (bound && args[3] !== true) return true
      resumed.push(String(args[1])); bound = String(args[1]); return true
    }
    if (method === 'codex.snapshot') return { running: true, url: '', tasks: [{ taskId: id, threadId: bound,
      gate: { kind: 'idle', blocked: false }, patch: { taskId: id, state: 'done', history: { phase: 'ready' },
        blocks: bound ? [{ kind: 'message', role: 'assistant', text: bound === 'child' ? 'Recovered job result' : 'Stale parent' }] : [] } }] }
    throw new Error(`Recovery must not send work or fork: ${method}`)
  })
  await old.listen(); await survivor.listen()
  const a = new RuntimeRpcClient(join(root, 'old.sock')), b = new RuntimeRpcClient(join(root, 'survivor.sock'))
  const router = new CompatibleCodexRuntime(a, b, store)
  let manager!: TaskManager
  const hub = new PersistentCodexHub(router, { resolveBin: async () => '/codex', onPatch: patch => manager?.applyHubPatch(patch) })
  manager = new TaskManager({ baseDir: root, executorFactory() { throw new Error('No terminal fallback') }, codexHub: hub })
  t.after(async () => { manager.shutdown(); hub.stop(); router.disconnect(); a.disconnect(); b.disconnect(); await old.close(); await survivor.close(); await Promise.all([...(manager as any).metaChains.values()]); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) })
  await hub.reconnect()
  await manager.rehydrate()
  assert.equal(manager.get(id)?.sessionId, 'child')
  assert.equal(JSON.parse(await readFile(join(home, 'meta.json'), 'utf8')).codexRolloutId, 'child')
  await hub.reconnect()
  assert.ok(!manager.get(id)?.blocks?.some(block => block.kind === 'message' && block.text === 'Stale parent'))
  assert.equal(await manager.resume(id), true)
  assert.equal(released, staleBinding, 'retire a stale notification mapping before attaching the child')
  assert.deepEqual(resumed, ['child'])
  assert.equal(manager.get(id)?.state, 'done')
  assert.equal(manager.get(id)?.history?.phase, 'ready')
  assert.ok(manager.get(id)?.blocks?.some(block => block.kind === 'message' && block.text === 'Recovered job result'))
})
