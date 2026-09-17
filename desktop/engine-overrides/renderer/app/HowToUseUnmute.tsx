export type GuideSectionId = 'dictation' | 'sessions' | 'notetaker' | 'notch'

export interface GuideEntry {
  id: string
  title: string
  summary: string
  shortcut?: string
  steps?: string[]
  example?: string
  keywords: string[]
  source: string
}

export interface GuideSection {
  id: GuideSectionId
  title: string
  intro: string
  entries: GuideEntry[]
}

export interface GuideData {
  title: string
  intro: string
  settings: { dictationKey: string; sessionKey: string; activationMode: string }
  sections: GuideSection[]
}

const SECTION_ORDER: GuideSectionId[] = ['dictation', 'sessions', 'notetaker', 'notch']

export function makeGuideViewModel(guide: GuideData): GuideSection[] {
  return SECTION_ORDER.flatMap((id) => {
    const section = guide.sections.find((candidate) => candidate.id === id)
    return section ? [section] : []
  })
}

const KEY_LABELS: Record<string, string> = {
  'Command-Shift-3': '⌘ ⇧ 3',
  'Command-Shift-4': '⌘ ⇧ 4',
  'Right Command': 'Right Command',
  'Right Option': 'Right Option',
  'Left Command': 'Left Command',
  'Left Control': 'Left Control',
  'Left Arrow': '←',
  'Right Arrow': '→',
  'Return': 'Return',
  'Enter': 'Enter',
  'Escape': 'Esc',
  'Fn': 'Fn',
}

const KEY_PATTERN = /(Command-Shift-3|Command-Shift-4|Right Command|Right Option|Left Command|Left Control|Left Arrow|Right Arrow|Return|Enter|Escape|Fn)/g

function KeyText({ children }: { children: string }) {
  return children.split(KEY_PATTERN).map((part, index) => {
    const label = KEY_LABELS[part]
    if (!label) return <span key={`${part}-${index}`}>{part}</span>
    return (
      <kbd
        key={`${part}-${index}`}
        className="mx-0.5 inline-flex min-h-[22px] items-center justify-center whitespace-nowrap rounded-md border border-black/50 bg-gradient-to-b from-[#302D29] to-ink px-2 py-0.5 align-[1px] font-sans text-[10.5px] font-bold leading-none text-white/95 shadow-[0_2px_0_rgba(0,0,0,0.42),0_1px_3px_rgba(0,0,0,0.18)]"
      >
        {label}
      </kbd>
    )
  })
}

function EntryRow({ entry }: { entry: GuideEntry }) {
  return (
    <div className="grid grid-cols-[138px_minmax(0,1fr)] gap-[18px] border-t border-border py-3.5">
      <div>
        <h3 className="text-[12.5px] font-bold leading-snug text-ink">{entry.title}</h3>
        <p className="mt-1 text-[11.5px] leading-snug text-ink-60">{entry.summary}</p>
      </div>
      <div className="min-w-0">
        {entry.shortcut && (
          <p aria-label={entry.shortcut} className="m-0 text-[12.5px] leading-relaxed text-ink">
            <KeyText>{entry.shortcut}</KeyText>
          </p>
        )}
        {entry.steps && entry.steps.length > 0 && (
          <ul className="mt-2 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[11.5px] leading-relaxed text-ink-60">
            {entry.steps.map((step) => <li key={step}><KeyText>{step}</KeyText></li>)}
          </ul>
        )}
        {entry.example && (
          <p className={`${entry.shortcut || entry.steps?.length ? 'mt-1.5' : 'mt-0'} text-[11.5px] leading-relaxed text-ink-60`}>
            <span className="font-semibold text-ink-35">Try: </span>{entry.example}
          </p>
        )}
      </div>
    </div>
  )
}

export default function HowToUseUnmute({ guide, loading = false }: { guide: GuideData | null; loading?: boolean }) {
  if (loading || !guide) {
    return <div className="py-14 text-center text-[13px] text-ink-35">Loading your shortcuts…</div>
  }

  const sections = makeGuideViewModel(guide)
  return (
    <div className="max-w-2xl">
      <header className="border-b border-ink-12 pb-6">
        <h1 className="font-display text-[26px] font-bold tracking-tight text-ink">{guide.title}</h1>
        <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-ink-60">{guide.intro}</p>

        <div className="mt-[18px] grid grid-cols-3 overflow-hidden rounded-[12px] border border-border bg-white/50">
          <div className="border-r border-border px-3 py-3">
            <strong className="block text-[12.5px] leading-tight text-ink">Dictation</strong>
            <span className="mt-1 block text-[11.5px] leading-snug text-ink-60">Dictation writes where your cursor is.</span>
          </div>
          <div className="border-r border-border px-3 py-3">
            <strong className="block text-[12.5px] leading-tight text-ink">Session</strong>
            <span className="mt-1 block text-[11.5px] leading-snug text-ink-60">A session does one task with you.</span>
          </div>
          <div className="px-3 py-3">
            <strong className="block text-[12.5px] leading-tight text-ink">Unmute Agent</strong>
            <span className="mt-1 block text-[11.5px] leading-snug text-ink-60">The Agent finds and manages sessions.</span>
          </div>
        </div>
      </header>

      <nav aria-label="Guide sections" className="sticky top-0 z-10 -mx-1 flex gap-1 bg-cream/95 px-1 py-3 backdrop-blur-md">
        {sections.map((section) => (
          <a key={section.id} href={`#${section.id}`} className="rounded-full px-2.5 py-1 text-[11.5px] font-semibold text-ink-60 hover:bg-ink-07 hover:text-ink">
            {section.id === 'sessions' ? 'Sessions' : section.id === 'notch' ? 'Notch' : section.title}
          </a>
        ))}
      </nav>

      <div>
        {sections.map((section, index) => (
          <section id={section.id} key={section.id} className={`scroll-mt-12 pb-1 ${index === 0 ? 'pt-1' : 'mt-4 border-t border-ink-12 pt-5'}`}>
            <div className="grid grid-cols-[138px_minmax(0,1fr)] gap-[18px] pb-2">
              <h2 className="font-display text-[17px] font-bold leading-tight tracking-tight text-ink">
                {section.id === 'sessions' ? 'Sessions' : section.title}
              </h2>
              <p className="mt-px text-[12.5px] leading-relaxed text-ink-60">{section.intro}</p>
            </div>
            {section.entries.map((entry) => <EntryRow key={entry.id} entry={entry} />)}
          </section>
        ))}
      </div>

      <div className="mt-5 flex items-baseline gap-2 border-l-[3px] border-accent bg-accent/[0.055] px-4 py-3 text-[12.5px] leading-relaxed text-ink">
        <strong className="shrink-0">Still unsure?</strong>
        <span>Ask the Unmute Agent “How do I…?” It knows this guide and can help manage your sessions.</span>
      </div>
    </div>
  )
}
