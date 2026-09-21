// THE AGENT SEES WHAT YOU CAPTURED.
//
// A screenshot taken during an Agent capture used to reach the provider as an
// opaque handle string and nothing else — the Agent could file it into memory
// but could not look at it, so "what do you see in this screenshot?" had no
// answer. Tasks never had this problem: their images arrive as real files.
//
// This is the one place that turns a capture's image paths into what each
// provider's input actually accepts. Claude's stream-json input takes base64
// image blocks; Codex takes local image paths directly, so it needs nothing
// from here beyond the filter.

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** Only these reach the model as pictures; anything else keeps its handle. */
export function isTurnImage(path: string): boolean {
  return extname(path).toLowerCase() in MEDIA_TYPES
}

/** The API refuses an image over 5 MB of base64. A Retina full-screen PNG can
 *  be larger than that, so anything near the line is re-encoded first. */
const MAX_RAW_BYTES = 3_500_000
/** Past this the API downsizes anyway; sending more is only upload time. */
const MAX_EDGE_PX = 2000

export interface ClaudeImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

/**
 * Base64 image blocks for a Claude user turn. A file that cannot be read is
 * skipped rather than failing the turn — the words still go, and the handle
 * the controller listed still names it.
 */
export async function claudeImageBlocks(paths: readonly string[] = []): Promise<ClaudeImageBlock[]> {
  const blocks: ClaudeImageBlock[] = []
  for (const path of paths) {
    if (!isTurnImage(path)) continue
    try {
      const size = (await stat(path)).size
      if (size <= MAX_RAW_BYTES) {
        blocks.push(block(MEDIA_TYPES[extname(path).toLowerCase()], await readFile(path)))
        continue
      }
      const shrunk = await downscaleToJpeg(path)
      if (shrunk) blocks.push(block('image/jpeg', shrunk))
    } catch (error) {
      console.warn('[agent] turn image skipped:', path, error instanceof Error ? error.message : error)
    }
  }
  return blocks
}

function block(mediaType: string, bytes: Buffer): ClaudeImageBlock {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } }
}

/** macOS's own image tool, so no dependency is added for one resize. */
async function downscaleToJpeg(path: string): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'unmute-agent-image-'))
  const out = join(dir, 'image.jpg')
  try {
    await new Promise<void>((resolve, reject) => execFile('/usr/bin/sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(MAX_EDGE_PX), path, '--out', out],
      { timeout: 15_000 }, (error) => error ? reject(error) : resolve()))
    const bytes = await readFile(out)
    return bytes.length <= MAX_RAW_BYTES ? bytes : null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
