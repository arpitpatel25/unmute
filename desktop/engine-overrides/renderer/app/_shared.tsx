// Shared UI primitives + formatters. Extracted from the old single-page
// Settings.tsx during the UI restructure; now used by the app shell and
// onboarding as well as by Settings, Account and the Permissions section.
// Pure presentation only — no IPC, no state.
//
// TYPE SCALE (decision D8). The scale is 22 / 16 / 14 / 13 / 12.5 / 11 / 10 px
// and nothing between. THIS FILE now conforms — the odd 9px and 12px sizes that
// used to live here were folded into 10px and 12.5px — as do App.tsx and
// Onboarding.tsx. The rest of the app does not yet: Settings.tsx still has 8,
// 9, 12 and 18, and Account/Language/Permissions/Privacy still have 12. Those
// belong to other packs.
//
// ICONS. One glyph per concept. `BehaviorIcon` used to be a clock, which is
// also what the sidebar's History row draws — two concepts, one glyph. It is
// now a set of sliders. Three more sections are still borrowing it: Help
// (Settings.tsx), and Profile and Engine (Account.tsx). Glyphs for all three
// are defined below and are NOT yet wired up — Pack A owns neither call site,
// so Pack B rewires Help and whoever is given Account.tsx rewires the other
// two. Until then `BehaviorIcon` still appears four times.

import React from 'react'

/* ─── Settings sections ───
 *
 * The seven sections of Settings. Pack A's sidebar renders these as sub-items
 * and hands the active one to `Settings` as a prop; Pack B renders one section
 * at a time. Declared here rather than in App.tsx so Settings.tsx can import
 * the type without an import cycle back through App.
 */

export type SettingsSection =
  | 'triggers'
  | 'audio'
  | 'appearance'
  | 'permissions'
  | 'language'
  | 'privacy'
  | 'help'

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'triggers', label: 'Triggers' },
  { id: 'audio', label: 'Audio & behaviour' },
  { id: 'appearance', label: 'Appearance & notch' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'language', label: 'Language' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'help', label: 'Help & about' },
]

/* ─── Section header ─── */

export function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="ui-section-header flex items-center">
      <span className="text-ink-35">{icon}</span>
      <h3 className="text-[10px] font-bold text-ink-35 uppercase tracking-[0.11em]">{title}</h3>
    </div>
  )
}

/* ─── Toggle ─── */

export function Toggle({ checked, onChange, disabled = false, title }: {
  checked: boolean
  onChange: (val: boolean) => void
  /** Locked — the setting isn't the user's to change (e.g. plan-gated).
   *  Rendered dimmed and inert rather than hidden, so the capability is
   *  discoverable and the upgrade path is obvious. */
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      onClick={() => { if (!disabled) onChange(!checked) }}
      disabled={disabled}
      title={title}
      aria-disabled={disabled}
      role="switch"
      aria-checked={checked}
      aria-label={title}
      className={`w-[38px] h-[22px] rounded-full transition-all duration-200 relative shrink-0 ${
        checked ? 'bg-ink' : 'bg-cream-dark'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <div
        className={`w-[18px] h-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.18)] absolute top-[2px] transition-transform duration-200 ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}

/* ─── Segmented control (light) ─── */

export function SegmentedControl({ options, value, onChange }: {
  options: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="ui-segments bg-cream-mid border border-border">
      {options.map((opt) => (
        <button
          key={opt.value}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 rounded-md text-[12.5px] font-medium transition-all duration-120 ${
            value === opt.value
              ? 'bg-ink text-white shadow-sm'
              : 'text-ink-60 hover:text-ink'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/* ─── Segmented control (dark — used inside the dark Keyboard-Shortcuts hero) ─── */

export function SegmentedControlDark({ options, value, onChange }: {
  options: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="ui-segments bg-white/[0.06] border border-white/[0.08]">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all duration-120 ${
            value === opt.value
              ? 'bg-white/[0.14] text-white shadow-sm'
              : 'text-white/36 hover:text-white/60'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/* ─── HeroKey — chunky keycap label ─── */

export function HeroKey({ children, variant }: { children: React.ReactNode; variant?: 'red' }) {
  if (variant === 'red') {
    return (
      <span className="inline-flex items-center justify-center text-[12.5px] font-extrabold text-white rounded-[9px] px-3 py-1.5 min-h-[36px] min-w-[44px] select-none whitespace-nowrap bg-gradient-to-b from-[#F04040] to-[#C02020] border border-black/40 shadow-[0_4px_0_#7a1010,0_6px_14px_rgba(200,30,30,0.35),inset_0_1px_0_rgba(255,255,255,0.22)]">
        {children}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center justify-center text-[12.5px] font-extrabold text-white/90 rounded-[9px] px-3 py-1.5 min-h-[36px] min-w-[44px] select-none whitespace-nowrap bg-gradient-to-b from-white/[0.14] to-white/[0.06] border border-white/16 shadow-[0_4px_0_rgba(0,0,0,0.45),0_6px_14px_rgba(0,0,0,0.30),inset_0_1px_0_rgba(255,255,255,0.18)]">
      {children}
    </span>
  )
}

/* ─── MiniWave — animated audio bars decoration ─── */

export function MiniWave() {
  const bars = [
    { d: '0.55s', h: '6px' },
    { d: '0.70s', h: '14px', delay: '0.1s' },
    { d: '0.60s', h: '10px', delay: '0.05s' },
    { d: '0.80s', h: '18px', delay: '0.15s' },
    { d: '0.65s', h: '8px', delay: '0.08s' },
    { d: '0.75s', h: '16px', delay: '0.12s' },
  ]
  return (
    <div className="flex items-center gap-[3px] h-[18px] opacity-30">
      {bars.map((bar, i) => (
        <div
          key={i}
          className="w-[3px] rounded-sm bg-white"
          style={{
            animation: `wv ${bar.d} ease-in-out infinite alternate`,
            animationDelay: bar.delay || '0s',
            height: '4px',
          }}
        />
      ))}
      <style>{`@keyframes wv { from { height: 4px; } to { height: var(--h, 14px); } }`}</style>
    </div>
  )
}

/* ─── SettingRow — generic label/description + right-aligned control ─── */

export function SettingRow({ label, description, children }: {
  label: string
  description: string
  children: React.ReactNode
}) {
  return (
    // THE TEXT KEEPS ITS COLUMN. Without `min-w-0 flex-1` on the copy and
    // `flex-none` on the control, a wide control wins the whole row and squeezes
    // the description down to its longest WORD — the description then renders
    // one word per line, as a tall thin ribbon. Seen the moment a third swatch
    // was added to Surface tone; the row had simply never been asked to hold
    // anything wide before.
    <div className="ui-setting-row flex items-center justify-between border-b border-border last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        <p className="text-[11px] text-ink-35 mt-0.5">{description}</p>
      </div>
      <div className="flex-none">{children}</div>
    </div>
  )
}

/* ─── UsageDetail — small stat card ─── */

export function UsageDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-cream-mid border border-border rounded-[12px] px-3.5 py-2.5 flex items-center justify-between">
      <span className="text-[11px] font-medium text-ink-60">{label}</span>
      <span className="text-[13px] font-bold text-ink tabular-nums tracking-tight">{value}</span>
    </div>
  )
}

/* ─── PermissionRow — status pill + grant/open-settings actions ─── */

export function PermissionRow({
  title, description, granted, statusText, primary, secondary, divider,
}: {
  title: string
  description: string
  granted: boolean
  statusText: string
  primary: { label: string; onClick: () => void } | null
  secondary: { label: string; onClick: () => void } | null
  divider?: boolean
}) {
  return (
    <div className={`px-5 py-4 flex items-start gap-3 ${divider ? 'border-t border-border' : ''}`}>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${granted ? 'bg-success-soft text-success' : 'bg-ink-07 text-ink-35'}`}>
        {granted ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] font-semibold text-ink">{title}</p>
          <span className={`text-[10px] font-bold uppercase tracking-wider ${granted ? 'text-success' : 'text-ink-35'}`}>{statusText}</span>
        </div>
        <p className="text-[12.5px] text-ink-60 leading-relaxed mt-1.5">{description}</p>
        {(primary || secondary) && (
          <div className="flex items-center gap-2 mt-3">
            {primary && (
              <button onClick={primary.onClick} className="px-3 py-1.5 rounded-full bg-ink text-white text-[11px] font-semibold hover:opacity-90 transition-opacity">
                {primary.label}
              </button>
            )}
            {secondary && (
              <button onClick={secondary.onClick} className="px-3 py-1.5 rounded-full border border-border text-[11px] font-semibold text-ink-60 hover:bg-cream-mid hover:border-border-md transition-all">
                {secondary.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Formatters ─── */

/** Format an estimated USD amount; tiny sub-cent totals show as "<$0.01". */
export function fmtUsd(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n <= 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return '$' + n.toFixed(2)
}

/** Compact count: 1234 → "1.2K", 1_200_000 → "1.2M". Undefined → "—". */
export function fmtCount(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

/** Audio seconds → "Xs" / "X.X min" / "Xh Ym". Undefined → "—". */
export function fmtDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '—'
  if (seconds < 60) return Math.round(seconds) + 's'
  if (seconds < 3600) return (seconds / 60).toFixed(1).replace(/\.0$/, '') + ' min'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

/* ─── Icons ─── */

export function MicIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2a2.5 2.5 0 0 1 0 5M5.5 2a5 5 0 0 0 0 5M8 7v6M5 13h6" />
    </svg>
  )
}

export function KeyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5.5" cy="5.5" r="3" />
      <path d="M7.6 7.6l5 5M11 11l1.5-1.5M13 13l1-1" />
    </svg>
  )
}

export function ShieldIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 14.5s5.5-2.5 5.5-7V3.5L8 1.5 2.5 3.5V7.5c0 4.5 5.5 7 5.5 7z" />
      <polyline points="5.5 8 7 9.5 10.5 6" />
    </svg>
  )
}

export function UsageIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1v14M11 4H6.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H5" />
    </svg>
  )
}

/** Behaviour — sliders. Was a clock, which is the History glyph; one concept
 *  per icon (D8), so the clock stays with history and behaviour gets knobs. */
export function BehaviorIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.5h8M13 4.5h1M2 11.5h1M6 11.5h8" />
      <circle cx="11.5" cy="4.5" r="1.75" />
      <circle cx="4.5" cy="11.5" r="1.75" />
    </svg>
  )
}

/** Help & about — the question mark. */
export function HelpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6.1a1.9 1.9 0 0 1 3.7.6c0 1.3-1.9 1.6-1.9 2.8" />
      <path d="M8 11.9h.01" />
    </svg>
  )
}

/** Profile — an ID card. Deliberately NOT a person figure: that glyph is the
 *  sidebar's Account row, which is the destination; this is a section header
 *  inside it, and one glyph per concept (D8) means they cannot share. */
export function ProfileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <circle cx="6" cy="7" r="1.75" />
      <path d="M3.25 11.6a3 3 0 0 1 5.5 0M10.5 6.5h2.25M10.5 9h2.25" />
    </svg>
  )
}

/** Engine — the transcription backend. A chip, not a gear (gear is Settings). */
export function EngineIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.75" y="4.75" width="6.5" height="6.5" rx="1.25" />
      <path d="M6.5 2v2.75M9.5 2v2.75M6.5 11.25V14M9.5 11.25V14M2 6.5h2.75M2 9.5h2.75M11.25 6.5H14M11.25 9.5H14" />
    </svg>
  )
}

export function AppearanceIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="5" />
      <path d="M8 3V1M8 15v-2M3 8H1M15 8h-2" />
    </svg>
  )
}
