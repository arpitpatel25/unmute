import { promises as fs, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { projectSlug } from './projects'
import { resolveTmuxBin, sessionNameFor, tmuxPaneStartCommandArgs } from './tmux'

// Self-heals a task whose meta.json got truncated/lost (see atomic-file.ts for
// the write-side bug this is a safety net for). meta.json is only Unmute's own
// CACHE of facts that really live in the agent's own transcript — Codex's
// rollout, or Claude Code's project transcript. As long as that transcript is
// still there, the task can be rebuilt from it. If it isn't, that's a loss on
// the agent's side, not Unmute's, and there is nothing left to reconstruct.
//
// SCOPE: full recovery (agent + sessionId + real intent) only works for the
// "scratch" dispatch shape, where a task's OWN directory IS the cwd it ran in
// (home === cwd) — the common case for CLI/native dispatch. A project-bound
// session (cwd is the user's real repo, not this task's receipt dir) has no
// durable pointer back to that cwd once meta.json is gone, so it falls back
// to a DEGRADED record built from status.json alone: real completion state
// and the real answer text, just not the literal original question wording.

export interface RecoveredSession {
  agent: 'codex' | 'claude'
  sessionId: string
  intent: string
}

export interface ReconstructedMeta {
  intent: string
  agent?: 'codex' | 'claude'
  sessionId?: string
  state?: string
  /** True when this came ONLY from status.json — no session was matched, so
   *  `intent` is the recovered ANSWER text, not the original question. */
  degraded: boolean
}

interface StatusSnapshot {
  state?: string
  updatedAt?: string
  summary?: string
}

const ROLLOUT_RE = /^rollout-.+\.jsonl$/

/** A live Codex rollout keeps growing for as long as the session runs — one
 *  was seen at 26GB on this real machine. Reconstruction runs unconditionally
 *  on every app launch, so it must never read a whole rollout/transcript into
 *  memory. `session_meta` and the first user turn are always near the top of
 *  the file; this is generous headroom for both, on any file, forever. */
const SAFE_SCAN_BYTES = 2 * 1024 * 1024

function truncate(s: string, n = 200): string {
  const t = s.trim().split('\n')[0] ?? ''
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t
}

/** Read up to `cap` bytes from the START of a file. Never reads the whole
 *  file regardless of its actual size. A line straddling the cap boundary is
 *  simply dropped by the tolerant JSONL parser below, not corrupted. */
export async function __readBoundedPrefix(path: string, cap = SAFE_SCAN_BYTES): Promise<string | null> {
  let fh
  try {
    fh = await fs.open(path, 'r')
  } catch {
    return null
  }
  try {
    const stat = await fh.stat()
    const len = Math.min(stat.size, cap)
    if (len === 0) return ''
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

function parseJsonlLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t) as Record<string, unknown>) } catch { /* truncated tail from the read cap, or mid-write — skip */ }
  }
  return out
}

async function walkFiles(dir: string, match: (name: string) => boolean, maxDepth = 4): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries
    try { entries = await fs.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) { await walk(p, depth + 1); continue }
      if (match(e.name)) out.push(p)
    }
  }
  await walk(dir, 0)
  return out
}

/** Find the Codex rollout whose `session_meta.cwd` exactly matches `cwd`,
 *  newest first, and recover its first user message as the task's intent. */
export async function findCodexSessionByCwd(cwd: string, home = homedir()): Promise<RecoveredSession | null> {
  const roots = [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')]
  const paths = (await Promise.all(roots.map((r) => walkFiles(r, (n) => ROLLOUT_RE.test(n))))).flat()
  const withMtime = await Promise.all(paths.map(async (p) => {
    try { return { p, m: (await fs.stat(p)).mtimeMs } } catch { return null }
  }))
  const sorted = withMtime.filter((x): x is { p: string; m: number } => x !== null).sort((a, b) => b.m - a.m)

  for (const { p } of sorted) {
    const prefix = await __readBoundedPrefix(p)
    if (!prefix) continue
    const events = parseJsonlLines(prefix)
    const meta = events.find((e) => e.type === 'session_meta')?.payload as { cwd?: string; session_id?: string } | undefined
    if (!meta || meta.cwd !== cwd) continue
    const firstAsk = events.find((e) => e.type === 'event_msg' && (e.payload as { type?: string } | undefined)?.type === 'user_message')
    const payload = firstAsk?.payload as { message?: string; text?: string } | undefined
    const text = String(payload?.message ?? payload?.text ?? '')
    return {
      agent: 'codex',
      sessionId: meta.session_id ?? '',
      intent: text ? truncate(text) : 'Recovered Codex task',
    }
  }
  return null
}

function claudeMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text?: unknown }).text ?? '') : '')).join(' ').trim()
  }
  return ''
}

/** Find the newest Claude Code transcript under the cwd's project slug, and
 *  verify the exact cwd on the record itself — the slug is a LOSSY encoding
 *  (every non-alphanumeric char becomes '-'), so a slug match alone is not
 *  proof of the same directory. */
export async function findClaudeSessionByCwd(cwd: string, home = homedir()): Promise<RecoveredSession | null> {
  const dir = join(home, '.claude', 'projects', projectSlug(cwd))
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return null }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name)
  const withMtime = await Promise.all(files.map(async (name) => {
    try { return { name, m: (await fs.stat(join(dir, name))).mtimeMs } } catch { return null }
  }))
  const sorted = withMtime.filter((x): x is { name: string; m: number } => x !== null).sort((a, b) => b.m - a.m)

  for (const { name } of sorted) {
    const prefix = await __readBoundedPrefix(join(dir, name))
    if (!prefix) continue
    const events = parseJsonlLines(prefix)
    const firstUser = events.find((e) => e.type === 'user' && typeof (e.message as { role?: string } | undefined)?.role === 'string')
    if (!firstUser || firstUser.cwd !== cwd) continue
    const text = claudeMessageText((firstUser.message as { content?: unknown } | undefined)?.content)
    const sessionId = String(firstUser.sessionId ?? name.replace(/\.jsonl$/, ''))
    return { agent: 'claude', sessionId, intent: text ? truncate(text) : 'Recovered Claude Code task' }
  }
  return null
}

/** Best-effort read of the durable completion facts every task writes,
 *  independent of meta.json — real state, real answer text. */
export async function readStatusSnapshot(dir: string): Promise<StatusSnapshot | null> {
  let raw: string
  try { raw = await fs.readFile(join(dir, 'status.json'), 'utf8') } catch { return null }
  if (!raw.trim()) return null
  let parsed: { state?: string; updated_at?: string; result?: { summary?: string } }
  try { parsed = JSON.parse(raw) } catch { return null }
  return { state: parsed.state, updatedAt: parsed.updated_at, summary: parsed.result?.summary }
}

function defaultRunTmux(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 2_000 }, (error, stdout) => {
      if (error) return resolve('') // no such session (or tmux server not running) — not an error to surface
      resolve(String(stdout))
    })
  })
}

/**
 * The one fully-certain "which agent is this" signal left once meta.json is
 * gone but a task's runtime happens to have survived: what tmux actually
 * started that pane with. THE BUG THIS EXISTS FOR — without it, a degraded
 * reconstruction leaves `agent` unset, and the generic rehydrate path
 * defaults a missing agent to 'claude'. That's fine for a genuinely ancient
 * pre-agent-field receipt (the original reason for that default); it is
 * simply wrong for a task that is, right now, provably running Codex.
 * Returns null for a dead runtime — nothing left to ask.
 */
export async function sniffLiveAgent(
  taskId: string,
  run: (bin: string, args: string[]) => Promise<string> = defaultRunTmux,
): Promise<'codex' | 'claude' | null> {
  const bin = resolveTmuxBin(existsSync)
  if (!bin) return null
  const out = await run(bin, tmuxPaneStartCommandArgs(sessionNameFor(taskId)))
  const cmd = (out.trim().split('\n')[0] ?? '').toLowerCase()
  if (/(^|[\s'"])codex(\s|$)/.test(cmd)) return 'codex'
  if (/(^|[\s'"])claude(\s|$)/.test(cmd)) return 'claude'
  return null
}

/**
 * Rebuild what meta.json would have held for one task directory, when
 * meta.json itself is missing, empty, or unparseable.
 *
 * `dir` doubles as the candidate cwd: full recovery (agent + sessionId +
 * real intent) only works for the "scratch" dispatch shape (home === cwd). A
 * project-bound session's real cwd is gone once meta.json is, and there's no
 * other durable pointer to it. Before fully degrading, still check whether
 * the task's own runtime survived — if so, at least label it with the agent
 * it is provably running, rather than guessing. Returns null only when
 * NOTHING survived at all: no session match, no live runtime, no status.json.
 */
export async function reconstructTaskMeta(
  dir: string,
  home = homedir(),
  sniffAgent: (taskId: string) => Promise<'codex' | 'claude' | null> = sniffLiveAgent,
): Promise<ReconstructedMeta | null> {
  const status = await readStatusSnapshot(dir)

  const codex = await findCodexSessionByCwd(dir, home)
  if (codex) return { intent: codex.intent, agent: 'codex', sessionId: codex.sessionId, state: status?.state, degraded: false }

  const claude = await findClaudeSessionByCwd(dir, home)
  if (claude) return { intent: claude.intent, agent: 'claude', sessionId: claude.sessionId, state: status?.state, degraded: false }

  const liveAgent = await sniffAgent(basename(dir))
  if (liveAgent) return { intent: status?.summary ?? 'Recovered task', agent: liveAgent, state: status?.state, degraded: true }

  if (status) return { intent: status.summary ?? 'Recovered task', state: status.state, degraded: true }

  return null
}
