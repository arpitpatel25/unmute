import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnAndCollect } from './headlessAgent'

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
