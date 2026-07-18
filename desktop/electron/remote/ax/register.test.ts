// register — rename + enable-guarantee tests. Covers the pure helpers only
// (the execFile/fs side effects are exercised live, not unit-tested).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AX_MCP_NAME, LEGACY_MCP_NAME, pruneDisabledServers, removeBlock, ensureNotDisabled } from './register'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('name is unmute-scoped so it cannot collide with the built-in computer-use', () => {
  assert.equal(AX_MCP_NAME, 'unmute-computer')
  assert.equal(LEGACY_MCP_NAME, 'computer')
  assert.notEqual(AX_MCP_NAME, 'computer-use')
})

test('pruneDisabledServers removes our name from every project + reports change', () => {
  const config = {
    projects: {
      '/a': { disabledMcpServers: ['unmute-computer', 'other'] },
      '/b': { disabledMcpServers: ['computer'] },
      '/c': { disabledMcpServers: ['other'] },
      '/d': { foo: 1 }, // no list — must be left untouched
    },
    disabledMcpjsonServers: ['computer', 'keep'],
  }
  const { changed } = pruneDisabledServers(config, ['unmute-computer', 'computer'])
  assert.equal(changed, true)
  assert.deepEqual(config.projects['/a'].disabledMcpServers, ['other'])
  assert.deepEqual(config.projects['/b'].disabledMcpServers, [])
  assert.deepEqual(config.projects['/c'].disabledMcpServers, ['other']) // unrelated untouched
  assert.deepEqual((config.projects['/d'] as any), { foo: 1 })
  assert.deepEqual(config.disabledMcpjsonServers, ['keep'])
})

test('pruneDisabledServers reports NO change when our name is absent (so caller skips the write)', () => {
  const config = { projects: { '/a': { disabledMcpServers: ['other'] } } }
  const { changed } = pruneDisabledServers(config, ['unmute-computer', 'computer'])
  assert.equal(changed, false)
})

test('ensureNotDisabled rewrites the file only when something changed', async () => {
  const home = await fs.mkdtemp(join(tmpdir(), 'unmute-reg-'))
  const path = join(home, '.claude.json')
  // Case 1: a disable present → cleared and written back, rest preserved.
  await fs.writeFile(path, JSON.stringify({ keepMe: 42, projects: { '/x': { disabledMcpServers: ['unmute-computer'] } } }))
  await ensureNotDisabled(['unmute-computer', 'computer'], home)
  const after = JSON.parse(await fs.readFile(path, 'utf-8'))
  assert.deepEqual(after.projects['/x'].disabledMcpServers, [])
  assert.equal(after.keepMe, 42) // untouched fields survive the rewrite

  // Case 2: nothing disabled → file left byte-for-byte identical (no rewrite).
  const clean = JSON.stringify({ projects: { '/x': { disabledMcpServers: ['other'] } } })
  await fs.writeFile(path, clean)
  await ensureNotDisabled(['unmute-computer', 'computer'], home)
  assert.equal(await fs.readFile(path, 'utf-8'), clean)
})

test('steer block markers still round-trip after the rename', () => {
  const md = 'top\n\n<!-- UNMUTE-COMPUTER-USE:BEGIN -->\nuse unmute-computer\n<!-- UNMUTE-COMPUTER-USE:END -->\n'
  assert.equal(removeBlock(md).trim(), 'top')
})
