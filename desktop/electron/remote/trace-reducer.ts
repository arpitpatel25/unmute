import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log'
import { projectSlug } from './projects'

const log = createLogger('trace-reducer')
const reducerLog = createLogger('trace-reducer:reduce')

function defaultProjectsDir(): string { return join(homedir(), '.claude', 'projects') }

/** The DETERMINISTIC transcript path for a (cwd, Claude session id) pair. Claude
 *  Code stores each conversation at
 *  ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl, and Unmute mints + pins that
 *  session id (--session-id) at spawn, so this resolves the EXACT conversation —
 *  one file per task — instead of "the newest .jsonl in the folder" (which
 *  collapses multiple sessions sharing a repo dir onto one transcript). Uses the
 *  same slug transform init.ts already uses for this path (projectSlug: every run
 *  of non-alphanumerics → '-', verified against a real install). */
export function transcriptPathFor(cwd: string, sessionId: string, opts: { projectsDir?: string } = {}): string {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir()
  return join(projectsDir, projectSlug(cwd), `${sessionId}.jsonl`)
}

/** transcriptPathFor, but null when the file doesn't exist yet — e.g. a
 *  freshly-spawned session whose transcript Claude hasn't written. */
export async function resolveTranscriptById(cwd: string, sessionId: string, opts: { projectsDir?: string } = {}): Promise<string | null> {
  const p = transcriptPathFor(cwd, sessionId, opts)
  try { await fs.stat(p); return p } catch { return null }
}

/** Resolve the executor's JSONL by taskId (the cwd's last segment), which is the
 *  suffix of Claude's encoded project-dir name. Robust to the exact encoding:
 *  we match the dir whose name CONTAINS the taskId, then take the newest jsonl. */
export async function locateTranscript(taskCwd: string, opts: { projectsDir?: string } = {}): Promise<string | null> {
  const taskId = basename(taskCwd)
  const projectsDir = opts.projectsDir ?? defaultProjectsDir()
  let dirs: string[]
  try { dirs = await fs.readdir(projectsDir) } catch { return null }
  const match = dirs.find((d) => d.includes(taskId))
  if (!match) {
    // TEMP(memory-debug): remove after calibration
    log.event('locate-transcript', { taskId, matched: false, resolved: null })
    return null
  }
  const dir = join(projectsDir, match)
  let files: string[]
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')) } catch { return null }
  if (!files.length) {
    // TEMP(memory-debug): remove after calibration
    log.event('locate-transcript', { taskId, matched: true, resolved: null })
    return null
  }
  // stat can race a concurrent delete; a vanished file sorts last (m: -1) rather than throwing.
  const withMtime = await Promise.all(files.map(async (f) => {
    try { return { f, m: (await fs.stat(join(dir, f))).mtimeMs } } catch { return { f, m: -1 } }
  }))
  withMtime.sort((a, b) => b.m - a.m)
  const resolved = join(dir, withMtime[0].f)
  // TEMP(memory-debug): remove after calibration
  log.event('locate-transcript', { taskId, matched: true, resolved })
  return resolved
}

/** Render one tool_use as a SEMANTIC trace line. Browser/GUI interactions are
 *  distilled to their intent (the action verb + entry URL + typed text) with
 *  raw pixel COORDINATES stripped — those are brittle and worthless to the
 *  librarian. A durable recipe needs "click Post", not "click (834,221)". */
function toolLine(name: string, input: any): string {
  const n = name ?? 'unknown'
  // chrome browser navigation: the URL is the durable entry point.
  if (/navigate/.test(n)) return `NAV ${input?.url ?? ''}`.trim()
  // chrome computer/GUI interaction: keep the action verb + typed text, drop coordinates.
  if (/computer|mouse|click|keyboard/.test(n) && input && typeof input.action === 'string') {
    const txt = typeof input.text === 'string' ? ` "${input.text.slice(0, 80)}"`
      : typeof input.key === 'string' ? ` ${input.key}` : ''
    return `UI ${input.action}${txt}`
  }
  return `TOOL ${n}: ${JSON.stringify(input ?? {}).slice(0, 240)}`
}

/** Distill a noisy Claude Code JSONL into an ordered, bounded markdown "action
 *  trace": tool calls (semantic, no pixel coordinates), tool results (ok/error),
 *  and the assistant's narration. Deterministic extraction only — judgment is
 *  the librarian's. Selector paths reflect the verified fixture schema (README.md). */
export function reduceTranscript(jsonl: string, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 8000
  const out: string[] = []
  // Collapse consecutive identical lines (e.g. a run of clicks) into "… (xN)"
  // so brittle UI churn never drowns the semantic story.
  const push = (line: string) => {
    const prev = out[out.length - 1]
    const m = prev && prev.match(/^(.*?)(?: \(x(\d+)\))?$/)
    if (m && m[1] === line) { out[out.length - 1] = `${line} (x${(Number(m[2]) || 1) + 1})` }
    else out.push(line)
  }
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let ev: any
    try { ev = JSON.parse(line) } catch { continue }
    const msg = ev.message ?? ev
    const content = Array.isArray(msg?.content) ? msg.content : []
    for (const block of content) {
      if (block?.type === 'tool_use') {
        push(toolLine(block.name, block.input))
      } else if (block?.type === 'tool_result') {
        const isErr = block.is_error === true
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? '').join(' ') : ''
        const clean = String(text).replace(/\s+/g, ' ').trim()
        // Errors always matter. Empty "ok" results (e.g. a GUI screenshot with no
        // text) are noise — drop them so consecutive UI actions stay adjacent and
        // collapse, and the semantic story isn't buried.
        if (isErr) push(`  -> ERROR: ${clean.slice(0, 200)}`)
        else if (clean) push(`  -> ok: ${clean.slice(0, 200)}`)
      } else if (block?.type === 'text' && msg?.role === 'assistant') {
        const t = String(block.text ?? '').replace(/\s+/g, ' ').trim()
        if (t) push(`SAY: ${t.slice(0, 300)}`)
      }
    }
  }
  const joined = out.join('\n')
  const result = joined.length > maxChars ? joined.slice(-maxChars) : joined
  // TEMP(memory-debug): summary log — input bytes → output bytes
  reducerLog.event('reduce-transcript', { inputBytes: jsonl.length, outputBytes: result.length })
  return result
}
