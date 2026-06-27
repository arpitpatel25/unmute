import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Librarian, buildLibrarianPrompt } from './librarian.ts'
import { graduatedDir } from './recipe-store.ts'
import type { AgentExecutor, SpawnOpts } from './executor.ts'

async function tmpBase(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'remote-lib-'))
}

// Fake librarian session: when dispatched, plays "Claude" by writing a skill
// file into the shared dir and marking its status file done.
function makeLibrarianExecutor(opts: { onWrite: (cwd: string) => Promise<void> }) {
  let cwd = ''
  let alive = true
  const ex: AgentExecutor = {
    get alive() { return alive },
    async spawn(o: SpawnOpts) { cwd = o.cwd },
    async isReady() {},
    // The real flow sends an empty trust-accept write first, then the prompt.
    // Only react to the actual prompt (non-empty), like real Claude would.
    writeStdin(t: string) { if (t.trim()) void opts.onWrite(cwd) },
    write() {},
    resize() {},
    onData() {},
    kill() { alive = false },
  }
  return ex
}

async function writeDone(statusPath: string, summary: string) {
  const tmp = statusPath + '.tmp'
  await fs.writeFile(tmp, JSON.stringify({ state: 'done', result: { summary } }))
  await fs.rename(tmp, statusPath)
}

test('librarian applies a suggestion by writing into the shared skills dir', { timeout: 8000 }, async () => {
  const base = await tmpBase()
  const taskCwd = path.join(base, 'tasks', 't1')
  await fs.mkdir(taskCwd, { recursive: true })
  await fs.writeFile(path.join(taskCwd, 'recipe.json'), JSON.stringify({ steps: ['unzip'] }))

  const lib = new Librarian({
    baseDir: base,
    trustAcceptMs: 0,
    pollMs: 25,
    executorFactory: () => makeLibrarianExecutor({
      onWrite: async (libCwd) => {
        // write a skill into the graduated dir, then mark librarian status done
        await fs.mkdir(path.join(graduatedDir(base), 'general'), { recursive: true })
        await fs.writeFile(path.join(graduatedDir(base), 'general', 'extract-zip.md'), '---\nname: extract-zip\n---\nsteps')
        await writeDone(path.join(libCwd, 'status.json'), 'created extract-zip')
      },
    }),
  })

  await lib.submit({ taskId: 't1', intent: 'extract a zip', scratchPath: path.join(taskCwd, 'recipe.json'), cwd: taskCwd })
  // the shared skill now exists
  assert.ok((await fs.readFile(path.join(graduatedDir(base), 'general', 'extract-zip.md'), 'utf8')).includes('extract-zip'))
})

test('librarian is serialized — only one session runs at a time (PRD §9.3)', { timeout: 8000 }, async () => {
  const base = await tmpBase()
  let concurrent = 0
  let maxConcurrent = 0
  const lib = new Librarian({
    baseDir: base,
    trustAcceptMs: 0,
    pollMs: 20,
    executorFactory: () => makeLibrarianExecutor({
      onWrite: async (libCwd) => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 60))
        concurrent--
        await writeDone(path.join(libCwd, 'status.json'), 'ok')
      },
    }),
  })

  const cwd1 = path.join(base, 'a'); const cwd2 = path.join(base, 'b')
  await fs.mkdir(cwd1, { recursive: true }); await fs.mkdir(cwd2, { recursive: true })
  // submit two concurrently
  await Promise.all([
    lib.submit({ taskId: 'a', intent: 'x', scratchPath: path.join(cwd1, 'r.json'), cwd: cwd1 }),
    lib.submit({ taskId: 'b', intent: 'y', scratchPath: path.join(cwd2, 'r.json'), cwd: cwd2 }),
  ])
  assert.equal(maxConcurrent, 1, 'librarian must never run two sessions at once')
})

test('runMaintenance is serialized against librarian sessions — never two writers at once', { timeout: 8000 }, async () => {
  const base = await tmpBase()
  let active = 0
  let maxActive = 0
  const bump = async (ms: number) => {
    active++; maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, ms))
    active--
  }
  const lib = new Librarian({
    baseDir: base,
    trustAcceptMs: 0,
    pollMs: 20,
    executorFactory: () => makeLibrarianExecutor({
      onWrite: async (libCwd) => {
        await bump(60)
        await writeDone(path.join(libCwd, 'status.json'), 'ok')
      },
    }),
  })
  const cwd1 = path.join(base, 'a')
  await fs.mkdir(cwd1, { recursive: true })
  // A librarian session and a gardening maintenance pass kick off together;
  // the maintenance job must wait for the session (single-writer invariant).
  await Promise.all([
    lib.submit({ taskId: 'a', intent: 'x', scratchPath: path.join(cwd1, 'r.json'), cwd: cwd1 }),
    lib.runMaintenance(async () => { await bump(60) }),
  ])
  assert.equal(maxActive, 1, 'gardening must never overlap a librarian session')
})

test('librarian prompt encodes the dials + read-only proposal in gated mode', () => {
  const p = buildLibrarianPrompt({
    intent: 'scan my inboxes', outcome: 'failed',
    injectedRecipes: [{ name: 'gmail-inbox-sweep', tier: 'nursery', surface: 'gmail' }],
    reducedTrace: 'TOOL Bash: gmail\n  -> ERROR: profile 3 not found',
    existing: [], profile: '', writeEnabled: false,
    recipesDir: '/m/recipes', skillsDir: '/m/skills', profilePath: '/m/profile.md', proposalPath: '/lib/proposal.json', statusPath: '/lib/status.json',
  })
  assert.match(p, /Invariants|Definition of done/)        // hard-section rule present
  assert.match(p, /Defaults|Procedure/)                   // soft-section rule present
  assert.match(p, /down fast|demote/i)
  assert.match(p, /proposal\.json/)                       // read-only target
  assert.match(p, /do not (modify|write|change)/i)        // gated: no store mutation
  assert.match(p, /gmail-inbox-sweep/)                    // injected recipe named
})

test('librarian prompt allows writes when enabled', () => {
  const p = buildLibrarianPrompt({
    intent: 'x', outcome: 'done', injectedRecipes: [], reducedTrace: '', existing: [], profile: '',
    writeEnabled: true, recipesDir: '/m/recipes', skillsDir: '/m/skills', profilePath: '/canonical/profile.md', proposalPath: '/lib/proposal.json', statusPath: '/lib/status.json',
  })
  assert.match(p, /recipes\//)
  assert.doesNotMatch(p, /proposal\.json/)
  // Profile facts must target the canonical path, never a task-local PROFILE.md copy.
  assert.match(p, /\/canonical\/profile\.md/)             // exact canonical path given
  assert.match(p, /NEVER[^\n]*PROFILE\.md|task director/i) // forbids the throwaway copy
})

test('librarian prompt tells it to DISTIL browser runs into a semantic recipe (not no-op everything)', () => {
  const p = buildLibrarianPrompt({
    intent: 'post a tweet from my unmute account', outcome: 'done', injectedRecipes: [],
    reducedTrace: 'NAV https://x.com/compose\nUI left_click (x4)\nUI type "hi"', existing: [], profile: '',
    writeEnabled: true, recipesDir: '/m/recipes', skillsDir: '/m/skills', profilePath: '/m/profile.md',
    proposalPath: '/lib/proposal.json', statusPath: '/lib/status.json',
  })
  assert.match(p, /SEMANTIC PROCEDURE|semantic skeleton/i)   // browser procedures ARE recipe-worthy
  assert.match(p, /DISTILL|distil/i)                         // distill, don't transcribe
  assert.match(p, /coordinates|pixel/i)                      // raw coordinates explicitly excluded
  assert.match(p, /Preconditions/)                           // recipe template present
  assert.match(p, /Gotchas/)
  assert.match(p, /COMPLETED|completed the task/i)           // only from completed runs
})
