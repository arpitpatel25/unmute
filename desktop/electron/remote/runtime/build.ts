import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * A short fingerprint of a runtime script.
 *
 * Its own module on purpose: runtime/main.ts starts a daemon when it is
 * imported, so the app must never import from it. The runtime computes this
 * over the script it is running; the app computes it over the script it would
 * spawn. A mismatch means the running process is an older build.
 */
export function runtimeBuild(script: string | undefined): string | undefined {
  if (!script) return undefined
  try { return createHash('sha256').update(readFileSync(script)).digest('hex').slice(0, 16) } catch { return undefined }
}
