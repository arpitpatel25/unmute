// The explainer layer — one shell, seven pages.
//
// WHY THIS EXISTS. Before this, every explanation in the product was a
// parenthetical inside a control row: Capture and Scratchpad each carried a
// four-line paragraph next to their toggle, and everything else — the
// orchestrator, computer use, browser use — was explained nowhere at all. A
// settings row is the wrong place for a paragraph, so the paragraphs moved here
// and the rows kept one short line plus a "What this does" link.
//
// THE RULE FOR EVERY SENTENCE ON THESE PAGES: it must be checkable against the
// code. Each page carries a `SOURCES` comment naming the file and line that
// proves its claims. A sentence with no source was cut rather than softened —
// see ../../../../docs/superpowers/specs/launch/decisions/pack-b-settings-explainers.md
// for the two places where that rule bit, and what happened to them.
//
// NO WORKFLOWS PAGE. Decision D1: no workflows feature exists, so there is
// nothing to explain. AND NO PAGE MAY CLAIM THE APP GETS SMARTER BY WATCHING
// YOU. Decision D7: the curator and the librarian are switched off for launch,
// so any copy about the product accumulating knowledge of your work would be
// describing something that is not running.
//
// TYPE SCALE (D8): 22 / 16 / 14 / 13 / 12.5 / 11 / 10 and nothing between.
// Every size on every page comes from `Shell` (which draws the back link, the
// title and the standfirst), `Sec`, `P`, `Li`, `Lit` and `Note` below. The seven
// page files carry no `className` at all, so the scale is enforced in one file
// rather than seven.

import React from 'react'
import Dictation from './Dictation'
import Instruct from './Instruct'
import Capture from './Capture'
import Scratchpad from './Scratchpad'
import Orchestrator from './Orchestrator'
import ComputerUse from './ComputerUse'
import BrowserUse from './BrowserUse'

/* ─── The seven pages ─── */

export type HelpPageId =
  | 'dictation'
  | 'instruct'
  | 'capture'
  | 'scratchpad'
  | 'orchestrator'
  | 'computer-use'
  | 'browser-use'

/** The index Settings → Help & about renders. Order is teaching order: the two
 *  things every user touches, then the two that ride along with them, then the
 *  three that belong to the agent. */
export const HELP_PAGES: { id: HelpPageId; title: string; blurb: string }[] = [
  { id: 'dictation', title: 'Dictation', blurb: 'Speak, and the words arrive where your cursor is' },
  { id: 'instruct', title: 'Instruct', blurb: 'Select something and say what to do with it' },
  { id: 'capture', title: 'Capture', blurb: 'What you copy while the mic is on lands in the text' },
  { id: 'scratchpad', title: 'Scratchpad', blurb: 'Hold what you dictate instead of delivering it' },
  { id: 'orchestrator', title: 'Orchestrator', blurb: 'Speak a task and an agent does it on this Mac' },
  { id: 'computer-use', title: 'Computer use', blurb: 'Let an agent drive apps without moving your screen' },
  { id: 'browser-use', title: 'Browser use', blurb: 'Let an agent use the Chrome you are already signed in to' },
]

/** Render one page by id. Settings owns the `which page` state; this is the
 *  only place the id → component mapping lives, so adding a page is one entry
 *  in HELP_PAGES and one case here. */
export function HelpPage({ id, onBack }: { id: HelpPageId; onBack: () => void }) {
  switch (id) {
    case 'dictation': return <Dictation onBack={onBack} />
    case 'instruct': return <Instruct onBack={onBack} />
    case 'capture': return <Capture onBack={onBack} />
    case 'scratchpad': return <Scratchpad onBack={onBack} />
    case 'orchestrator': return <Orchestrator onBack={onBack} />
    case 'computer-use': return <ComputerUse onBack={onBack} />
    case 'browser-use': return <BrowserUse onBack={onBack} />
  }
}

/* ─── The shared shell ─── */

export interface HelpProps {
  onBack: () => void
}

export function Shell({ title, standfirst, onBack, children }: {
  title: string
  standfirst: string
  onBack: () => void
  children: React.ReactNode
}) {
  return (
    <div className="max-w-lg">
      <button
        onClick={onBack}
        className="text-[11px] font-semibold text-ink-35 hover:text-ink transition-colors mb-4 flex items-center gap-1"
      >
        ← Back to settings
      </button>
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-2">{title}</h2>
      <p className="text-[13px] text-ink-60 leading-relaxed mb-6">{standfirst}</p>
      {children}
    </div>
  )
}

/** A titled block. The card is the unit of reading on these pages — one idea
 *  per card, so a page can be skimmed by its headings alone. */
export function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-2 border border-border rounded-2xl px-5 py-4 mb-3 shadow-sm">
      <h3 className="text-[14px] font-semibold text-ink mb-2">{title}</h3>
      <div className="text-[12.5px] text-ink-60 leading-relaxed space-y-2">{children}</div>
    </div>
  )
}

export function P({ children }: { children: React.ReactNode }) {
  return <p>{children}</p>
}

/** A tight list. `<ul>` rather than paragraphs wherever the content really is a
 *  set of things (the five capture kinds, the two destinations). */
export function Li({ children }: { children: React.ReactNode }) {
  return (
    <ul className="list-disc pl-4 space-y-1 marker:text-ink-35">{children}</ul>
  )
}

/** Inline code / literal — a setting name, a key, a value from the code. */
export function Lit({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[11px] text-ink bg-cream-mid border border-border rounded px-1 py-[1px]">{children}</span>
}

/** The quiet line at the foot of a card: a caveat, or where to find the switch. */
export function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-ink-35 leading-relaxed">{children}</p>
}
