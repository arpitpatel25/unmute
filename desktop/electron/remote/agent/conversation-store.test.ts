import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryCrypto } from './memory/crypto'
import { AgentConversationStore } from './conversation-store'

test('encrypted conversation preserves full Unicode, detects missing/corrupt snapshots and prior publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-conversation-'))
  try {
    const crypto = new MemoryCrypto({ keyProvider: { getMasterKey: async () => Buffer.alloc(32, 7) } })
    const store = new AgentConversationStore({ root, crypto })
    const text = '秘密🙂'.repeat(12000)
    const snapshot = { generation: 1, chat: { runId: 'run', turns: [{ role: 'user' as const, text, at: 1 }] }, draft: { text: 'unsent', revision: 2 }, queued: [] }
    const id = await store.write(snapshot)
    assert.deepEqual(await store.read(id), snapshot)
    const envelope = JSON.parse((await crypto.decrypt(await readFile(join(root, `${id}.enc`)))).toString('utf8'))
    assert.equal(envelope.format, 'unmute-agent-conversation')
    assert.equal(envelope.version, 1)
    assert.deepEqual(envelope.snapshot, snapshot)
    await writeFile(join(root, 'unsupported.enc'), await crypto.encrypt(JSON.stringify({ ...envelope, version: 999 })))
    await assert.rejects(store.read('unsupported'))
    assert.equal((await readFile(join(root, `${id}.enc`))).includes(Buffer.from('秘密')), false)
    await assert.rejects(store.read('missing'))
    await assert.rejects(store.read('../outside'))
    const other = await store.write({ ...snapshot, generation: 2 })
    await writeFile(join(root, `${other}.enc`), 'broken')
    await assert.rejects(store.read(other))
    assert.deepEqual(await store.read(id), snapshot)
  } finally { await rm(root, { recursive: true, force: true }) }
})
