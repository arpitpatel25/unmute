import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/**
 * FINDING ONE SESSION, ON DEMAND — and nothing else.
 *
 * The sweep that used to maintain an index of every session was deleted in
 * cc48bbf: it re-derived summaries on a 60s timer, spawned a CLI per session,
 * and discovered its own output as new work (~17k launches a day). None of
 * that is needed to answer "where is session X". The transcript filename IS
 * the id in both harnesses, so a lookup is a walk and a stat, with no model
 * call, no cache to maintain and no timer.
 *
 * Listing and searching deliberately do NOT live here. The Agent already holds
 * Glob, Grep and Read, and a tool over readable data caps it at the queries a
 * schema author imagined. This module exists for the one thing the Agent
 * cannot do for itself: hand an id to something that can spawn a process.
 */

export type Harness = 'claude' | 'codex'

export interface SessionRoots {
  claudeProjects: string
  codexSessions: string
}

export function defaultRoots(home: string = homedir()): SessionRoots {
  return {
    claudeProjects: join(home, '.claude', 'projects'),
    codexSessions: join(home, '.codex', 'sessions'),
  }
}

export interface LocatedSession {
  sessionId: string
  harness: Harness
  path: string
  /** The directory the session ran in. Absent when the transcript never says. */
  cwd?: string
  provenance?: SessionProvenance
}

export interface SessionProvenance {
  // 'routine' is never produced here: it is assigned in turn-index.ts from the
  // session's cwd, once the cwd it needs has already been recovered below.
  kind: 'main' | 'subagent' | 'unknown' | 'routine'
  parentSessionId?: string
  reason?: string
}

/** Project complete header fields without parsing a truncated string as metadata.
 * Codex puts multi-megabyte base instructions after the provenance header. Keep
 * the read bounded; a quoted mention of `source` in those instructions is never
 * evidence. Incomplete provenance itself remains unknown.
 */
function headerObject(line: string): Record<string, any> | undefined {
  try { return JSON.parse(line) } catch { /* bounded prefix, possibly incomplete */ }
  let quoted = false, escaped = false
  const stack: string[] = []
  let boundary: { index: number; closers: string } | undefined
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') stack.pop()
    else if (char === ',' && stack.length > 0 && stack.length <= 2 && stack.every(value => value === '{')) {
      boundary = { index: i, closers: '}'.repeat(stack.length) }
    }
  }
  if (!boundary) return undefined
  try { return JSON.parse(line.slice(0, boundary.index) + boundary.closers) } catch { return undefined }
}

export function provenanceFromPrefix(prefix: string, harness: Harness, path: string, sessionId: string): SessionProvenance {
  if (harness === 'claude') {
    if (path.split(/[\\/]/).includes('subagents')) return { kind: 'subagent', reason: 'Claude subagent transcript' }
    let main = false, incomplete = false
    for (const line of prefix.split('\n')) {
      const record = headerObject(line)
      if (!record || !['user', 'assistant'].includes(record.type)) continue
      if (record.isSidechain === true || record.agentId) return { kind: 'subagent', reason: 'Claude sidechain' }
      if (record.sessionId && record.sessionId !== sessionId) return { kind: 'unknown', reason: 'Transcript identity does not match its filename' }
      if (record.isSidechain === false) {
        try { JSON.parse(line); main = true } catch { incomplete = true }
      }
    }
    return main ? { kind: 'main' } : { kind: 'unknown', reason: incomplete ? 'Incomplete Claude session metadata' : 'No explicit main-conversation provenance' }
  }
  const firstLine = prefix.split('\n', 1)[0]
  const record = headerObject(firstLine)
  if (record?.type !== 'session_meta' || !record.payload) return { kind: 'unknown', reason: 'Missing Codex session metadata' }
  const meta = record.payload
  const spawn = meta.source?.subagent?.thread_spawn
  const parentSessionId = typeof spawn?.parent_thread_id === 'string' ? spawn.parent_thread_id
    : typeof meta.parent_thread_id === 'string' ? meta.parent_thread_id : undefined
  if (meta.source && typeof meta.source === 'object' && 'subagent' in meta.source
    || meta.thread_source === 'subagent'
    || typeof meta.agent_path === 'string' && meta.agent_path !== '/root') {
    return { kind: 'subagent', ...(parentSessionId ? { parentSessionId } : {}), reason: 'Codex subagent conversation' }
  }
  // A positive classification needs the entire header: exclusion fields can
  // follow a large instructions string. A partial header can only reject.
  try { JSON.parse(firstLine) } catch { return { kind: 'unknown', reason: 'Incomplete Codex session metadata' } }
  // `id` identifies the thread. In child rollouts `session_id` can identify
  // the ROOT instead, so never turn that field into the selected thread ID.
  const actualId = meta.id ?? meta.session_id
  if (actualId !== sessionId) return { kind: 'unknown', reason: 'Transcript identity does not match its filename' }
  if (['cli', 'vscode', 'exec', 'appServer', 'app-server'].includes(meta.source)) return { kind: 'main' }
  return { kind: 'unknown', reason: 'No explicit main-conversation provenance' }
}

/** Scan only an oversized first record, retaining bounded JSON structure while
 * discarding large string VALUES. This sees provenance after instructions
 * without materializing megabytes of prompts or synchronously parsing them.
 * Input, output, and individual tokens are capped; malformed/over-limit data
 * remains unknown. No transcript turns are scanned by this fallback.
 */
async function compactSessionHeader(path: string, harness: Harness): Promise<string> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 })
  const parts: string[] = []
  let quoted = false, escaped = false, clipped = false, token = '', unicodeDigits = 0
  let read = 0, retained = 0
  try {
    for await (const chunk of stream) {
      read += Buffer.byteLength(chunk as string)
      if (read > 64 * 1024 * 1024) return ''
      for (const char of chunk as string) {
        if (quoted) {
          if (char.charCodeAt(0) < 32) return ''
          if (!clipped) {
            token += char
            if (token.length > 4096) { token = ''; clipped = true }
          }
          if (unicodeDigits) {
            if (!/[0-9a-f]/i.test(char)) return ''
            unicodeDigits--
          } else if (escaped) {
            if (char === 'u') unicodeDigits = 4
            else if (!'"\\/bfnrt'.includes(char)) return ''
            escaped = false
          }
          else if (char === '\\') escaped = true
          else if (char === '"') {
            const value = clipped ? '""' : token
            parts.push(value); retained += value.length
            quoted = false; token = ''; clipped = false
          }
        } else if (char === '\n') {
          const line = parts.join('')
          if (harness === 'codex') return line
          let record: any
          try { record = JSON.parse(line) } catch { return '' }
          if (['user', 'assistant'].includes(record?.type)) return line
          parts.length = 0; retained = 0
        }
        else if (char === '"') { quoted = true; token = '"' }
        else { parts.push(char); retained++ }
        if (retained > 128 * 1024) return ''
      }
    }
    return quoted ? '' : parts.join('')
  } catch { return '' } finally { stream.destroy() }
}

export async function readSessionProvenance(path: string, harness: Harness, sessionId: string, prefix: string): Promise<SessionProvenance> {
  const initial = provenanceFromPrefix(prefix, harness, path, sessionId)
  if (!initial.reason?.startsWith('Incomplete ')) return initial
  return provenanceFromPrefix(await compactSessionHeader(path, harness), harness, path, sessionId)
}

/** Execution boundary: discovery filtering alone cannot protect a direct ID. */
export function requireMainSession(located: LocatedSession): void {
  if (located.provenance?.kind === 'main') return
  const parent = located.provenance?.parentSessionId
  throw new Error(located.provenance?.kind === 'subagent'
    ? `Sub-agent conversations cannot be resumed, forked, or used as context. Find the main conversation${parent ? ` (parent candidate: ${parent}; verify it first)` : ''}.`
    : 'Cannot verify that this is a main conversation. No session was started; find a verified main conversation.')
}

/**
 * How much of a transcript is read to recover `cwd`.
 *
 * Claude states it a few KB in (measured: byte 4833 of a real session, after
 * the mode/permission preamble). Codex states it in the first line's
 * session_meta — but that same line then carries the entire base-instructions
 * prompt, and one real file measured 21 MB before its first user turn. So a
 * bounded prefix, never the whole file.
 */
const PREFIX_BYTES = 64 * 1024

/** Never JSON.parse'd: a prefix is not valid JSON. */
export function cwdFromPrefix(prefix: string): string | undefined {
  const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.){1,1024})"/.exec(prefix)?.[1]
  return cwd ? cwd.replace(/\\(.)/g, '$1') : undefined
}

/**
 * Exact, in both harnesses. A prefix match would resolve a truncated or
 * hand-copied id to a NEIGHBOURING session, and resuming the wrong
 * conversation is worse than not finding one.
 */
function isTranscriptFor(name: string, harness: Harness, sessionId: string): boolean {
  if (harness === 'claude') return name === `${sessionId}.jsonl`
  return name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`)
}

async function findUnder(
  dir: string,
  harness: Harness,
  sessionId: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 6) return null
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as unknown as typeof entries
  } catch { return null }
  const dirs: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) dirs.push(full)
    else if (entry.isFile() && isTranscriptFor(entry.name, harness, sessionId)) return full
  }
  for (const child of dirs) {
    const hit = await findUnder(child, harness, sessionId, depth + 1)
    if (hit) return hit
  }
  return null
}

async function readPrefix(path: string): Promise<string> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(path, 'r')
    const buffer = Buffer.alloc(PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, PREFIX_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** The transcript for this id, or null when it is not on this machine. */
export async function locateSession(
  sessionId: string,
  roots: SessionRoots = defaultRoots(),
): Promise<LocatedSession | null> {
  const id = sessionId.trim()
  if (!id) return null
  for (const [harness, root] of [
    ['claude', roots.claudeProjects],
    ['codex', roots.codexSessions],
  ] as const) {
    const path = await findUnder(root, harness, id)
    if (!path) continue
    const prefix = await readPrefix(path)
    const cwd = cwdFromPrefix(prefix)
    return { sessionId: id, harness, path, provenance: await readSessionProvenance(path, harness, id, prefix), ...(cwd ? { cwd } : {}) }
  }
  return null
}

/** Exported for the caller that wants the name without re-deriving it. */
export function transcriptName(located: LocatedSession): string {
  return basename(located.path)
}
