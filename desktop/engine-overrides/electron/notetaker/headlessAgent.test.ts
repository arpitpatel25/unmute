import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { headlessArgvFor, spawnAndCollect } from './headlessAgent'

// Exercised against REAL child processes (Node itself, via -e inline
// scripts) rather than mocked child_process internals — deterministic,
// portable across CI machines, and tests the actual spawn/stdin/timeout
// wiring instead of a stand-in for it.

describe('spawnAndCollect', () => {
  test('captures stdout and resolves ok on a clean exit', async () => {
    const result = await spawnAndCollect(
      process.execPath,
      ['-e', 'process.stdin.resume(); let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => { process.stdout.write(d.toUpperCase()); process.exit(0) })'],
      'hello',
      5000,
    )
    assert.deepEqual(result, { ok: true, output: 'HELLO' })
  })

  test('a non-zero exit resolves ok:false with stderr as the error', async () => {
    const result = await spawnAndCollect(
      process.execPath,
      ['-e', 'process.stderr.write("boom"); process.exit(2)'],
      '',
      5000,
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'boom')
  })

  test('a non-zero exit with empty stderr falls back to the exit code in the message', async () => {
    const result = await spawnAndCollect(process.execPath, ['-e', 'process.exit(3)'], '', 5000)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /exited with code 3/)
  })

  test('a command that cannot be spawned resolves ok:false, never throws', async () => {
    const result = await spawnAndCollect('this-binary-does-not-exist-anywhere', [], '', 5000)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /process error/)
  })

  test('a process that outlives the timeout is killed and reported as timed out', async () => {
    const result = await spawnAndCollect(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 5000)'],
      '',
      100,
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /timed out/)
  })

  test('whitespace in stdout is trimmed', async () => {
    const result = await spawnAndCollect(
      process.execPath,
      ['-e', 'process.stdout.write("\\n  padded  \\n")'],
      '',
      5000,
    )
    assert.deepEqual(result, { ok: true, output: 'padded' })
  })
})

/**
 * THE BUG THIS PINS. Codex refuses to run outside a trusted git directory, and
 * every caller of this helper runs somewhere that deliberately is not a repo —
 * the notetaker's cleanup jobs, and the session summariser, which works out of
 * the Agent's own runtime directory so its transcripts never land in the user's
 * projects. Without the flag it exited in ~70ms, and because a failed summary
 * does not advance its cursor, all 1,352 sessions retried on every sweep,
 * forever.
 *
 * The Agent's own turn path never had this: codex-headless.ts builds its own
 * argv and passes the flag. Two launchers, one missing it.
 */
test('codex is launched with --skip-git-repo-check', () => {
  const [command, args] = headlessArgvFor('codex')
  assert.equal(command, 'codex')
  assert.deepEqual(args, ['exec', '--skip-git-repo-check'])
})

test('claude needs no such flag', () => {
  const [command, args] = headlessArgvFor('claude')
  assert.equal(command, 'claude')
  assert.deepEqual(args, ['-p'])
})
