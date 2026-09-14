import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import type { RunWindow } from './window'

/**
 * THE INPUTS FOR A ROUTINE RUN, GATHERED BY CODE, NOT SEARCHED FOR BY THE MODEL.
 *
 * §3.3 of the design: when a routine's `inputs` include `sessions`, this reads
 * the two files SessionTurnIndex already maintains — sessions.jsonl and
 * turns.jsonl — and turns them into one manifest scoped to the run's window.
 * Nothing here parses a transcript; the index already did that work once.
 *
 * Two independent guards keep a routine from feeding on its own output (the
 * self-feeding loop behind the deleted session-summary sweep, §4.2):
 * provenance `routine` (set in turn-index.ts from the session's cwd) and
 * `excludeCwdPart`, a belt-and-suspenders cwd check the caller passes
 * explicitly. Either one alone would do; both together survive the index
 * lagging behind either check on its own.
 */

export interface ManifestSession {
  id: string
  provider: string
  cwd?: string
  firstAt?: number
  lastAt?: number
  turnsInWindow: number
  turns: Array<{ t: number; o: number; text?: string }>
}

export interface RoutineManifest {
  window: RunWindow
  sessions: ManifestSession[]
  totals: { sessions: number; turns: number }
  truncated: boolean
}

/** What manifest.md and manifest.json land in, inside a run directory. */
const MANIFEST_JSON = 'manifest.json'
const MANIFEST_MD = 'manifest.md'
/** A turn is context, not the transcript; go to its offset for the whole thing. */
const MAX_TEXT_CHARS = 400
/** Matches the SessionTurnIndex root — see turn-index.ts's defaultIndexRoot. */
export function defaultIndexDir(): string {
  return join(homedir(), '.unmute', 'remote', 'session-index')
}
const DEFAULT_MAX_BYTES = 256 * 1024

interface RawIndexedSession {
  id?: unknown
  provider?: unknown
  cwd?: unknown
  provenance?: unknown
  firstAt?: unknown
  lastAt?: unknown
}
interface RawIndexedTurn {
  s?: unknown
  t?: unknown
  o?: unknown
  text?: unknown
}

/**
 * Truncate by CODE POINT, not by UTF-16 index: `String.prototype.slice` counts
 * `\uD800`-`\uDBFF`/`\uDC00`-`\uDFFF` surrogate halves separately, so a plain
 * `.slice(0, n)` can land exactly between the two halves of an emoji or other
 * astral character and leave a lone, invalid surrogate in the output. The
 * `text.length <= maxCodePoints` fast path is safe without spreading: a
 * string's UTF-16 length is always >= its code point count, so if the former
 * is already within budget the latter is too.
 */
function truncateText(text: string, maxCodePoints: number): string {
  if (text.length <= maxCodePoints) return text
  const codePoints = Array.from(text)
  return codePoints.length <= maxCodePoints ? text : codePoints.slice(0, maxCodePoints).join('')
}

/** Line-by-line over a stream so a huge index file is never held whole in
 *  memory; a missing file is simply nothing to read, never an error. */
async function forEachLine(path: string, onLine: (line: string) => void): Promise<void> {
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(path, { encoding: 'utf8' })
  } catch { return }
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (line.trim()) onLine(line)
    }
  } catch { /* absent or unreadable file: nothing more to read */ }
  finally {
    rl.close()
    stream.destroy()
  }
}

export async function buildManifest(opts: {
  indexDir: string
  window: RunWindow
  excludeCwdPart: string
  maxBytes?: number
}): Promise<RoutineManifest> {
  const { indexDir, window, excludeCwdPart } = opts
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  // sessions.jsonl is small (one line per session) and read whole first, so
  // turns.jsonl — the large file — can be filtered as it streams rather than
  // held in memory to be joined afterward. A later line for the same id wins,
  // exactly as the index's own reload does.
  const rawSessions = new Map<string, RawIndexedSession>()
  await forEachLine(join(indexDir, 'sessions.jsonl'), line => {
    try {
      const record = JSON.parse(line) as RawIndexedSession
      if (record && typeof record.id === 'string') rawSessions.set(record.id, record)
    } catch { /* one bad line is not a bad file */ }
  })

  const eligible = new Map<string, ManifestSession>()
  for (const session of rawSessions.values()) {
    const id = session.id as string
    if (session.provenance === 'routine') continue
    const cwd = typeof session.cwd === 'string' ? session.cwd : undefined
    if (cwd && cwd.includes(excludeCwdPart)) continue
    eligible.set(id, {
      id,
      provider: typeof session.provider === 'string' ? session.provider : 'unknown',
      ...(cwd ? { cwd } : {}),
      ...(typeof session.firstAt === 'number' ? { firstAt: session.firstAt } : {}),
      ...(typeof session.lastAt === 'number' ? { lastAt: session.lastAt } : {}),
      turnsInWindow: 0,
      turns: [],
    })
  }

  await forEachLine(join(indexDir, 'turns.jsonl'), line => {
    let record: RawIndexedTurn
    try { record = JSON.parse(line) } catch { return }
    if (typeof record.s !== 'string' || typeof record.t !== 'number' || typeof record.o !== 'number') return
    if (record.t < window.start || record.t > window.end) return
    const session = eligible.get(record.s)
    if (!session) return
    session.turnsInWindow += 1
    const text = typeof record.text === 'string' ? truncateText(record.text, MAX_TEXT_CHARS) : undefined
    session.turns.push({ t: record.t, o: record.o, ...(text !== undefined ? { text } : {}) })
  })

  const sessions = [...eligible.values()]
    .filter(session => session.turnsInWindow > 0)
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

  const totals = { sessions: sessions.length, turns: sessions.reduce((sum, s) => sum + s.turnsInWindow, 0) }
  const manifest: RoutineManifest = { window, sessions, totals, truncated: false }
  // UTF-8 bytes, not `.length` (UTF-16 code units): non-ASCII turn text — CJK,
  // emoji — undercounts by up to ~3x under `.length`, which let a manifest
  // past the real 256 KB budget report `truncated: false`.
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') <= maxBytes) return manifest

  // Over the cap: drop text, keep offsets. The transcript is still reachable
  // by `o`, so nothing here is lost — only what the model would have read
  // inline shrinks.
  return {
    ...manifest,
    truncated: true,
    sessions: sessions.map(session => ({
      ...session,
      turns: session.turns.map(turn => ({ t: turn.t, o: turn.o })),
    })),
  }
}

function renderMarkdown(manifest: RoutineManifest): string {
  const lines: string[] = ['# Inputs for this run', '']
  lines.push(
    `${manifest.window.label} — ${manifest.totals.sessions} session${manifest.totals.sessions === 1 ? '' : 's'}, `
    + `${manifest.totals.turns} turn${manifest.totals.turns === 1 ? '' : 's'}${manifest.truncated ? ' (truncated)' : ''}`,
  )
  for (const session of manifest.sessions) {
    lines.push('', `## ${session.id} · ${session.provider} · ${session.cwd ?? 'unknown cwd'}`)
    for (const turn of session.turns) {
      const when = new Date(turn.t).toISOString()
      lines.push(`- ${when} (offset ${turn.o}): ${turn.text ?? ''}`)
    }
  }
  return lines.join('\n') + '\n'
}

export async function writeManifest(dir: string, manifest: RoutineManifest): Promise<{ jsonPath: string; mdPath: string }> {
  await fs.mkdir(dir, { recursive: true })
  const jsonPath = join(dir, MANIFEST_JSON)
  const mdPath = join(dir, MANIFEST_MD)
  await writeFileAtomic(jsonPath, JSON.stringify(manifest, null, 2))
  await writeFileAtomic(mdPath, renderMarkdown(manifest))
  return { jsonPath, mdPath }
}
