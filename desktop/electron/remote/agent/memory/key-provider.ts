import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { safeStorage as electronSafeStorage } from 'electron'

const MASTER_KEY_BYTES = 32
const MASTER_KEY_FILE = join('runtime', 'master-key.enc')

export type ProtectedValueStore = Pick<
  typeof electronSafeStorage,
  'isEncryptionAvailable' | 'encryptString' | 'decryptString'
>

export interface MasterKeyProvider {
  getMasterKey(): Promise<Buffer>
}

export interface SafeStorageKeyProviderOptions {
  root: string
  protectedValueStore: ProtectedValueStore
  randomBytes?: (size: number) => Buffer
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function decodeMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64')
  if (key.byteLength !== MASTER_KEY_BYTES || key.toString('base64') !== encoded) {
    throw new Error('Protected memory master key is invalid')
  }
  return key
}

export class SafeStorageKeyProvider implements MasterKeyProvider {
  private readonly root: string
  private readonly protectedValueStore: ProtectedValueStore
  private readonly randomBytes: (size: number) => Buffer

  constructor(options: SafeStorageKeyProviderOptions) {
    this.root = options.root
    this.protectedValueStore = options.protectedValueStore
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
  }

  async getMasterKey(): Promise<Buffer> {
    if (!this.protectedValueStore.isEncryptionAvailable()) {
      throw new Error('Secure key protection is unavailable')
    }

    const keyPath = join(this.root, MASTER_KEY_FILE)
    try {
      return this.unprotect(await readFile(keyPath))
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }

    await mkdir(join(this.root, 'runtime'), { recursive: true, mode: 0o700 })

    const key = Buffer.from(this.randomBytes(MASTER_KEY_BYTES))
    if (key.byteLength !== MASTER_KEY_BYTES) {
      throw new Error('Memory master-key generator did not return 32 bytes')
    }
    const protectedBlob = this.protectedValueStore.encryptString(key.toString('base64'))
    if (!Buffer.isBuffer(protectedBlob) || protectedBlob.byteLength === 0) {
      throw new Error('Secure key protection returned an invalid blob')
    }

    try {
      await writeFile(keyPath, protectedBlob, { flag: 'wx', mode: 0o600 })
      return key
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      key.fill(0)
      return this.unprotect(await readFile(keyPath))
    }
  }

  private unprotect(protectedBlob: Buffer): Buffer {
    return decodeMasterKey(this.protectedValueStore.decryptString(protectedBlob))
  }
}
