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
    caption: 'Your dictation is sent securely for transcription and is not stored by Unmute. Your Claude Code and Codex interactions stay between you and those tools.',
    card: { kind: 'permission', title: 'Your privacy' },
  },
  microphone: {
    action: 'microphone', clipId: 'permission-microphone-v1', caption: 'Allow microphone access so Unmute can hear your dictation.',
    card: { kind: 'permission', title: 'Microphone' },
  },
  accessibility: {
    action: 'accessibility', clipId: 'permission-accessibility-v1', caption: 'Allow Accessibility so Unmute can deliver text into the app you are using.',
    card: { kind: 'permission', title: 'Accessibility' },
  },
  'input-monitoring': {
    action: 'input-monitoring', clipId: 'permission-input-monitoring-v1', caption: 'Allow Input Monitoring so your global Unmute shortcuts work everywhere.',
    card: { kind: 'permission', title: 'Input Monitoring' },
  },
  'system-audio': {
    action: 'system-audio', clipId: 'permission-system-audio-v1', caption: 'Allow system audio so Notetaker can hear the conversation you choose to record.',
    card: { kind: 'permission', title: 'System Audio' },
  },
  'provider-choice': {
    action: 'provider-choice', clipId: 'provider-readiness-v1', caption: 'Unmute uses the Claude Code or Codex CLI already configured on your Mac.',
    card: { kind: 'provider', title: 'Choose your agent' },
  },
  'notes-dictation': {
    action: 'notes-dictation', clipId: 'dictation-explain-v1', caption: 'Put your cursor in Apple Notes, hold Function, speak, then release to paste.',
    card: { kind: 'speak', phrase: 'My first Unmute dictation.' },
  },
  'notes-instruct': {
    action: 'notes-instruct', clipId: 'instruct-explain-v1', caption: 'Select your sentence and use Instruct to rewrite it.',
    card: { kind: 'speak', phrase: 'Make this sound more confident.' },
  },
  'clipboard-capture': {
    action: 'clipboard-capture', clipId: 'capture-clipboard-v1', caption: 'Copy something while dictating. Unmute will compose it with your words.',
    card: { kind: 'speak', phrase: 'Add this copied detail to my note.' },
  },
  'screenshot-capture': {
    action: 'screenshot-capture', clipId: 'capture-screenshot-v1', caption: 'Take a normal macOS screenshot while dictating, then let Unmute place both into Notes.',
    card: { kind: 'speak', phrase: 'Include this screenshot in my note.' },
  },
  'orchestrator-task': {
    action: 'orchestrator-task', clipId: 'orchestrator-explain-v1', caption: 'Press Right Option and ask Orchestrator to do a real, safely isolated task.',
    card: { kind: 'speak', phrase: 'Create hello-unmute.txt containing My first Unmute task.' },
  },
  'agent-task-link': {
    action: 'agent-task-link', clipId: 'agent-explain-v1', caption: 'The Unmute Agent remembers your work and can create or resume tasks. Ask it to create one, then open its task link.',
    card: { kind: 'speak', phrase: "Create a follow-up task to add today's date to hello-unmute.txt." },
  },
  'notetaker-save': {
    action: 'notetaker-save', clipId: 'notetaker-explain-v1', caption: 'Double-tap Left Control to start Notetaker, then save the recording from the real pill.',
    card: { kind: 'speak', phrase: 'This is my first Unmute note.' },
  },
  'product-orientation': {
    action: 'product-orientation', clipId: 'orientation-v1', caption: 'See today’s tasks, automatic workspaces, and saved Notetaker summaries in the Unmute app.',
    card: { kind: 'success', title: 'Your workspace is ready' },
  },
  'sign-in': {
    action: 'sign-in', clipId: 'sign-in-v1', caption: 'Sign in to keep using Unmute after this guided experience.',
    card: { kind: 'success', title: 'One last step' },
  },
  complete: {
    action: 'complete', clipId: 'complete-v1', caption: 'You are ready to use Unmute everywhere on your Mac.',
    card: { kind: 'success', title: 'Welcome to Unmute' },
  },
}

export function presenterSnapshot(action: ActionId): PresenterCommand {
  const chapter = CHAPTERS[action]
  return { type: 'snapshot', action, clipId: chapter.clipId, caption: chapter.caption, card: chapter.card }
}
