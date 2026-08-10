/**
 * WHICH BACKEND RAN THIS, AS A MARK RATHER THAN A SENTENCE.
 *
 * The renderer twin of native-notch/ProviderMark.swift, kept deliberately
 * identical in shape: same inputs, same terminal glyph rule, same fallback. The
 * two surfaces are different technologies showing the same fact, and when they
 * drift the user is the one who notices — a Codex task marked one way in the
 * notch and another on the wall.
 *
 * ICON ONLY. "Claude Code CLI" was four words of chrome on a row already
 * carrying a title, a directory, an age and a model. The name survives in the
 * tooltip and the accessibility label, which is where a name belongs once a
 * mark is doing the work.
 *
 * THE TERMINAL GLYPH IS A CAPABILITY. It follows `provider.hasTerminal`, so a
 * CLI backend added later gets it with no edit here and a desktop backend never
 * claims a terminal it does not have.
 */
import type { RemoteTask } from './taskFacts'
import { hasTerminal, providerLabel } from './taskFacts'
import { PROVIDER_LOGOS, opticalScale } from './providerLogos'

/** Which vendor's mark to draw. Two surfaces per vendor share one logo — Codex
 *  CLI and Codex desktop are the same product wearing different clothes, and
 *  the terminal glyph is what tells them apart. */
function vendorOf(t: RemoteTask): 'codex' | 'claude' {
  const a = t.provider?.id ?? t.agent
  return a === 'codex' || a === 'codex-desktop' ? 'codex' : 'claude'
}

/** ONE SIZE, EVERYWHERE — the Swift twin holds the same constant. Call sites
 *  that drift by a point make one mark read as a different asset rather than a
 *  smaller one. Override only with a reason (the panel's fact value is 15). */
export const MARK_SIZE = 13

export function ProviderMark({ task, size = MARK_SIZE }: { task: RemoteTask; size?: number }) {
  const vendor = vendorOf(task)
  const art = PROVIDER_LOGOS[vendor]
  const terminal = hasTerminal(task)
  const title = `${providerLabel(task)}${terminal ? ' · has a terminal' : ''}`

  return (
    <span
      title={title}
      aria-label={title}
      role="img"
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.31, flex: 'none' }}
    >
      {art ? (
        // SIZED BY ITS INK, NOT BY ITS FILE — `scale` is measured from the
        // logo's opaque bounds when it is embedded. Fitting both logos to one
        // box leaves the one with more internal padding looking smaller, and
        // the eye compares the marks rather than the boxes.
        <span style={{
          width: size, height: size, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', flex: 'none',
        }}>
          <img
            src={art.src}
            alt=""
            aria-hidden
            style={{ width: size * opticalScale(art.ink), height: size * opticalScale(art.ink), objectFit: 'contain' }}
          />
        </span>
      ) : (
        // NO ART YET ⇒ THE NAME, not a shape. A missing logo means we cannot
        // show the mark; it does not mean we cannot say which backend this is,
        // and the point of the change was to make that MORE legible.
        <span aria-hidden style={{ fontSize: size * 0.82, opacity: 0.65, whiteSpace: 'nowrap' }}>
          {vendor === 'codex' ? 'Codex' : 'Claude'}
        </span>
      )}
      {terminal && (
        <svg width={size * 0.8} height={size * 0.8} viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden style={{ opacity: 0.5, flex: 'none' }}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
          <path d="M4.5 6.5L7 8.75L4.5 11" />
          <path d="M8.5 11h3.5" />
        </svg>
      )}
    </span>
  )
}
