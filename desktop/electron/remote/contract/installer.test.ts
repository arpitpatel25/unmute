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

test('installContract writes a CLAUDE.md containing the real contract', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cwd-'))
  const target = await installContract(cwd)
  const body = await fs.readFile(target, 'utf8')
  assert.match(target, /CLAUDE\.md$/)
  assert.match(body, /Unmute Remote — operating contract/) // from the real contract.md
  assert.match(body, /status file/i)
})

test('readContractText returns the bundled contract', async () => {
  const t = await readContractText()
  assert.match(t, /UNMUTE-REMOTE-CONTRACT:BEGIN/)
  assert.match(t, /atomically/i)
})
