import assert from 'node:assert/strict'
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MemoryCrypto } from './crypto.ts'
import {
  SafeStorageKeyProvider,
  type KeyProviderFileSystem,
  type ProtectedValueStore,
} from './key-provider.ts'

class FakeProtectedValueStore implements ProtectedValueStore {
  available = true
  decryptError: Error | null = null

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(value: string): Buffer {
    return Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5)
  }

  decryptString(value: Buffer): string {
    if (this.decryptError) throw this.decryptError
    return value.map((byte) => byte ^ 0xa5).toString('utf8')
  }
}

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'unmute-memory-crypto-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function keyProvider(
  root: string,
  protectedValueStore: FakeProtectedValueStore,
  randomBytes?: (size: number) => Buffer,
  fileSystem?: KeyProviderFileSystem,
): SafeStorageKeyProvider {
  return new SafeStorageKeyProvider({ root, protectedValueStore, randomBytes, fileSystem })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('creates one protected 32-byte master key with owner-only permissions', async (t) => {
  const root = await temporaryRoot(t)
  const protectedValueStore = new FakeProtectedValueStore()
  const expectedKey = Buffer.alloc(32, 0x3c)
  const provider = keyProvider(root, protectedValueStore, () => Buffer.from(expectedKey))

  const key = await provider.getMasterKey()
  const keyPath = join(root, 'runtime', 'master-key.enc')
  const protectedBlob = await readFile(keyPath)

  assert.deepEqual(key, expectedKey)
  assert.equal(key.byteLength, 32)
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600)
  assert.notDeepEqual(protectedBlob, expectedKey)
  assert.equal(protectedBlob.includes(expectedKey.toString('base64')), false)
})

test('recovers the existing master key instead of replacing it', async (t) => {
  const root = await temporaryRoot(t)
  const protectedValueStore = new FakeProtectedValueStore()
  const expectedKey = Buffer.alloc(32, 0x7a)

  await keyProvider(root, protectedValueStore, () => Buffer.from(expectedKey)).getMasterKey()
  const recovered = await keyProvider(root, protectedValueStore, () => {
    throw new Error('must not generate a replacement key')
  }).getMasterKey()

  assert.deepEqual(recovered, expectedKey)
})

test('publishes a concurrent first-use key only after its protected blob is complete', async (t) => {
  const root = await temporaryRoot(t)
  const protectedValueStore = new FakeProtectedValueStore()
  const firstKey = Buffer.alloc(32, 0x11)
  const winningKey = Buffer.alloc(32, 0x22)
  const firstPublishReached = deferred()
  const releaseFirstPublish = deferred()
  let linkCount = 0
  const fileSystem = {
    async mkdir(path, options) { await mkdir(path, options) },
    readFile: (path) => readFile(path),
    open: (path, flags, mode) => open(path, flags, mode),
    async link(existingPath, newPath) {
      linkCount += 1
      if (linkCount === 1) {
        firstPublishReached.resolve()
        await releaseFirstPublish.promise
      }
      await link(existingPath, newPath)
    },
    unlink: (path) => unlink(path),
  } satisfies KeyProviderFileSystem

  const firstResult = keyProvider(
    root,
    protectedValueStore,
    () => Buffer.from(firstKey),
    fileSystem,
  ).getMasterKey()
  const firstEvent = await Promise.race([
    firstPublishReached.promise.then(() => 'ready-to-publish' as const),
    firstResult.then(() => 'returned-before-staging' as const),
  ])

  assert.equal(firstEvent, 'ready-to-publish')

  const winnerResult = await keyProvider(
    root,
    protectedValueStore,
    () => Buffer.from(winningKey),
    fileSystem,
  ).getMasterKey()
  releaseFirstPublish.resolve()

  assert.deepEqual(winnerResult, winningKey)
  assert.deepEqual(await firstResult, winningKey)
  assert.deepEqual(await readdir(join(root, 'runtime')), ['master-key.enc'])
  assert.equal((await stat(join(root, 'runtime', 'master-key.enc'))).mode & 0o777, 0o600)
})

test('AES-256-GCM encryption round-trips binary payloads', async (t) => {
  const root = await temporaryRoot(t)
  const crypto = new MemoryCrypto({
    keyProvider: keyProvider(root, new FakeProtectedValueStore()),
  })
  const plaintext = Buffer.from('title: Caf\u00e9\n\nBinary byte: \u0000\u00ff', 'utf8')

  const envelope = await crypto.encrypt(plaintext)

  assert.deepEqual(await crypto.decrypt(envelope), plaintext)
})

test('reuses the key but gives identical plaintext a fresh nonce and ciphertext', async (t) => {
  const root = await temporaryRoot(t)
  const crypto = new MemoryCrypto({
    keyProvider: keyProvider(root, new FakeProtectedValueStore()),
  })
  const plaintext = Buffer.from('same memory payload')

  const first = await crypto.encrypt(plaintext)
  const second = await crypto.encrypt(plaintext)

  assert.notDeepEqual(first, second)
  assert.deepEqual(await crypto.decrypt(first), plaintext)
  assert.deepEqual(await crypto.decrypt(second), plaintext)
})

test('rejects tampering with the authenticated envelope', async (t) => {
  const root = await temporaryRoot(t)
  const crypto = new MemoryCrypto({
    keyProvider: keyProvider(root, new FakeProtectedValueStore()),
  })
  const envelope = await crypto.encrypt(Buffer.from('do not alter'))
  const tampered = Buffer.from(envelope)
  tampered[tampered.length - 1] ^= 0x01

  await assert.rejects(() => crypto.decrypt(tampered))
})

test('fails closed when OS-backed key protection is unavailable', async (t) => {
  const root = await temporaryRoot(t)
  const protectedValueStore = new FakeProtectedValueStore()
  protectedValueStore.available = false
  const provider = keyProvider(root, protectedValueStore)

  await assert.rejects(() => provider.getMasterKey(), /secure key protection is unavailable/i)
  await assert.rejects(
    () => new MemoryCrypto({ keyProvider: provider }).encrypt(Buffer.from('never plaintext')),
    /secure key protection is unavailable/i,
  )
  await assert.rejects(() => stat(join(root, 'runtime', 'master-key.enc')), { code: 'ENOENT' })
})

test('does not replace an unreadable protected key or persist record fragments', async (t) => {
  const root = await temporaryRoot(t)
  const protectedValueStore = new FakeProtectedValueStore()
  const provider = keyProvider(root, protectedValueStore)
  const crypto = new MemoryCrypto({ keyProvider: provider })
  const title = 'Quarterly Planning Compass'
  const content = 'rotate the cobalt launch key after review'
  const plaintext = Buffer.from(`${title}\n\n${content}`, 'utf8')
  const recordPath = join(root, 'records', 'record-1.md.enc')

  await mkdir(join(root, 'records'), { recursive: true })
  await writeFile(recordPath, await crypto.encrypt(plaintext))
  const encryptedFile = await readFile(recordPath)

  assert.equal(encryptedFile.includes(Buffer.from(title)), false)
  assert.equal(encryptedFile.includes(Buffer.from(content)), false)

  const protectedKeyPath = join(root, 'runtime', 'master-key.enc')
  const originalProtectedKey = await readFile(protectedKeyPath)
  protectedValueStore.decryptError = new Error('OS key store rejected the blob')

  await assert.rejects(() => provider.getMasterKey(), /OS key store rejected the blob/)
  assert.deepEqual(await readFile(protectedKeyPath), originalProtectedKey)
})
