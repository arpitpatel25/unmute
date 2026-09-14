import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildManifest, writeManifest, defaultIndexDir } from './manifest'
import type { RunWindow } from './window'

const WINDOW: RunWindow = { start: 1_000, end: 3_000, label: 'test window' }
const EXCLUDE = '/unmute-agent/routines/runs/'

async function indexDir() {
  return fs.mkdtemp(join(tmpdir(), 'routines-manifest-'))
}

function sessionLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields) + '\n'
}
function turnLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields) + '\n'
}

test('includes only in-window turns from sessions that are not routine-provenance and not under the routine runs cwd', async () => {
  const dir = await indexDir()
  await fs.writeFile(join(dir, 'sessions.jsonl'),
    sessionLine({ id: 's1', provider: 'claude', cwd: '/repo/proj', provenance: 'main', firstAt: 1_000, lastAt: 5_000 })
    + sessionLine({ id: 's2', provider: 'codex', cwd: '/x', provenance: 'routine', firstAt: 1_000, lastAt: 4_000 })
    + sessionLine({ id: 's3', provider: 'claude', cwd: '/x/unmute-agent/routines/runs/abc', provenance: 'main', firstAt: 1_000, lastAt: 6_000 }))
  await fs.writeFile(join(dir, 'turns.jsonl'),
    turnLine({ s: 's1', t: 2_000, o: 10, text: 'inside the window' })
    + turnLine({ s: 's1', t: 500, o: 20, text: 'before the window' })
    + turnLine({ s: 's1', t: 4_000, o: 30, text: 'after the window' })
    + turnLine({ s: 's2', t: 1_500, o: 5, text: 'routine noise' })
    + turnLine({ s: 's3', t: 1_500, o: 5, text: 'routine run noise' }))

  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE })

  assert.equal(manifest.sessions.length, 1)
  const [session] = manifest.sessions
  assert.equal(session!.id, 's1')
  assert.equal(session!.provider, 'claude')
  assert.equal(session!.cwd, '/repo/proj')
  assert.equal(session!.turnsInWindow, 1)
  assert.deepEqual(session!.turns, [{ t: 2_000, o: 10, text: 'inside the window' }])
  assert.deepEqual(manifest.totals, { sessions: 1, turns: 1 })
  assert.equal(manifest.truncated, false)
  assert.deepEqual(manifest.window, WINDOW)
})

test('a later sessions.jsonl line for the same id wins', async () => {
  const dir = await indexDir()
  await fs.writeFile(join(dir, 'sessions.jsonl'),
    sessionLine({ id: 's1', provider: 'claude', cwd: '/repo/proj', provenance: 'main', firstAt: 1_000, lastAt: 1_000 })
    + sessionLine({ id: 's1', provider: 'claude', cwd: '/repo/proj', provenance: 'routine', firstAt: 1_000, lastAt: 9_000 }))
  await fs.writeFile(join(dir, 'turns.jsonl'), turnLine({ s: 's1', t: 2_000, o: 10, text: 'hi' }))

  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE })

  // The later line marks it provenance routine, so it must not appear at all.
  assert.equal(manifest.sessions.length, 0)
  assert.deepEqual(manifest.totals, { sessions: 0, turns: 0 })
})

test('sessions are sorted by lastAt descending', async () => {
  const dir = await indexDir()
  await fs.writeFile(join(dir, 'sessions.jsonl'),
    sessionLine({ id: 'older', provider: 'claude', cwd: '/a', provenance: 'main', firstAt: 1_000, lastAt: 1_500 })
    + sessionLine({ id: 'newer', provider: 'codex', cwd: '/b', provenance: 'main', firstAt: 1_000, lastAt: 2_900 }))
  await fs.writeFile(join(dir, 'turns.jsonl'),
    turnLine({ s: 'older', t: 1_200, o: 1, text: 'a' })
    + turnLine({ s: 'newer', t: 1_300, o: 2, text: 'b' }))

  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE })

  assert.deepEqual(manifest.sessions.map(s => s.id), ['newer', 'older'])
})

test('turn text is truncated to 400 characters', async () => {
  const dir = await indexDir()
  await fs.writeFile(join(dir, 'sessions.jsonl'),
    sessionLine({ id: 's1', provider: 'claude', cwd: '/repo', provenance: 'main', firstAt: 1_000, lastAt: 2_000 }))
  const long = 'x'.repeat(500)
  await fs.writeFile(join(dir, 'turns.jsonl'), turnLine({ s: 's1', t: 2_000, o: 10, text: long }))

  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE })

  assert.equal(manifest.sessions[0]!.turns[0]!.text!.length, 400)
  assert.equal(manifest.sessions[0]!.turns[0]!.text, long.slice(0, 400))
})

test('over the byte cap, turn text is dropped and truncated is set', async () => {
  const dir = await indexDir()
  await fs.writeFile(join(dir, 'sessions.jsonl'),
    sessionLine({ id: 's1', provider: 'claude', cwd: '/repo', provenance: 'main', firstAt: 1_000, lastAt: 2_000 }))
  const big = 'y'.repeat(400)
  const lines: string[] = []
  for (let i = 0; i < 30; i++) lines.push(turnLine({ s: 's1', t: 1_000 + i, o: i, text: big }))
  await fs.writeFile(join(dir, 'turns.jsonl'), lines.join(''))

  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE, maxBytes: 2_000 })

  assert.equal(manifest.truncated, true)
  assert.equal(manifest.sessions[0]!.turns.length, 30)
  for (const turn of manifest.sessions[0]!.turns) assert.equal('text' in turn, false)
})

test('the byte cap is measured in UTF-8 bytes, not UTF-16 code units, so wide characters are not undercounted', async () => {
  const dir = await indexDir()
  await fs.writeFile(join(dir, 'sessions.jsonl'),
    sessionLine({ id: 's1', provider: 'claude', cwd: '/repo', provenance: 'main', firstAt: 1_000, lastAt: 2_000 }))
  // Each character here is ONE UTF-16 code unit (so `.length` counts it as 1)
  // but THREE UTF-8 bytes — exactly the gap a `.length`-based cap misses.
  const text = '日本語'.repeat(200)
  await fs.writeFile(join(dir, 'turns.jsonl'), turnLine({ s: 's1', t: 2_000, o: 10, text }))

  const uncapped = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE, maxBytes: Number.MAX_SAFE_INTEGER })
  const serialized = JSON.stringify(uncapped)
  const charLength = serialized.length
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  // Confirms the fixture actually exercises the gap this test is about;
  // if this fails the fixture stopped being wide enough to prove anything.
  assert.ok(byteLength > charLength, 'fixture must actually exercise the UTF-16 vs UTF-8 gap')

  // A cap set to the (UTF-16) char length: a `.length`-based check would call
  // this "at or under budget" even though the real UTF-8 size is bigger.
  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE, maxBytes: charLength })

  assert.equal(manifest.truncated, true)
  assert.equal('text' in manifest.sessions[0]!.turns[0]!, false)
})

test('turn text is truncated at a code point boundary, never splitting a surrogate pair', async () => {
  const dir = await indexDir()
  await fs.writeFile(join(dir, 'sessions.jsonl'),
    sessionLine({ id: 's1', provider: 'claude', cwd: '/repo', provenance: 'main', firstAt: 1_000, lastAt: 2_000 }))
  // An emoji is one code point but two UTF-16 code units (a surrogate pair).
  // Placed so the 400-code-point cut lands exactly on it: a raw
  // `.slice(0, 400)` would keep only its high surrogate.
  const prefix = 'a'.repeat(399)
  const text = prefix + '\u{1F600}' + 'b'.repeat(50)
  await fs.writeFile(join(dir, 'turns.jsonl'), turnLine({ s: 's1', t: 2_000, o: 10, text }))

  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE })

  const stored = manifest.sessions[0]!.turns[0]!.text!
  assert.equal(stored, prefix + '\u{1F600}')
  assert.equal([...stored].length, 400)
  // A split pair would leave a lone surrogate half with no partner.
  assert.doesNotMatch(stored, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'a high surrogate must not be left unpaired')
})

test('a missing index dir returns an empty manifest rather than throwing', async () => {
  const dir = join(await indexDir(), 'does-not-exist')

  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE })

  assert.deepEqual(manifest.sessions, [])
  assert.deepEqual(manifest.totals, { sessions: 0, turns: 0 })
  assert.equal(manifest.truncated, false)
})

test('a corrupt line in either file is skipped, not fatal', async () => {
  const dir = await indexDir()
  await fs.writeFile(join(dir, 'sessions.jsonl'),
    '{ not json\n' + sessionLine({ id: 's1', provider: 'claude', cwd: '/repo', provenance: 'main', firstAt: 1_000, lastAt: 2_000 }))
  await fs.writeFile(join(dir, 'turns.jsonl'),
    '{ not json\n' + turnLine({ s: 's1', t: 2_000, o: 10, text: 'ok' }))

  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE })

  assert.equal(manifest.sessions.length, 1)
  assert.equal(manifest.sessions[0]!.turns[0]!.text, 'ok')
})

test('writeManifest writes manifest.json and manifest.md, and the markdown lists every session by id', async () => {
  const dir = await indexDir()
  await fs.writeFile(join(dir, 'sessions.jsonl'),
    sessionLine({ id: 's1', provider: 'claude', cwd: '/repo/proj', provenance: 'main', firstAt: 1_000, lastAt: 2_000 }))
  await fs.writeFile(join(dir, 'turns.jsonl'), turnLine({ s: 's1', t: 2_000, o: 10, text: 'add a row' }))
  const manifest = await buildManifest({ indexDir: dir, window: WINDOW, excludeCwdPart: EXCLUDE })

  const outDir = await fs.mkdtemp(join(tmpdir(), 'routines-manifest-out-'))
  const { jsonPath, mdPath } = await writeManifest(outDir, manifest)

  assert.equal(jsonPath, join(outDir, 'manifest.json'))
  assert.equal(mdPath, join(outDir, 'manifest.md'))
  const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'))
  assert.deepEqual(json, manifest)
  const md = await fs.readFile(mdPath, 'utf8')
  assert.match(md, /^# Inputs for this run/)
  assert.match(md, /## s1 · claude · \/repo\/proj/)
  assert.match(md, /add a row/)
})

test('defaultIndexDir points at the session index root', () => {
  assert.equal(defaultIndexDir(), join(homedir(), '.unmute', 'remote', 'session-index'))
})
