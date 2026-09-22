import type { CSSProperties } from 'react'

// One optical grid and stroke weight for navigation and controls. Brand marks
// remain their own assets; interface symbols all use this neutral line family.
const paths = {
  guide: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4 M12 17h.01',
  history: 'M12 7v5l3 2',
  notes: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M9 8h6 M9 12h6 M9 16h4',
  agent: 'M12 3v3 M9 3h6 M6 7h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z M8 12h.01 M16 12h.01 M9 16h6',
  dashboard: 'M4 4h6v6H4Z M14 4h6v6h-6Z M4 14h6v6H4Z M14 14h6v6h-6Z',
  account: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2 M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  settings: 'M4 7h9 M17 7h3 M4 17h3 M11 17h9 M13 4v6 M7 14v6',
  triggers: 'M4 6h16v12H4Z M7 9h.01 M11 9h.01 M15 9h.01 M7 12h.01 M11 12h.01 M15 12h.01 M8 15h8',
  audio: 'M9 5 5 9H2v6h3l4 4V5Z M13 8a6 6 0 0 1 0 8 M16 5a10 10 0 0 1 0 14',
  appearance: 'M4 4h16v13H4Z M8 21h8 M12 17v4',
  permissions: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z M8 12l3 3 5-6',
  language: 'M3 5h12 M9 3v2 M6 5c0 6 5 10 8 11 M12 5c0 6-5 10-9 12 M14 21l4-10 4 10 M16 17h4',
  privacy: 'M6 10h12v11H6Z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  help: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4 M12 17h.01',
  chevron: 'm9 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  close: 'm6 6 12 12 M18 6 6 18',
  back: 'm15 5-7 7 7 7',
  play: 'm8 4 12 8-12 8V4Z',
  pause: 'M8 5v14 M16 5v14',
  replay: 'M3 10a9 9 0 1 1 1 7 M3 4v6h6',
  file: 'M14 2H5v20h14V7l-5-5Z M14 2v6h5 M8 13h8 M8 17h6',
  link: 'm10 13 4-2 M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
} as const

export type UIIconName = keyof typeof paths

export function UIIcon({ name, size = 18, style }: { name: UIIconName; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flexShrink: 0, ...style }}>
      {(name === 'guide' || name === 'help' || name === 'history') && <circle cx="12" cy="12" r="9" />}
      <path d={paths[name]} />
    </svg>
  )
}
