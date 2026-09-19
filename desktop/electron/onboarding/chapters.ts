import type { ActionId, ChapterDefinition, PresenterCommand } from './types'

export const ACTION_ORDER: readonly ActionId[] = [
  'welcome',
  'privacy',
  'microphone',
  'accessibility',
  'function-key',
  'system-audio',
  'provider-choice',
  'notes-dictation',
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
  'welcome',
  'privacy',
  'microphone',
  'accessibility',
  'function-key',
  'system-audio',
] as const

export const CHAPTERS: Readonly<Record<ActionId, ChapterDefinition>> = {
  welcome: {
    action: 'welcome', clipId: 'welcome-product-v1',
    caption: 'Welcome to Unmute. Unmute lets you speak instead of type, turn requests into real work with Claude Code or Codex, and capture meeting notes without breaking your flow. In the next few minutes, you’ll use each part yourself.',
    card: { kind: 'success', title: 'Meet Unmute', detail: 'Dictate, delegate, and remember—without leaving what you are doing.' },
  },
  privacy: {
    action: 'privacy', clipId: 'privacy-v1',
    caption: 'Before we begin, here’s how your data moves. Dictation is sent securely for transcription and is not stored by Unmute. Your Claude Code and Codex work goes directly through the tools you already use; Unmute does not proxy or store those conversations.',
    card: { kind: 'permission', title: 'Your privacy' },
  },
  microphone: {
    action: 'microphone', clipId: 'permission-microphone-v1', caption: 'First, allow microphone access. Unmute only listens when you deliberately activate a recording feature.',
    card: { kind: 'permission', title: 'Microphone' },
  },
  accessibility: {
    action: 'accessibility', clipId: 'permission-accessibility-v1', caption: 'Next, allow Accessibility. This lets Unmute recognize its shortcuts and place finished text wherever your cursor is.',
    card: { kind: 'permission', title: 'Accessibility' },
  },
  'function-key': {
    action: 'function-key', clipId: 'function-key-readiness-v1', caption: 'Before dictation, make sure macOS leaves the Function key available to Unmute. In Keyboard Settings, set “Press Globe key to” to “Do Nothing,” then come back and tap Function once so Unmute can verify it.',
    card: { kind: 'repair', title: 'Make Function available', detail: 'Set “Press 🌐 key to” to “Do Nothing,” then tap Function once.' },
  },
  'system-audio': {
    action: 'system-audio', clipId: 'permission-system-audio-v1', caption: 'Finally, allow System Audio. Unmute uses it only when you deliberately start Notetaker.',
    card: { kind: 'permission', title: 'System Audio' },
  },
  'provider-choice': {
    action: 'provider-choice', clipId: 'provider-readiness-v1', caption: 'Unmute runs agent tasks through Claude Code or Codex on your Mac. We’ll check what is ready and help you set up either one if it is missing.',
    card: { kind: 'provider', title: 'Connect your agent', detail: 'Unmute needs at least one of these tools to run agent tasks.' },
  },
  'notes-dictation': {
    action: 'notes-dictation', clipId: 'dictation-explain-v1', caption: 'Let’s start with dictation. We’ve opened Apple Notes for you. Put your cursor in the note, tap Function once, say the sentence shown here, then tap Function again to submit.',
    card: { kind: 'speak', phrase: 'My first Unmute dictation.' },
  },
  'clipboard-capture': {
    action: 'clipboard-capture', clipId: 'capture-clipboard-v1', caption: 'You can also give Unmute context while you speak. Tap Function once, say the phrase shown here, copy the highlighted text, then tap Function again to submit. Unmute will combine both in the same result.',
    card: { kind: 'speak', phrase: 'Add this copied detail to my note.' },
  },
  'screenshot-capture': {
    action: 'screenshot-capture', clipId: 'capture-screenshot-v1', caption: 'The same thing works with screenshots. Tap Function once, say the phrase shown here, take a normal macOS screenshot, then tap Function again to submit.',
    card: { kind: 'speak', phrase: 'Include this screenshot in my note.' },
  },
  'orchestrator-task': {
    action: 'orchestrator-task', clipId: 'orchestrator-explain-v1', caption: 'Starting a new Claude Code or Codex session—or finding the right existing one—creates friction between having a thought and acting on it. Orchestrator removes that friction. If you’re reading a tweet, article, or document and a question comes to mind, select the useful context, tap Right Option, say your question, then tap Right Option again. Unmute creates or continues the task without making you manage terminals or sessions. Let’s try it now.',
    card: { kind: 'speak', phrase: 'Create hello-unmute.txt containing My first Unmute task.' },
  },
  'agent-task-link': {
    action: 'agent-task-link', clipId: 'agent-explain-v1', caption: 'The Unmute Agent helps you find, create, and continue work. It understands your Unmute tasks, sessions, and notes. Double-tap Right Command, say the follow-up shown here, tap Right Command once to submit, and then open the task link it gives you.',
    card: { kind: 'speak', phrase: "Create a follow-up task to add today's date to hello-unmute.txt." },
  },
  'notetaker-save': {
    action: 'notetaker-save', clipId: 'notetaker-explain-v1', caption: 'Unmute also includes Notetaker. It uses the strong models you already pay for through Claude Code or Codex to create useful notes you can interact with later. Double-tap Left Control, say the line shown here, and save the recording from the pill.',
    card: { kind: 'speak', phrase: 'This is my first Unmute note.' },
  },
  'product-orientation': {
    action: 'product-orientation', clipId: 'orientation-v1', caption: 'This is your Unmute home. Orchestrator shows today’s tasks and automatically groups related work into workspaces. Notetaker keeps your recordings, transcripts, and summaries here. And when your notes are ready, you can ask the Unmute Agent to find information in them.',
    card: { kind: 'success', title: 'Your workspace is ready' },
  },
  'sign-in': {
    action: 'sign-in', clipId: 'sign-in-v1', caption: 'You’ve now used every major part of Unmute. Sign in to keep using it after this guided session.',
    card: { kind: 'success', title: 'One last step' },
  },
  complete: {
    action: 'complete', clipId: 'complete-v1', caption: 'That’s it. You now know Unmute because you’ve actually used it. Welcome.',
    card: { kind: 'success', title: 'Welcome to Unmute' },
  },
}

export function presenterSnapshot(action: ActionId, gesture?: { started: boolean; stopped: boolean }): PresenterCommand {
  const chapter = CHAPTERS[action]
  const phase = gesture?.stopped ? 'processing' : gesture?.started ? 'listening' : 'ready'
  const card = chapter.card?.kind === 'speak' && phase !== 'ready'
    ? { ...chapter.card, detail: phase === 'listening' ? 'Listening — perform the action, then tap the shortcut again to submit.' : 'Processing…' }
    : chapter.card
  return { type: 'snapshot', action, clipId: chapter.clipId, caption: chapter.caption, card, phase }
}
