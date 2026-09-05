import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runtimeExecutable } from './client'

test('packaged macOS runtime uses the helper executable so LaunchServices can relaunch the GUI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unmute-runtime-exec-'))
  const main = join(root, 'unmute.app', 'Contents', 'MacOS', 'unmute')
  const helper = join(root, 'unmute.app', 'Contents', 'Frameworks', 'unmute Helper.app', 'Contents', 'MacOS', 'unmute Helper')
  try {
    await mkdir(dirname(main), { recursive: true })
    await mkdir(dirname(helper), { recursive: true })
    await writeFile(main, '')
    await writeFile(helper, '')
    assert.equal(runtimeExecutable(main), helper)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runtime executable falls back outside a packaged macOS bundle', () => {
  assert.equal(runtimeExecutable('/usr/local/bin/electron'), '/usr/local/bin/electron')
})
