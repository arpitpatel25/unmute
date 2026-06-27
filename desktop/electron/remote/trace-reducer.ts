import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log'

const log = createLogger('trace-reducer')
const reducerLog = createLogger('trace-reducer:reduce')

function defaultProjectsDir(): string { return join(homedir(), '.claude', 'projects') }

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

/** Distill a noisy Claude Code JSONL into an ordered, bounded markdown "action
 *  trace": tool calls (+ key inputs), tool results (ok/error), and the final
 *  assistant text. Deterministic extraction only — judgment is the librarian's.
 *  Selector paths reflect the verified fixture schema (README.md). */
export function reduceTranscript(jsonl: string, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 8000
  const out: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let ev: any
    try { ev = JSON.parse(line) } catch { continue }
    const msg = ev.message ?? ev
    const content = Array.isArray(msg?.content) ? msg.content : []
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const input = JSON.stringify(block.input ?? {})
        out.push(`TOOL ${block.name ?? 'unknown'}: ${input.slice(0, 240)}`)
      } else if (block?.type === 'tool_result') {
        const isErr = block.is_error === true
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? '').join(' ') : ''
        out.push(`  -> ${isErr ? 'ERROR' : 'ok'}: ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`)
      } else if (block?.type === 'text' && msg?.role === 'assistant') {
        const t = String(block.text ?? '').replace(/\s+/g, ' ').trim()
        if (t) out.push(`SAY: ${t.slice(0, 300)}`)
      }
    }
  }
  const joined = out.join('\n')
  const result = joined.length > maxChars ? joined.slice(-maxChars) : joined
  // TEMP(memory-debug): summary log — input bytes → output bytes
  reducerLog.event('reduce-transcript', { inputBytes: jsonl.length, outputBytes: result.length })
  return result
}
