import { mkdir, stat, access, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { AgentRunSupervisor } from '../agent/supervisor'
import { AgentTokenStore } from '../agent/tokens'
import { AgentJournal } from '../agent/journal'
import { UnmuteAgentController, type AgentInteractionActivity, type AgentInteractionResult } from '../agent/controller'
import { AgentConversationLifecycle, type AgentConversationView } from '../agent/lifecycle'
import { AgentConversationStore } from '../agent/conversation-store'
import { ClaudeCodeProvider } from '../agent/providers/claude'
import { CodexCliProvider } from '../agent/providers/codex'
import type { AgentProvider, AgentProviderId, ProviderProbe } from '../agent/provider'
import { CapabilityRegistry } from '../agent/capabilities/registry'
import { MemoryCapability } from '../agent/capabilities/memory'
import { HistoryCapability } from '../agent/capabilities/history'
import { SessionsCapability } from '../agent/capabilities/sessions'
import { HandoffCapability } from '../agent/capabilities/handoff'
import { NotetakerCapability } from '../agent/capabilities/notetaker'
import { DeliveryCapability, type AttachmentDeliveryTransaction, type DeliveryAttachmentMetadata } from '../agent/capabilities/delivery'
import { MemoryCrypto } from '../agent/memory/crypto'
import { EncryptedRecordStore } from '../agent/memory/record-store'
import { InteractionAttachmentHandles, EncryptedAttachmentStore } from '../agent/memory/attachments'
import { MemoryService } from '../agent/memory/service'
import { JsonlMemoryAudit } from '../agent/memory/audit'
import { DurableMemoryMutationJournal } from '../agent/memory/journal'
import { openSqlCipherMemoryIndex } from '../agent/memory/sqlcipher-index'
import { loadPersona } from '../agent/persona'
import { agentConstitution } from '../agent/constitution'
import { SESSION_PREAMBLE } from '../session-policy'
import { startMcpServer, MCP_PATH, type McpServer } from '../mcp-server'
import { createLogger } from '../log'
import { diagnostic } from '../diagnostics'

export type AgentRuntimeConfig = { masterKey: string; selectedProvider: AgentProviderId; maxActiveProcesses?: number; conversationCeiling?: number; notetaker?: boolean }
export type AgentRuntimeEvent = { kind: 'view'; view: AgentConversationView } | { kind: 'activity'; activity: AgentInteractionActivity }
  | { kind: 'completion'; submissionId: string; result: AgentInteractionResult }
export type AgentHostCall = (method: string, args: unknown[]) => Promise<any>
export class AgentRuntimeService {
  private key?: Buffer
  private supervisor?: AgentRunSupervisor
  private controller?: UnmuteAgentController
  private lifecycle?: AgentConversationLifecycle
  private index?: ReturnType<typeof openSqlCipherMemoryIndex>
  private mcp?: McpServer
  private config?: Omit<AgentRuntimeConfig, 'masterKey'>
  private configuring?: Promise<unknown>
  private providers: Map<AgentProviderId, AgentProvider>
  private probes: ProviderProbe[] = []
  private completions = new Map<string, AgentInteractionResult>()
  private activity?: AgentInteractionActivity
  private records?: EncryptedRecordStore
  private memory?: MemoryService
  constructor(private root: string, private emit: (event: AgentRuntimeEvent) => void, private host: AgentHostCall,
    providers?: Map<AgentProviderId, AgentProvider>, private openIndex = openSqlCipherMemoryIndex) {
    this.providers = providers ?? new Map<AgentProviderId, AgentProvider>([
      ['claude', new ClaudeCodeProvider({ runtime: 'persistent' })], ['codex', new CodexCliProvider({ runtime: 'persistent' })],
    ])
  }
  private async configure(input: AgentRuntimeConfig): Promise<unknown> {
    if (this.lifecycle) {
      const providerChanged = this.config!.selectedProvider !== input.selectedProvider
      this.config!.selectedProvider = input.selectedProvider
      this.config!.conversationCeiling = input.conversationCeiling
      if (providerChanged) await this.lifecycle.requestProvider(input.selectedProvider)
      return this.snapshot()
    }
    if (this.configuring) return this.configuring
    this.configuring = this.initialize(input).finally(() => { this.configuring = undefined })
    return this.configuring
  }
  private async initialize(input: AgentRuntimeConfig): Promise<unknown> {
    const key = Buffer.from(input.masterKey, 'base64')
    if (key.length !== 32) { key.fill(0); throw new Error('Agent memory requires a 32-byte master key') }
    this.key = key
    const { masterKey: _secret, ...config } = input
    this.config = config
    try {
      const memoryRoot = join(this.root, 'memory')
      await mkdir(join(memoryRoot, 'index'), { recursive: true, mode: 0o700 })
      const crypto = new MemoryCrypto({ keyProvider: { getMasterKey: async () => Buffer.from(this.key!) } })
      this.index = this.openIndex({ databasePath: join(memoryRoot, 'index', 'memory.sqlite'), key, recoverCorruption: true })
      const handles = new InteractionAttachmentHandles()
      const records = new EncryptedRecordStore({ root: memoryRoot, crypto })
      this.records = records
      const attachments = new EncryptedAttachmentStore({ root: memoryRoot, crypto, handles })
      const memory = new MemoryService({ records, attachments, index: this.index,
        audit: new JsonlMemoryAudit({ root: memoryRoot }), journal: new DurableMemoryMutationJournal({ root: memoryRoot }),
        keepFile: async (principal, input) => {
          const path = input.path.startsWith('~') ? join(homedir(), input.path.slice(1)) : input.path
          if (!isAbsolute(path) || !(await stat(path)).isFile()) throw new Error('That path is not a regular file')
          await access(path, constants.R_OK)
          return handles.mintCapture(principal, { path, name: input.name ?? basename(path) })
        },
      })
      await memory.initialize()
      this.memory = memory
      const tokens = new AgentTokenStore()
      const journal = new AgentJournal({ root: join(this.root, 'runtime') })
      const constitutionPath = join(this.root, 'runtime', 'constitution.md')
      const prepareFresh = async () => {
        const persona = await loadPersona(join(this.root, 'agent'))
        await mkdir(dirname(constitutionPath), { recursive: true, mode: 0o700 })
        await writeFile(constitutionPath, agentConstitution(SESSION_PREAMBLE, persona.text), { mode: 0o600 })
      }
      await prepareFresh()
      const registry = new CapabilityRegistry([
        new MemoryCapability(memory),
        new HistoryCapability({ recent: ms => this.host('history.recent', [ms]), copy: id => this.host('history.copy', [id]) }),
        new SessionsCapability({
          createWorkspace: group => this.host('sessions.createWorkspace', [group]),
          workspaces: () => this.host('sessions.workspaces', []),
          open: input => this.host('sessions.open', [input]),
          close: input => this.host('sessions.close', [input]),
          resume: input => this.host('sessions.resume', [input]),
          fork: input => this.host('sessions.fork', [input]),
        }),
        new HandoffCapability({ createTask: input => this.host('handoff.createTask', [input]), taskStatus: id => this.host('handoff.taskStatus', [id]) }),
        ...(config.notetaker ? [new NotetakerCapability({ list: limit => this.host('notetaker.list', [limit]), search: (q, limit) => this.host('notetaker.search', [q, limit]), read: id => this.host('notetaker.read', [id]), open: id => this.host('notetaker.open', [id]) })] : []),
        new DeliveryCapability({ resolveAttachment: (principal, handle) => attachments.resolveForDelivery(principal, handle),
          copyText: text => this.host('delivery.copyText', [text]), prepareTaskDraftText: (id, text) => this.host('delivery.prepareTaskDraftText', [id, text]),
          openAttachmentFile: metadata => this.transaction('delivery.openAttachmentFile', metadata),
          stageAttachmentCopy: metadata => this.transaction('delivery.stageAttachmentCopy', metadata),
          stageTaskDraftAttachment: (id, metadata) => this.transaction('delivery.stageTaskDraftAttachment', metadata, id),
        }),
      ])
      const selectedProvider = () => this.config!.selectedProvider
      this.supervisor = new AgentRunSupervisor({ providers: this.providers, tokenStore: tokens, journal, selectedProvider, maxActiveProcesses: config.maxActiveProcesses,
        log: (event, data) => createLogger('agent-runtime').event(event, data) })
      this.controller = new UnmuteAgentController({ supervisor: this.supervisor, tokens, attachmentHandles: handles, journal, capabilities: registry, selectedProvider,
        runtime: () => {
          const endpoint = `http://127.0.0.1:${this.mcp!.port}${MCP_PATH}`
          return { cwd: dirname(constitutionPath), constitutionPath, environment: process.env,
            mcp: { endpoint, config: JSON.stringify({ mcpServers: { unmute: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer ${UNMUTE_MCP_TOKEN}' } } } }) } }
        }, onActivity: activity => {
          this.activity = activity
          diagnostic('agent-interaction-activity', { interactionId: activity.interactionId, runId: activity.agentRunId,
            provider: activity.provider, kind: activity.kind })
          this.emit({ kind: 'activity', activity })
        },
      })
      this.mcp = await startMcpServer({ resolveCaller: token => token ? tokens.resolve(token) : null,
        capabilityContext: principal => this.controller!.interactionContext(principal),
        createTask: async () => { throw new Error('Use agent handoff capability') }, taskStatus: async () => { throw new Error('Use agent handoff capability') },
      }, 0, registry)
      await this.supervisor.initialize()
      this.lifecycle = new AgentConversationLifecycle({ journal, store: new AgentConversationStore({ root: join(this.root, 'runtime', 'conversations'), crypto }),
        controller: this.controller, selectedProvider, ceiling: () => this.config?.conversationCeiling ?? 20, prepareFresh,
        pin: ids => this.supervisor!.pinConversation(ids), close: id => this.supervisor!.closeRun(id),
        onView: view => { if (view.record.phase === 'ready') this.activity = undefined; this.emit({ kind: 'view', view }) },
      })
      await this.lifecycle.initialize()
      this.probes = await Promise.all([...this.providers.values()].map(provider => provider.probe()))
      this.lifecycle.resumeQueued()
      return this.snapshot()
    } catch (error) { await this.close(); throw error }
  }
  private async transaction(method: string, metadata: DeliveryAttachmentMetadata, taskId?: string): Promise<AttachmentDeliveryTransaction> {
    const chunks: Buffer[] = []
    return { write: async chunk => { chunks.push(Buffer.from(chunk)) }, rollback: async () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0 },
      commit: async () => { const data = Buffer.concat(chunks); try { await this.host(method, [metadata, data.toString('base64'), taskId]) } finally { data.fill(0); for (const chunk of chunks) chunk.fill(0); chunks.length = 0 } },
    }
  }
  private snapshot() { return { view: this.lifecycle?.view(), activity: this.activity, availability: { available: !!this.lifecycle && this.probes.some(p => p.available), providers: this.probes.map(p => ({ ...p, id: p.provider })) } } }
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'configure') return this.configure(args[0] as AgentRuntimeConfig)
    if (method === 'disable') { await this.close(); return true }
    if (method === 'update') {
      if (!this.lifecycle || !this.config) throw new Error('Agent runtime is not configured')
      const update = args[0] as Partial<Omit<AgentRuntimeConfig, 'masterKey'>>
      if (update.conversationCeiling !== undefined) this.config.conversationCeiling = update.conversationCeiling
      if (update.selectedProvider) {
        this.config.selectedProvider = update.selectedProvider
        await this.lifecycle.requestProvider(update.selectedProvider)
      }
      return this.snapshot()
    }
    if (method === 'snapshot' || method === 'availability') return this.snapshot()
    if (!this.lifecycle) throw new Error('Agent runtime is not configured')
    const a = args as any[]
    switch (method) {
      case 'view': return this.lifecycle.view()
      case 'enqueue': {
        const queued = await this.lifecycle.enqueue(a[0], a[1])
        diagnostic('agent-request-enqueued', { submissionId: queued.submissionId })
        void queued.completion.then(result => {
          diagnostic('agent-request-completed', { submissionId: queued.submissionId, interactionId: result.interactionId,
            runId: result.agentRunId, provider: result.provider, sessionId: result.providerSessionId,
            outcome: result.outcome, errorCode: result.error?.code })
          this.completions.set(queued.submissionId, result); this.emit({ kind: 'completion', submissionId: queued.submissionId, result })
        })
        return { submissionId: queued.submissionId }
      }
      case 'submit': return this.lifecycle.submit(a[0])
      case 'retry': return this.lifecycle.retry()
      case 'setDraft': return this.lifecycle.setDraft(a[0], a[1])
      case 'requestProvider': this.config!.selectedProvider = a[0]; return this.lifecycle.requestProvider(a[0])
      case 'completion': return this.completions.get(a[0]) ?? null
      case 'interrupt': return this.supervisor!.interrupt(a[0])
      case 'records.list': return this.records!.list()
      case 'memory.get': return this.memory!.get(a[0], a[1], a[2])
      case 'memory.forget': return this.memory!.forget(a[0], a[1])
      case 'memory.restore': return this.memory!.restore(a[0], a[1])
      default: throw new Error('Unknown Agent runtime command')
    }
  }
  async close(): Promise<void> {
    this.lifecycle?.dispose(); this.lifecycle = undefined
    this.controller?.dispose(); this.controller = undefined
    await this.supervisor?.dispose(); this.supervisor = undefined
    this.mcp?.close(); this.mcp = undefined
    this.index?.close(); this.index = undefined
    this.key?.fill(0); this.key = undefined
    this.records = undefined; this.memory = undefined; this.config = undefined
    this.activity = undefined; this.completions.clear(); this.probes = []
  }
}
