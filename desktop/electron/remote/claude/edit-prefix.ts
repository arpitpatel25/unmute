import { blocksFromClaudeTranscript } from '../blocks-claude'
import { ClaudeTaskChannel } from './task-channel'
type Frame = Record<string, any>
/** Locate the last human prompt, ignoring provider notifications and tool results. */
export function claudeEditPrefix(frames: Frame[], expected: string): { frames: Frame[]; resumeAt?: string } {
  for (let i = frames.length - 1; i >= 0; i--) {
    const messages = blocksFromClaudeTranscript(ClaudeTaskChannel.displayTranscript([frames[i]])).blocks
    const prompt = messages.find(b => b.kind === 'message' && b.role === 'user')
    if (!prompt || prompt.kind !== 'message') continue
    if (prompt.text !== expected) throw new Error('The latest message changed. Reopen it before editing.')
    if (messages.some(b => b.kind === 'attachment')) throw new Error('Editing attachment messages is not supported yet.')
    const prefix = frames.slice(0, i)
    const previous = [...prefix].reverse().find(f => f.type === 'assistant' && typeof f.uuid === 'string')
    if (prefix.some(f => f.type === 'assistant') && !previous) throw new Error('This history has no stable message checkpoint.')
    return { frames: prefix, resumeAt: previous?.uuid }
  }
  throw new Error('No user message is available to edit.')
}
