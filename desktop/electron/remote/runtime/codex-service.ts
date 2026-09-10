import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-file'
import { CodexHub, type CodexHubDeps, type HubPatch, type CodexInputMetadata } from '../codex/hub'
import { CodexAppServer } from '../codex/app-server-client'
import type { FollowupGate } from '../task-followup'

export type CodexPreparation = {
  bin: string | null; config?: Record<string, unknown>
  cap?: ReturnType<NonNullable<CodexHubDeps['approvalCap']>>
  plans?: Awaited<ReturnType<NonNullable<CodexHubDeps['loadPlans']>>>
  inputMetadata?: CodexInputMetadata[]
}
export type CodexMirror = { taskId: string; patch: HubPatch; gate: FollowupGate; threadId?: string; validationError?: string }
export type CodexIdentity = { taskId: string; threadId: string; forkedFromId?: string }
export type CodexRuntimeEvent = { kind: 'patch'; patch: HubPatch; mirror: CodexMirror }
  | { kind: 'followup'; event: Parameters<Parameters<CodexHub['onFollowup']>[0]>[0]; mirror: CodexMirror }
export class CodexRuntimeService {
  readonly hub: CodexHub
  private prepared = new Map<string, CodexPreparation>()
  private patches = new Map<string, HubPatch>()
  private bin: string | null = null
  private writes = new Map<string, Promise<void>>()
  private registrations = new Map<string, Promise<unknown>>()
  private forks = new Map<string, { source: string; result: Promise<unknown> }>()
  constructor(private root: string, private emit: (event: CodexRuntimeEvent) => void, overrides: Pick<CodexHubDeps, 'makeServer'> = {}) {
    this.hub = new CodexHub({
      ...overrides,
      makeServer: overrides.makeServer ?? (bin => new CodexAppServer({ bin, ownerFile: join(this.root, 'app-server-owner.json') })),
      resolveBin: async () => this.bin,
      onForkConfirmed: async (id, result, operationId) => {
        // The canonical identity is the first durable commit after Codex
        // confirms a fork. The UI task record may be written later or the GUI
        // may crash; recovery must still select this exact child.
        await this.saveIdentity({ taskId: id, ...result })
        await this.save(id, result.forkedFromId, operationId ? `fork:${operationId}` : 'fork', () => result)
      },
      threadConfig: async id => this.prepared.get(id)?.config ?? {},
      approvalCap: id => this.prepared.get(id)?.cap ?? { roots: [], fullAccessAllowed: false },
      loadPlans: (id, thread) => this.read(id, thread, 'plans', []),
      savePlans: (id, thread, plans) => this.save(id, thread, 'plans', () => plans),
      loadInputMetadata: (id, thread) => this.read(id, thread, 'input', []),
      saveInputMetadata: (id, thread, record) => this.save(id, thread, 'input', (records: CodexInputMetadata[]) => [...records.filter(r => r.id !== record.id), record]),
      onPatch: patch => {
        const merged = { ...this.patches.get(patch.taskId), ...patch }
        if (patch.clearQuestion) delete merged.question
        else if (patch.question) delete merged.clearQuestion
        delete merged.assistantText // replay full blocks, never append an old delta twice
        this.patches.set(patch.taskId, merged)
        queueMicrotask(() => this.emit({ kind: 'patch', patch, mirror: this.mirror(patch.taskId) }))
      },
    })
    this.hub.onFollowup(event => {
      const id = event.type === 'ended' ? event.event.taskId : event.taskId
      queueMicrotask(() => this.emit({ kind: 'followup', event, mirror: this.mirror(id) }))
    })
  }
  private file(id: string, thread: string, kind: string): string {
    return join(this.root, createHash('sha256').update(JSON.stringify([id, thread, kind])).digest('hex') + '.json')
  }
  private identityFile(id: string): string {
    return join(this.root, `identity-${createHash('sha256').update(id).digest('hex')}.json`)
  }
  private async saveIdentity(identity: CodexIdentity): Promise<void> {
    const file = this.identityFile(identity.taskId)
    const write = (this.writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      let existing: CodexIdentity | null = null
      try { existing = JSON.parse(await readFile(file, 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (existing && (existing.threadId !== identity.threadId || existing.forkedFromId !== identity.forkedFromId)) {
        throw new Error('Canonical Codex identity cannot change')
      }
      await writeFileAtomic(file, JSON.stringify(identity))
    })
    this.writes.set(file, write)
    await write
  }
  private async identity(id: string, expectedSource?: string): Promise<CodexIdentity | null> {
    let identity: CodexIdentity | null = null
    try { identity = JSON.parse(await readFile(this.identityFile(id), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!identity) {
      // Upgrade path: older builds persisted fork confirmations under opaque
      // operation hashes. Recover only an unambiguous source→child mapping and
      // immediately promote it to the canonical task record.
      const candidates = new Map<string, CodexIdentity>()
      for (const file of await readdir(this.root).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })) {
        if (!file.endsWith('.json') || file.startsWith('identity-')) continue
        try {
          const value = JSON.parse(await readFile(join(this.root, file), 'utf8'))
          if (typeof value?.threadId === 'string' && typeof value?.forkedFromId === 'string'
            && (!expectedSource || value.forkedFromId === expectedSource) && value.threadId !== value.forkedFromId) {
            candidates.set(`${value.forkedFromId}\0${value.threadId}`, { taskId: id, threadId: value.threadId, forkedFromId: value.forkedFromId })
          }
        } catch { /* unrelated or incomplete durable record */ }
      }
      if (candidates.size > 1) throw new Error('Ambiguous durable Codex fork identity')
      identity = [...candidates.values()][0] ?? null
      if (identity) await this.saveIdentity(identity)
    }
    if (!identity || identity.taskId !== id) return null
    if (expectedSource && identity.forkedFromId !== expectedSource && identity.threadId !== expectedSource) {
      throw new Error('Canonical Codex identity contradicts the requested source')
    }
    return identity
  }
  private async read<T>(id: string, thread: string, kind: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(this.file(id, thread, kind), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
  }
  private save<T>(id: string, thread: string, kind: string, update: (old: T) => T): Promise<void> {
    const file = this.file(id, thread, kind)
    const write = (this.writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await writeFileAtomic(file, JSON.stringify(update(await this.read(id, thread, kind, [] as T))))
    })
    this.writes.set(file, write)
    return write
  }
  private mirror(taskId: string): CodexMirror {
    return { taskId, patch: this.patches.get(taskId) ?? { taskId }, gate: this.hub.followupGate(taskId), threadId: this.hub.threadIdFor(taskId), validationError: this.hub.validationErrorFor(taskId) }
  }
  private register(id: string, action: () => Promise<unknown>): Promise<unknown> {
    const current = this.registrations.get(id)
    const pending = (current ?? Promise.resolve()).catch(() => {}).then(action).finally(() => {
      if (this.registrations.get(id) === pending) this.registrations.delete(id)
    })
    this.registrations.set(id, pending)
    return pending
  }
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    const [id, ...rest] = args as any[]
    if (method === 'snapshot') return { running: this.hub.running, url: this.hub.url,
      tasks: [...this.patches.keys()].filter(key => !id || key === id).map(id => this.mirror(id)) }
    if (method === 'prepare') {
      const p = rest[0] as CodexPreparation
      this.bin = p.bin; this.prepared.set(id, p)
      const thread = rest[1] as string | undefined
      if (thread) {
        if (p.plans?.length) await this.save(id, thread, 'plans', (old: unknown[]) => old.length ? old : p.plans!)
        if (p.inputMetadata?.length) await this.save(id, thread, 'input', (old: unknown[]) => old.length ? old : p.inputMetadata!)
      }
      return true
    }
    switch (method) {
      case 'identity': return this.identity(id, rest[0])
      case 'forkResult': {
        const operationId = rest[1] as string | undefined
        const key = JSON.stringify([id, operationId ?? null])
        const kind = operationId ? `fork:${operationId}` : 'fork'
        const previous = this.forks.get(key)
        if (previous && previous.source !== rest[0]) throw new Error('Fork operation cannot change its source')
        const receipt = await this.read(id, rest[0], kind, null)
        if (receipt) return receipt
        if (previous) {
          try { return await previous.result } catch { /* read the durable provider identity below */ }
        }
        return this.read(id, rest[0], kind, null)
      }
      case 'startThread': return this.register(id, async () => this.hub.threadIdFor(id) ? { threadId: this.hub.threadIdFor(id), url: this.hub.url } : this.hub.startThread(id, rest[0]))
      case 'resumeThread': return this.register(id, () => this.hub.resumeThread(id, rest[0], rest[1], rest[2] === true))
      case 'rollbackLatestTurn': return this.register(id, () => this.hub.rollbackLatestTurn(id, rest[0]))
      case 'forkThread': {
        const operationId = rest[2] as string | undefined
        const key = JSON.stringify([id, operationId ?? null])
        const kind = operationId ? `fork:${operationId}` : 'fork'
        const previous = this.forks.get(key)
        if (previous) {
          if (previous.source !== rest[0]) throw new Error('Fork operation cannot change its source')
          return previous.result
        }
        const result = this.register(id, async () => {
          const receipt = await this.read<{ threadId: string; forkedFromId: string } | null>(id, rest[0], kind, null)
          if (receipt) {
            if (!receipt.threadId || receipt.threadId === rest[0] || receipt.forkedFromId !== rest[0]) throw new Error('Invalid durable fork identity')
            await this.hub.resumeThread(id, receipt.threadId, rest[1])
            return receipt
          }
          return this.hub.forkThread(id, rest[0], rest[1], operationId)
        })
        this.forks.set(key, { source: rest[0], result })
        return result
      }
      case 'send': return this.hub.send(id, rest[0], rest[1])
      case 'sendNewTurn': return this.hub.sendNewTurn(id, rest[0], rest[1], rest[2])
      case 'answer': { const accepted = this.hub.answer(id, rest[0], rest[1]); return { accepted, mirror: this.mirror(id) } }
      case 'interrupt': return this.hub.interrupt(id)
      case 'stopAndRelease': return this.hub.stopAndRelease(id)
      case 'rename': return this.hub.rename(id, rest[0])
      case 'release': this.hub.release(id); this.patches.delete(id); this.prepared.delete(id); return true
      case 'selfCheck': return this.hub.selfCheck()
      default: throw new Error('Unknown Codex runtime command')
    }
  }
  close(): void { this.hub.stop() }
}
