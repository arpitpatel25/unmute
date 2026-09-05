import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export function ownedImageExtension(validatedMimeType: string, _displayName: string): string {
  if (validatedMimeType === 'image/jpeg') return 'jpg'
  const extension = validatedMimeType.startsWith('image/') ? validatedMimeType.slice('image/'.length) : ''
  if (!['png', 'gif', 'webp'].includes(extension)) throw new Error('Use PNG, JPEG, GIF, or WebP images')
  return extension
}

export async function prepareChatImage(data: Buffer, claimedMimeType: string, name: string): Promise<{mimeType: string; extension: string; name: string}> {
  const mimeType = await validateChatImage(data, claimedMimeType)
  return { mimeType, extension: ownedImageExtension(mimeType, name), name }
}

/** Decode off the Electron UI thread. nativeImage only decodes PNG/JPEG;
 * macOS ImageIO (via sips) also handles the advertised GIF/WebP formats.
 * Decode the exact captured bytes, never a mutable original file path. */
export async function validateChatImage(data: Buffer, mimeType: string): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) throw new Error('Use PNG, JPEG, GIF, or WebP images')
  const directory = await mkdtemp(join(tmpdir(), 'unmute-image-validation-'))
  const source = join(directory, 'source')
  const decoded = join(directory, 'decoded.png')
  try {
    await writeFile(source, data, { mode: 0o600, flag: 'wx' })
    const identified = await run('/usr/bin/sips', ['-g', 'format', source], { timeout: 15_000, maxBuffer: 16_384 })
    const format = identified.stdout.match(/format:\s*(\S+)/i)?.[1]?.toLowerCase()
    const detected = format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : format ? `image/${format}` : ''
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(detected)) throw new Error('unsupported decoded image')
    await run('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', decoded], { timeout: 15_000, maxBuffer: 16_384 })
    return detected
  } catch {
    throw new Error('This image is corrupt or cannot be decoded. Choose another image.')
  } finally {
    // Only these two files in our newly allocated private directory are disposable.
    await unlink(source).catch(() => {})
    await unlink(decoded).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
}
