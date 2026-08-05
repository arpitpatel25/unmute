import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  upsertContractBlock,
  installContract,
  readContractText,
  CONTRACT_BEGIN,
  CONTRACT_END,
} from './installer.ts'

const block = `${CONTRACT_BEGIN}\nHELLO CONTRACT\n${CONTRACT_END}`

test('upsert appends into an empty body', () => {
  const out = upsertContractBlock('', block)
  assert.match(out, /HELLO CONTRACT/)
  assert.ok(out.includes(CONTRACT_BEGIN) && out.includes(CONTRACT_END))
})

test('upsert preserves user content and appends below it', () => {
  const out = upsertContractBlock('# My project notes\nstuff', block)
  assert.match(out, /My project notes/)
  assert.match(out, /HELLO CONTRACT/)
  assert.ok(out.indexOf('My project notes') < out.indexOf('HELLO CONTRACT'))
})

test('upsert is idempotent — replaces the block, no duplication', () => {
  const once = upsertContractBlock('# notes', block)
  const twice = upsertContractBlock(once, `${CONTRACT_BEGIN}\nNEW CONTRACT\n${CONTRACT_END}`)
  assert.equal((twice.match(new RegExp(CONTRACT_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1)
  assert.match(twice, /NEW CONTRACT/)
  assert.doesNotMatch(twice, /HELLO CONTRACT/)
  assert.match(twice, /notes/) // user content survives
})

test('the markers still upsert, so an OLD 244-line contract gets replaced not appended', async () => {
  // Task dispatch no longer calls this at all. It survives for the parked
  // librarian, and because a user upgrading from a previous build has stale
  // CLAUDE.md files in their task directories — this is what removes them.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cwd-'))
  const target = path.join(cwd, 'CLAUDE.md')
  await fs.writeFile(target, `${CONTRACT_BEGIN}\n# Unmute Remote — operating contract\n## 4a. Classify the task\n${CONTRACT_END}`)
  await installContract(cwd)
  const body = await fs.readFile(target, 'utf8')
  assert.doesNotMatch(body, /Classify the task/, 'the old contract survived the upsert')
  assert.match(body, /Unmute task/)
})

test('the bundled text is now the four-line preamble, not a protocol', async () => {
  const t = await readContractText()
  assert.match(t, /UNMUTE-REMOTE-CONTRACT:BEGIN/)
  assert.ok(t.length < 800, `contract text grew back to ${t.length} chars`)
  for (const banned of ['status.json', 'atomically', 'schema_version', 'recipe']) {
    assert.ok(!t.toLowerCase().includes(banned), `contract text mentions "${banned}" again`)
  }
})
