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

/** A fence long enough to survive whatever backtick runs are inside. */
export function fenceFor(content: string): string {
  let longest = 0
  for (const run of content.match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Kinds that read as part of the sentence. Everything else gets a boundary. */
const INLINE = new Set(['url', 'path', 'line'])

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
      // A plain text field cannot hold an image, so the cursor skips it
      // entirely rather than pasting a path the user did not ask for.
      if (dest === 'cursor') continue
      attachments.push(e.content)
      pieces.push({ text: `[image: ${e.content}]`, block: false })
      continue
    }
    if (INLINE.has(e.kind)) {
      pieces.push({ text: e.content.trim(), block: false })
      continue
    }
    const fence = fenceFor(e.content)
    pieces.push({ text: `${fence}\n${e.content}\n${fence}`, block: true })
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
