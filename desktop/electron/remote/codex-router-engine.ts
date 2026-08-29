// Unmute Remote — the Codex routing engine.
//
// WHY THIS EXISTS. The router was a Claude Code CLI session, unconditionally —
// `routerExecutorFactory` hardcodes ClaudeCodeExecutor. Anyone with the Codex
// desktop app but no Claude CLI therefore had no router at all: routeOnce threw
// at ensureSession, fell to failsafeDecision, and every utterance became a NEW
// task carrying the raw transcript. No new-vs-resume, no targeting, no intent
// cleanup, no naming, no project/kind/group. Most of the product's judgement,
// gone, silently. Codex ships its own CLI inside the app bundle, so that user
// always has an engine — we simply were not using it.
//
// WHY THE APP-SERVER AND NOT `codex exec`. `exec` spawns a process per call:
// cold start on every utterance, which is the one thing a router cannot afford.
// The app-server is a single persistent process; each decision is an ephemeral
// thread on it. Measured on this machine:
//
//     warm (spawn + initialize)   435 ms   — once, at startup
//     thread/start + turn/start   ~5.2 s   — per decision
//
// against the Claude router's own 8.0s and 13.8s in the same session's logs. So
// this is not a degraded fallback; it is the faster engine of the two.
//
// WHY NO DECISION FILE. Claude runs as a TUI, so its answer has to come back
// through a file — stdout is a mess of escape codes. The app-server hands back
// the assistant's message directly, so asking Codex to write a file would add a
// tool call, a permission prompt and seconds of latency to buy nothing. Hence
// buildRoutingPrompt's two answer styles; everything else in that prompt — the
// targeting rules, the consent policy, kinds, groups, skills, ops — is shared
// verbatim, because that is how unmute thinks and must not fork per backend.

import { spawn } from 'node:child_process'
import { createLogger } from './log'

const log = createLogger('codex-router')

/** The Codex CLI bundled inside the desktop app — present for any desktop user. */
export const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex'

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

/**
 * A persistent Codex app-server that answers routing questions.
 *
 * Deliberately NOT an AgentExecutor. That interface is shaped around a PTY —
 * writeStdin, a raw `\r` to submit, liveness, a decision file — and none of it
 * describes a JSON-RPC process. Forcing this through that shape would mean
 * faking a terminal; the honest boundary is "give me a prompt, I return text".
 */
export class CodexRouterEngine {
  /** Name for the router's logs. */
  readonly label = 'codex-appserver'
  private proc: ReturnType<typeof spawn> | null = null
  private buf = ''
  private nextId = 0
  private pending = new Map<number, Pending>()
  /** Text of every assistant item in the CURRENT turn, in arrival order. */
  private items: string[] = []
  private turnDone: (() => void) | null = null

  constructor(private readonly cli: string = BUNDLED_CODEX) {}

  get alive(): boolean { return !!this.proc && !this.proc.killed }

  /**
   * Bring the process up and complete the handshake.
   *
   * Called at startup so no utterance pays for it. Rejects rather than
   * half-starting: a caller that cannot warm should fall back to the other
   * engine immediately instead of discovering it mid-decision.
   */
  async warm(): Promise<void> {
    if (this.alive) return
    const proc = spawn(this.cli, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.proc = proc
    proc.stdin?.on('error', () => { /* the pipe died with the process */ })
    proc.on('exit', () => { this.proc = null; this.failAll('codex app-server exited') })
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve())
      proc.once('error', (e) => { log.warn('codex-router-spawn-failed', { error: e.message }); reject(e) })
    })
    proc.stdout?.on('data', (d: Buffer) => this.onData(d.toString()))
    await this.call('initialize', { clientInfo: { name: 'unmute', title: 'unmute', version: '1' } })
    this.notify('initialized')
    log.event('codex-router-warm', { cli: this.cli })
  }

  /**
   * Ask one routing question. Returns the raw assistant text, or null.
   *
   * ALWAYS resolves — never throws into the routing path. A null here lands the
   * caller on failsafeDecision, which is the same contract the Claude engine
   * has when its decision file never appears.
   */
  async decide(prompt: string, timeoutMs = 45_000): Promise<string | null> {
    try {
      if (!this.alive) await this.warm()
      const started = Date.now()
      const thread = await this.call('thread/start', { ephemeral: true }) as { thread?: { id?: string } }
      const threadId = thread?.thread?.id
      if (!threadId) { log.warn('codex-router-no-thread', {}); return null }

      this.items = []
      const finished = new Promise<void>((resolve) => { this.turnDone = resolve })
      void this.call('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })

      const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))
      const outcome = await Promise.race([finished.then(() => 'done' as const), timer])
      this.turnDone = null
      if (outcome === 'timeout') { log.warn('codex-router-timeout', { timeoutMs }); return null }

      // The FIRST completed item is the echo of our own prompt; the answer is
      // the last assistant item. Verified live — both arrive as item/completed.
      const answer = this.items.length ? this.items[this.items.length - 1] : null
      log.event('codex-router-decision', { afterMs: Date.now() - started, raw: (answer ?? '').slice(0, 300) })
      return answer
    } catch (e) {
      log.warn('codex-router-failed', { error: (e as Error).message })
      return null
    }
  }

  dispose(): void {
    this.failAll('disposed')
    try { this.proc?.kill() } catch { /* already gone */ }
    this.proc = null
  }

  // ─── plumbing ───────────────────────────────────────────────────

  private onData(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown }
      try { msg = JSON.parse(line) } catch { continue }

      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message ?? 'codex rpc error'))
        else p.resolve(msg.result)
        continue
      }

      if (msg.method === 'item/completed') {
        const t = itemText(msg.params)
        if (t) this.items.push(t)
      } else if (msg.method === 'turn/completed' || msg.method === 'turn/failed') {
        this.turnDone?.()
      }
    }
  }

  private call(method: string, params: unknown = {}): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') }
      catch (e) { this.pending.delete(id); reject(e as Error) }
    })
  }

  private notify(method: string, params: unknown = {}): void {
    try { this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') }
    catch { /* the process is gone; the next call reports it */ }
  }

  private failAll(reason: string): void {
    for (const [, p] of this.pending) p.reject(new Error(reason))
    this.pending.clear()
    this.turnDone?.()
    this.turnDone = null
  }
}

/** Pull the text out of an `item/completed` payload, whatever shape it takes. */
export function itemText(params: unknown): string | null {
  const p = params as { item?: Record<string, unknown> } | undefined
  const item = (p?.item ?? p) as Record<string, unknown> | undefined
  if (!item) return null
  if (typeof item.text === 'string' && item.text.trim()) return item.text
  const content = item.content as Array<{ text?: string }> | undefined
  if (Array.isArray(content)) {
    const joined = content.map((c) => c?.text ?? '').join('').trim()
    if (joined) return joined
  }
  return null
}
