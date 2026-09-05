import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-file'
import { CodexHub, type CodexHubDeps, type HubPatch, type CodexInputMetadata } from '../codex/hub'
import type { FollowupGate } from '../task-followup'

export type CodexPreparation = {
  bin: string | null; config?: Record<string, unknown>
  cap?: ReturnType<NonNullable<CodexHubDeps['approvalCap']>>
  plans?: Awaited<ReturnType<NonNullable<CodexHubDeps['loadPlans']>>>
  inputMetadata?: CodexInputMetadata[]
}
export type CodexMirror = { taskId: string; patch: HubPatch; gate: FollowupGate; threadId?: string; validationError?: string }
export type CodexRuntimeEvent = { kind: 'patch'; patch: HubPatch; mirror: CodexMirror }
  | { kind: 'followup'; event: Parameters<Parameters<CodexHub['onFollowup']>[0]>[0]; mirror: CodexMirror }
export class CodexRuntimeService {
  readonly hub: CodexHub
  private prepared = new Map<string, CodexPreparation>()
  private patches = new Map<string, HubPatch>()
  private bin: string | null = null
  private writes = new Map<string, Promise<void>>()
  private registrations = new Map<string, Promise<unknown>>()
  constructor(private root: string, private emit: (event: CodexRuntimeEvent) => void, overrides: Pick<CodexHubDeps, 'makeServer'> = {}) {
    this.hub = new CodexHub({
      ...overrides, resolveBin: async () => this.bin,
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
    if (method === 'snapshot') return { running: this.hub.running, url: this.hub.url, tasks: [...this.patches.keys()].map(id => this.mirror(id)) }
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
      case 'startThread': return this.register(id, async () => this.hub.threadIdFor(id) ? { threadId: this.hub.threadIdFor(id), url: this.hub.url } : this.hub.startThread(id, rest[0]))
      case 'resumeThread': return this.register(id, () => this.hub.resumeThread(id, rest[0], rest[1], false))
      case 'forkThread': return this.register(id, () => this.hub.forkThread(id, rest[0], rest[1]))
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
