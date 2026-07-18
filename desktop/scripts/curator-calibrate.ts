// Skill Curator — DEV-ONLY calibration harness (never ships, never imported by
// app code). It runs the curator's detector over the user's historical Unmute
// sessions so the triage thresholds (DEFAULT_TRIAGE) and the synthesize prompt
// can be tuned BEFORE any of this reaches the live review inbox.
//
//   npx tsx scripts/curator-calibrate.ts            # PHASE 1 only — free, no LLM
//   npx tsx scripts/curator-calibrate.ts --distill 3 [--out FILE]   # + PHASE 2
//
// PHASE 1 (default): survey every historical `unmute-remote-local` transcript
//   with computeTriageMetrics + passesTriage and print a size-sorted table plus
//   totals. ZERO LLM calls, ZERO writes outside stdout. This is safe to run any
//   number of times.
//
// PHASE 2 (opt-in, --distill N): for the top N triage-PASSING transcripts, run
//   the REAL reduce→distill→synthesize pipeline (makeRunSweep) with the same
//   autonomous librarian executor the sweep uses. This SPENDS subscription quota
//   (hence opt-in + capped at N). Everything the pipeline persists goes to a
//   throwaway store under os.tmpdir() so the real ~/.unmute/remote/curator store
//   is never touched; the resulting proposals are dumped to --out + stdout as
//   the artifact the user reads to tune the thresholds and the prompt.

import { promises as fs, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'

import {
  computeTriageMetrics,
  passesTriage,
  DEFAULT_TRIAGE,
  type TriageMetrics,
} from '../electron/remote/curator-triage'
import {
  curatorPaths,
  readTranscriptDelta,
  listPendingProposals,
  type CuratorPaths,
} from '../electron/remote/curator-store'
import { makeRunSweep, type MaterialSession } from '../electron/remote/curator'
import { ClaudeCodeExecutor } from '../electron/remote/pty-session'
import { getModels } from '../electron/remote/runtime-config'
import { resolveTmuxBin, TMUX_CONF } from '../electron/remote/tmux'

// ── Args ─────────────────────────────────────────────────────────────────────

interface Args { distill: number | null; out: string }

function parseArgs(argv: string[]): Args {
  let distill: number | null = null
  let out = 'curator-calibration-proposals.json'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--distill') {
      const n = Number(argv[++i])
      distill = Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    } else if (a === '--out') {
      out = argv[++i] ?? out
    }
  }
  return { distill, out }
}

// ── Transcript enumeration ───────────────────────────────────────────────────

// The curator's own auxiliary sessions get their own project dirs suffixed like
// the doer's; NONE of them are user work sessions and must be excluded.
const EXCLUDED_SUFFIXES = ['-librarian', '-router', '-curator']

interface TranscriptRow {
  taskId: string        // short display id (trailing uuid, truncated)
  dir: string
  transcriptPath: string
  bytes: number
  metrics: TriageMetrics
  pass: boolean
  lines: string[]       // kept so PHASE 2 need not re-read
  error?: string
}

/** The largest `.jsonl` in a project dir (the primary session transcript;
 *  sidecar/summary jsonl files are always smaller). null if none. */
async function largestJsonl(dir: string): Promise<{ path: string; bytes: number } | null> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  let best: { path: string; bytes: number } | null = null
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    try {
      const st = await fs.stat(path)
      if (!st.isFile()) continue
      if (!best || st.size > best.bytes) best = { path, bytes: st.size }
    } catch { /* unreadable entry — skip */ }
  }
  return best
}

function shortTaskId(dirName: string): string {
  // Dir looks like `-Users-…--unmute-remote-local-<uuid>`. Show the leading
  // chunk of the uuid so rows are distinguishable without being 60 chars wide.
  const m = dirName.match(/unmute-remote-local-(.+)$/)
  const id = m ? m[1] : dirName
  return id.length > 12 ? id.slice(0, 12) : id
}

async function enumerateTranscripts(projectsDir: string): Promise<TranscriptRow[]> {
  let dirs: string[]
  try {
    dirs = await fs.readdir(projectsDir)
  } catch (e) {
    console.error(`Could not read projects dir ${projectsDir}: ${(e as Error).message}`)
    return []
  }
  const candidates = dirs.filter(
    (d) => d.includes('unmute-remote-local') && !EXCLUDED_SUFFIXES.some((s) => d.endsWith(s)),
  )

  const rows: TranscriptRow[] = []
  for (const d of candidates) {
    const dir = join(projectsDir, d)
    // Per-transcript try/catch: one malformed/unreadable session must never
    // abort the whole survey.
    try {
      const largest = await largestJsonl(dir)
      if (!largest) continue // no transcript in this dir
      const { lines } = await readTranscriptDelta(largest.path, 0)
      const metrics = computeTriageMetrics(lines)
      rows.push({
        taskId: shortTaskId(d),
        dir,
        transcriptPath: largest.path,
        bytes: largest.bytes,
        metrics,
        pass: passesTriage(metrics),
        lines,
      })
    } catch (e) {
      console.error(`  ! skipped ${d}: ${(e as Error).message}`)
    }
  }
  // Sort by size (bytes) descending — the biggest sessions first.
  rows.sort((a, b) => b.bytes - a.bytes)
  return rows
}

// ── PHASE 1 — the triage survey ──────────────────────────────────────────────

const MB = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(2)
const MIN = (ms: number): string => (ms / 60_000).toFixed(1)
const pad = (s: string | number, w: number): string => String(s).padStart(w)
const padEnd = (s: string | number, w: number): string => String(s).padEnd(w)

function printPhase1(rows: TranscriptRow[]): { total: number; passing: number } {
  console.log('')
  console.log('══════════════════════════════════════════════════════════════════════════════')
  console.log('  PHASE 1 — triage survey over historical Unmute sessions (no LLM, read-only)')
  console.log('══════════════════════════════════════════════════════════════════════════════')
  console.log(
    `  thresholds: wallClock≥${MIN(DEFAULT_TRIAGE.minWallClockMs)}m & tools≥${DEFAULT_TRIAGE.minToolCalls}` +
      `  OR errors≥${DEFAULT_TRIAGE.minErrors}  OR userTurns≥${DEFAULT_TRIAGE.minUserTurns}`,
  )
  console.log('')

  const header =
    '  ' +
    padEnd('taskId', 13) +
    pad('MB', 7) +
    pad('wall(m)', 9) +
    pad('tools', 7) +
    pad('errs', 6) +
    pad('recov', 7) +
    pad('uTurns', 8) +
    '  ' +
    'triage'
  console.log(header)
  console.log('  ' + '─'.repeat(header.length - 2))

  let passing = 0
  for (const r of rows) {
    if (r.pass) passing++
    console.log(
      '  ' +
        padEnd(r.taskId, 13) +
        pad(MB(r.bytes), 7) +
        pad(MIN(r.metrics.wallClockMs), 9) +
        pad(r.metrics.toolCalls, 7) +
        pad(r.metrics.errors, 6) +
        pad(r.metrics.recoveries, 7) +
        pad(r.metrics.userTurns, 8) +
        '  ' +
        (r.pass ? 'PASS' : 'fail'),
    )
  }

  console.log('  ' + '─'.repeat(header.length - 2))
  console.log(`  ${rows.length} transcripts, ${passing} pass triage`)
  console.log('')
  return { total: rows.length, passing }
}

// ── PHASE 2 — reduce → distill → synthesize (opt-in, spends quota) ────────────

/** The autonomous, no-browser executor the sweep uses — replicated from
 *  init.ts's librarianExecutorFactory (skip-permissions so a prompt can't hang
 *  it, no --chrome, opus). Same construction so calibration mirrors production. */
function librarianExecutorFactory(): ClaudeCodeExecutor {
  const model = getModels().librarian
  const tmuxBin = resolveTmuxBin((p) => existsSync(p))
  let tmux: { bin: string; confPath: string; cols: number; rows: number } | undefined
  if (tmuxBin) {
    const confPath = join(homedir(), '.unmute', 'remote', 'tmux.conf')
    try {
      if (!existsSync(confPath)) {
        mkdirSync(dirname(confPath), { recursive: true })
        writeFileSync(confPath, TMUX_CONF)
      }
      tmux = { bin: tmuxBin, confPath, cols: 120, rows: 40 }
    } catch { /* no tmux conf — fall back to a direct (non-popout) session */ }
  }
  return new ClaudeCodeExecutor({ extraArgs: ['--dangerously-skip-permissions'], model, chrome: false, tmux })
}

async function runPhase2(passing: TranscriptRow[], n: number, outFile: string): Promise<void> {
  const chosen = passing.slice(0, n)
  console.log('══════════════════════════════════════════════════════════════════════════════')
  console.log(`  PHASE 2 — distill+synthesize over top ${chosen.length} passing transcript(s)`)
  console.log('  (spends subscription quota; proposals go to a throwaway tmp store)')
  console.log('══════════════════════════════════════════════════════════════════════════════')

  // Throwaway store under os.tmpdir() — NOTHING touches the real curator store.
  const storeRoot = join(tmpdir(), `curator-calib-${Date.now()}`)
  const paths: CuratorPaths = curatorPaths(storeRoot)
  console.log(`  tmp store: ${storeRoot}`)
  console.log('')

  const material: MaterialSession[] = chosen.map((r) => ({
    taskId: r.taskId,
    intent: '(historical Unmute session — original intent unavailable)',
    transcriptPath: r.transcriptPath,
    fromLine: 0,
    lines: r.lines,
    lookback: [],
    newOffset: r.lines.length,
  }))

  const runSweep = makeRunSweep({
    executorFactory: librarianExecutorFactory,
    paths,
    // Empty curated library — calibration runs against a fresh (tmp) curator.
    curatedIndex: async () => [],
  })

  for (const r of chosen) {
    console.log(`  → will distill ${r.taskId}  (${MB(r.bytes)} MB, ${r.metrics.toolCalls} tools, ${r.metrics.errors} errs)`)
  }
  console.log('')
  console.log('  Running pipeline (this can take several minutes per session)…')

  await runSweep(material)

  const proposals = await listPendingProposals(paths)

  writeFileSync(outFile, JSON.stringify(proposals, null, 2))
  console.log('')
  console.log('══════════════════════════════════════════════════════════════════════════════')
  console.log(`  PROPOSALS — ${proposals.length} (written to ${outFile})`)
  console.log('══════════════════════════════════════════════════════════════════════════════')
  if (proposals.length === 0) {
    console.log('  (none — zero proposals is the expected common case per the filter)')
  }
  for (const p of proposals) {
    console.log('')
    console.log(`  • ${p.draft.name}  [${p.kind}]  occurrences: ${p.evidence?.occurrences ?? '?'}`)
    console.log(`    ${p.draft.description}`)
    console.log(`    rationale: ${p.rationale}`)
  }
  console.log('')
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const projectsDir = join(homedir(), '.claude', 'projects')

  const rows = await enumerateTranscripts(projectsDir)
  const { passing } = printPhase1(rows)

  if (args.distill == null) {
    console.log('  (PHASE 1 only. Pass --distill N to run the LLM pipeline over the top N — spends quota.)')
    console.log('')
    return
  }

  const passingRows = rows.filter((r) => r.pass)
  if (passingRows.length === 0) {
    console.log('  No triage-passing transcripts — nothing to distill.')
    return
  }
  await runPhase2(passingRows, Math.min(args.distill, passingRows.length), args.out)
}

main().catch((e) => {
  console.error('calibration harness failed:', e)
  process.exitCode = 1
})
