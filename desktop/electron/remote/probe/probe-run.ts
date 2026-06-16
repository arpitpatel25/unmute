// Unmute Remote — Task 0 live probe (PRD §3.6, §15.2 step 1).
//
// Drives the REAL `claude` binary through the REAL executor + status-file loop
// in a throwaway dir, and reports what actually happens. This is the empirical
// validation milestone: does an owned-PTY interactive claude session, dispatched
// our way, actually run a task and complete via the status file?
//
// Run: npx tsx electron/remote/probe/probe-run.ts
//
// Notes:
//   * Uses --dangerously-skip-permissions (PRD §10.1 auto-approve ON) so the
//     probe doesn't stall on tool-permission prompts — we're validating the
//     frictionless path.
//   * Never sets ANTHROPIC_API_KEY (executor strips it) → subscription billing.
//   * The /status billing-pool confirmation is the user's to run; this probe
//     validates the mechanism (spawn → ready → dispatch → status loop → done).

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as nodePty from 'node-pty'
import { ClaudeCodeExecutor } from '../pty-session.ts'
import { scaffoldStatusFile, readStatus } from '../status-file.ts'
import { installContract } from '../contract/installer.ts'
import { buildDispatch } from '../dispatch-prompt.ts'
import { configureRemoteLogging } from '../log.ts'

async function main() {
  const runId = `probe-${Date.now()}`
  const cwd = join(tmpdir(), 'unmute-remote-probe', runId)
  await fs.mkdir(cwd, { recursive: true })
  const statusPath = join(cwd, 'status.json')
  const logFile = configureRemoteLogging({ dir: join(cwd, 'logs'), runId })

  console.log('\n================ UNMUTE REMOTE LIVE PROBE ================')
  console.log('cwd:        ', cwd)
  console.log('status file:', statusPath)
  console.log('log file:   ', logFile)

  await scaffoldStatusFile(statusPath)
  await installContract(cwd)

  const rawChunks: string[] = []
  const arrivalGaps: number[] = []
  let lastChunkAt = Date.now()

  const ex = new ClaudeCodeExecutor({
    extraArgs: ['--dangerously-skip-permissions'],
    ptyLoader: () => nodePty as unknown as { spawn: typeof nodePty.spawn },
  })
  ex.onData((c) => {
    const now = Date.now()
    arrivalGaps.push(now - lastChunkAt)
    lastChunkAt = now
    rawChunks.push(c)
  })

  const tSpawn = Date.now()
  await ex.spawn({ cwd, env: process.env, taskId: runId })
  await ex.isReady()
  const readyMs = Date.now() - tSpawn
  console.log(`\n[probe] first quiet window after ${readyMs}ms`)

  // Accept the folder-trust prompt if claude shows one on first run in a new
  // dir. The default highlighted choice is "1. Yes, I trust this folder" and
  // the footer says "Enter to confirm" — so a bare carriage return accepts it.
  // Harmless if there's no prompt (an empty REPL submit is ignored).
  console.log('[probe] sending Enter to accept any folder-trust prompt…')
  ex.writeStdin('') // writeStdin appends \r ⇒ just an Enter
  await new Promise((r) => setTimeout(r, 2500)) // let the REPL boot after trust

  // A trivial, harmless, fully-local task.
  const intent = 'Create a file named hello.txt in the current directory containing the text "hi from unmute remote". Then mark the task done in your status file.'
  ex.writeStdin(buildDispatch({ intent, statusPath }))
  console.log('[probe] dispatched task; polling status file (max 120s)…\n')

  const deadline = Date.now() + 120_000
  let finalState = 'processing'
  let lastLoggedState = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const s = await readStatus(statusPath)
    if (s && s.state !== lastLoggedState) {
      console.log(`[probe] status → ${s.state}${s.step ? ' ('+s.step+')' : ''}`)
      lastLoggedState = s.state
    }
    if (s && (s.state === 'done' || s.state === 'failed')) {
      finalState = s.state
      console.log('[probe] result:', JSON.stringify(s.result ?? s.error ?? {}, null, 2))
      break
    }
  }

  ex.kill()

  // ── Did the side effect actually happen? ──
  let helloExists = false
  let helloContent = ''
  try {
    helloContent = await fs.readFile(join(cwd, 'hello.txt'), 'utf8')
    helloExists = true
  } catch { /* not created */ }

  // ── TUI silence analysis (PRD §6.3 #1 — bonus only) ──
  const totalOutputBytes = rawChunks.reduce((n, c) => n + c.length, 0)
  const maxGap = arrivalGaps.length ? Math.max(...arrivalGaps) : 0

  console.log('\n================ PROBE REPORT ================')
  console.log('REPL ready (ms):          ', readyMs)
  console.log('Final status state:       ', finalState)
  console.log('hello.txt created:        ', helloExists, helloExists ? `(content: ${JSON.stringify(helloContent.trim())})` : '')
  console.log('Total PTY output bytes:   ', totalOutputBytes)
  console.log('Max gap between chunks(ms):', maxGap, '(if large while idle ⇒ TUI goes quiet ⇒ silence-hint viable as a bonus)')
  console.log('Log file (full detail):   ', logFile)
  console.log('Working dir (inspect):    ', cwd)
  console.log('=============================================\n')

  // Persist a compact findings stub for the plan.
  const findings = {
    runId, readyMs, finalState, helloExists, helloContent: helloContent.trim(),
    totalOutputBytes, maxGapMs: maxGap,
    verdict: finalState === 'done' && helloExists
      ? 'PASS — owned-PTY interactive claude completed a task via the status-file loop'
      : 'INCOMPLETE — see log + working dir',
  }
  await fs.writeFile(join(cwd, 'probe-findings.json'), JSON.stringify(findings, null, 2))
  console.log('[probe] findings written:', join(cwd, 'probe-findings.json'))
  process.exit(0)
}

main().catch((e) => { console.error('[probe] FAILED:', e); process.exit(1) })
