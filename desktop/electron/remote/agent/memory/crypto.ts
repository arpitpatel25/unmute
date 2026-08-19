import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto'

import type { MasterKeyProvider } from './key-provider.ts'

const ENVELOPE_MAGIC = Buffer.from('UMEM', 'ascii')
const ENVELOPE_VERSION = 1
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16
const HEADER_BYTES = ENVELOPE_MAGIC.byteLength + 1
const MINIMUM_ENVELOPE_BYTES = HEADER_BYTES + NONCE_BYTES + AUTH_TAG_BYTES

export interface MemoryCryptoPrimitives {
  randomBytes(size: number): Buffer
  createCipheriv(
    algorithm: 'aes-256-gcm',
    key: Buffer,
    nonce: Buffer,
    options: { authTagLength: number },
  ): CipherGCM
  createDecipheriv(
    algorithm: 'aes-256-gcm',
    key: Buffer,
    nonce: Buffer,
    options: { authTagLength: number },
  ): DecipherGCM
}

export interface MemoryCryptoOptions {
  keyProvider: MasterKeyProvider
  crypto?: MemoryCryptoPrimitives
}

const nodeCrypto: MemoryCryptoPrimitives = {
  randomBytes,
  createCipheriv,
  createDecipheriv,
}

function requireMasterKey(key: Buffer): Buffer {
  if (key.byteLength !== 32) throw new Error('Memory master key must be 32 bytes')
  return key
}

export class MemoryCrypto {
  private readonly keyProvider: MasterKeyProvider
  private readonly crypto: MemoryCryptoPrimitives

  constructor(options: MemoryCryptoOptions) {
    this.keyProvider = options.keyProvider
    this.crypto = options.crypto ?? nodeCrypto
  }

  async encrypt(plaintext: Uint8Array | string): Promise<Buffer> {
    const key = requireMasterKey(await this.keyProvider.getMasterKey())
    const nonce = Buffer.from(this.crypto.randomBytes(NONCE_BYTES))
    if (nonce.byteLength !== NONCE_BYTES) {
      throw new Error('Memory nonce generator did not return 12 bytes')
    }

    const header = Buffer.concat([ENVELOPE_MAGIC, Buffer.from([ENVELOPE_VERSION])])
    const authenticatedPrefix = Buffer.concat([header, nonce])
    const cipher = this.crypto.createCipheriv('aes-256-gcm', key, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    })
    cipher.setAAD(authenticatedPrefix)
    const ciphertext = Buffer.concat([
      cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()

    return Buffer.concat([authenticatedPrefix, ciphertext, tag])
  }

  async decrypt(envelope: Uint8Array): Promise<Buffer> {
    const bytes = Buffer.from(envelope)
    if (bytes.byteLength < MINIMUM_ENVELOPE_BYTES) {
      throw new Error('Memory ciphertext envelope is truncated')
    }
    if (!bytes.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)) {
      throw new Error('Memory ciphertext envelope has invalid magic')
    }
    if (bytes[ENVELOPE_MAGIC.byteLength] !== ENVELOPE_VERSION) {
      throw new Error('Memory ciphertext envelope version is unsupported')
    }

    const nonceEnd = HEADER_BYTES + NONCE_BYTES
    const tagStart = bytes.byteLength - AUTH_TAG_BYTES
    const authenticatedPrefix = bytes.subarray(0, nonceEnd)
    const nonce = bytes.subarray(HEADER_BYTES, nonceEnd)
    const ciphertext = bytes.subarray(nonceEnd, tagStart)
    const tag = bytes.subarray(tagStart)
    const key = requireMasterKey(await this.keyProvider.getMasterKey())
    const decipher = this.crypto.createDecipheriv('aes-256-gcm', key, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    })
    decipher.setAAD(authenticatedPrefix)
    decipher.setAuthTag(tag)

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch {
      throw new Error('Memory ciphertext authentication failed')
    }
  }
}
