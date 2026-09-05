import fs from 'node:fs/promises'
import { basename, join } from 'node:path'
import { cwdFromPrefix, defaultRoots, type Harness, type SessionRoots } from './locate'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
const WINDOW_BYTES = 128 * 1024
const MAX_FILES = 2_000

export interface SessionCatalogEntry {
  sessionId: string
  harness: Harness
  path: string
  cwd?: string
  modifiedAt: number
  userText: string
  artifacts: string[]
  forkedFromId?: string
  score: number
}

async function transcriptFiles(root: string, depth = 0, found: string[] = []): Promise<string[]> {
  if (depth > 6 || found.length >= MAX_FILES) return found
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (found.length >= MAX_FILES) break
    const path = join(root, entry.name)
    if (entry.isDirectory()) await transcriptFiles(path, depth + 1, found)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
  }
  return found
}

async function boundedTranscript(path: string): Promise<{ text: string; modifiedAt: number }> {
  const stat = await fs.stat(path)
  const handle = await fs.open(path, 'r')
  try {
    if (stat.size <= WINDOW_BYTES) return { text: await handle.readFile('utf8'), modifiedAt: stat.mtimeMs }
    const half = WINDOW_BYTES / 2
    const head = Buffer.alloc(half), tail = Buffer.alloc(half)
    const first = await handle.read(head, 0, half, 0)
    const last = await handle.read(tail, 0, half, Math.max(0, stat.size - half))
    return {
      text: `${head.subarray(0, first.bytesRead).toString('utf8')}\n${tail.subarray(0, last.bytesRead).toString('utf8')}`,
      modifiedAt: stat.mtimeMs,
    }
  } finally {
    await handle.close()
  }
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

function userText(text: string): string {
  const turns: string[] = []
  for (const line of text.split('\n')) {
    let record: any
    try { record = JSON.parse(line) } catch { continue }
    const message = record?.message ?? record?.payload?.message
    const isUser = record?.type === 'user'
      || record?.payload?.type === 'user_message'
      || message?.role === 'user'
      || record?.payload?.role === 'user'
    if (!isUser) continue
    const content = record?.payload?.type === 'user_message'
      ? record.payload.message
      : message?.content ?? record?.payload?.content ?? record?.content
    turns.push(...strings(content))
  }
  return turns.join('\n').replace(/\s+/g, ' ').trim().slice(0, 12_000)
}

function artifactRefs(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s"'<>\\]+/g) ?? []
  const paths = text.match(/(?:^|[\s"'])((?:\/Users|\/home|\/Volumes|\/tmp)\/[^\s"'<>\\]{2,})/gm)?.map(value => value.trim().replace(/^['"]|['",;)]$/g, '')) ?? []
  return [...new Set([...urls, ...paths])].slice(0, 32)
}

function idFor(path: string, harness: Harness): string | null {
  const name = basename(path)
  if (harness === 'claude') return name.replace(/\.jsonl$/, '').match(UUID)?.[0] ?? null
  return name.startsWith('rollout-') ? name.match(UUID)?.[0] ?? null : null
}

export async function searchSessionCatalog(
  query: string,
  roots: SessionRoots = defaultRoots(),
  limit = 12,
): Promise<SessionCatalogEntry[]> {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
  if (!tokens.length) return []
  const results: SessionCatalogEntry[] = []
  for (const [harness, root] of [['claude', roots.claudeProjects], ['codex', roots.codexSessions]] as const) {
    for (const path of await transcriptFiles(root)) {
      const sessionId = idFor(path, harness)
      if (!sessionId) continue
      const { text, modifiedAt } = await boundedTranscript(path).catch(() => ({ text: '', modifiedAt: 0 }))
      const turns = userText(text)
      const haystack = `${turns}\n${cwdFromPrefix(text) ?? ''}`.toLowerCase()
      const matches = tokens.map(token => haystack.split(token).length - 1)
      if (matches.some(count => count === 0)) continue
      const forkedFromId = /"forkedFromId"\s*:\s*"([^"]+)"/.exec(text)?.[1]
      results.push({
        sessionId, harness, path, modifiedAt, userText: turns,
        artifacts: artifactRefs(turns), score: matches.reduce((sum, count) => sum + count, 0),
        ...(cwdFromPrefix(text) ? { cwd: cwdFromPrefix(text) } : {}),
        ...(forkedFromId ? { forkedFromId } : {}),
      })
    }
  }
  return results.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt).slice(0, Math.max(1, Math.min(25, limit)))
}
