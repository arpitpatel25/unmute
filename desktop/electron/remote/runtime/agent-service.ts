import { setAgentModelChoices, type AgentModelChoices } from '../agent/modelPolicy'
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
import { PocketCapability } from '../agent/capabilities/pocket'
import { HelpCapability } from '../agent/capabilities/help'
import { IndexSearchCapability } from '../agent/capabilities/index-search'
import { warmTurnSearch } from '../agent/sessions/turn-search'
import { HandoffCapability } from '../agent/capabilities/handoff'
import { NotetakerCapability } from '../agent/capabilities/notetaker'
import { RoutinesCapability, type RoutinesServiceLike } from '../agent/capabilities/routines'
import { DeliveryCapability, type AttachmentDeliveryTransaction, type DeliveryAttachmentMetadata } from '../agent/capabilities/delivery'
import { MemoryCrypto } from '../agent/memory/crypto'
import { EncryptedRecordStore } from '../agent/memory/record-store'
import { InteractionAttachmentHandles, EncryptedAttachmentStore } from '../agent/memory/attachments'
import { MemoryService } from '../agent/memory/service'
import { JsonlMemoryAudit } from '../agent/memory/audit'
import { DurableMemoryMutationJournal } from '../agent/memory/journal'
import { openSqlCipherMemoryIndex } from '../agent/memory/sqlcipher-index'
import { describeRules, loadPersona } from '../agent/persona'
import { agentConstitution } from '../agent/constitution'
import { SESSION_PREAMBLE } from '../session-policy'
import { startMcpServer, MCP_PATH, type McpServer } from '../mcp-server'
import { createLogger } from '../log'
import { diagnostic, diagnosticError } from '../diagnostics'
import { RoutineService } from '../agent/routines/service'
import { RoutineAgentExecutor, ACTOR_ALLOWED_TOOLS, type RoutineRunPair } from '../agent/routines/executor'
import type { RoutinesView } from '../agent/routines/types'
import type { AgentRunMcpContext } from '../agent/supervisor'
import { findTranscriptById } from '../transcript-locate'
import { findRollout } from '../codex/cli-session'

export type AgentRuntimeConfig = { masterKey: string; selectedProvider: AgentProviderId; maxActiveProcesses?: number; conversationCeiling?: number; notetaker?: boolean; routines?: boolean
  /** Per-provider default model and fallbacks (agent/modelPolicy.ts). */
  models?: AgentModelChoices
  /** Continue on another provider when this one cannot answer. Default on. */
  switchWhenUnavailable?: boolean }
export type AgentRuntimeEvent = { kind: 'view'; view: AgentConversationView } | { kind: 'activity'; activity: AgentInteractionActivity }
  | { kind: 'completion'; submissionId: string; result: AgentInteractionResult } | { kind: 'routines'; view: RoutinesView }
export type RoutineProviders = { reader: Map<AgentProviderId, AgentProvider>; actor?: Map<AgentProviderId, AgentProvider> }
type Routines = Pick<RoutineService, 'view' | 'list' | 'create' | 'update' | 'remove' | 'duplicate' | 'refreshContext' | 'setEnabled' | 'runNow' | 'event' | 'wake'
  | 'cancel' | 'markRead' | 'decideProposal' | 'run' | 'runs' | 'result' | 'definitionPath' | 'close'>
/** Stands in for a routines service that could not start, so the Agent itself still runs and the UI can say why. */
class UnavailableRoutines implements Routines {
  constructor(private reason: string, private dir: string) {}
  view(): RoutinesView { return { available: false, reason: this.reason, items: [], runs: [] } }
  list() { return [] }
  runs() { return [] }
  run() { return undefined }
  async result() { return null }
  definitionPath(id: string) { return join(this.dir, `${id}.md`) }
  async close() {}
  private async refuse(): Promise<never> { throw new Error(this.reason) }
  create = () => this.refuse(); update = () => this.refuse(); remove = () => this.refuse(); setEnabled = () => this.refuse()
  runNow = () => this.refuse(); event = () => this.refuse(); wake = () => this.refuse(); cancel = () => this.refuse()
  markRead = () => this.refuse(); decideProposal = () => this.refuse()
  duplicate = () => this.refuse()
  refreshContext = () => this.refuse()
}
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
  private routines?: Routines
  private routineGeneration = 0
  private routinesChain: Promise<unknown> = Promise.resolve()
  private routineSupervisors: AgentRunSupervisor[] = []
  private routineControllers: UnmuteAgentController[] = []
  private routineDeps?: { registry: CapabilityRegistry; tokens: AgentTokenStore; handles: InteractionAttachmentHandles }
  private routineProviders: RoutineProviders
  constructor(private root: string, private emit: (event: AgentRuntimeEvent) => void, private host: AgentHostCall,
    providers?: Map<AgentProviderId, AgentProvider>, private openIndex = openSqlCipherMemoryIndex, routineProviders?: RoutineProviders) {
    this.providers = providers ?? new Map<AgentProviderId, AgentProvider>([
      ['claude', new ClaudeCodeProvider({ runtime: 'persistent' })], ['codex', new CodexCliProvider({ runtime: 'persistent' })],
    ])
    this.routineProviders = routineProviders ?? {
      reader: new Map<AgentProviderId, AgentProvider>([['claude', new ClaudeCodeProvider({ runtime: 'headless' })], ['codex', new CodexCliProvider({ runtime: 'headless' })]]),
      actor: new Map<AgentProviderId, AgentProvider>([['claude', new ClaudeCodeProvider({ runtime: 'headless', allowedTools: ACTOR_ALLOWED_TOOLS, extraArgs: ['--chrome'] })]]),
    }
  }
  private async configure(input: AgentRuntimeConfig): Promise<unknown> {
    setAgentModelChoices(input.models)
    if (this.lifecycle) {
      this.config!.models = input.models
      this.config!.switchWhenUnavailable = input.switchWhenUnavailable
      const providerChanged = this.config!.selectedProvider !== input.selectedProvider
      this.config!.selectedProvider = input.selectedProvider
      this.config!.conversationCeiling = input.conversationCeiling
      if (providerChanged) await this.lifecycle.requestProvider(input.selectedProvider)
      await this.applyRoutines(input.routines)
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
        diagnostic('agent-rules-loaded', describeRules(persona))
        await mkdir(dirname(constitutionPath), { recursive: true, mode: 0o700 })
        await writeFile(constitutionPath, agentConstitution(SESSION_PREAMBLE, persona.text), { mode: 0o600 })
      }
      await prepareFresh()
      warmTurnSearch()
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
          send: input => this.host('sessions.send', [input]),
        }),
        new PocketCapability({
          list: () => this.host('pocket.list', []),
          rename: input => this.host('pocket.rename', [input]),
          stop: input => this.host('pocket.stop', [input]),
          end: input => this.host('pocket.end', [input]),
          removeFromPocket: input => this.host('pocket.removeFromPocket', [input]),
          delete: input => this.host('pocket.delete', [input]),
        }),
        // The constitution sends every how-do-I question here; it was only
        // ever registered on the retired in-process path.
        new HelpCapability(() => this.host('help.settings', [])),
        // Reads the index file directly: it is on this machine, and a host
        // round-trip would only copy 28 MB across a socket.
        new IndexSearchCapability(),
        new HandoffCapability({ createTask: input => this.host('handoff.createTask', [input]), taskStatus: id => this.host('handoff.taskStatus', [id]), cardForSession: id => this.host('handoff.cardForSession', [id]) }),
        ...(config.notetaker ? [new NotetakerCapability({ list: limit => this.host('notetaker.list', [limit]), search: (q, limit) => this.host('notetaker.search', [q, limit]), read: id => this.host('notetaker.read', [id]), open: id => this.host('notetaker.open', [id]) })] : []),
        new RoutinesCapability(this.lazyRoutines()),
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
        runtime: () => ({ cwd: dirname(constitutionPath), constitutionPath, environment: process.env, mcp: this.mcpContext() }), onActivity: activity => {
          this.activity = activity
          diagnostic('agent-interaction-activity', { interactionId: activity.interactionId, runId: activity.agentRunId,
            provider: activity.provider, kind: activity.kind })
          this.emit({ kind: 'activity', activity })
        },
      })
      /* Only the Agent's own controller is consulted here. Routine runs mint tokens in the same store,
       * but their controllers are deliberately absent: with no live interaction context, every
       * non-read capability call from a routine is refused by authorizeCapabilityCall. That
       * omission is what keeps routine runs read-only. */
      this.mcp = await startMcpServer({ resolveCaller: token => token ? tokens.resolve(token) : null,
        capabilityContext: principal => this.controller!.interactionContext(principal),
        createTask: async () => { throw new Error('Use agent handoff capability') }, taskStatus: async () => { throw new Error('Use agent handoff capability') },
      }, 0, registry)
      await this.supervisor.initialize()
      this.routineDeps = { registry, tokens, handles }
      await this.startRoutines(this.routinesEnabled(config.routines))
      this.lifecycle = new AgentConversationLifecycle({ journal, store: new AgentConversationStore({ root: join(this.root, 'runtime', 'conversations'), crypto }),
        attachmentsDir: join(this.root, 'runtime', 'chat-attachments'),
        controller: this.controller, selectedProvider, ceiling: () => this.config?.conversationCeiling ?? 20, prepareFresh,
        pin: ids => this.supervisor!.pinConversation(ids), close: id => this.supervisor!.closeRun(id),
        interrupt: id => this.supervisor!.interrupt(id),
        onView: view => { if (view.record.phase === 'ready') this.activity = undefined; this.emit({ kind: 'view', view }) },
        alternateProvider: current => this.config?.switchWhenUnavailable === false ? undefined
          : this.probes.find(p => p.available && p.provider !== current)?.provider,
      })
      await this.lifecycle.initialize()
      this.probes = await Promise.all([...this.providers.values()].map(provider => provider.probe()))
      this.lifecycle.resumeQueued()
      return this.snapshot()
    } catch (error) { await this.close(); throw error }
  }
  private routinesEnabled(value: boolean | undefined): boolean { return value !== false && process.env.UNMUTE_ROUTINES !== '0' }
  private mcpContext(): AgentRunMcpContext {
    const endpoint = `http://127.0.0.1:${this.mcp!.port}${MCP_PATH}`
    return { endpoint, config: JSON.stringify({ mcpServers: { unmute: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer ${UNMUTE_MCP_TOKEN}' } } } }) }
  }
  private routineService(): Routines {
    if (!this.routines) throw new Error('Routines are not ready yet')
    return this.routines
  }
  /** The registry is built before the routines service (and rebuilt services replace it), so the capability reads it late. */
  private lazyRoutines(): RoutinesServiceLike {
    const service = () => this.routineService()
    return {
      list: () => service().list(), create: fields => service().create(fields), update: (id, fields) => service().update(id, fields),
      remove: id => service().remove(id), setEnabled: (id, enabled) => service().setEnabled(id, enabled), runNow: id => service().runNow(id),
      runs: opts => service().runs(opts), result: runId => service().result(runId),
    }
  }
  /** Never throws: a failure is logged, half-built supervisors are disposed, and an unavailable stand-in is published. */
  private async startRoutines(enabled: boolean): Promise<boolean> {
    const generation = ++this.routineGeneration
    try {
      const { registry, tokens, handles } = this.routineDeps!
      const selectedProvider = () => this.config!.selectedProvider
      let executor: RoutineAgentExecutor | undefined
      const pair = (name: 'reader' | 'actor', providers: Map<AgentProviderId, AgentProvider>): RoutineRunPair => {
        const journal = new AgentJournal({ root: join(this.root, 'routines', 'agent-journal', name) })
        const supervisor = new AgentRunSupervisor({ providers, tokenStore: tokens, journal, maxActiveProcesses: 2, selectedProvider,
          log: (event, data) => createLogger('agent-routines').event(event, { pair: name, ...data }) })
        const controller = new UnmuteAgentController({ supervisor, tokens, attachmentHandles: handles, journal, capabilities: registry, selectedProvider,
          runtime: () => { throw new Error('routine runs pass their runtime') }, onActivity: activity => executor?.routeActivity(activity) })
        this.routineSupervisors.push(supervisor); this.routineControllers.push(controller)
        return { controller, supervisor }
      }
      if (enabled) {
        const reader = pair('reader', this.routineProviders.reader)
        const actor = this.routineProviders.actor ? pair('actor', this.routineProviders.actor) : undefined
        await Promise.all(this.routineSupervisors.map(supervisor => supervisor.initialize()))
        executor = new RoutineAgentExecutor({ reader, actor,
          baseConstitution: async () => agentConstitution(SESSION_PREAMBLE, (await loadPersona(join(this.root, 'agent'))).text),
          readTools: () => registry.tools({ kind: 'unmute-agent', runId: 'routine', interactionId: 'routine', expiresAt: Number.MAX_SAFE_INTEGER })
            .filter(tool => tool.consequence === 'read'),
          mcp: () => this.mcpContext(), environment: process.env })
      }
      const routines = new RoutineService({ root: this.root, enabled, agentProvider: selectedProvider,
        listMeetings: () => this.config?.notetaker ? this.host('notetaker.list', [100]) : Promise.resolve([]),
        executor: executor ?? { start: () => { throw new Error('Routines are turned off in Settings') }, dispose: async () => {} },
        emit: view => { if (this.routineGeneration === generation) this.emit({ kind: 'routines', view }) } })
      try { await routines.initialize() } catch (error) { await routines.close().catch(() => {}); throw error }
      this.routines = routines
      return true
    } catch (error) {
      diagnostic('routines-start-failed', diagnosticError(error))
      await this.disposeRoutinePairs()
      const unavailable = new UnavailableRoutines(`Routines couldn't start: ${error instanceof Error ? error.message : String(error)}`, join(this.root, 'routines'))
      this.routines = unavailable
      if (this.routineGeneration === generation) this.emit({ kind: 'routines', view: unavailable.view() })
      return false
    }
  }
  /** Serialized, so concurrent toggles can never leave an orphaned live service firing alongside the current one.
   * The flag is committed only after a successful start; a service that failed to start is retried even when the flag matches. */
  private applyRoutines(value: boolean | undefined): Promise<void> {
    const applied = this.routinesChain.then(async () => {
      if (!this.config || !this.routineDeps) return
      const want = value ?? this.config.routines
      if (this.routines instanceof RoutineService && (want !== false) === (this.config.routines !== false)) return
      await this.stopRoutines()
      if (await this.startRoutines(this.routinesEnabled(want))) this.config.routines = want
    })
    this.routinesChain = applied.catch(() => {})
    return applied
  }
  private async stopRoutines(): Promise<void> {
    this.routineGeneration++
    const routines = this.routines; this.routines = undefined
    try { await routines?.close() } finally { await this.disposeRoutinePairs() }
  }
  private async disposeRoutinePairs(): Promise<void> {
    const controllers = this.routineControllers, supervisors = this.routineSupervisors
    this.routineControllers = []; this.routineSupervisors = []
    for (const controller of controllers) controller.dispose()
    await Promise.allSettled(supervisors.map(supervisor => supervisor.dispose()))
  }
  private async transcriptPath(runId: string): Promise<string | null> {
    try {
      const run = this.routines?.run(runId)
      if (!run?.providerSessionId) return null
      return run.provider === 'codex' ? await findRollout(run.providerSessionId)
        : await findTranscriptById(join(this.root, 'routines', 'runs', run.id), run.providerSessionId)
    } catch { return null }
  }
  private async transaction(method: string, metadata: DeliveryAttachmentMetadata, taskId?: string): Promise<AttachmentDeliveryTransaction> {
    const chunks: Buffer[] = []
    return { write: async chunk => { chunks.push(Buffer.from(chunk)) }, rollback: async () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0 },
      commit: async () => { const data = Buffer.concat(chunks); try { await this.host(method, [metadata, data.toString('base64'), taskId]) } finally { data.fill(0); for (const chunk of chunks) chunk.fill(0); chunks.length = 0 } },
    }
  }
  private snapshot() { return { view: this.lifecycle?.view(), activity: this.activity, availability: { available: !!this.lifecycle && this.probes.some(p => p.available), providers: this.probes.map(p => ({ ...p, id: p.provider })) }, routines: this.routines?.view() } }
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'configure') return this.configure(args[0] as AgentRuntimeConfig)
    if (method === 'disable') { await this.close(); return true }
    if (method === 'update') {
      if (!this.lifecycle || !this.config) throw new Error('Agent runtime is not configured')
      const update = args[0] as Partial<Omit<AgentRuntimeConfig, 'masterKey'>>
      if (update.conversationCeiling !== undefined) this.config.conversationCeiling = update.conversationCeiling
      if (update.models !== undefined) { this.config.models = update.models; setAgentModelChoices(update.models) }
      if (update.switchWhenUnavailable !== undefined) this.config.switchWhenUnavailable = update.switchWhenUnavailable
      if (update.selectedProvider) {
        this.config.selectedProvider = update.selectedProvider
        await this.lifecycle.requestProvider(update.selectedProvider)
      }
      await this.applyRoutines(update.routines)
      return this.snapshot()
    }
    if (method === 'snapshot' || method === 'availability') return this.snapshot()
    // Answerable before the Agent is configured: the notch asks for these on attach.
    if (method === 'routines.view') return this.routines?.view() ?? { available: false, reason: 'The Agent is not running', items: [], runs: [] }
    if (method === 'routines.transcriptPath') return this.transcriptPath(args[0] as string)
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
      case 'discard': return this.lifecycle.discard()
      // THE TURN THAT IS RUNNING, whichever run that is — the lifecycle knows,
      // and the caller does not have to. `interrupt` below takes a run id and
      // is the supervisor's; these are deliberately not the same command.
      case 'interruptTurn': return this.lifecycle.interrupt()
      case 'setDraft': return this.lifecycle.setDraft(a[0], a[1])
      case 'requestProvider': this.config!.selectedProvider = a[0]; return this.lifecycle.requestProvider(a[0])
      case 'completion': return this.completions.get(a[0]) ?? null
      case 'interrupt': return this.supervisor!.interrupt(a[0])
      case 'records.list': return this.records!.list()
      case 'memory.get': return this.memory!.get(a[0], a[1], a[2])
      case 'memory.forget': return this.memory!.forget(a[0], a[1])
      case 'memory.restore': return this.memory!.restore(a[0], a[1])
      case 'routines.create': return this.routineService().create(a[0])
      case 'routines.update': return this.routineService().update(a[0], a[1])
      case 'routines.remove': return this.routineService().remove(a[0])
      case 'routines.duplicate': return this.routineService().duplicate(a[0])
      case 'routines.refreshContext': return this.routineService().refreshContext()
      case 'routines.setEnabled': return this.routineService().setEnabled(a[0], a[1])
      case 'routines.runNow': return this.routineService().runNow(a[0])
      case 'routines.event': return this.routineService().event(a[0])
      case 'routines.wake': return this.routineService().wake()
      case 'routines.cancel': return this.routineService().cancel(a[0])
      case 'routines.proposal': return this.routineService().decideProposal(a[0], a[1], a[2])
      case 'routines.markRead': return this.routineService().markRead()
      case 'routines.run': {
        const routines = this.routineService(), run = routines.run(a[0])
        return run ? { run, result: await routines.result(run.id) } : null
      }
      case 'routines.path': return this.routineService().definitionPath(a[0])
      default: throw new Error('Unknown Agent runtime command')
    }
  }
  async close(): Promise<void> {
    const stopping = this.routinesChain.then(() => { this.routineDeps = undefined; return this.stopRoutines() })
    this.routinesChain = stopping.catch(() => {})
    await stopping.catch(error => diagnostic('routines-close-failed', diagnosticError(error)))
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
