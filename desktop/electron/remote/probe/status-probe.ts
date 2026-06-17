// Unmute Remote — Task-0 billing confirmation (PRD §3.6).
// Spawns the real interactive `claude` (no API key) and runs /status, capturing
// what it reports about the auth/billing pool. Read-only — runs no task.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as nodePty from 'node-pty'
import { ClaudeCodeExecutor } from '../pty-session.ts'

function strip(s: string): string {
  // drop common ANSI/control so the captured text is readable
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/\][^]*?/g, '').replace(/\r/g, '')
}

async function main() {
  const cwd = join(tmpdir(), 'unmute-status-probe', String(Date.now()))
  await fs.mkdir(cwd, { recursive: true })
  let raw = ''
  const ex = new ClaudeCodeExecutor({
    extraArgs: ['--dangerously-skip-permissions'],
    ptyLoader: () => nodePty as unknown as { spawn: typeof nodePty.spawn },
  })
  ex.onData((c) => { raw += c })

  console.log('[status-probe] spawning claude (no API key in env)…')
  await ex.spawn({ cwd, env: process.env, taskId: 'status' })
  await ex.isReady()
  ex.writeStdin('') // accept folder-trust
  await new Promise((r) => setTimeout(r, 2500))
  console.log('[status-probe] sending /status …')
  ex.writeStdin('/status')
  await new Promise((r) => setTimeout(r, 7000)) // let /status render
  ex.kill()

  const text = strip(raw)
  console.log('\n================ /status OUTPUT (cleaned) ================')
  // Print lines that look relevant to auth/billing, plus a tail for context.
  const relevant = text.split('\n').filter((l) =>
    /(account|login|subscription|plan|pro|max|api|credit|usage|billing|organization|email|auth)/i.test(l),
  )
  console.log(relevant.length ? relevant.join('\n') : '(no obviously billing-related lines matched — full tail below)')
  console.log('\n---- last 60 lines of raw /status render ----')
  console.log(text.split('\n').slice(-60).join('\n'))
  console.log('=========================================================')
  process.exit(0)
}
main().catch((e) => { console.error('[status-probe] FAILED:', e); process.exit(1) })
