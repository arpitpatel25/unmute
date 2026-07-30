import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describeApproval, pendingApprovals, expireStaleApprovals, decideApproval, clearApproval, beat, type CodexApprovalRequest } from './hooks'

// These exercise the UNMUTE side of the channel against a real directory, and
// the generated handler against a real node process. The handler is a string
// template that runs inside someone else's app, so a typo in it fails silently
// in production — running it here is the only way to know it works.

const tmp = () => fs.mkdtemp(join(tmpdir(), 'unmute-approve-'))

const run = (script: string, stdin: string): Promise<string> =>
  new Promise((resolve) => {
    const p = execFile(process.execPath, [script], (_e, stdout) => resolve(stdout))
    p.stdin?.end(stdin)
  })

describe('approval payload rendering', () => {
  const base: CodexApprovalRequest = {
    threadId: 't1', turnId: 'u1', cwd: '/x', toolName: 'Bash', toolInput: null, at: 1,
  }

  it('shows the command Codex actually wants to run', () => {
    // Verbatim from the live fire test, 2026-07-25.
    const req = { ...base, toolInput: { command: "printf '%s\\n' hello > /tmp/unmute-hook-probe.txt" } }
    assert.equal(describeApproval(req), "printf '%s\\n' hello > /tmp/unmute-hook-probe.txt")
  })

  it('falls back to tool + path, then to the tool name', () => {
    assert.equal(describeApproval({ ...base, toolName: 'Edit', toolInput: { file_path: '/a/b.ts' } }), 'Edit: /a/b.ts')
    assert.equal(describeApproval(base), 'Bash')
  })

  it('never renders an empty prompt', () => {
    assert.equal(describeApproval({ ...base, toolName: '', toolInput: { command: '   ' } }), 'an action')
  })
})

describe('the unmute side of the inbox', () => {
  it('reads every pending request — across ALL threads, not just one', async () => {
    // The reason this channel exists: a user with seven blocked tasks must see
    // seven, whatever the Codex window happens to be showing.
    const dir = await tmp()
    for (const id of ['a', 'b', 'c']) {
      await fs.writeFile(join(dir, `${id}.json`), JSON.stringify({
        threadId: id, turnId: 't', cwd: '/x', toolName: 'Bash', toolInput: { command: `echo ${id}` }, at: 1,
      }))
    }
    const got = await pendingApprovals(dir)
    assert.deepEqual(got.map((r) => r.threadId).sort(), ['a', 'b', 'c'])
  })

  it('ignores junk instead of throwing the sweep', async () => {
    const dir = await tmp()
    await fs.writeFile(join(dir, 'half-written.json'), '{"threadId":')
    await fs.writeFile(join(dir, 'notes.txt'), 'hello')
    await fs.writeFile(join(dir, 'x.decision'), '{"behavior":"allow"}')
    assert.deepEqual(await pendingApprovals(dir), [])
  })

  it('returns empty for a directory that does not exist yet', async () => {
    assert.deepEqual(await pendingApprovals(join(tmpdir(), 'unmute-nope-' + Math.random())), [])
  })

  it('clearing drops both the request and any stale decision', async () => {
    const dir = await tmp()
    await fs.writeFile(join(dir, 'z.json'), JSON.stringify({ threadId: 'z' }))
    await decideApproval('z', 'allow', dir)
    await clearApproval('z', dir)
    assert.deepEqual(await fs.readdir(dir), [])
  })
})

describe('the generated handler (run for real)', () => {
  // A live PermissionRequest payload, captured 2026-07-25.
  const EVENT = JSON.stringify({
    session_id: '019f9a12-b931-7591-98ef-e1fae9f90b1f',
    turn_id: '019f9a12-b999-7d62-9e71-872e578e7662',
    transcript_path: '/Users/x/.codex/sessions/rollout.jsonl',
    cwd: '/Users/x/project',
    hook_event_name: 'PermissionRequest',
    model: 'gpt-5.6-terra',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: "printf '%s\\n' hello > /tmp/x.txt" },
  })

  /**
   * Installs into a scratch HOME so the handler's hardcoded ~/.unmute path
   * lands somewhere disposable.
   */
  async function install(waitSec: number): Promise<{ dir: string; script: string }> {
    // os.homedir() reads $HOME on POSIX, and the handler is a child process
    // that inherits it — so pointing HOME at a scratch dir redirects BOTH sides
    // of the channel without touching the real one. The trust step needs a live
    // Codex, which a unit test has no business requiring; pointing it at a
    // nonexistent CLI exercises the degrade-to-"no trust" path instead.
    const home = await tmp()
    process.env.HOME = home
    const { installApprovalHook, approvalDir, hookDir } = await import('./hooks')
    const res = await installApprovalHook({ runtime: process.execPath, waitSec, codexCli: '/nonexistent-codex' })
    assert.equal(res.ok, false, 'no Codex ⇒ not trusted, but the files are still written')
    return { dir: approvalDir(), script: join(hookDir(), 'permission-request.cjs') }
  }

  const REAL_HOME = process.env.HOME

  it('records the request and asks Codex for nothing when unmute is DOWN', async () => {
    // The most important failure mode: with no unmute running the hook must not
    // stall the user's agent. It reports, then gets out of the way.
    const { dir, script } = await install(30)
    const started = Date.now()
    const out = await run(script, EVENT)
    const elapsed = Date.now() - started

    assert.ok(elapsed < 5000, `must not wait when unmute is down (waited ${elapsed}ms)`)
    assert.deepEqual(JSON.parse(out), { suppressOutput: true }, 'no decision ⇒ Codex asks the user itself')

    const pending = await pendingApprovals(dir)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].threadId, '019f9a12-b931-7591-98ef-e1fae9f90b1f')
    assert.equal(pending[0].toolName, 'Bash')
    assert.equal(describeApproval(pending[0]), "printf '%s\\n' hello > /tmp/x.txt")
    process.env.HOME = REAL_HOME
  })

  it('returns ALLOW when unmute answers while it waits — this is the crank', async () => {
    const { dir, script } = await install(30)
    await beat(dir)

    const done = run(script, EVENT)
    // Answer the way the notch does, once the request has landed.
    await new Promise((r) => setTimeout(r, 600))
    await decideApproval('019f9a12-b931-7591-98ef-e1fae9f90b1f', 'allow', dir)

    // CODEX'S contract — `{decision}` — not Claude Code's hookSpecificOutput.
    // This test asserted the Claude shape and passed for months while every
    // real denial was silently ignored by Codex, which recognises none of
    // those keys. A test that encodes our misunderstanding is worse than no
    // test: it certifies the bug.
    assert.deepEqual(JSON.parse(await done), { decision: 'allow' })
    // Answered ⇒ nothing left blocking.
    assert.deepEqual(await pendingApprovals(dir), [])
    process.env.HOME = REAL_HOME
  })

  it('returns DENY the same way', async () => {
    const { dir, script } = await install(30)
    await beat(dir)
    const done = run(script, EVENT)
    await new Promise((r) => setTimeout(r, 600))
    await decideApproval('019f9a12-b931-7591-98ef-e1fae9f90b1f', 'deny', dir)
    // A block MUST carry a non-empty reason — Codex discards it otherwise
    // ("hook returned decision:block without a non-empty reason").
    const out = JSON.parse(await done)
    assert.equal(out.decision, 'block')
    assert.ok(out.reason && out.reason.length > 0, 'a block needs a reason or Codex drops it')
    process.env.HOME = REAL_HOME
  })

  it('gives up and lets Codex ask, rather than blocking forever', async () => {
    const { dir, script } = await install(1)
    await beat(dir)
    const started = Date.now()
    const out = await run(script, EVENT)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 900, 'it really did wait')
    assert.ok(elapsed < 8000, `and really did give up (${elapsed}ms)`)
    assert.deepEqual(JSON.parse(out), { suppressOutput: true })
    // Still pending: the request is real and Codex is about to ask in-app, so
    // the card must keep showing as blocked.
    assert.equal((await pendingApprovals(dir)).length, 1)
    process.env.HOME = REAL_HOME
  })

  it('says nothing at all when handed garbage', async () => {
    const { script } = await install(2)
    assert.deepEqual(JSON.parse(await run(script, 'not json')), { suppressOutput: true })
    assert.deepEqual(JSON.parse(await run(script, '{"no":"session"}')), { suppressOutput: true })
    process.env.HOME = REAL_HOME
  })
})

describe('installing into the user\'s hooks.json', () => {
  it('KEEPS hooks the user already had', async () => {
    // ~/.codex/hooks.json belongs to the user. Clobbering it would silently
    // break their own automation, and they would have no idea why.
    const home = await tmp()
    const cxHome = join(home, '.codex')
    await fs.mkdir(cxHome, { recursive: true })
    const theirs = {
      description: 'mine',
      hooks: {
        PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/their-hook' }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/their-other-hook' }] }],
      },
    }
    await fs.writeFile(join(cxHome, 'hooks.json'), JSON.stringify(theirs))

    process.env.HOME = home
    const { installApprovalHook } = await import('./hooks')
    await installApprovalHook({ runtime: process.execPath, codexCli: '/nonexistent-codex', home: cxHome })

    const after = JSON.parse(await fs.readFile(join(cxHome, 'hooks.json'), 'utf8'))
    const commands = after.hooks.PermissionRequest.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command))
    assert.ok(commands.includes('/usr/local/bin/their-hook'), 'their PermissionRequest hook survived')
    assert.ok(commands.some((c: string) => c.includes('/.unmute/remote/codex-hooks/')), 'ours was added')
    assert.ok(after.hooks.PostToolUse, 'their other event survived untouched')
  })

  it('does not stack duplicates when the user reconnects repeatedly', async () => {
    const home = await tmp()
    const cxHome = join(home, '.codex')
    process.env.HOME = home
    const { installApprovalHook } = await import('./hooks')
    for (let i = 0; i < 3; i++) {
      await installApprovalHook({ runtime: process.execPath, codexCli: '/nonexistent-codex', home: cxHome })
    }
    const after = JSON.parse(await fs.readFile(join(cxHome, 'hooks.json'), 'utf8'))
    const mine = after.hooks.PermissionRequest.filter((g: { hooks: Array<{ command: string }> }) =>
      g.hooks.some((h) => h.command.includes('/.unmute/remote/codex-hooks/')))
    assert.equal(mine.length, 1, 'exactly one unmute entry after three connects')
  })

  it('writes the PascalCase shape Codex actually parses', async () => {
    // camelCase and snake_case keys parse WITHOUT error and are silently
    // ignored — four spellings were tried live before this one registered.
    const home = await tmp()
    const cxHome = join(home, '.codex')
    process.env.HOME = home
    const { installApprovalHook } = await import('./hooks')
    await installApprovalHook({ runtime: process.execPath, codexCli: '/nonexistent-codex', home: cxHome })
    const after = JSON.parse(await fs.readFile(join(cxHome, 'hooks.json'), 'utf8'))
    assert.ok(after.hooks.PermissionRequest, 'PermissionRequest, not permissionRequest')
    const entry = after.hooks.PermissionRequest[0].hooks[0]
    assert.equal(entry.type, 'command')
    assert.ok(entry.command.endsWith('permission-request.sh'))
    // `async: false` is REQUIRED and is what makes the decision enforceable —
    // without it Codex fires the hook and runs the command without waiting, so
    // a Deny arrives after the fact. This assertion is the difference between
    // an approval prompt and an approval GATE.
    assert.equal(entry.async, false, 'async:false — otherwise Codex does not wait for our decision')
    // ON DISK the key is `timeout` (Codex renames it to timeoutSec only when
    // reporting via hooks/list). Writing `timeoutSec` here is ignored and Codex
    // silently uses its 600s default — verified by probe.
    assert.ok(entry.timeout > 0, 'Codex kills the hook at timeout; it must outlast our own wait')
  })
})

// ── stale pending-approval garbage collection (added 2026-07-30) ────────────
// A request from 2026-07-28 was still sitting in codex-approvals/ two days
// later: the hook had fired, no live task carried that threadId, sweepApprovals
// skipped it silently, and nothing ever deleted it.

it('a request older than the handler could possibly wait is binned', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'unmute-approvals-'))
  const now = Date.now()
  const old = { threadId: 'thread-old', turnId: 't', cwd: '/tmp', toolName: 'Bash', toolInput: {}, at: now - 20 * 60_000 }
  const fresh = { threadId: 'thread-fresh', turnId: 't', cwd: '/tmp', toolName: 'Bash', toolInput: {}, at: now - 5_000 }
  await fs.writeFile(join(dir, 'thread-old.json'), JSON.stringify(old))
  await fs.writeFile(join(dir, 'thread-fresh.json'), JSON.stringify(fresh))

  assert.equal(await expireStaleApprovals(dir, () => now), 1)
  const got = await pendingApprovals(dir)
  assert.deepEqual(got.map((r) => r.threadId), ['thread-fresh'])
  // and the stale one is GONE from disk, not merely filtered out
  const left = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'))
  assert.deepEqual(left, ['thread-fresh.json'])
})

it('a fresh request is never binned by the sweep', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'unmute-approvals-'))
  const now = Date.now()
  await fs.writeFile(join(dir, 'a.json'), JSON.stringify(
    { threadId: 'a', turnId: 't', cwd: '/tmp', toolName: 'Bash', toolInput: {}, at: now }))
  assert.equal(await expireStaleApprovals(dir, () => now), 0)
  assert.equal((await pendingApprovals(dir)).length, 1)
  assert.equal((await fs.readdir(dir)).length, 1)
})
