import { randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises'
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

type KeyTempFile = Pick<FileHandle, 'writeFile' | 'sync' | 'close'>

export interface KeyProviderFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>
  readFile(path: string): Promise<Buffer>
  open(path: string, flags: 'wx', mode: number): Promise<KeyTempFile>
  link(existingPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface SafeStorageKeyProviderOptions {
  root: string
  protectedValueStore: ProtectedValueStore
  randomBytes?: (size: number) => Buffer
  fileSystem?: KeyProviderFileSystem
}

const nodeFileSystem: KeyProviderFileSystem = {
  async mkdir(path, options) { await mkdir(path, options) },
  readFile: (path) => readFile(path),
  open: (path, flags, mode) => open(path, flags, mode),
  async link(existingPath, newPath) { await link(existingPath, newPath) },
  async unlink(path) { await unlink(path) },
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
  private readonly fileSystem: KeyProviderFileSystem

  constructor(options: SafeStorageKeyProviderOptions) {
    this.root = options.root
    this.protectedValueStore = options.protectedValueStore
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
    this.fileSystem = options.fileSystem ?? nodeFileSystem
  }

  async getMasterKey(): Promise<Buffer> {
    if (!this.protectedValueStore.isEncryptionAvailable()) {
      throw new Error('Secure key protection is unavailable')
    }

    const keyPath = join(this.root, MASTER_KEY_FILE)
    try {
      return this.unprotect(await this.fileSystem.readFile(keyPath))
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }

    const runtimeDir = join(this.root, 'runtime')
    await this.fileSystem.mkdir(runtimeDir, { recursive: true, mode: 0o700 })

    const key = Buffer.from(this.randomBytes(MASTER_KEY_BYTES))
    if (key.byteLength !== MASTER_KEY_BYTES) {
      throw new Error('Memory master-key generator did not return 32 bytes')
    }
    const protectedBlob = this.protectedValueStore.encryptString(key.toString('base64'))
    if (!Buffer.isBuffer(protectedBlob) || protectedBlob.byteLength === 0) {
      throw new Error('Secure key protection returned an invalid blob')
    }

    const tempPath = join(runtimeDir, `.master-key.${process.pid}.${randomUUID()}.tmp`)
    let tempFile: KeyTempFile | null = null
    try {
      tempFile = await this.fileSystem.open(tempPath, 'wx', 0o600)
      await tempFile.writeFile(protectedBlob)
      await tempFile.sync()
      await tempFile.close()
      tempFile = null

      try {
        await this.fileSystem.link(tempPath, keyPath)
        return key
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
        key.fill(0)
        return this.unprotect(await this.fileSystem.readFile(keyPath))
      }
    } finally {
      if (tempFile) await tempFile.close()
      try {
        await this.fileSystem.unlink(tempPath)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
  }

  private unprotect(protectedBlob: Buffer): Buffer {
    return decodeMasterKey(this.protectedValueStore.decryptString(protectedBlob))
  }
}
