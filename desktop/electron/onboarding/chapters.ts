import type { ActionId, ChapterDefinition, OnboardingEvent, PresenterCommand } from './types'

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
  'agent-notes',
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
    action: 'welcome', clipId: 'welcome-product-v2',
    caption: 'Welcome to Unmute. Ideas happen while you browse, watch, or read. Unmute turns those thoughts into actions with a key press.',
    card: { kind: 'success', title: 'Meet Unmute', detail: 'Turn thoughts into actions from anywhere on your Mac.' },
  },
  privacy: {
    action: 'privacy', clipId: 'privacy-v2',
    caption: 'Before we begin, a quick note on privacy. Only dictation goes through Unmute for transcription, and we never store it. Claude Code and Codex activity does not pass through Unmute.',
    card: { kind: 'permission', title: 'Your privacy' },
  },
  microphone: {
    action: 'microphone', clipId: 'permission-microphone-v2', caption: 'First, allow microphone access. Unmute only listens when you deliberately activate dictation.',
    card: { kind: 'permission', title: 'Microphone' },
  },
  accessibility: {
    action: 'accessibility', clipId: 'permission-accessibility-v2', caption: 'Next, allow Accessibility. This lets Unmute recognize its shortcuts and place transcribed text wherever your cursor is.',
    card: { kind: 'permission', title: 'Accessibility' },
  },
  'function-key': {
    action: 'function-key', clipId: 'function-key-readiness-v2', caption: 'Before dictation, make sure macOS leaves the Function key available to Unmute. In Keyboard Settings, set “Press Globe key to” to “Do Nothing,” then come back and tap Function once so Unmute can verify it.',
    card: { kind: 'repair', title: 'Make Function available', detail: 'Set “Press 🌐 key to” to “Do Nothing,” then tap Function once.' },
  },
  'system-audio': {
    action: 'system-audio', clipId: 'permission-system-audio-v2', caption: 'Finally, allow System Audio. Unmute uses it only when you deliberately start Notetaker.',
    card: { kind: 'permission', title: 'System Audio' },
  },
  'provider-choice': {
    action: 'provider-choice', clipId: 'provider-readiness-v2', caption: 'Unmute runs agent tasks through your Claude Code or Codex plan. We’ll check what is already configured and offer setup if needed.',
    card: { kind: 'provider', title: 'Connect your agent', detail: 'Unmute needs at least one of these tools to run agent tasks.' },
  },
  'notes-dictation': {
    action: 'notes-dictation', clipId: 'dictation-explain-v2', caption: 'Let’s start with dictation. We’ve opened Apple Notes. Put your cursor in the note, tap Function once, say the phrase shown here, then tap Function again to submit.',
    card: { kind: 'speak', phrase: 'My first Unmute dictation.' },
  },
  'clipboard-capture': {
    action: 'clipboard-capture', clipId: 'capture-clipboard-v2', caption: 'You can also copy text while dictating. Tap Function once, say the phrase shown here, click the sample text and press Command+C, then return to Apple Notes and tap Function again to submit.',
    card: { kind: 'speak', title: 'Copy context while speaking', phrase: 'Add this copied detail to my note.', copyText: 'Unmute turns thoughts into actions.', detail: 'Click the sample text to select it, then press Command+C while dictation is active.' },
  },
  'screenshot-capture': {
    action: 'screenshot-capture', clipId: 'capture-screenshot-v2', caption: 'The same thing works with screenshots. Tap Function once, say the phrase shown here, capture a normal macOS screenshot, return to Apple Notes, then tap Function again to submit.',
    card: { kind: 'speak', phrase: 'Include this screenshot in my note.' },
  },
  'orchestrator-task': {
    action: 'orchestrator-task', clipId: 'orchestrator-explain-v2', caption: 'Turn a thought into a task from anywhere on your Mac. Tap Right Option, say the request shown here, then tap Right Option again. Your new Claude Code or Codex task appears in the notch.',
    card: { kind: 'speak', phrase: 'Create hello-unmute.txt containing My first Unmute task.' },
  },
  'agent-task-link': {
    action: 'agent-task-link', clipId: 'agent-explain-v2', caption: 'The Unmute Agent finds, creates, and resumes sessions for you. Double-tap Right Command, say the follow-up shown here, tap Right Command once to submit, then open the task link it gives you.',
    card: { kind: 'speak', phrase: "Create a follow-up task to add today's date to hello-unmute.txt." },
  },
  'notetaker-save': {
    action: 'notetaker-save', clipId: 'notetaker-explain-v2', caption: 'Unmute Notetaker uses the Claude Code or Codex models you already pay for. Double-tap Left Control to start a short recording, then save it from the pill. You can later ask the Unmute Agent about the note.',
    card: { kind: 'speak', title: 'Try Notetaker', phrase: 'This is my first Unmute note.', detail: 'Double-tap Left Control to start; save the recording from the pill when you finish.' },
  },
  'agent-notes': {
    action: 'agent-notes', clipId: '', caption: 'The Unmute Agent can find information in notes you captured with Notetaker. Once processing finishes, ask it about any note.',
    card: { kind: 'success', title: 'Ask about your notes', detail: 'Once a note is ready, the Unmute Agent can find details or summarize it for you.' },
  },
  'product-orientation': {
    action: 'product-orientation', clipId: 'orientation-v2', caption: 'You have now used every major part of Unmute. Whenever you want to write, edit, start a project, or create a PR, just unmute yourself.',
    card: { kind: 'success', title: 'Explore your work', detail: 'Your tasks and workspaces live in Unmute; your recordings and summaries live in Notetaker.' },
  },
  'sign-in': {
    action: 'sign-in', clipId: '', caption: 'Sign in to keep using Unmute after this guided session.',
    card: { kind: 'success', title: 'One last step' },
  },
  complete: {
    action: 'complete', clipId: 'complete-v1', caption: 'That’s it. You now know Unmute because you’ve actually used it. Welcome.',
    card: { kind: 'success', title: 'Welcome to Unmute' },
  },
}

export function presenterSnapshot(action: ActionId, gesture?: { started: boolean; stopped: boolean }, notetakerActive = false): PresenterCommand {
  const chapter = CHAPTERS[action]
  const phase = notetakerActive && action === 'notetaker-save'
    ? 'listening'
    : gesture?.stopped ? 'processing' : gesture?.started ? 'listening' : 'ready'
  const processingDetail = action === 'agent-task-link'
    ? 'Request sent to Unmute Agent. Your task is being processed. You can wait for it to finish or skip this section.'
    : action === 'orchestrator-task'
      ? 'Request sent to Unmute. Your task is being processed. You can wait for it to finish or skip this section.'
      : 'Your request is being processed.'
  const card = chapter.card?.kind === 'speak' && phase !== 'ready'
    ? { ...chapter.card, detail: phase === 'listening' ? 'Listening — perform the action, then tap the shortcut again to submit.' : processingDetail }
    : chapter.card
  const totalSteps = ACTION_ORDER.length - 1
  const step = action === 'complete' ? totalSteps : ACTION_ORDER.indexOf(action) + 1
  return { type: 'snapshot', action, clipId: chapter.clipId, caption: chapter.caption, card, step, totalSteps, phase }
}

export function skipEventFor(command: PresenterCommand): OnboardingEvent | null {
  return command.action === 'complete' ? null : { type: 'section-skipped', action: command.action }
}

export function escapeEventFor(command: PresenterCommand): OnboardingEvent | null {
  return command.phase === 'processing'
    && (command.action === 'orchestrator-task' || command.action === 'agent-task-link')
    ? { type: 'capability-satisfied', action: command.action }
    : null
}
