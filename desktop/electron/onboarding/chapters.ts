import type { ActionId, ChapterDefinition, PresenterCommand } from './types'

export const ACTION_ORDER: readonly ActionId[] = [
  'privacy',
  'microphone',
  'accessibility',
  'input-monitoring',
  'system-audio',
  'provider-choice',
  'notes-dictation',
  'notes-instruct',
  'clipboard-capture',
  'screenshot-capture',
  'orchestrator-task',
  'agent-task-link',
  'notetaker-save',
  'product-orientation',
  'sign-in',
  'complete',
] as const

export const PERMISSION_ACTIONS: readonly ActionId[] = [
  'privacy',
  'microphone',
  'accessibility',
  'input-monitoring',
  'system-audio',
] as const

export const CHAPTERS: Readonly<Record<ActionId, ChapterDefinition>> = {
  privacy: {
    action: 'privacy', clipId: 'welcome-privacy-v1',
    caption: 'Welcome to Unmute. Your dictation is sent securely for transcription, and we do not store it. Your Claude Code and Codex work goes directly through the tools you already use, not through Unmute.',
    card: { kind: 'permission', title: 'Your privacy' },
  },
  microphone: {
    action: 'microphone', clipId: 'permission-microphone-v1', caption: 'First, allow microphone access. Unmute only listens when you deliberately activate a recording feature.',
    card: { kind: 'permission', title: 'Microphone' },
  },
  accessibility: {
    action: 'accessibility', clipId: 'permission-accessibility-v1', caption: 'Next, allow Accessibility. This lets Unmute place the finished text wherever your cursor is.',
    card: { kind: 'permission', title: 'Accessibility' },
  },
  'input-monitoring': {
    action: 'input-monitoring', clipId: 'permission-input-monitoring-v1', caption: 'Allow Input Monitoring so Unmute’s keyboard shortcuts work from any application.',
    card: { kind: 'permission', title: 'Input Monitoring' },
  },
  'system-audio': {
    action: 'system-audio', clipId: 'permission-system-audio-v1', caption: 'Finally, allow System Audio. Unmute uses it only when you deliberately start Notetaker.',
    card: { kind: 'permission', title: 'System Audio' },
  },
  'provider-choice': {
    action: 'provider-choice', clipId: 'provider-readiness-v1', caption: 'Unmute runs agent tasks through Claude Code or Codex on your Mac. We will check what is ready and help you set up either one if it is missing.',
    card: { kind: 'provider', title: 'Connect your agent', detail: 'Unmute needs at least one of these tools to run agent tasks.' },
  },
  'notes-dictation': {
    action: 'notes-dictation', clipId: 'dictation-explain-v1', caption: 'We opened Apple Notes for you. Put your cursor in the note, hold Function, say the sentence shown here, and release.',
    card: { kind: 'speak', phrase: 'My first Unmute dictation.' },
  },
  'notes-instruct': {
    action: 'notes-instruct', clipId: 'instruct-explain-v1', caption: 'Now select that sentence, press Caps Lock, and say the instruction shown here. Unmute will replace the selected text.',
    card: { kind: 'speak', phrase: 'Make this sound more confident.' },
  },
  'clipboard-capture': {
    action: 'clipboard-capture', clipId: 'capture-clipboard-v1', caption: 'Unmute can combine your voice with captured context. Hold Function, begin speaking, copy the highlighted text, and then release.',
    card: { kind: 'speak', phrase: 'Add this copied detail to my note.' },
  },
  'screenshot-capture': {
    action: 'screenshot-capture', clipId: 'capture-screenshot-v1', caption: 'It works with screenshots too. Hold Function, begin speaking, take a normal macOS screenshot, and then release.',
    card: { kind: 'speak', phrase: 'Include this screenshot in my note.' },
  },
  'orchestrator-task': {
    action: 'orchestrator-task', clipId: 'orchestrator-explain-v1', caption: 'Orchestrator turns a spoken request into a real task for Claude Code or Codex. Press Right Option and say the request shown here.',
    card: { kind: 'speak', phrase: 'Create hello-unmute.txt containing My first Unmute task.' },
  },
  'agent-task-link': {
    action: 'agent-task-link', clipId: 'agent-explain-v1', caption: 'The Unmute Agent remembers your work and can create or resume tasks. Double-tap Right Command, say this follow-up, and open the task link it gives you.',
    card: { kind: 'speak', phrase: "Create a follow-up task to add today's date to hello-unmute.txt." },
  },
  'notetaker-save': {
    action: 'notetaker-save', clipId: 'notetaker-explain-v1', caption: 'Notetaker uses the models you already pay for. Double-tap Left Control, say the line shown here, and save the recording from the real pill.',
    card: { kind: 'speak', phrase: 'This is my first Unmute note.' },
  },
  'product-orientation': {
    action: 'product-orientation', clipId: 'orientation-v1', caption: 'This is your Unmute home: today’s tasks, automatic workspaces, and your Notetaker recordings and summaries.',
    card: { kind: 'success', title: 'Your workspace is ready' },
  },
  'sign-in': {
    action: 'sign-in', clipId: 'sign-in-v1', caption: 'You have now used every major part of Unmute. Sign in to keep using it after this guided session.',
    card: { kind: 'success', title: 'One last step' },
  },
  complete: {
    action: 'complete', clipId: 'complete-v1', caption: 'That’s it. You now know Unmute because you have actually used it. Welcome.',
    card: { kind: 'success', title: 'Welcome to Unmute' },
  },
}

export function presenterSnapshot(action: ActionId): PresenterCommand {
  const chapter = CHAPTERS[action]
  return { type: 'snapshot', action, clipId: chapter.clipId, caption: chapter.caption, card: chapter.card }
}
