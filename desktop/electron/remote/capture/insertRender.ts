// Turn a pad into the thing that actually gets delivered.
//
// Provenance lives in the BUFFER and is rendered away HERE, per destination —
// never discarded at capture time. The cursor wants clean text; a task benefits
// from knowing what was spoken versus what was pointed at, because pasted text
// is verbatim ground truth while dictated text has been through STT and may be
// wrong.
//
// A FENCE IS A BOUNDARY MARKER, NOT A CLAIM. It asserts only "this is verbatim,
// it starts here, it ends here" — the one thing we know for certain. We never
// label an insert ("the user copied:", "context:"), because that would assert
// meaning we have no way to know.

import type { Destination, Entry, Pad } from './types'
import { ordered } from './captureBuffer'

export interface RenderResult {
  text: string
  attachments: string[]
}

/** Wrap verbatim material so it cannot be mistaken for what was spoken.
 *
 *  NOT MARKDOWN. This text is pasted wherever the cursor is — Notes, a
 *  terminal, a chat box, a search field — and nothing there renders backticks.
 *  A fenced block came out as literal ``` characters in every one of them.
 *  A blank line and a pair of straight quotes are visible in all of them and
 *  syntax in none.
 *
 *  Straight quotes, not curly: the cleanup pipeline normalises curly quotes,
 *  and a marker that gets rewritten downstream is not a marker.
 *
 *  EVERY KIND IS MARKED, including a bare link or a single line. Those used to
 *  be merged into the sentence on the theory that they read as part of it —
 *  but the reader cannot then tell a URL that was SAID from one that was
 *  COPIED, which is the only distinction this exists to make. */
export function quoteFor(content: string): string {
  return `"${content.trim()}"`
}

export function render(pad: Pad, dest: Destination): RenderResult {
  const attachments: string[] = []
  // Each piece carries whether it must stand alone, so joining can decide
  // between a space and a blank line without re-inspecting kinds.
  const pieces: { text: string; block: boolean }[] = []

  for (const e of ordered(pad) as Entry[]) {
    if (e.type === 'segment') {
      const t = e.text.trim()
      if (t) pieces.push({ text: t, block: false })
      continue
    }
    if (e.kind === 'image') {
      // AN IMAGE IS ALWAYS DELIVERED — the destinations differ only in HOW.
      //
      // Paths never belong in the visible text. Every destination receives the
      // real file through its attachment channel; PTY delivery may render a
      // reference later, at the transport boundary where that is required.
      //
      // So the cursor gets the image out of the TEXT and into the attachment
      // list, and delivery hands the real bytes over through the pasteboard
      // (see clipboard.ts's injectOutput). Every destination sees the same
      // list, in the same order, from this one walk of the pad.
      attachments.push(e.content)
      continue
    }
    // Every insert stands alone, whatever its kind: a blank line above and
    // below, and quotes around it.
    pieces.push({ text: quoteFor(e.content), block: true })
  }

  // Track prevBlock explicitly. Do NOT look the previous piece up with
  // indexOf: two identical blocks are equal by value, so indexOf returns the
  // first one and the separator is computed against the wrong neighbour.
  let text = ''
  let prevBlock = false
  for (const p of pieces) {
    if (!text) { text = p.text; prevBlock = p.block; continue }
    text += (p.block || prevBlock ? '\n\n' : ' ') + p.text
    prevBlock = p.block
  }
  return { text, attachments }
}
