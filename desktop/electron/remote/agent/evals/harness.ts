/**
 * Behaviour evals for the Unmute Agent.
 *
 * The unit tests prove the schema REFUSES a bad record. They cannot prove the
 * model writes a good one, because that depends on wording — and wording is
 * exactly what drifted: three identical runs of the old constitution produced
 * three differently shaped answers, and the one field failure that started all
 * this (a transcript, a read-back and a standing instruction crammed into one
 * body) passed every unit test we had.
 *
 * So this runs the REAL model against the REAL tool schemas and the REAL
 * constitution, over a stub MCP server that records what it was asked to do.
 * Nothing here is a copy: the tools come from MemoryCapability and the prompt
 * from constitution.ts, so a change to either is exercised, not shadowed.
 *
 * It costs money and needs the network, so it is opt-in — `npm run eval:agent`,
 * never part of `npm test`.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { MemoryCapability, type MemoryCapabilityService } from '../capabilities/memory'
import { HandoffCapability, type HandoffAdapters } from '../capabilities/handoff'
import { HistoryCapability, type HistoryService } from '../capabilities/history'
import { NotetakerCapability, type NotetakerAdapters } from '../capabilities/notetaker'
import { SessionsCapability, type SessionAdapters } from '../capabilities/sessions'
import { PocketCapability, type PocketAdapters } from '../capabilities/pocket'
import { AGENT_PRINCIPLES } from '../constitution'
import { providerTranscript } from '../controller'

export interface RecordedCall {
  tool: string
  args: Record<string, unknown>
}

export interface EvalOutcome {
  calls: RecordedCall[]
  reply: string
  ok: boolean
}

/** Canned answers, so an eval exercises the model rather than the database. */
export interface StubBehaviour {
  searchResults?: Array<{
    id: string; title: string; kind: string; snippet: string
    score: number; attachmentCount: number; scopes: string[]
  }>
  getRecord?: Record<string, unknown>
  storeFails?: string
  /** What memory_list returns with no group: the map. Absent means an empty store. */
  map?: Record<string, unknown>
  /** What memory_list returns for a named group. */
  groupEntries?: Array<Record<string, unknown>>
}

const PROTOCOL_VERSION = '2024-11-05'

function rpc(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function toolText(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

/**
 * Serves the genuine tool definitions. A hand-written copy here would keep
 * passing after the real schema changed, which is the failure mode an eval is
 * supposed to catch.
 */
function realTools(): Array<Record<string, unknown>> {
  // EVERY capability the Agent actually holds, not just memory.
  //
  // This used to serve MemoryCapability alone, which quietly invalidated a
  // third of the corpus: 'outside work becomes a task' asserts a task_create
  // call, and task_create was never on the wire to be called. A case that
  // cannot pass is worse than a missing one, because the suite still reports
  // a number.
  //
  // Only `.tools` is read, so the adapters are casts — an eval never dispatches
  // into a real service, it records what the model asked for.
  const modules = [
    new MemoryCapability({} as MemoryCapabilityService),
    new HandoffCapability({} as HandoffAdapters),
    new HistoryCapability({} as HistoryService),
    new NotetakerCapability({} as NotetakerAdapters),
    new SessionsCapability({} as SessionAdapters),
    new PocketCapability({} as PocketAdapters),
  ]
  return modules.flatMap((module) => module.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })))
}

export async function startStub(behaviour: StubBehaviour): Promise<{
  port: number; calls: RecordedCall[]; close(): Promise<void>
}> {
  const calls: RecordedCall[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let msg: { id?: unknown; method?: string; params?: Record<string, any> }
      try { msg = JSON.parse(body) } catch { res.writeHead(400).end(); return }
      if (msg.id === undefined && msg.method?.startsWith('notifications/')) {
        res.writeHead(202).end(); return
      }
      const send = (result: unknown) =>
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(rpc(msg.id, result))

      if (msg.method === 'initialize') {
        send({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'unmute', version: '1.0.0' },
        })
        return
      }
      if (msg.method === 'ping') { send({}); return }
      if (msg.method === 'tools/list') { send({ tools: realTools() }); return }
      if (msg.method === 'tools/call') {
        const tool = String(msg.params?.name ?? '')
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
        calls.push({ tool, args })
        if (tool === 'memory_list') {
          send(toolText(JSON.stringify(args.group === undefined
            ? { ok: true, result: { map: behaviour.map ?? { total: 0, groups: [], ungrouped: 0 } } }
            : { ok: true, result: { entries: behaviour.groupEntries ?? [] } })))
        } else if (tool === 'memory_search') {
          send(toolText(JSON.stringify({ ok: true, result: { results: behaviour.searchResults ?? [] } })))
        } else if (tool === 'memory_get') {
          send(toolText(JSON.stringify({ ok: true, result: { record: behaviour.getRecord ?? {} } })))
        } else if (tool === 'memory_store' && behaviour.storeFails) {
          send(toolText(JSON.stringify({ ok: false, error: { code: 'duplicate', message: behaviour.storeFails } }), true))
        } else {
          send(toolText(JSON.stringify({ ok: true, result: { id: 'memory-new', version: 1 } })))
        }
        return
      }
      send({})
    })
  })
  const port: number = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return {
    port,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** One turn: the real constitution, the real schemas, a real model. */
export async function runTurn(utterance: string, behaviour: StubBehaviour = {}): Promise<EvalOutcome> {
  const stub = await startStub(behaviour)
  const dir = await fs.mkdtemp(join(tmpdir(), 'agent-eval-'))
  const constitutionPath = join(dir, 'constitution.md')
  await fs.writeFile(constitutionPath, AGENT_PRINCIPLES)
  const config = JSON.stringify({
    mcpServers: { unmute: { type: 'http', url: `http://127.0.0.1:${stub.port}/mcp` } },
  })
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', [
        '-p',
        '--output-format', 'json',
        '--append-system-prompt', AGENT_PRINCIPLES,
        '--allowedTools', 'mcp__unmute',
        '--mcp-config', config,
        '--strict-mcp-config',
        '--session-id', randomUUID(),
      ], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (c) => { out += c })
      child.on('error', reject)
      child.on('close', () => {
        try { resolve(String(JSON.parse(out).result ?? '')) } catch { resolve(out) }
      })
      // THE TURN THE CONTROLLER WOULD ACTUALLY SEND, not the bare utterance.
      //
      // The harness used to pipe the raw sentence in, so the per-turn preamble
      // was never under test — and that preamble is exactly where the 25 August
      // failure lived ("Never send, submit, publish, or commit it" beat the
      // constitution and blocked four task_create calls). An eval that skips
      // the wrapper cannot see the class of bug that wrapper causes.
      child.stdin.write(providerTranscript(
        { transcript: utterance, attachments: [] } as Parameters<typeof providerTranscript>[0],
        [],
        [],
        realTools().map((tool) => ({
          name: String(tool.name),
          description: String(tool.description),
        })),
      ))
      child.stdin.end()
    })
    return { calls: stub.calls, reply, ok: true }
  } finally {
    await stub.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}
