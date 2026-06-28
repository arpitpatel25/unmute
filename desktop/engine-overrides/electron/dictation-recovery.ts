// Unmute — dictation crash-recovery (DECIDED with the owner).
//
// Reliability net: if the app dies AFTER the user finished speaking but BEFORE
// transcription completed, the audio is already on disk but there's no History
// entry — so from the user's view their dictation is simply lost. On launch we
// recover it: any dictation AUDIO that has no completed DB session is transcribed
// with the LOCAL model and written into History, so a spoken dictation is never
// silently dropped.
//
// THE JOURNAL IS IMPLICIT — audio-on-disk vs the DB. A completed dictation has
// BOTH (audio + a session row carrying its transcript). A crashed one has audio
// but no row (saveSession only runs on completion). This module never touches
// the live recording path.
//
// FAIL-OPEN at every step: any CATCHABLE error skips that one recording and it
// retries next launch; never a broken dictation. But transcription runs in the
// native ASR (onnxruntime), and a malformed recording can make it ABORT the whole
// process — an uncatchable crash that the try/catch below can't see. Without a
// durable record of "we already tried this one", the same poison recording would
// re-crash on every launch: a permanent boot-crash loop. So before transcribing
// an orphan we drop a `<id>.recovery-attempted` QUARANTINE MARKER that survives a
// process kill; a recording that already hard-crashed once is skipped thereafter.
// Catchable failures delete the marker, preserving the retry-next-launch behavior.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parakeetManager } from './parakeet'
import { getSession, saveSession } from './db'

const TAG = '[dictation-recovery]'
// UUID prefix of any audio filename (<uuid>-dictation.webm, <uuid>-chunk-N.webm, …).
const SESSION_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

function audioDir(): string {
  return path.join(app.getPath('userData'), 'audio')
}

/** Durable "we already attempted recovery of this id" marker. Survives a process
 *  kill, so a recording that hard-crashed the native ASR once is never retried. */
function attemptMarker(dir: string, id: string): string {
  return path.join(dir, `${id}.recovery-attempted`)
}
async function recoveryAttempted(dir: string, id: string): Promise<boolean> {
  try { await fs.access(attemptMarker(dir, id)); return true } catch { return false }
}

/** Numeric index of a chunk file (handles both -chunk-N and -final-chunk-N). */
function chunkIndex(filename: string): number {
  const m = filename.match(/-chunk-(\d+)\.webm$/)
  return m ? parseInt(m[1], 10) : -1
}

/** Best-effort wait for the local Whisper model to finish loading at boot. */
async function waitForWhisper(maxWaitMs = 60_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    if (parakeetManager.isAvailable()) return true
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return parakeetManager.isAvailable()
}

/** Reassemble a dictation's audio: prefer a complete file, else cat the chunks
 *  in order (the webm header lives in chunk 0, so concatenation reconstructs it). */
async function readDictationAudio(dir: string, files: string[], id: string): Promise<Buffer | null> {
  for (const name of [`${id}-dictation-final.webm`, `${id}-dictation.webm`]) {
    if (files.includes(name)) {
      try { return await fs.readFile(path.join(dir, name)) } catch { /* fall through */ }
    }
  }
  const chunks = files
    .filter((f) => f.startsWith(`${id}-`) && f.includes('-chunk-'))
    .map((f) => ({ f, n: chunkIndex(f) }))
    .filter((c) => c.n >= 0)
    .sort((a, b) => a.n - b.n)
  if (!chunks.length) return null
  const bufs: Buffer[] = []
  for (const c of chunks) {
    try { bufs.push(await fs.readFile(path.join(dir, c.f))) } catch { /* skip a bad chunk */ }
  }
  return bufs.length ? Buffer.concat(bufs) : null
}

/** Run once at launch (after initDB). Recovers any unfinished dictation into
 *  History. Best-effort throughout. */
export async function recoverOrphanDictations(): Promise<void> {
  const dir = audioDir()
  let files: string[]
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.webm')) } catch { return }

  // Group dictation audio by base sessionId (skip instruction recordings).
  const ids = new Set<string>()
  for (const f of files) {
    if (f.includes('-instruction')) continue
    const m = f.match(SESSION_ID_RE)
    if (m) ids.add(m[1])
  }
  if (!ids.size) return

  // Orphans = audio exists but no completed DB session (no transcript) AND not
  // already quarantined by a prior attempt that hard-crashed the process.
  const orphans: string[] = []
  for (const id of ids) {
    let sess: ReturnType<typeof getSession>
    try { sess = getSession(id) } catch { sess = undefined }
    if (sess && sess.dictation_transcript) continue // already recovered
    if (await recoveryAttempted(dir, id)) {
      console.warn(`${TAG} skipping ${id} — a prior recovery attempt crashed; quarantined`)
      continue
    }
    orphans.push(id)
  }
  if (!orphans.length) return

  console.log(`${TAG} ${orphans.length} unfinished dictation(s) on disk — recovering`)
  if (!(await waitForWhisper())) {
    console.log(`${TAG} local model not ready — will retry next launch`)
    return
  }

  for (const id of orphans) {
    const marker = attemptMarker(dir, id)
    try {
      // Drop the quarantine marker BEFORE the native transcribe. If that aborts
      // the process (malformed audio), the marker survives and this id is skipped
      // next launch — breaking the crash loop. Caught failures below remove it.
      await fs.writeFile(marker, new Date().toISOString())
      const audio = await readDictationAudio(dir, files, id)
      if (!audio || audio.byteLength < 100) { await fs.rm(marker, { force: true }); continue } // nothing usable
      const transcript = (await parakeetManager.transcribe(audio)).trim()
      if (!transcript) { await fs.rm(marker, { force: true }); continue }
      let createdAt = Date.now()
      try { createdAt = (await fs.stat(path.join(dir, files.find((f) => f.startsWith(id)) ?? ''))).mtimeMs } catch { /* keep now */ }
      saveSession({
        sessionId: id,
        flowType: 'dictation',
        dictationTranscript: transcript,
        instructionTranscript: null,
        selectedText: null,
        selectedTextRole: null,
        output: null,
        audioFilePath: null,
        status: 'done', // surfaces in History like a normal completed dictation
        errorMessage: null,
        createdAt,
      })
      await fs.rm(marker, { force: true }) // recovered cleanly — clear the marker
      console.log(`${TAG} recovered dictation ${id} (${transcript.length} chars)`)
    } catch (e) {
      // A CATCHABLE failure (not a process abort): clear the marker so this one
      // still retries next launch — preserving the original fail-open behavior.
      // Only a hard native crash leaves the marker behind (we never reach here).
      await fs.rm(marker, { force: true }).catch(() => {})
      console.warn(`${TAG} recovery failed for ${id}: ${(e as Error).message}`)
    }
  }
}
