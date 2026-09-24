import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveCodexCli } from './driver'

test('Codex CLI resolves the app bundle when a managed Mac has no codex on PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bundled-cli-'))
  try {
    const bundled = join(root, 'codex')
    await writeFile(bundled, '')
    assert.equal(await resolveCodexCli(async () => null, bundled), bundled)
    assert.equal(await resolveCodexCli(async () => '/opt/homebrew/bin/codex', bundled), '/opt/homebrew/bin/codex')
  } finally { await rm(root, { recursive: true, force: true }) }
})
