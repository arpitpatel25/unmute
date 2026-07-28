// Unmute Remote — the Codex APPROVAL CHANNEL.
//
// THE PROBLEM THIS SOLVES
//
// A Codex task that stops for approval is invisible to unmute. That breaks the
// one thing the cockpit exists for: the crank — next → approve → next — across
// EVERY blocked task, not whichever thread the Codex window happens to have
// open. On a company/managed plan "Full access" is not offered at all, so
// blocking is the normal path, not an edge case.
//
// Everything else was ruled out by test on 2026-07-25: rollout files never
// persist approvals; the sidebar DOM exposes no status; the conversation DOM
// only ever holds the ONE mounted thread; `inbox_items` is empty;
// `thread_timeline_ledger` is the realtime-voice feature; and a second
// app-server client does not reflect the desktop app's UI state. The hooks
// system is the only push channel that reaches every thread.
//
// WHAT WAS PROVEN LIVE (2026-07-25, codex 0.146.0-alpha.3.1)
//
//   1. `~/.codex/hooks.json` is read as a `user`-source config — it applies to
//      EVERY cwd, which is what makes it work for desktop threads whose cwd we
//      never chose.
//   2. The file's shape is Claude-Code-shaped, with PascalCase event keys:
//        { description, hooks: { PermissionRequest: [ { matcher, hooks: [
//            { type: "command", command, timeout } ] } ] } }
//      (camelCase / snake_case keys parse without error and are silently
//      ignored — a real trap; four spellings were tried before this one.)
//   3. `hooks/list` over the app-server reports the entry with `key`,
//      `currentHash` and `trustStatus: "untrusted"`.
//   4. Writing `hooks.state."<key>" = { trusted_hash: <currentHash>, enabled }`
//      via `config/value/write` flips it to `trustStatus: "trusted"` —
//      HEADLESSLY. We never have to reproduce Codex's hash function, because we
//      echo back the hash Codex just told us for the file we just wrote.
//   5. Firing: a sandboxed write triggered `hook/started` →
//      `hook/completed` → `waitingOnApproval`, and our handler received the
//      full payload (session_id = thread id, turn_id, cwd, tool_name,
//      tool_input) BEFORE the approval reached the reviewer.
//
// THE SHAPE OF THE CONTRACT
//
// The handler reports, then waits a bounded time for unmute to answer:
//
//   * unmute alive (fresh heartbeat) → wait for a decision file, and return
//     `allow`/`deny` if one appears. The user approved from the notch and never
//     touched Codex. That is the crank.
//   * unmute not running, or no answer in time → return NOTHING. Codex then
//     asks in its own UI exactly as it does today.
//
// The fallback is the important half: a decision channel that hangs the user's
// agent when unmute is closed would be worse than no channel at all.

import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../log'
import { CODEX_BUNDLED_CLI, codexHome } from './driver'

const log = createLogger('codex-hooks')

/** Where the handler drops requests and picks up answers. */
export const approvalDir = () => join(homedir(), '.unmute', 'remote', 'codex-approvals')
export const hookDir = () => join(homedir(), '.unmute', 'remote', 'codex-hooks')
const pendingPath = (dir: string, threadId: string) => join(dir, `${threadId}.json`)
const decisionPath = (dir: string, threadId: string) => join(dir, `${threadId}.decision`)
const heartbeatPath = (dir: string) => join(dir, 'unmute.alive')

/** A Codex approval request, as it reached us from inside Codex. */
export interface CodexApprovalRequest {
  threadId: string
  turnId: string
  cwd: string
  toolName: string
  /** The command / patch / arguments Codex wants permission for. */
  toolInput: unknown
  at: number
}

/** Human-readable one-liner for the notch, derived from the tool payload. */
export function describeApproval(req: CodexApprovalRequest): string {
  const inp = req.toolInput as Record<string, unknown> | null
  const cmd = inp && typeof inp === 'object' ? inp.command : null
  if (typeof cmd === 'string' && cmd.trim()) return cmd.trim().slice(0, 200)
  const path = inp && typeof inp === 'object' ? (inp.file_path ?? inp.path) : null
  if (typeof path === 'string') return `${req.toolName}: ${path}`
  return req.toolName || 'an action'
}

// ---------------------------------------------------------------------------
// The handler that runs INSIDE Codex
// ---------------------------------------------------------------------------

/**
 * The handler body. It runs as a short-lived node process spawned by Codex, so
 * it gets no imports from this bundle — everything it needs is inlined.
 *
 * It deliberately fails OPEN: any parse error, missing directory, or dead
 * unmute returns an empty object, which Codex reads as "this hook has no
 * opinion" and falls back to asking the user itself.
 */
function handlerSource(waitMs: number): string {
  return `#!/usr/bin/env node
// GENERATED BY UNMUTE — do not edit. Rewritten on every "Connect Codex".
// Reports a Codex approval request to unmute and waits briefly for an answer.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DIR = path.join(os.homedir(), '.unmute', 'remote', 'codex-approvals')
const WAIT_MS = ${waitMs}
const NO_OPINION = JSON.stringify({ suppressOutput: true })

function done(out) { process.stdout.write(out); process.exit(0) }

let ev = {}
try { ev = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { done(NO_OPINION) }
const threadId = ev.session_id
if (!threadId) done(NO_OPINION)

try { fs.mkdirSync(DIR, { recursive: true }) } catch { done(NO_OPINION) }

// Is unmute actually up? A stale heartbeat means nobody is listening, so we
// must not make the user wait — Codex asks them directly instead.
let live = false
try {
  const st = fs.statSync(path.join(DIR, 'unmute.alive'))
  live = Date.now() - st.mtimeMs < 90_000
} catch {}

const pending = path.join(DIR, threadId + '.json')
const decision = path.join(DIR, threadId + '.decision')
try { fs.unlinkSync(decision) } catch {}
try {
  fs.writeFileSync(pending, JSON.stringify({
    threadId, turnId: ev.turn_id, cwd: ev.cwd,
    toolName: ev.tool_name, toolInput: ev.tool_input, at: Date.now(),
  }))
} catch { done(NO_OPINION) }

if (!live) done(NO_OPINION)

// Poll for unmute's answer. Sync sleep is fine: this process exists only to
// wait, and Codex's own hook timeout is the outer bound.
const deadline = Date.now() + WAIT_MS
const sab = new Int32Array(new SharedArrayBuffer(4))
while (Date.now() < deadline) {
  let raw = null
  try { raw = fs.readFileSync(decision, 'utf8') } catch {}
  if (raw) {
    let behavior = null
    try { behavior = JSON.parse(raw).behavior } catch {}
    try { fs.unlinkSync(decision) } catch {}
    try { fs.unlinkSync(pending) } catch {}
    // CODEX'S CONTRACT, NOT CLAUDE'S.
    //
    // This used to emit Claude Code's shape —
    //   { suppressOutput, hookSpecificOutput: { hookEventName, decision: { behavior } } }
    // — and Codex recognises NONE of those keys (verified against the binary:
    // hookSpecificOutput 0 matches, hookEventName 0, suppressOutput 0). So a
    // DENY was silently ignored, Codex fell through to its own auto_review
    // reviewer, and the command ran anyway. A user tapped Deny in the notch and
    // the file was created on their Desktop.
    //
    // Codex's own strings give the contract: "hook returned decision:block
    // without a non-empty reason" and "Command blocked by PreToolUse hook: ".
    // The accepted values are 'allow' and 'block', and a block REQUIRES a
    // non-empty reason or it is discarded.
    if (behavior === 'deny') {
      done(JSON.stringify({ decision: 'block', reason: 'Denied in unmute' }))
    }
    if (behavior === 'allow') {
      done(JSON.stringify({ decision: 'allow' }))
    }
    done(NO_OPINION)
  }
  Atomics.wait(sab, 0, 0, 250)
}
// Timed out. Leave the pending file: the request is still real, and Codex is
// about to ask in its own UI, so unmute should keep showing it as blocked.
done(NO_OPINION)
`
}

/**
 * The shim Codex actually executes.
 *
 * It runs unmute's OWN Electron binary in node mode rather than a `node` off
 * the user's PATH: a packaged app cannot assume node exists, and baking an
 * absolute Homebrew path (which is what the probe did) breaks the moment the
 * user's node updates.
 */
function shimSource(runtime: string, handler: string): string {
  return `#!/bin/sh
# GENERATED BY UNMUTE — do not edit. Rewritten on every "Connect Codex".
ELECTRON_RUN_AS_NODE=1 exec "${runtime}" "${handler}"
`
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

interface HooksFile {
  description?: string
  hooks?: Record<string, unknown[]>
  [k: string]: unknown
}

/** Recognises OUR entry so a re-install replaces it instead of stacking. */
const MINE = (entry: unknown): boolean => {
  const g = entry as { hooks?: Array<{ command?: string }> } | null
  return !!g?.hooks?.some((h) => typeof h.command === 'string' && h.command.includes('/.unmute/remote/codex-hooks/'))
}

export interface InstallResult {
  ok: boolean
  /** 'trusted' means it will actually run. */
  trustStatus?: string
  key?: string
  reason?: string
}

/**
 * Install (or repair) the approval hook and trust it.
 *
 * Safe to call on every connect: it rewrites our files, merges rather than
 * clobbers the user's other hooks, and re-trusts the new hash. Idempotent by
 * construction — the hash only changes when we change the script.
 */
/**
 * Repair the approval channel if it has gone missing.
 *
 * Installation is tied to an explicit "connect Codex" — reasonable for the
 * FIRST install, but it cannot be the only check. These files live outside the
 * app bundle, so a Codex update, an app move, or a cleaned home directory takes
 * them away and nothing notices: Codex is left holding a trusted hash for a
 * file that no longer exists, every approval goes to Codex's own dialog, and a
 * task blocked on permission sits at "Working" forever with no way to answer it
 * from the notch. Observed in the field exactly that way — config.toml still
 * trusted hooks.json days after hooks.json had ceased to exist.
 *
 * The check is two stat calls, so it is free to run before every dispatch. The
 * REPAIR costs an app-server round trip, so it only happens when something is
 * actually gone — and reinstalling is already idempotent by design.
 */
export async function ensureApprovalHook(opts: {
  runtime: string
  codexCli?: string
  home?: string
}): Promise<InstallResult | { ok: true; reason: 'present' }> {
  const shim = join(hookDir(), 'permission-request.sh')
  const handler = join(hookDir(), 'permission-request.cjs')
  const hooksJson = join(opts.home ?? codexHome(), 'hooks.json')
  if (existsSync(shim) && existsSync(handler) && existsSync(hooksJson)) {
    return { ok: true, reason: 'present' }
  }
  log.warn('codex-hook-missing', {
    shim: existsSync(shim), handler: existsSync(handler), hooksJson: existsSync(hooksJson),
  })
  return await installApprovalHook(opts)
}

export async function installApprovalHook(opts: {
  /** Absolute path to the Electron binary that will run the handler. */
  runtime: string
  /** Seconds the hook may block waiting for the user (Codex kills it after `timeout`). */
  waitSec?: number
  codexCli?: string
  home?: string
}): Promise<InstallResult> {
  const waitSec = opts.waitSec ?? 240
  const dir = hookDir()
  const handler = join(dir, 'permission-request.cjs')
  const shim = join(dir, 'permission-request.sh')
  const cxHome = opts.home ?? codexHome()
  const hooksJson = join(cxHome, 'hooks.json')

  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.mkdir(approvalDir(), { recursive: true })
    await fs.writeFile(handler, handlerSource(waitSec * 1000), { mode: 0o755 })
    await fs.writeFile(shim, shimSource(opts.runtime, handler), { mode: 0o755 })
  } catch (e) {
    log.warn('codex-hook-write-failed', { error: (e as Error).message })
    return { ok: false, reason: 'write-failed' }
  }

  // MERGE. `~/.codex/hooks.json` is the user's file and may already hold hooks
  // that have nothing to do with us; dropping them would be a silent, invisible
  // breakage of their setup.
  let file: HooksFile = {}
  try {
    const raw = await fs.readFile(hooksJson, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) file = parsed as HooksFile
  } catch { /* absent or unreadable → start fresh */ }

  const events = (file.hooks ?? {}) as Record<string, unknown[]>
  const others = Array.isArray(events.PermissionRequest) ? events.PermissionRequest.filter((e) => !MINE(e)) : []
  events.PermissionRequest = [
    ...others,
    // ASYNC:FALSE IS THE WHOLE POINT, AND IT IS A REQUIRED FIELD WE OMITTED.
    //
    // ConfiguredHookHandler requires ['async','command','type']. Without
    // `async: false` Codex runs the hook FIRE-AND-FORGET: it starts our handler,
    // does not wait, and executes the command anyway. Measured — the hook fired
    // at :06, the command completed at :15, and the user's Deny arrived at :51
    // into a process nobody was listening to. A denial cannot be enforced by a
    // hook that the agent is not waiting on.
    //
    // THE FILE FORMAT IS NOT THE RPC FORMAT. On disk the key is `timeout`;
    // Codex maps it to `timeoutSec` when it reports the hook back over
    // hooks/list. Probed directly — writing timeout:111 and timeoutSec:222 made
    // hooks/list report timeoutSec:111. Setting `timeoutSec` in the file (which
    // is what the app-server's ConfiguredHookHandler schema calls it) is
    // silently ignored and Codex falls back to its 600s default.
    //
    // `async` stays: it is REQUIRED by that same schema, and without it Codex
    // treats the hook as fire-and-forget — it starts our handler, does not wait,
    // and runs the command anyway. hooks/list does not echo the field, so
    // whether the file honours this spelling is confirmed only by observing
    // that a denial is actually enforced.
    { matcher: '*', hooks: [{ type: 'command', command: shim, async: false, timeout: waitSec + 30 }] },
  ]
  file.hooks = events
  if (!file.description) file.description = 'Hooks configured by unmute and by you.'

  try {
    await fs.mkdir(cxHome, { recursive: true })
    await fs.writeFile(hooksJson, JSON.stringify(file, null, 2))
  } catch (e) {
    log.warn('codex-hooks-json-failed', { error: (e as Error).message })
    return { ok: false, reason: 'hooks-json-failed' }
  }

  return await trustHook(shim, { codexCli: opts.codexCli ?? CODEX_BUNDLED_CLI, home: cxHome })
}

/**
 * Ask Codex which hooks it sees, then trust ours.
 *
 * We only ever trust an entry whose command is the shim we just wrote, in our
 * own directory — this grants nothing to anything the user did not install by
 * connecting Codex to unmute.
 */
async function trustHook(shim: string, opts: { codexCli: string; home: string }): Promise<InstallResult> {
  const rpc = new AppServerClient(opts.codexCli)
  try {
    await rpc.start()
    await rpc.call('initialize', { clientInfo: { name: 'unmute', title: 'unmute', version: '1' } })

    const find = async (): Promise<Record<string, unknown> | null> => {
      const res = await rpc.call('hooks/list', { cwds: [homedir()] })
      const entries = (res as { data?: Array<{ hooks?: Array<Record<string, unknown>> }> })?.data ?? []
      for (const e of entries) {
        for (const h of e.hooks ?? []) if (h.command === shim) return h
      }
      return null
    }

    const before = await find()
    if (!before) {
      log.warn('codex-hook-not-discovered', { shim })
      return { ok: false, reason: 'not-discovered' }
    }
    if (before.trustStatus === 'trusted' || before.trustStatus === 'managed') {
      log.event('codex-hook-already-trusted', { key: before.key })
      return { ok: true, trustStatus: String(before.trustStatus), key: String(before.key) }
    }

    // Echo back the hash Codex just computed for the file we just wrote.
    await rpc.call('config/value/write', {
      keyPath: `hooks.state."${String(before.key)}"`,
      mergeStrategy: 'upsert',
      value: { trusted_hash: before.currentHash, enabled: true },
    })

    const after = await find()
    const trustStatus = String(after?.trustStatus ?? 'unknown')
    const ok = trustStatus === 'trusted' || trustStatus === 'managed'
    log[ok ? 'event' : 'warn']('codex-hook-trust', { key: before.key, trustStatus, ok })
    return { ok, trustStatus, key: String(before.key), ...(ok ? {} : { reason: 'trust-refused' }) }
  } catch (e) {
    log.warn('codex-hook-trust-error', { error: (e as Error).message })
    return { ok: false, reason: 'trust-error' }
  } finally {
    rpc.stop()
  }
}

// ---------------------------------------------------------------------------
// The unmute side of the channel
// ---------------------------------------------------------------------------

/** Tell the handler we are alive; without this it never waits for us. */
export async function beat(dir = approvalDir()): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(heartbeatPath(dir), String(Date.now()))
  } catch { /* a missed beat only costs us one fallback-to-Codex approval */ }
}

/** Every approval currently waiting, across all threads. */
export async function pendingApprovals(dir = approvalDir()): Promise<CodexApprovalRequest[]> {
  let names: string[] = []
  try { names = await fs.readdir(dir) } catch { return [] }
  const out: CodexApprovalRequest[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, n), 'utf8')
      const req = JSON.parse(raw) as CodexApprovalRequest
      if (req?.threadId) out.push(req)
    } catch { /* half-written; it will be there next poll */ }
  }
  return out
}

/**
 * Answer one. If the hook is still waiting this decides it outright; if it has
 * already timed out the file is simply consumed and Codex's own dialog stands.
 */
export async function decideApproval(
  threadId: string,
  behavior: 'allow' | 'deny',
  dir = approvalDir(),
): Promise<void> {
  try {
    await fs.writeFile(decisionPath(dir, threadId), JSON.stringify({ behavior, at: Date.now() }))
    log.event('codex-approval-decided', { threadId, behavior })
  } catch (e) {
    log.warn('codex-approval-decide-failed', { threadId, error: (e as Error).message })
  }
}

/** Drop a request we are no longer showing (task killed, thread gone). */
export async function clearApproval(threadId: string, dir = approvalDir()): Promise<void> {
  await fs.rm(pendingPath(dir, threadId), { force: true }).catch(() => {})
  await fs.rm(decisionPath(dir, threadId), { force: true }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Minimal app-server client (read + config write only)
// ---------------------------------------------------------------------------

/**
 * A second app-server client cannot drive the desktop app's UI — that was
 * settled by test, and is why writes go through CDP. It is perfectly good for
 * capability queries and config, which is all this is used for.
 */
export class AppServerClient {
  private proc: ReturnType<typeof spawn> | null = null
  private buf = ''
  private nextId = 0
  private pending = new Map<number, (v: unknown) => void>()

  constructor(private readonly cli: string) {}

  /** Rejects when the CLI cannot be launched, rather than making every
   *  subsequent call sit out its timeout. */
  async start(): Promise<void> {
    const proc = spawn(this.cli, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.proc = proc
    // A missing/unlaunchable CLI emits 'error' asynchronously; unhandled it
    // takes the whole process down.
    proc.stdin?.on('error', () => { /* the pipe died with the process */ })
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve)
      proc.once('error', (e) => {
        log.warn('codex-appserver-spawn-failed', { error: e.message })
        reject(e)
      })
    })
    this.proc.stdout?.on('data', (d: Buffer) => {
      this.buf += d.toString()
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (!line.trim()) continue
        let msg: { id?: number; result?: unknown; error?: unknown }
        try { msg = JSON.parse(line) } catch { continue }
        if (typeof msg.id === 'number') {
          const resolve = this.pending.get(msg.id)
          if (resolve) { this.pending.delete(msg.id); resolve(msg.error ? null : msg.result) }
        }
      }
    })
  }

  call(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    return new Promise((resolve) => {
      const id = this.nextId++
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null) }, timeoutMs)
      this.pending.set(id, (v) => { clearTimeout(timer); resolve(v) })
      try { this.proc?.stdin?.write(`${JSON.stringify({ id, method, params })}\n`) }
      catch { clearTimeout(timer); this.pending.delete(id); resolve(null) }
    })
  }

  stop(): void { try { this.proc?.kill() } catch { /* already gone */ } }
}
