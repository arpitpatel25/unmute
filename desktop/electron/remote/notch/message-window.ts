import type { Block } from '../blocks'
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
    else if (block.kind !== 'turnStart' && block.kind !== 'turnEnd') finalReply = undefined
  })
  finish()
  const olderMessages = Math.max(0, starts.length - Math.max(1, limit))
  return { blocks: blocks.slice(olderMessages ? starts[olderMessages] : 0), olderMessages }
}
