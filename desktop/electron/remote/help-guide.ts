export type DictationKey = 'fn' | 'right-option'
export type ActivationMode = 'tap-toggle' | 'push-to-talk' | 'double-tap-push'
export type HelpSectionId = 'dictation' | 'sessions' | 'notetaker' | 'notch'

export interface HelpGuideEntry {
  id: string
  title: string
  summary: string
  shortcut?: string
  steps?: string[]
  example?: string
  keywords: string[]
  source: string
}

export interface HelpGuideSection {
  id: HelpSectionId
  title: string
  intro: string
  entries: HelpGuideEntry[]
}

export interface HelpGuide {
  title: string
  intro: string
  settings: {
    dictationKey: string
    sessionKey: string
    activationMode: ActivationMode
  }
  sections: HelpGuideSection[]
}

export type HelpGuideSearchResult = HelpGuideEntry & { section: HelpSectionId }
export interface CompactHelpGuide {
  title: string
  sections: Array<{
    id: HelpSectionId
    title: string
    intro: string
    entries: Array<Pick<HelpGuideEntry, 'id' | 'title' | 'summary' | 'shortcut' | 'steps' | 'example'>>
  }>
}

function keyLabel(key: DictationKey): string {
  return key === 'fn' ? 'Fn' : 'Right Option'
}

function dictationGesture(key: string, mode: ActivationMode): string {
  if (mode === 'push-to-talk') return `Hold ${key} while you talk. Let go to finish.`
  if (mode === 'double-tap-push') return `Double-tap ${key} for hands-free, or hold it while you talk.`
  return `Tap ${key} to start. Tap it again to finish.`
}

export function resolveHelpGuide(input: {
  dictationKey: DictationKey
  activationMode: ActivationMode
}): HelpGuide {
  const dictationKey = keyLabel(input.dictationKey)
  const sessionKey = keyLabel(input.dictationKey === 'fn' ? 'right-option' : 'fn')

  return {
    title: 'How to use Unmute',
    intro: 'Talk instead of type. Use Dictation for the app in front of you, a session for ongoing work, and the Unmute Agent when you want help managing that work.',
    settings: { dictationKey, sessionKey, activationMode: input.activationMode },
    sections: [
      {
        id: 'dictation',
        title: 'Dictation',
        intro: 'Put the words you say into the app under your cursor.',
        entries: [
          {
            id: 'dictation-talk',
            title: 'Talk where your cursor is',
            summary: 'Unmute turns your voice into text in the app you are using.',
            shortcut: dictationGesture(dictationKey, input.activationMode),
            example: 'Click a message box, start Dictation, then say “Can we meet tomorrow morning?”',
            keywords: ['dictation', 'voice', 'type', 'cursor', 'microphone', dictationKey],
            source: 'desktop/engine-overrides/electron/keyboard.ts',
          },
          {
            id: 'dictation-context',
            title: 'Show it what you mean',
            summary: 'While the mic is on, copied text, links, file paths, images, and screenshots become context at that point in what you say.',
            shortcut: 'Use Command-Shift-3 for the full screen or Command-Shift-4 for a region while Dictation is listening.',
            example: 'Say “Explain this error,” copy the error, and keep talking.',
            keywords: ['capture', 'copy', 'copied text', 'clipboard', 'screenshot', 'image', 'link', 'path', 'context'],
            source: 'desktop/engine-overrides/renderer/app/help/Capture.tsx',
          },
          {
            id: 'dictation-scratchpad',
            title: 'Build something in Scratchpad',
            summary: 'Scratchpad holds several bits of dictation and captured material until you are ready to send them together.',
            example: 'Collect notes from two pages, add what you want done, then send the whole request to a session.',
            keywords: ['scratchpad', 'hold', 'collect', 'draft', 'several', 'send later'],
            source: 'desktop/electron/remote/notch/notch-client.ts',
          },
        ],
      },
      {
        id: 'sessions',
        title: 'Sessions and the Unmute Agent',
        intro: 'A session does the work. The Unmute Agent helps you find and manage sessions.',
        entries: [
          {
            id: 'session-direct',
            title: 'Talk straight to a session',
            summary: 'Use this for one clear task when you already know what you want the session to do.',
            shortcut: `Tap ${sessionKey} to start. Tap it again to send.`,
            example: '“Open the checkout code and fix the failing test.”',
            keywords: ['session', 'direct', 'create', 'talk', 'send', sessionKey],
            source: 'desktop/engine-overrides/electron/keyboard.ts',
          },
          {
            id: 'agent-manager',
            title: 'Ask the session manager',
            summary: 'The Unmute Agent can find, compare, resume, create, and route work across sessions. It knows about your sessions, Notetaker notes, and remembered information.',
            shortcut: 'Double-tap Right Command to start. Tap Right Command once to send.',
            example: '“Which session was fixing checkout? Resume it and tell it about today’s meeting notes.”',
            keywords: ['unmute agent', 'session manager', 'right command', 'find', 'compare', 'resume', 'create', 'route', 'multiple sessions', 'confused', 'meeting notes', 'memory'],
            source: 'desktop/engine-overrides/electron/keyboard.ts',
          },
          {
            id: 'session-pocket',
            title: 'Open your session pocket',
            summary: 'The pocket is the quick way to glance at your active sessions and open one.',
            shortcut: 'Hold Right Command first, then tap Right Option. Repeat the same chord to expand the selected session.',
            steps: ['Use Left or Right Arrow to move between sessions.', 'Press Return or Enter to expand the selected session.', 'Press Escape to shrink or close the current surface.'],
            example: 'Open the pocket, move to the checkout session, then repeat the chord to open it.',
            keywords: ['pocket', 'sessions', 'right command', 'right option', 'arrow', 'return', 'enter', 'escape', 'expand', 'shrink'],
            source: 'desktop/electron/remote/notch/notch-controller.ts',
          },
        ],
      },
      {
        id: 'notetaker',
        title: 'Notetaker',
        intro: 'Record a meeting and keep its transcript, notes, and visual references together.',
        entries: [
          {
            id: 'notetaker-record',
            title: 'Start meeting notes',
            summary: 'Notetaker listens to the meeting and prepares a transcript and notes you can return to later.',
            shortcut: 'Double-tap Left Control to start. Double-tap it again to stop.',
            example: 'Start Notetaker before the call, then ask the Unmute Agent what decisions were made.',
            keywords: ['notetaker', 'meeting', 'record', 'transcript', 'notes', 'left control', 'start', 'stop'],
            source: 'desktop/engine-overrides/electron/keyboard.ts',
          },
          {
            id: 'notetaker-screenshot',
            title: 'Save a meeting reference',
            summary: 'While Notetaker is running, save what is on screen beside the meeting notes.',
            shortcut: 'Double-tap Left Command for the full screen, or hold Left Command for about 600 ms to choose a region.',
            example: 'Capture the roadmap slide so it stays with the transcript.',
            keywords: ['notetaker', 'meeting', 'screenshot', 'reference', 'left command', 'full screen', 'region'],
            source: 'desktop/engine-overrides/electron/keyboard.ts',
          },
        ],
      },
      {
        id: 'notch',
        title: 'Inside the notch',
        intro: 'The notch keeps sessions close without making you leave the app you are in.',
        entries: [
          {
            id: 'notch-navigation',
            title: 'Move around',
            summary: 'Use Left and Right Arrow to move between sessions when you are not typing in a text field.',
            shortcut: 'Escape closes the nearest open layer first, then shrinks the surface.',
            example: 'If a command menu is open, Escape closes that before it closes the session.',
            keywords: ['notch', 'navigation', 'arrow', 'escape', 'close', 'shrink', 'surface'],
            source: 'desktop/native-notch/Sources/unmute-notch/AppController.swift',
          },
        ],
      },
    ],
  }
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

export function searchHelpGuide(guide: HelpGuide, query: string): HelpGuideSearchResult[] {
  const needle = query.trim().toLowerCase()
  const queryWords = new Set(words(needle))
  const scored = guide.sections.flatMap((section) => section.entries.map((entry) => {
    const keywordText = entry.keywords.join(' ').toLowerCase()
    const searchable = [entry.title, entry.summary, entry.shortcut, entry.example, ...entry.steps ?? [], keywordText].filter(Boolean).join(' ').toLowerCase()
    let score = searchable.includes(needle) ? 20 : 0
    for (const word of queryWords) {
      if (keywordText.includes(word)) score += 4
      else if (searchable.includes(word)) score += 1
    }
    return { ...entry, section: section.id, score }
  }))
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ score: _score, ...entry }) => entry)
}

export function compactHelpGuide(guide: HelpGuide): CompactHelpGuide {
  return {
    title: guide.title,
    sections: guide.sections.map((section) => ({
      id: section.id,
      title: section.title,
      intro: section.intro,
      entries: section.entries.map(({ keywords: _keywords, source: _source, ...entry }) => entry),
    })),
  }
}
