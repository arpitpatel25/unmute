import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Librarian } from './librarian.ts'
import { installSkillsIntoCwd, sharedSkillsDir, sessionSkillsDir } from './skills.ts'
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

test('installSkillsIntoCwd copies shared recipes into the session cwd (PRD §8.3)', async () => {
  const base = await tmpBase()
  const sdir = sharedSkillsDir(base)
  await fs.mkdir(sdir, { recursive: true })
  await fs.writeFile(path.join(sdir, 'extract-zip.md'), '# recipe')
  const cwd = path.join(base, 'task1')
  const n = await installSkillsIntoCwd(cwd, base)
  assert.equal(n, 1)
  assert.ok((await fs.readFile(path.join(sessionSkillsDir(cwd), 'extract-zip.md'), 'utf8')).includes('recipe'))
})

test('installSkillsIntoCwd is a no-op when there are no shared skills yet', async () => {
  const base = await tmpBase()
  const n = await installSkillsIntoCwd(path.join(base, 'task1'), base)
  assert.equal(n, 0)
})

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
        // write a skill into the shared dir, then mark librarian status done
        await fs.writeFile(path.join(sharedSkillsDir(base), 'extract-zip.md'), '---\nname: extract-zip\n---\nsteps')
        await writeDone(path.join(libCwd, 'status.json'), 'created extract-zip')
      },
    }),
  })

  await lib.submit({ taskId: 't1', intent: 'extract a zip', scratchPath: path.join(taskCwd, 'recipe.json'), cwd: taskCwd })
  // the shared skill now exists
  assert.ok((await fs.readFile(path.join(sharedSkillsDir(base), 'extract-zip.md'), 'utf8')).includes('extract-zip'))
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
