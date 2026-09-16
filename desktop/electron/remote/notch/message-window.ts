import type { Block } from '../blocks'
import { liftCanvases } from '../canvas'
/** Bound native decoding/rendering by human-visible messages, retaining intervening work. */
export function messageWindow(blocks: readonly Block[], limit = 10): { blocks: Block[]; olderMessages: number } {
  const starts: number[] = []
  // Match the native turn presentation: user prompts and final replies are
  // visible messages; intermediate Claude narration belongs to the work group.
  let finalReply: number | undefined
  const finish = () => { if (finalReply !== undefined) starts.push(finalReply); finalReply = undefined }
  blocks.forEach((block, i) => {
    if (block.kind === 'message' && block.role === 'user') { finish(); starts.push(i) }
    else if (block.kind === 'message' && block.role === 'assistant') finalReply = i
    else if (block.kind !== 'turnStart' && block.kind !== 'turnEnd' && block.kind !== 'sessionBoundary') finalReply = undefined
  })
  finish()
  const olderMessages = Math.max(0, starts.length - Math.max(1, limit))
  let from = olderMessages ? starts[olderMessages] : 0
  // A divider marking a fresh Agent session belongs to the page it opens.
  if (from > 0 && blocks[from - 1]?.kind === 'sessionBoundary') from -= 1
  const shown = blocks.slice(from)
  // DRAWINGS ARE LIFTED HERE, and the position is load-bearing twice over.
  //
  // AFTER the scan above, because that scan decides which blocks are visible
  // messages by walking the stream — and its rule is that anything which is
  // not a turn marker cancels a pending final reply. A canvas block inserted
  // before the walk would sit between the assistant's message and `turnEnd`,
  // cancel it, and quietly shift every window boundary. Lifting afterwards
  // leaves that logic looking at exactly the stream it has always seen.
  //
  // AND HERE RATHER THAN IN THE EXTRACTOR, because `blocksFromClaudeTranscript`
  // returns `pendingTools` as INDEXES into its own array; reordering blocks
  // underneath those would point in-flight tool rows at the wrong thing. This
  // is the surface's copy, so the stored transcript keeps the fence verbatim —
  // replay, copy-as-text and debugging all still see the source.
  return { blocks: liftCanvases(shown), olderMessages }
}
