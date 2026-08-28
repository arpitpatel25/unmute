// THE CODEX ROUTER, HEADLESS AND SCHEMA-BOUND.
//
// Codex needs no MCP tool for this: `codex exec --output-schema <file>` sets
// the model's response_format directly, which is structured output at the
// strongest point in the chain. The final message is written to a file we name,
// so there is no stream to parse and no terminal anywhere in the path.
//
// STRICT MODE IS THE CONSTRAINT, and it was found by running it rather than
// reading about it (28 Aug):
//
//   "'required' is required to be supplied and to be an array including every
//    key in properties. Missing 'name'."
//
// So the schema lists every key in `required` and types the optional ones as
// ["string","null"]. See router-decision-schema.ts — the same module feeds the
// Claude lane's MCP tool, so the two transports cannot drift apart.
//
// Measured: 10.2s cold, schema-valid, and it correctly filed "Reddit marketing
// for Unmute" under the existing "unmute marketing" stream rather than minting
// a sibling — the failure this whole change set started from.
//
// ONE EXEC PER ROUTE, deliberately. `codex exec resume` exists and would shave
// the cold start, but resuming is what re-introduces the accumulating context
// that made the PTY router slow down as a session aged. A cold 10.2s that
// stays 10.2s beats a warm 6s that becomes 24s.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createLogger } from './log'
import { decisionSchema, compactDecision, type DecisionSchemaOpts } from './router-decision-schema'

const log = createLogger('codex-exec-router')

export interface CodexExecRouterOpts {
  dir?: string
  model?: string
  /** Test seam. */
  spawnFn?: typeof spawn
}

export class CodexExecRouterEngine {
  private readonly dir: string
  private readonly model?: string
  private readonly spawnFn: typeof spawn
  private schemaPath: string | null = null

  constructor(opts: CodexExecRouterOpts = {}, private readonly schemaOpts: DecisionSchemaOpts = { ops: true }) {
    this.dir = opts.dir ?? join(homedir(), '.unmute', 'remote', 'router-codex-exec')
    this.model = opts.model
    this.spawnFn = opts.spawnFn ?? spawn
  }

  /** Nothing to keep alive — warming here just writes the schema once so the
   *  first route does not pay for it. */
  async warm(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      const p = join(this.dir, 'decision.schema.json')
      await fs.writeFile(p, JSON.stringify(decisionSchema(this.schemaOpts), null, 2))
      this.schemaPath = p
      log.event('codex-exec-warm', {})
    } catch (e) {
      log.warn('codex exec router failed to warm', { error: (e as Error).message })
    }
  }

  async decide(prompt: string, timeoutMs = 60_000): Promise<string | null> {
    if (!this.schemaPath) await this.warm()
    if (!this.schemaPath) return null

    // A per-route output file: two routes must never read each other's answer.
    const outPath = join(this.dir, `decision-${randomUUID()}.json`)
    const t0 = Date.now()
    try {
      await new Promise<void>((resolve, reject) => {
        const args = [
          'exec',
          '--skip-git-repo-check',
          '--sandbox', 'read-only',   // the router reads nothing and writes nothing
          '--output-schema', this.schemaPath!,
          '-o', outPath,
          ...(this.model ? ['-m', this.model] : []),
          prompt,
        ]
        // STDIN MUST BE CLOSED, not merely unused. With an open pipe on stdin
        // codex prints "Reading additional input from stdin..." and waits for
        // EOF that never comes — the prompt is already in argv, so it hangs
        // until the timeout. Cost one live run to find (28 Aug); execFile
        // cannot express this, which is why this is spawn.
        const child = this.spawnFn('codex', args, { cwd: this.dir, stdio: ['ignore', 'ignore', 'pipe'] })
        const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, timeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
        child.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
        child.on('exit', (code: number | null) => {
          clearTimeout(timer)
          code === 0 ? resolve() : reject(new Error(`codex exec exited ${code}`))
        })
      })

      const raw = await fs.readFile(outPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      const compact = compactDecision(parsed)
      log.event('codex-exec-decision', { ms: Date.now() - t0, bytes: compact.length })
      return compact || null
    } catch (e) {
      log.warn('codex exec router: no decision', { ms: Date.now() - t0, error: (e as Error).message })
      return null
    } finally {
      // Awaited, not fired-and-forgotten: a per-route filename means an
      // un-awaited unlink leaves a slow drip of dead files in the router dir.
      // It is a local unlink on a file we just read — sub-millisecond.
      await fs.rm(outPath, { force: true }).catch(() => {})
    }
  }

  dispose(): void { /* nothing resident to tear down */ }
}
