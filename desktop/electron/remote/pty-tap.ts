// THE INSTRUMENT, NOT THE FIX.
//
// Three separate theories about why a Claude CLI session dies — a termClose
// tearing down the tty, an injected quit key, tmux destroying an unattached
// session — each survived until the next query and then died. Every one of them
// failed for the same reason: the stream that would settle it is the one the
// general logger cannot carry. `serializeFields` truncates any string past 2000
// characters, deliberately and correctly, so that one PTY dump cannot blow up a
// log line. The consequence is that the seconds before a session exits are
// exactly the seconds we cannot read.
//
// So this is a separate channel with one job: every byte in and out of a PTY,
// untruncated, in order, with a direction and a timestamp, in its own file.
// Nothing here interprets anything. It exists so the next reproduction produces
// evidence rather than a fourth theory.
//
// OFF unless explicitly enabled — it records everything the agent reads and
// writes, which includes whatever the user typed. Gate it, keep it to a
// reproduction, delete the file afterwards.

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export type TapDirection = 'in' | 'out'

export interface TapRecord {
  /** 'in' = written to the agent (keystrokes, replies). 'out' = from the agent. */
  dir: TapDirection
  atMs: number
  bytes: Buffer
}

/** One JSONL line. Base64 because the payload is arbitrary binary — control
 *  bytes ARE the subject here, and a tap that mangles 0x04 into U+FFFD cannot
 *  answer whether something sent Ctrl-D. */
export function ptyTapLine(dir: TapDirection, bytes: Buffer, atMs: number): string {
  return JSON.stringify({ dir, atMs, b64: bytes.toString('base64') })
}

/** Inverse of ptyTapLine, for tests and for whatever reads the file back. */
export function decodeTapLine(line: string): TapRecord {
  const { dir, atMs, b64 } = JSON.parse(line) as { dir: TapDirection; atMs: number; b64: string }
  return { dir, atMs, bytes: Buffer.from(b64, 'base64') }
}

/** Only '1' enables, matching the curator devlog's fail-safe-off convention. */
export function ptyTapEnabled(): boolean {
  return process.env.UNMUTE_PTY_TAP === '1'
}

/** Append one record for a task. No-op when the gate is off — no file, no
 *  directory, no cost. Best-effort: a tap that throws into the agent path would
 *  be worse than no tap at all. */
export function tapPty(logsDir: string, taskId: string, dir: TapDirection, bytes: Buffer, atMs: number): void {
  if (!ptyTapEnabled() || bytes.length === 0) return
  const line = ptyTapLine(dir, bytes, atMs) + '\n'
  void (async () => {
    try {
      await mkdir(logsDir, { recursive: true })
      await appendFile(join(logsDir, `pty-${taskId}.raw.jsonl`), line)
    } catch { /* never throw into the PTY path */ }
  })()
}
