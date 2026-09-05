import { extname } from 'node:path'

/** Provider-authored links must not invoke arbitrary local application handlers.
 * Local file artifacts have a separate explicit path action. */
export function safeArtifactURL(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('Invalid artifact link') }
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new Error('Unsupported artifact link protocol')
  return value
}

/** Call with the resolved real path: a harmless-looking symlink must not launch
 * an executable. Unknown formats can always be found and opened explicitly by
 * the user in Finder. */
export function artifactPathAction(path: string): 'open' | 'reveal' {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.pdf', '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.log'].includes(extname(path).toLowerCase()) ? 'open' : 'reveal'
}
