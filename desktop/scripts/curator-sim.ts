// curator-sim — run the REAL Skill Curator sweep pipeline on selected Claude
// Code transcripts, standalone (bare Node via tsx), persisting NOTHING to the
// real store.
//
// Usage:
//   node --import tsx scripts/curator-sim.ts <transcript1.jsonl> [<transcript2.jsonl> ...]
//
// What it does: for each transcript arg it builds a MaterialSession whose delta
// is the WHOLE file (no triage/cursor gating — we selected these on purpose),
// then drives the exact makeRunSweep pipeline (distill → audit → match →
// synthesize → propose) via a NON-PTY SimExecutor that runs `claude` headless.
// Same prompts, same model, same parsing/ledger/judge as Unmute — just no pty.
//
// Isolation: the parent process's HOME is redirected to a scratch fake-home so
// EVERYTHING (including curator-devlog's hardcoded default curatorPaths(), where
// the reasoning dumps go) lands under the scratch dir. The child `claude` gets
// the REAL home back (SimExecutor) so login/auth still works. The real
// ~/.unmute/remote/curator store is never read or written.

import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

// ── Capture the REAL home BEFORE any redirect (claude auth needs it) and force
//    the dev-log gate on so reasoning is written. Must happen before importing
//    curator modules that read the gate at call-time (harmless if hoisted, but
//    kept explicit). ──────────────────────────────────────────────────────────
const REAL_HOME = process.env.HOME || homedir()
process.env.UNMUTE_SIM_REAL_HOME = REAL_HOME
process.env.UNMUTE_CURATOR_DEVLOG = '1'

// Scratch fake-home: a throwaway dir that becomes the process's HOME, so the
// dev-log's default curatorPaths() (join(homedir(),'.unmute','remote','curator'))
// resolves INTO scratch — same root we inject into the pipeline below.
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const FAKE_HOME = join(tmpdir(), 'curator-sim', STAMP)
const SCRATCH_ROOT = join(FAKE_HOME, '.unmute', 'remote', 'curator')

import { curatorPaths } from '../electron/remote/curator-store.ts'
import { makeRunSweep, type MaterialSession } from '../electron/remote/curator.ts'
import { buildCuratedIndexFrom } from '../electron/remote/curator-index.ts'
import { SimExecutor } from './sim-executor.ts'

async function nonEmptyLines(file: string): Promise<string[]> {
  const raw = await fs.readFile(file, 'utf8')
  return raw.split('\n').filter((l) => l.trim() !== '')
}

async function readJsonl(file: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') } catch { return out }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* skip torn/partial line */ }
  }
  return out
}

/** The session intent = the transcript's FIRST genuine user turn (its content,
 *  whether a plain string — the "[Unmute Remote task] Task: …" opener — or the
 *  first human text block). tool_result-only user blocks (tool outputs, not the
 *  person) are skipped. Falls back to '(sim)' when no user text is found. */
async function firstUserIntent(file: string): Promise<string> {
  for (const ev of await readJsonl(file)) {
    const msg = (ev.message ?? ev) as Record<string, unknown>
    if (msg?.role !== 'user') continue
    const content = msg.content
    if (typeof content === 'string') {
      const t = content.replace(/\s+/g, ' ').trim()
      if (t) return t
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          const t = block.text.replace(/\s+/g, ' ').trim()
          if (t) return t
        }
      }
    }
  }
  return '(sim)'
}

function hr(title: string): void {
  console.log(`\n${'═'.repeat(78)}\n${title}\n${'═'.repeat(78)}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  if (args.length === 0) {
    console.error('usage: node --import tsx scripts/curator-sim.ts <transcript.jsonl> [more.jsonl ...]')
    process.exit(2)
  }

  // Build a MaterialSession per transcript — the WHOLE file is the delta.
  const material: MaterialSession[] = []
  for (const arg of args) {
    const transcriptPath = resolve(arg)
    const lines = await nonEmptyLines(transcriptPath)
    const taskId = basename(transcriptPath).replace(/\.jsonl$/, '')
    // Derive the REAL intent from the transcript's first user turn (the
    // "[Unmute Remote task] Task: …" opener, or the first user message content) so
    // the distiller receives the same session intent Unmute would pass in prod —
    // not a placeholder. transcriptPath already flows to distill as the raw path.
    const intent = await firstUserIntent(transcriptPath)
    material.push({
      taskId,
      intent,
      transcriptPath,
      fromLine: 0,
      lines,
      lookback: [],
      newOffset: lines.length,
      convKey: taskId,
    })
    console.log(`• material: ${taskId} — ${lines.length} lines — intent: "${intent}" — ${transcriptPath}`)
  }

  // Scratch curator dir — nothing touches the real ~/.unmute/remote/curator.
  const paths = curatorPaths(SCRATCH_ROOT)
  await fs.mkdir(paths.root, { recursive: true })

  // curatedIndex: the judge's "already exists?" context. We read the user's REAL
  // global skills (~/.claude/skills, read-only) for realistic dedup — resolved
  // against REAL_HOME captured before the HOME redirect, no owned names (scratch
  // ownership is empty), no project roots.
  const globalSkillsDir = join(REAL_HOME, '.claude', 'skills')
  const curatedIndex = () => buildCuratedIndexFrom([], globalSkillsDir, [])

  // Redirect HOME now (after capturing REAL_HOME / building the curatedIndex
  // closure). From here on, default curatorPaths()/homedir() → scratch.
  process.env.HOME = FAKE_HOME

  const run = makeRunSweep({
    executorFactory: () => new SimExecutor(),
    paths,
    curatedIndex,
    sessionTimeoutMs: 10 * 60_000, // headless opus one-shots are slower than a REPL keystroke; give them room
    pollMs: 1_000,                 // the out-file is written once at completion — no need to poll fast
    now: () => Date.now(),
  })

  hr(`RUNNING SWEEP over ${material.length} session(s) — this spawns real headless claude, ~minutes`)
  const t0 = Date.now()
  try {
    await run(material)
  } catch (err) {
    console.error(`\n‼ sweep threw: ${(err as Error).name}: ${(err as Error).message}`)
    console.error(`  (scratch preserved for inspection at ${FAKE_HOME})`)
    await printSummary(paths).catch(() => {})
    process.exit(1)
  }
  console.log(`\n✓ sweep completed in ${((Date.now() - t0) / 1000).toFixed(0)}s`)

  await printSummary(paths)
}

async function printSummary(paths: ReturnType<typeof curatorPaths>): Promise<void> {
  // ── Timeline (from the dev-log events.jsonl) — distill findings, match, synth ──
  const events = await readJsonl(join(paths.logsDir, 'events.jsonl'))
  hr('DISTILL FINDINGS (per session)')
  const distills = events.filter((e) => e.kind === 'distilled')
  if (distills.length === 0) console.log('(none logged)')
  for (const e of distills) {
    console.log(`\n  session ${String(e.taskId)}:`)
    const procs = Array.isArray(e.procedures) ? e.procedures : []
    if (procs.length === 0) console.log('    (no findings — the normal case for a discussion-only session)')
    for (const p of procs as Array<Record<string, unknown>>) {
      console.log(`    - ${String(p.title ?? p.intent ?? '?')}${p.struggle ? '  [correction present]' : ''}${p.usedCuratedSkill ? `  [used skill: ${String(p.usedCuratedSkill)}]` : ''}`)
    }
    if (typeof e.reasoning === 'string' && e.reasoning.trim()) {
      console.log(`    reasoning: ${e.reasoning.slice(0, 400)}${e.reasoning.length > 400 ? '…' : ''}`)
    }
  }

  // ── Fused ledger (the authoritative scratch candidates.json) ──
  hr('FUSED LEDGER (candidates.json)')
  const cand = await readJsonOr(join(paths.candidates), { candidates: {} as Record<string, any> })
  const entries = Object.values(cand.candidates ?? {}) as Array<Record<string, any>>
  if (entries.length === 0) console.log('(ledger empty)')
  for (const c of entries) {
    const sessions = new Set((c.occurrences ?? []).map((o: any) => o.taskId)).size
    console.log(`\n  [${c.key}] status:${c.status ?? 'watched'} — total:${c.total} across ${sessions} distinct session(s)`)
    console.log(`    intent: ${c.intent ?? c.title}`)
    if (Array.isArray(c.contextSupplied) && c.contextSupplied.length) console.log(`    contextSupplied: ${c.contextSupplied.join('; ')}`)
    if (c.correction) console.log(`    correction: ${c.correction}`)
  }

  // ── Proposals ──
  hr('PROPOSALS')
  let ids: string[] = []
  try { ids = await fs.readdir(paths.proposalsDir) } catch { /* none */ }
  if (ids.length === 0) console.log('(no proposals — {"proposals":[]} is a fine, common result)')
  for (const id of ids) {
    const prop = await readJsonOr(join(paths.proposalsDir, id, 'proposal.json'), null as any)
    if (!prop) continue
    console.log(`\n  ${prop.id}  kind:${prop.kind}`)
    console.log(`    name:        ${prop.draft?.name}`)
    console.log(`    description: ${prop.draft?.description}`)
    if (prop.targetSkill) console.log(`    targetSkill: ${prop.targetSkill}`)
    console.log(`    rationale:   ${prop.rationale}`)
    if (Array.isArray(prop.sourceKeys)) console.log(`    sourceKeys:  ${prop.sourceKeys.join(', ')}`)
    if (Array.isArray(prop.changeSummary) && prop.changeSummary.length) console.log(`    changeSummary:\n${prop.changeSummary.map((s: string) => `      - ${s}`).join('\n')}`)
  }

  // ── Where everything lives ──
  hr('SCRATCH DIR (inspect everything here)')
  console.log(`  scratch home:   ${FAKE_HOME}`)
  console.log(`  curator root:   ${paths.root}`)
  console.log(`  reasoning logs: ${paths.logsDir}   (events.jsonl timeline + <sweepId>-<stage>*.json full dumps)`)
  console.log(`  candidates:     ${paths.candidates}`)
  console.log(`  proposals:      ${paths.proposalsDir}`)
  console.log(`  reduced traces: ${paths.tracesDir}`)
  // List the per-stage reasoning dump files so they're easy to open.
  try {
    const dumps = (await fs.readdir(paths.logsDir)).filter((f) => f.endsWith('.json'))
    if (dumps.length) console.log(`  dump files:     ${dumps.join(', ')}`)
  } catch { /* logs dir may not exist if nothing ran */ }
}

async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T } catch { return fallback }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
