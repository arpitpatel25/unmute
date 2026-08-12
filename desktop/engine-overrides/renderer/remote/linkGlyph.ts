// Unmute Orchestrator — what a link *is*, never who owns it.
//
// The dashboard twin of `native-notch/Sources/MarkdownSupport/LinkGlyph.swift`.
// Both surfaces show the same agent prose, so they classify links by the same
// policy: scheme and path shape, NEVER a table of brands.
//
// Codex desktop draws a YouTube play mark beside a youtube.com link. That icon
// is not in the markdown — Codex recognises the hostname. Copying that means
// maintaining a brand list, which is wrong for every site not in it and stale
// the day a logo changes, with nothing in the build to catch either. A site
// nobody has heard of gets the same correct treatment as YouTube.
//
// Deliberately no favicons: fetching one tells that host you are reading their
// link, and this surface shows an agent's output about private work.
//
// ONE DIFFERENCE FROM THE SWIFT TWIN, on purpose. The notch runs in a process
// that can `stat`, so it can tell a real directory from a file with no
// extension. The renderer is a browser context and cannot, so here a bare
// `/Users/x/sessions` reads as `file` where the notch says `folder`. Asking main
// over IPC for an icon is not worth a round-trip. The POLICY is shared; the
// precision differs by what each runtime can actually know.

export type LinkKind = 'web' | 'file' | 'folder' | 'image' | 'mail' | 'phone'

// Bounded and boring on purpose — unlike a brand list, the set of raster formats
// a markdown link points at does not change month to month.
const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tiff', 'tif', 'svg', 'avif',
])

/** The local filesystem path a destination refers to, or null if it is not one. */
export function localPath(raw: string): string | null {
  const s = raw.trim()
  if (/^file:\/\//i.test(s)) {
    const rest = s.slice('file://'.length)
    try { return decodeURIComponent(rest) } catch { return rest }
  }
  // `~/.codex/sessions` is written by agents constantly. We cannot expand it
  // here (no home dir in a renderer), but we can still recognise it as local.
  if (s.startsWith('/') || s === '~' || s.startsWith('~/')) return s
  return null
}

export function linkKind(destination: string): LinkKind {
  const raw = (destination || '').trim()
  if (!raw) return 'web'

  const lower = raw.toLowerCase()
  if (lower.startsWith('mailto:')) return 'mail'
  if (lower.startsWith('tel:') || lower.startsWith('sms:')) return 'phone'

  const path = localPath(raw)
  if (path !== null) {
    // A trailing slash is the author SAYING it is a directory, and it is true
    // regardless of what exists on this machine.
    if (path.endsWith('/')) return 'folder'
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    if (path.includes('.') && IMAGE_EXT.has(ext)) return 'image'
    return 'file'
  }

  return 'web'
}
