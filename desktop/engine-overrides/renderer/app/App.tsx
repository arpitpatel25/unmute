import { useState, useEffect } from 'react'
import unmuteLogo from '../assets/unmute-logo.png'
import History from './History'
import Settings from './Settings'
import Account from './Account'
import Onboarding, { WhatsNew } from './Onboarding'
import { SETTINGS_SECTIONS, SegmentedControl } from './_shared'
import type { SettingsSection } from './_shared'
import { BalancePill } from '../paywall/BalancePill'
// ─── Unmute Remote ───
// The notch remains the single ATTENTION surface (spec 2026-07-24): top-center
// = status output, bottom-center = voice input. Nothing here interrupts you,
// and the notch is still where a running task announces itself.
//
// What changed: the Orchestrator tab now has a Tasks page (`TaskPanel`) as its
// default, because a destination described as "what your agents are doing" that
// opens on a settings pane is the wrong first frame. That is an on-demand list
// you navigate to, not a surface that pushes at you — the notch keeps that job.
import { OutOfCreditBanner } from '../paywall/OutOfCreditBanner'
import { AuthProvider, useAuth } from '../paywall/AuthContext'
import { SignInScreen } from '../paywall/SignInScreen'
// Remote settings live in the main window now that the floating overlay that
// used to host them was retired (ede9966).
import { RemoteSettings } from '../remote/RemoteSettings'
import { RemoteSetup } from '../remote/RemoteSetup'
import { RemoteSetupEntry } from '../remote/RemoteSetupEntry'
import { RemoteHowItWorks } from '../remote/RemoteHowItWorks'
import { TaskPanel } from '../remote/TaskPanel'
import { NotetakerTab } from '../notetaker/NotetakerTab'
import { AgentSettings } from '../remote/AgentSettings'
import AgentHelp from './help/Agent'

/**
 * Five destinations:
 *   history       what you said
 *   notetaker     the meetings you've recorded
 *   orchestrator  what your agents are doing
 *   account       who you are and what you pay
 *   settings      everything else
 *
 * Permissions, Language and Privacy are sections INSIDE settings now, not
 * top-level tabs. The Features tab is gone — its Dictate/Instruct content is
 * superseded by the explainer pages. Decision D2 puts the chaining tip it
 * uniquely carried (dictate, then immediately Caps Lock to reshape) on Pack B,
 * to place in the Instruct explainer. That is an obligation, not something
 * already done: on this branch no explainer page exists yet.
 */
type Tab = 'history' | 'notetaker' | 'agent' | 'orchestrator' | 'account' | 'settings'

/** Sub-pages of the Orchestrator tab. Setup is NOT one-time — a user may add a
 *  second agent months later, and Codex loses its connection whenever its app
 *  is reopened normally — so the way in is permanent, never gated on
 *  "complete". */
type OrchestratorPage = 'tasks' | 'how' | 'setup' | 'settings'
/** The Agent is its own destination: its settings and its explanation, nothing
 *  else. It lived inside Orchestrator → Settings, three levels down, which is
 *  the wrong place for the one part of Unmute you address directly. */
type AgentPage = 'settings' | 'how'

type AppView = 'loading' | 'onboarding' | 'whats-new' | 'main'

/* ─── The onboarding gate (decision D4) ───────────────────────────────
 *
 * The gate used to be `unmute_onboarding_complete` alone, an unversioned
 * boolean. Every existing user has it set, so any revamp of the flow would have
 * reached new installs only. Two keys now share the job:
 *
 *   unmute_onboarding_complete  'true' ⇔ this user has been through onboarding
 *                               at all. Unchanged meaning, unchanged name.
 *   unmute_onboarding_version   which flow they saw. Absent but complete='true'
 *                               ⇒ the old eight-step flow ⇒ version 1.
 *
 * Resolving to:
 *   not complete → the full nine-step flow (a new install, or a replay)
 *   version < 2  → a three-screen "what's new", then version 2 is written
 *   version >= 2 → straight into the app
 *
 * WHY THE LEGACY KEY IS STILL WRITTEN rather than migrated away. Settings →
 * Help's "Replay onboarding" — which this pack does not own — clears exactly
 * that key and reloads. If completion were recorded only in the new key, that
 * button would silently stop working the day this shipped: the version would
 * survive at 2 and the app would go straight back in. Keeping the legacy key as
 * the presence flag means the existing button keeps working untouched, and
 * `resetOnboarding()` below (which clears both) is the tidier equivalent for
 * Pack B to move to.
 */

/** Bump this when onboarding changes materially enough that existing users
 *  need to be told. Every bump needs a matching "what's new" for the step. */
export const ONBOARDING_VERSION = 2
export const ONBOARDING_VERSION_KEY = 'unmute_onboarding_version'
export const LEGACY_ONBOARDING_COMPLETE_KEY = 'unmute_onboarding_complete'

/** The version of onboarding this user has seen, or null if they have seen
 *  none. A completion flag with no version is the old flow, i.e. version 1. */
export function readOnboardingVersion(): number | null {
  try {
    if (localStorage.getItem(LEGACY_ONBOARDING_COMPLETE_KEY) !== 'true') return null
    const raw = localStorage.getItem(ONBOARDING_VERSION_KEY)
    if (raw !== null) {
      const parsed = Number.parseInt(raw, 10)
      if (Number.isFinite(parsed)) return parsed
    }
    return 1
  } catch {
    // localStorage unavailable — treat as current so we never trap a user in
    // an onboarding loop whose completion can never be recorded.
    return ONBOARDING_VERSION
  }
}

/** Clears both keys, so the user gets the full flow rather than the three-screen
 *  summary. Exported for Settings → Help & about's "Replay onboarding" to call.
 *  NOTHING CALLS IT YET: that button lives in `Settings.tsx`, which this pack
 *  does not own, and still inlines `removeItem('unmute_onboarding_complete')`.
 *  That inline version keeps working — see the note on the legacy key above —
 *  so this is the tidier replacement, not a fix for something broken. */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_VERSION_KEY)
    localStorage.removeItem(LEGACY_ONBOARDING_COMPLETE_KEY)
  } catch { /* ignore — nothing we can do, and nothing breaks */ }
}

function markOnboardingSeen(): void {
  try {
    localStorage.setItem(LEGACY_ONBOARDING_COMPLETE_KEY, 'true')
    localStorage.setItem(ONBOARDING_VERSION_KEY, String(ONBOARDING_VERSION))
  } catch { /* ignore */ }
}

/** The renderer types in this project do not declare `window.electronAPI`, so
 *  reaching for it directly is a type error on every line. Same runtime access,
 *  none of the noise — the idiom the `renderer/remote/` override files use.
 *  (Several `renderer/app/` files still reach for it directly and pay the
 *  error; migrating them is not this pack's to do.) */
type AppAPI = {
  getDictationKey?: () => Promise<string>
  paywallGetLanguageAutoDetect?: () => Promise<boolean>
  paywallGetLanguage?: () => Promise<string>
  onUpdateDownloaded?: (cb: (version: string) => void) => void
  restartToUpdate?: () => void
  /** The Unmute Agent's notetaker_open tool fired — main already showed and
   *  focused this window, so landing on the meeting is the only thing left. */
  notetakerOnOpenRequested?: (cb: (meetingId: string) => void) => () => void
}
function api(): AppAPI {
  return (window as unknown as { electronAPI?: AppAPI }).electronAPI ?? {}
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  )
}

function AppInner() {
  const [view, setView] = useState<AppView>('loading')
  const [activeTab, setActiveTab] = useState<Tab>('history')
  const [dictationKey, setDictationKey] = useState<'fn' | 'right-option'>('fn')
  const [pendingUpdate, setPendingUpdate] = useState<string | null>(null)
  // Language sub-item badge — "Auto" or the ISO code (uppercased). Re-read
  // whenever the sidebar is not sitting on the Language section, since the
  // Language component itself is the only writer. DORMANT on this branch alone:
  // `Language.tsx` moves inside Settings and Pack B mounts it, so until that
  // lands nothing can change the setting and the badge never moves after its
  // first read.
  const [languageBadge, setLanguageBadge] = useState<string>('Auto')
  const [orchestratorPage, setOrchestratorPage] = useState<OrchestratorPage>('tasks')
  // Which of the seven Settings sections the sidebar has selected. Pack B's
  // Settings renders one section at a time from this.
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('triggers')
  const [agentPage, setAgentPage] = useState<AgentPage>('settings')
  // Set by the Agent's notetaker_open tool (via main), consumed once by
  // NotetakerTab/MeetingsList to select that meeting, then cleared — see the
  // effect below and notetakerOnOpenRequested's own comment.
  const [pendingMeetingId, setPendingMeetingId] = useState<string | null>(null)

  async function refreshLanguageBadge() {
    try {
      const auto = await api().paywallGetLanguageAutoDetect?.()
      if (auto) { setLanguageBadge('Auto'); return }
      const code = await api().paywallGetLanguage?.()
      if (typeof code === 'string' && code) setLanguageBadge(code.toUpperCase())
    } catch { /* ignore — keep previous badge */ }
  }

  useEffect(() => {
    // Load dictation key setting (for the pro-tip hint)
    api().getDictationKey?.().then((key: string) => {
      if (key === 'fn' || key === 'right-option') setDictationKey(key)
    }).catch(() => {})

    // Onboarding gate — no sign-in in local BYO-key mode
    const seen = readOnboardingVersion()
    setView(
      seen === null ? 'onboarding'
        : seen < ONBOARDING_VERSION ? 'whats-new'
          : 'main',
    )

    // Listen for downloaded updates and surface a "Restart" banner.
    api().onUpdateDownloaded?.((version) => setPendingUpdate(version))

    // The Agent asked to open a meeting (notetaker_open). main has already
    // shown/focused the window; land on the Notetaker tab with it selected.
    const unsubscribeOpenRequested = api().notetakerOnOpenRequested?.((meetingId) => {
      setView('main')
      setActiveTab('notetaker')
      setPendingMeetingId(meetingId)
    })

    refreshLanguageBadge()
    return () => unsubscribeOpenRequested?.()
  }, [])

  // Re-read on any navigation that does not land on the Language section. One
  // or two IPC calls (the second only when auto-detect is off), which is cheap
  // enough to beat introducing a pub/sub channel just for this badge.
  useEffect(() => {
    const onLanguage = activeTab === 'settings' && settingsSection === 'language'
    if (!onLanguage) refreshLanguageBadge()
  }, [activeTab, settingsSection])

  function handleOnboardingComplete() {
    markOnboardingSeen()
    setView('main')
  }

  /** "Connect an agent" in onboarding, and the same from the what's-new
   *  summary: finish the flow and land on the setup page rather than dumping
   *  the user on History to find it themselves. */
  function handleOpenAgentSetup() {
    markOnboardingSeen()
    setActiveTab('orchestrator')
    setOrchestratorPage('setup')
    setView('main')
  }

  if (view === 'loading') {
    return (
      <div className="flex items-center justify-center h-screen bg-cream">
        <div className="titlebar-drag absolute top-0 left-0 right-0 h-8" />
        <div className="flex items-center gap-2">
          <div className="w-[5px] h-[5px] rounded-full bg-ink/30 animate-dot-bounce" />
          <div className="w-[5px] h-[5px] rounded-full bg-ink/30 animate-dot-bounce" style={{ animationDelay: '0.15s' }} />
          <div className="w-[5px] h-[5px] rounded-full bg-ink/30 animate-dot-bounce" style={{ animationDelay: '0.3s' }} />
        </div>
      </div>
    )
  }

  if (view === 'onboarding') {
    return (
      <>
        <Onboarding onComplete={handleOnboardingComplete} onOpenAgentSetup={handleOpenAgentSetup} />
        <SignInOverlay />
      </>
    )
  }

  if (view === 'whats-new') {
    return (
      <>
        <WhatsNew onComplete={handleOnboardingComplete} onOpenAgentSetup={handleOpenAgentSetup} />
        <SignInOverlay />
      </>
    )
  }

  return (
    <div className="flex h-screen bg-cream">
      {/* Titlebar drag region */}
      <div className="titlebar-drag absolute top-0 left-0 right-0 h-8 z-10" />

      {/* Paywall overlays */}
      <OutOfCreditBanner />
      <SignInOverlay />
      <div className="absolute top-2 right-3 z-30 flex items-center gap-2">
        <BalancePill />
        <ProfileButton />
      </div>

      {/* Update-ready banner */}
      {pendingUpdate && (
        <div className="absolute top-8 left-0 right-0 z-20 flex justify-center pointer-events-none">
          <div className="pointer-events-auto mt-2 flex items-center gap-3 px-4 py-2.5 rounded-full bg-ink text-white shadow-lg border border-black/30 animate-fade-up-in">
            <span className="text-[12.5px] font-medium">
              <span className="font-bold">unmute {pendingUpdate}</span> ready to install.
            </span>
            <button
              onClick={() => api().restartToUpdate?.()}
              className="text-[12.5px] font-semibold px-3 py-1 rounded-full bg-white text-ink hover:opacity-90 transition-opacity"
            >
              Restart now
            </button>
            <button
              onClick={() => setPendingUpdate(null)}
              className="text-[16px] leading-none text-white/60 hover:text-white px-1"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <nav className="w-[220px] min-w-[220px] border-r border-border pt-12 px-2 flex flex-col bg-cream-mid overflow-y-auto">
        {/* Brand — the wordmark PNG itself carries the distinguisher
            from OSS unmute (baked into the asset, not a CSS overlay), so
            this is back to a single image + tagline. */}
        <div className="px-3 mb-5 pb-5 border-b border-border flex flex-col items-center shrink-0">
          <div className="relative">
            <img src={unmuteLogo} alt="unmute" className="h-[54px] w-auto" />
          </div>
          <p className="text-[10px] text-ink-60 font-medium -mt-0.5">
            Typing sucks. Just unmute.
          </p>
        </div>

        {/* Nav items — five destinations, one glyph each. */}
        <div className="flex flex-col gap-0.5 px-1">
          <SidebarButton
            icon={<HistoryIcon />}
            label="Dictation"
            active={activeTab === 'history'}
            onClick={() => setActiveTab('history')}
          />
          <SidebarButton
            icon={<NotetakerIcon />}
            label="Notetaker"
            active={activeTab === 'notetaker'}
            onClick={() => setActiveTab('notetaker')}
          />
          <SidebarButton
            icon={<AgentNavIcon />}
            label="Agent"
            active={activeTab === 'agent'}
            onClick={() => setActiveTab('agent')}
          />
          <SidebarButton
            icon={<OrchestratorIcon />}
            label="Orchestrator"
            active={activeTab === 'orchestrator'}
            onClick={() => setActiveTab('orchestrator')}
          />
          <SidebarButton
            icon={<AccountIcon />}
            label="Account"
            active={activeTab === 'account'}
            onClick={() => setActiveTab('account')}
          />
          <SidebarButton
            icon={<SettingsIcon />}
            label="Settings"
            active={activeTab === 'settings'}
            onClick={() => setActiveTab('settings')}
          />

          {/* Settings sub-navigation — Triggers · Audio & behaviour ·
              Appearance & notch · Permissions · Language · Privacy · Help &
              about. The list itself is SETTINGS_SECTIONS in _shared.tsx, so
              Settings.tsx can import the section type without an import cycle
              back through this file. Settings is the only destination with
              sub-items IN THE SIDEBAR — Orchestrator also has four sub-pages,
              but they are a segmented control inside the content area, so the
              rail stays four rows deep. */}
          {activeTab === 'settings' && (
            <div className="flex flex-col gap-0.5 mt-0.5 mb-1 pl-[26px] border-l border-border ml-[15px]">
              {SETTINGS_SECTIONS.map((section) => (
                <SidebarSubButton
                  key={section.id}
                  label={section.label}
                  active={settingsSection === section.id}
                  onClick={() => setSettingsSection(section.id)}
                  trailing={section.id === 'language' ? (
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${settingsSection === 'language' ? 'bg-accent/10 text-accent' : 'bg-ink-07 text-ink-35'}`}
                    >
                      {languageBadge}
                    </span>
                  ) : undefined}
                />
              ))}
            </div>
          )}
        </div>

      </nav>

      {/* Content */}
      <main className="flex-1 pt-10 px-10 overflow-y-auto">
        <div className="max-w-2xl mx-auto pb-8">
          {activeTab === 'history' && <History />}
          {activeTab === 'notetaker' && (
            <NotetakerTab
              pendingMeetingId={pendingMeetingId}
              onConsumedPendingMeetingId={() => setPendingMeetingId(null)}
            />
          )}
          {activeTab === 'agent' && (
            <AgentTab page={agentPage} onPageChange={setAgentPage} />
          )}
          {activeTab === 'orchestrator' && (
            <OrchestratorTab page={orchestratorPage} onPageChange={setOrchestratorPage} />
          )}
          {activeTab === 'account' && <Account />}
          {activeTab === 'settings' && (
            // `section` is Pack A's half of the contract in the overview's
            // ownership table: this pack owns the navigation state, Pack B owns
            // what each section renders. Until Pack B widens SettingsProps this
            // prop is unknown to Settings.tsx — an expected, deliberate broken
            // link between the two packs, NOT something to fix by editing a file
            // this pack does not own.
            <Settings onDictationKeyChange={setDictationKey} section={settingsSection} />
          )}
        </div>
      </main>
    </div>
  )
}

/**
 * The Orchestrator tab and its four sub-pages. The components themselves belong
 * to Pack C; this is only the navigation between them.
 *
 * KNOWN SEAM FOR PACK C. `TaskPanel` carries its own `'tasks' | 'how' | 'setup'`
 * state and its own links into `RemoteHowItWorks` and `RemoteSetup` — it was
 * written as a standalone panel, and until this pack it was imported by nothing
 * at all. So there are briefly two navigations over the same three pages: enter
 * How-it-works from inside the Tasks page and the segment above still reads
 * "Tasks". Collapsing TaskPanel's internal pages into this control is Pack C's
 * to do; doing it here would mean editing a file this pack does not own.
 */
/** The Agent's own destination: what it is, and the switches that govern it. */
function AgentTab({ page, onPageChange }: {
  page: AgentPage
  onPageChange: (page: AgentPage) => void
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
        <h2 className="font-display text-[22px] font-bold text-ink tracking-tight">Agent</h2>
        <SegmentedControl
          options={[
            { value: 'settings', label: 'Settings' },
            { value: 'how', label: 'How it works' },
          ]}
          value={page}
          onChange={(value) => onPageChange(value as AgentPage)}
        />
      </div>

      {page === 'settings' && <AgentSettings />}
      {page === 'how' && <AgentHelp onBack={() => onPageChange('settings')} />}
    </>
  )
}

function OrchestratorTab({ page, onPageChange }: {
  page: OrchestratorPage
  onPageChange: (page: OrchestratorPage) => void
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
        <h2 className="font-display text-[22px] font-bold text-ink tracking-tight">Orchestrator</h2>
        <SegmentedControl
          options={[
            { value: 'tasks', label: 'Tasks' },
            { value: 'how', label: 'How it works' },
            { value: 'setup', label: 'Agents' },
            { value: 'settings', label: 'Settings' },
          ]}
          value={page}
          onChange={(value) => onPageChange(value as OrchestratorPage)}
        />
      </div>

      {page === 'tasks' && <TaskPanel />}
      {page === 'how' && (
        <RemoteHowItWorks
          onBack={() => onPageChange('tasks')}
          onOpenSetup={() => onPageChange('setup')}
        />
      )}
      {page === 'setup' && <RemoteSetup onBack={() => onPageChange('tasks')} />}
      {page === 'settings' && (
        <>
          <RemoteSetupEntry onOpen={() => onPageChange('setup')} />
          <RemoteSettings />
        </>
      )}
    </>
  )
}

/**
 * Renders the SignInScreen on top of everything when the user opens the modal
 * OR when an OAuth/exchange flow is mid-stream (so navigating away accidentally
 * doesn't drop the in-flight callback).
 */
function SignInOverlay() {
  const auth = useAuth()
  const visible = auth.showSignIn || auth.authState === 'opening' || auth.authState === 'waiting' || auth.authState === 'exchanging' || auth.authState === 'error'
  if (!visible) return null
  return <SignInScreen />
}

/**
 * Tiny avatar/initial chip in the title bar. Always present (so signed-out
 * users have a stable place to find sign-in), shows email initial when signed
 * in, opens a menu with sign-out + email on click.
 */
function ProfileButton() {
  const auth = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)

  if (!auth.signedIn) {
    return (
      <button
        onClick={() => auth.openSignIn()}
        className="titlebar-no-drag inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border border-border bg-white text-ink hover:bg-cream-mid transition-colors"
      >
        Sign in
      </button>
    )
  }

  const initial = (auth.user?.email ?? '?').charAt(0).toUpperCase()
  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((s) => !s)}
        className="titlebar-no-drag inline-flex items-center justify-center w-[26px] h-[26px] rounded-full bg-ink text-white text-[11px] font-bold hover:opacity-90 transition-opacity"
        aria-label="Account"
        title={auth.user?.email ?? 'Signed in'}
      >
        {initial}
      </button>
      {menuOpen && (
        <div
          className="absolute top-full right-0 mt-1.5 w-[200px] bg-white rounded-xl shadow-lg border border-border p-2 z-50"
          onMouseLeave={() => setMenuOpen(false)}
        >
          {auth.user?.email && (
            <div className="px-2 py-1.5">
              <p className="text-[10px] text-ink-35 font-bold uppercase tracking-wider mb-0.5">Signed in</p>
              <p className="text-[12.5px] font-semibold text-ink truncate">{auth.user.email}</p>
            </div>
          )}
          <div className="h-px bg-border my-1.5" />
          <button
            onClick={() => { setMenuOpen(false); auth.signOut() }}
            className="w-full text-left px-2 py-1.5 rounded-lg text-[12.5px] text-ink hover:bg-cream-mid transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

function SidebarButton({
  icon,
  label,
  active,
  onClick,
  trailing,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  trailing?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`titlebar-no-drag w-full flex items-center gap-2.5 text-left px-3 py-2.5 rounded-[10px] text-[13px] font-medium transition-all duration-150 select-none ${
        active
          ? 'bg-surface-2 text-ink shadow-sm'
          : 'text-ink-60 hover:bg-ink-07 hover:text-ink'
      }`}
    >
      <span className={`transition-colors ${active ? 'text-ink' : 'text-ink-35'}`}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}

/** A section inside Settings. Deliberately unglyphed: seven more icons in a
 *  220px rail would collide with the one-icon-per-concept rule (D8) long before
 *  they helped anyone scan the list. */
function SidebarSubButton({
  label,
  active,
  onClick,
  trailing,
}: {
  label: string
  active: boolean
  onClick: () => void
  trailing?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`titlebar-no-drag w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded-lg text-[12.5px] transition-all duration-150 select-none ${
        active
          ? 'bg-ink-07 text-ink font-semibold'
          : 'text-ink-60 font-medium hover:bg-ink-07 hover:text-ink'
      }`}
    >
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}

function HistoryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <polyline points="8,5 8,8 10,10" />
    </svg>
  )
}

/** Notetaker — a document glyph (two ruled lines), distinct from History's
 *  clock. Same size/stroke conventions as every other sidebar glyph. */
function NotetakerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="2" width="10" height="12" rx="1.5" />
      <line x1="5.5" y1="6" x2="10.5" y2="6" />
      <line x1="5.5" y1="9" x2="10.5" y2="9" />
    </svg>
  )
}

/** Orchestrator — the cockpit: many panes, many agents, one surface. */
/** The Agent's glyph: the same head the Settings section has always used, at
 *  sidebar weight. Deliberately not another grid — Orchestrator owns that. */
function AgentNavIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.75v1.75M3.5 6.5A2.5 2.5 0 0 1 6 4h4a2.5 2.5 0 0 1 2.5 2.5v4A2.5 2.5 0 0 1 10 13H6a2.5 2.5 0 0 1-2.5-2.5z" />
      <path d="M6 8h.01M10 8h.01M6.5 10.5h3" />
    </svg>
  )
}

function OrchestratorIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.75" y="2.25" width="5.25" height="5" rx="1.25" />
      <rect x="9" y="2.25" width="5.25" height="5" rx="1.25" />
      <rect x="1.75" y="8.75" width="5.25" height="5" rx="1.25" />
      <rect x="9" y="8.75" width="5.25" height="5" rx="1.25" />
    </svg>
  )
}

/** Settings — an actual gear. The old icon was a circle with eight straight
 *  spokes, which reads as a sun or a loading spinner, not a setting. */
function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function AccountIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M2.5 14a5.5 5.5 0 0 1 11 0" />
    </svg>
  )
}
