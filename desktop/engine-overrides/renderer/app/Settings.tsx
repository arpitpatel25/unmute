// Settings — seven sections, one at a time.
//
// SHAPE. Pack A's sidebar owns which section is showing and hands it down as
// `section`; the seven ids and their labels are `SETTINGS_SECTIONS` in
// _shared.tsx, so the sidebar and this file cannot drift apart. Permissions,
// Language and Privacy used to be top-level tabs of their own — they are
// rendered here now, as sections, and their files no longer draw a page title
// or a width.
//
// WHAT MOVED AND WHAT DID NOT. Every IPC call and every settings key is
// preserved verbatim. This is a layout and copy change; no behaviour moved.
//
// WHY `window.electronAPI.x` IS STILL WRITTEN OUT LONGHAND IN THIS FILE.
// `window.electronAPI` is undeclared in the renderer's types, so each of those
// call sites is a type error — Permissions.tsx and Language.tsx were converted
// to a typed cast-window accessor to remove exactly this noise. This file was
// NOT, for the seventeen calls that already existed: VERIFY 50 proves nothing
// was dropped by diffing the set of `electronAPI.<name>` strings against the
// base commit, and routing them through an accessor would erase every name from
// that diff and turn a real guard into a rubber stamp. New calls added by this
// pack go through `api()` below, which the same check permits (additions are
// fine) and which costs no new errors.
//
// TYPE SCALE (D8): 22 / 16 / 14 / 13 / 12.5 / 11 / 10 and nothing between. The
// old 8, 9, 12 and 18px sizes in this file are gone.
//
// ICONS (D8): `BehaviorIcon` used to mark Behaviour AND Help here. It now marks
// exactly one thing, and Help has `HelpIcon`.
//
// LONG DESCRIPTIONS ARE LINKS NOW. Capture and Scratchpad each carried a
// four-line paragraph inside a control row. Each keeps one short line and a
// "What this does" link to its page under ./help.

import React, { useEffect, useRef, useState } from 'react'
import Permissions from './Permissions'
import Language from './Language'
import Privacy from './Privacy'
import { HELP_PAGES, HelpPage, type HelpPageId } from './help'
// Pack A owns the onboarding gate and exports the reset. Importing it here is a
// module cycle (App → Settings → App) that resolves under ESM because it is only
// ever CALLED from a click handler, never read at module-evaluation time.
// Clearing a key by hand instead would be wrong: `resetOnboarding` clears BOTH
// the version key and the legacy boolean, and clearing only one of them replays
// the three-screen what's-new instead of the full flow.
import { resetOnboarding } from './App'
import {
  SETTINGS_SECTIONS,
  SectionHeader,
  Toggle,
  SegmentedControl,
  SegmentedControlDark,
  HeroKey,
  MiniWave,
  SettingRow,
  MicIcon,
  KeyIcon,
  ShieldIcon,
  BehaviorIcon,
  AppearanceIcon,
  HelpIcon,
  EngineIcon,
  type SettingsSection,
} from './_shared'

interface AudioDevice {
  deviceId: string
  label: string
}

interface SettingsProps {
  onDictationKeyChange?: (key: 'fn' | 'right-option') => void
  /** Which of the seven sections the sidebar has selected. Optional so the
   *  component still renders standalone; defaults to the first section. */
  section?: SettingsSection
}

interface TriggerState { enabled: boolean; locked: boolean }

/** Typed accessor for the parts of the preload bridge this file reaches for
 *  through a cast. Cast off `window`, NOT off `window.electronAPI`: the property
 *  is undeclared in this project's renderer types, so `window.electronAPI as
 *  unknown as …` is itself an error at every site. */
interface SettingsApi {
  getSurfaceAppearance?: () => Promise<string>
  setSurfaceAppearance?: (v: string) => Promise<string>
  getIphoneMicEnabled?: () => Promise<boolean>
  setIphoneMicEnabled?: (v: boolean) => Promise<boolean>
  remoteGetScreenshotCapture?: () => Promise<boolean>
  remoteSetScreenshotCapture?: (v: boolean) => Promise<boolean>
  remoteGetScratchpadEnabled?: () => Promise<boolean>
  remoteSetScratchpadEnabled?: (on: boolean) => Promise<boolean>
  paywallGetDictationCleanup?: () => Promise<boolean>
  paywallSetDictationCleanup?: (v: boolean) => Promise<boolean>
  paywallGetRemoteTrigger?: () => Promise<TriggerState>
  paywallOnRemoteTriggerChanged?: (cb: (s: TriggerState) => void) => () => void
  paywallSetRemoteTriggerEnabled?: (v: boolean) => Promise<TriggerState>
  /** The orchestrator's settings snapshot (remote/init.ts:3485-3498). Two of its
   *  fields are read here: `overlayAutoPresent` and `librarianWriteEnabled`. */
  remoteGetSettings?: () => Promise<{
    overlayAutoPresent?: boolean
    notchAutoExpand?: boolean
    notchTerminalAutoExpand?: boolean
    voiceFeedback?: boolean
    surfaceFill?: number
    showInScreenCapture?: boolean
    librarianWriteEnabled?: boolean
    curatorEnabled?: boolean
  }>
  remoteSetOverlayAutoPresent?: (on: boolean) => Promise<boolean>
  remoteSetNotchAutoExpand?: (on: boolean) => Promise<boolean>
  remoteSetTerminalAutoExpand?: (on: boolean) => Promise<boolean>
  remoteSetVoiceFeedback?: (on: boolean) => Promise<boolean>
  remoteSetSurfaceFill?: (fill: number) => Promise<number>
  remoteSetShowInScreenCapture?: (on: boolean) => Promise<boolean>
  /** Handled in main (remote/init.ts:3444) but NOT exposed by the preload —
   *  an orphaned handler. Optional-chained, so calling it is a no-op until
   *  `electron/remote-preload.ts` carries it. See KILL_SWITCHES_WIRED. */
  remoteSetLibrarianWriteEnabled?: (on: boolean) => Promise<boolean>
  /** No setting, no handler, no gate — the curator has no off switch at all.
   *  Named here so the row is one line from working. See KILL_SWITCHES_WIRED. */
  remoteSetCuratorEnabled?: (on: boolean) => Promise<boolean>
  paywallOpenExternal?: (url: string) => Promise<boolean>
  paywallCheckForUpdates?: () => Promise<
    | { status: 'available'; version: string }
    | { status: 'downloaded'; version: string }
    | { status: 'current'; version?: string }
    | { status: 'unsupported'; message: string }
    | { status: 'error'; message: string }
  >
  paywallOnUpdateStatus?: (cb: (s: UpdateStatus) => void) => () => void
  paywallInstallUpdate?: () => Promise<boolean>
}

/** Mirror of `UpdateStatus` in electron/paywall-glue.ts — the live phases the
 *  main process pushes while an update is being found and fetched. */
type UpdateStatus =
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'current'; version?: string }
  | { phase: 'downloading'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

/** MB with one decimal — the unit an app download lives in. Bytes are noise at
 *  this size and GB rounds a 170 MB update to "0.2". */
function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}
const api = (): SettingsApi =>
  (window as unknown as { electronAPI?: SettingsApi }).electronAPI ?? {}

/* ─── The two kill-switches, and why they are inert ───
 *
 * SPEC §2.7 asks for a curator switch and a librarian switch, both default off.
 * Both rows exist below. Neither can move its setting from the renderer, and
 * the reason is not cosmetic:
 *
 *   librarian — main HANDLES `remote:set-librarian-write-enabled`
 *     (electron/remote/init.ts:3444) but `electron/remote-preload.ts` never
 *     exposes it: the handler is orphaned and nothing in the app can call it.
 *     The READ is real — `remote:get-settings` returns `librarianWriteEnabled`
 *     (init.ts:3495) — so the row shows the true state, which is off
 *     (init.ts:200) and doubly so: LIBRARIAN_PARKED (init.ts:2143) means no
 *     librarian session spawns at all.
 *
 *   curator — there is no `curatorEnabled` setting, no handler and no gate.
 *     `curator.start()` (init.ts:2742) is unconditional, so THE CURATOR IS
 *     RUNNING in a release build. Decision D7 assumed it was already off for
 *     launch; it is not, and no pack disables it. That is escalated in this
 *     pack's decisions file as the one place the SPEC's premise is wrong.
 *
 * So the rows render DIMMED AND INERT rather than live. An enabled toggle here
 * would flip, write nothing, and snap back to off on the next mount — visibly
 * broken, and for the curator it would also assert a state that is false.
 * `Toggle`'s `disabled` prop is documented in _shared.tsx for exactly this: the
 * capability stays discoverable without the control lying about it.
 *
 * TO MAKE THEM LIVE, three lines outside this pack — after which flip this
 * constant and nothing else in this file changes:
 *   1. `electron/remote-preload.ts`: expose remoteSetLibrarianWriteEnabled →
 *      invoke('remote:set-librarian-write-enabled').
 *   2. same file: expose remoteSetCuratorEnabled → invoke('remote:set-curator-enabled').
 *   3. `electron/remote/init.ts`: a `curatorEnabled` setting (default false),
 *      that handler, `curatorEnabled` on the remote:get-settings snapshot, and
 *      gate `curator.start()` on it.
 */
const KILL_SWITCHES_WIRED = false

export default function Settings({ onDictationKeyChange, section = 'triggers' }: SettingsProps = {}) {
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [outputMode, setOutputMode] = useState<'paste' | 'clipboard'>('paste')
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  const [soundFeedback, setSoundFeedback] = useState(true)
  const [iphoneMic, setIphoneMic] = useState(false)
  const [screenshotCapture, setScreenshotCapture] = useState(true)
  const [scratchpadEnabled, setScratchpadEnabled] = useState(true)
  const [widgetPosition, setWidgetPosition] = useState<'center' | 'right'>('center')
  const [dictationKey, setDictationKey] = useState<'fn' | 'right-option'>('fn')
  const [activationMode, setActivationMode] = useState<'tap-toggle' | 'push-to-talk' | 'double-tap-push'>('tap-toggle')
  const [instructionEnabled, setInstructionEnabled] = useState<boolean>(true)
  // The orchestrator trigger — the key OPPOSITE the dictation key. `locked` is
  // the plan gate (no Unmute plan → off and not togglable); `enabled` is the
  // live gate, which for a subscriber starts on every time the app opens.
  const [remoteTrigger, setRemoteTrigger] = useState<TriggerState>({ enabled: false, locked: true })
  const [lowercaseOutput, setLowercaseOutput] = useState<boolean>(false)
  const [dictationCleanup, setDictationCleanup] = useState<boolean>(true)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  // ON-DEMAND UPDATE. The button used to open the releases page in a browser,
  // which answers a different question than the one being asked: the user wants
  // to know about the copy they are RUNNING, not what exists on GitHub.
  //
  // This runs the same electron-updater the background checker runs. A found
  // update downloads itself and arrives through the existing "ready to install"
  // banner, so on-demand and automatic are one path, not two. We never install
  // from here — restarting stays the user's decision either way.
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateNote, setUpdateNote] = useState<string | null>(null)
  // The live phase from main. Separate from `updateNote` because the two answer
  // different questions: the note is the last SENTENCE we told the user, the
  // status is where the download is RIGHT NOW — and the second one keeps moving
  // long after the check call that started it has resolved.
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const downloading = updateStatus?.phase === 'downloading' ? updateStatus : null
  const readyVersion = updateStatus?.phase === 'downloaded' ? updateStatus.version : null

  // Subscribe once, for the life of the pane. This also catches BACKGROUND
  // downloads the user never asked for, which is the honest thing to show: if
  // the app is pulling 170 MB, the About row should say so whether or not the
  // button is what started it.
  useEffect(() => {
    const off = api().paywallOnUpdateStatus?.((s) => {
      setUpdateStatus(s)
      if (s.phase === 'downloaded') setUpdateNote(`Version ${s.version} is ready. Restart to finish updating.`)
      else if (s.phase === 'error') setUpdateNote(s.message)
    })
    return () => { off?.() }
  }, [])

  async function runUpdateCheck(): Promise<void> {
    setUpdateBusy(true)
    setUpdateNote(null)
    try {
      const r = await api().paywallCheckForUpdates?.()
      // No bridge method at all — the preload extension did not make it into
      // this build. That is a packaging fault, not a network one, and saying
      // "check your connection" for it sends the user hunting in the wrong place.
      if (!r) { setUpdateNote('This build cannot check for updates (updater bridge missing).'); return }
      if (r.status === 'available') setUpdateNote(`Version ${r.version} found — downloading now.`)
      else if (r.status === 'downloaded') {
        setUpdateNote(`Version ${r.version} is ready. Restart to finish updating.`)
        setUpdateStatus({ phase: 'downloaded', version: r.version })
      }
      else if (r.status === 'current') setUpdateNote('You are up to date.')
      else if (r.status === 'unsupported') setUpdateNote(r.message)
      // The real reason, classified in main. The old code reported EVERY
      // failure as a connection problem — including the TypeError that used to
      // fire on every single click. See paywall-glue.ts's electron-updater import.
      else setUpdateNote(r.message)
    } catch (e) {
      setUpdateNote(`Update check failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setUpdateBusy(false)
    }
  }

  async function runInstallUpdate(): Promise<void> {
    setInstalling(true)
    const ok = await api().paywallInstallUpdate?.()
    // On success the app is already quitting, so this only ever runs when the
    // restart did NOT take — leave the button usable rather than stuck.
    if (!ok) { setInstalling(false); setUpdateNote('Nothing is staged to install yet.') }
  }
  // 'system' is the default and the only value that respects an accessibility
  // preference — macOS already owns this setting (Accessibility → Reduce
  // Transparency, and the Liquid Glass opacity slider on 26+). The explicit
  // options exist because an older surface cannot follow the system slider, and
  // because an always-on-top panel is a reasonable thing to want solid.
  const [surfaceAppearance, setSurfaceAppearance] = useState<'system' | 'glass' | 'solid'>('system')
  // DEFAULT ON, matching the setting it writes (remote/init.ts:198 —
  // `overlayAutoPresent: true`). A surface that never comes forward by itself is
  // a surface you have to remember to look at.
  //
  // THIS TOGGLE WORKS END TO END TODAY. `remote:set-overlay-auto-present`
  // (init.ts:3376) writes `overlayAutoPresent`, and `maybePresent()`
  // (init.ts:784) opens with `if (settings.get('overlayAutoPresent') === false)
  // return`. That is the ONLY path to `presentOrExpand` — every auto-present
  // call site routes through it — so OFF genuinely stops the notch coming
  // forward.
  //
  // An earlier revision of this comment claimed the last hop was missing. It was
  // not. Pack D separately added an additive `autoPresent` command to the notch's
  // own IPC so the surface can know its own policy; that is a refinement, and the
  // engine-side gate above is what actually does the work.
  const [notchAutoPresent, setNotchAutoPresent] = useState<boolean>(true)
  // DEFAULT ON. A surface that goes quiet-amber and waits to be noticed is easy
  // to walk past, and the notch exists precisely so you do not have to remember
  // to look. The controller guards it on `engaged === 'none'`, so this never
  // yanks you out of a task you are already reading.
  const [notchAutoExpand, setNotchAutoExpand] = useState<boolean>(true)
  // DEFAULT OFF — the behaviour that shipped. People who live in the terminal
  // want the opposite and were re-opening it on every task; that is a
  // preference, not something to decide for everyone.
  const [terminalAutoExpand, setTerminalAutoExpand] = useState<boolean>(false)
  // DEFAULT OFF. It speaks through the macOS system voice, and the thing it was
  // really answering — "did that land?" — is now shown in the notch instead.
  const [voiceFeedback, setVoiceFeedback] = useState<boolean>(false)
  // 0.8 matches the compiled-in default on the Swift side, so the control shows
  // the truth on the first frame rather than flicking once the snapshot lands.
  const [surfaceFill, setSurfaceFill] = useState<number>(0.8)
  // DEFAULT ON: captures should show what the user can see unless they
  // explicitly choose privacy. Main and Swift share the same default.
  const [showInScreenCapture, setShowInScreenCapture] = useState<boolean>(true)
  // The two kill-switches. DEFAULT OFF, both — D7 retires the curator and the
  // librarian for launch, and `librarianWriteEnabled` defaults to false in main
  // too (remote/init.ts:200). Neither can be WRITTEN from here; see
  // KILL_SWITCHES_WIRED above for why, and for what makes them live.
  const [curatorEnabled, setCuratorEnabled] = useState<boolean>(false)
  const [librarianEnabled, setLibrarianEnabled] = useState<boolean>(false)

  // Which explainer page is open, if any. One piece of state for both entry
  // points: the "What this does" links on Capture and Scratchpad, and the list
  // in Help & about.
  const [helpPage, setHelpPage] = useState<HelpPageId | null>(null)
  // Moving to another section leaves the page — otherwise clicking Privacy in
  // the sidebar would show whatever help page was last open.
  useEffect(() => { setHelpPage(null) }, [section])

  useEffect(() => {
    loadAudioDevices()
    // Build number — shown in Help & about so users know which version they're
    // on. Optional-chained so it no-ops gracefully against an older main
    // process in dev.
    window.electronAPI.paywallAppVersion?.()
      .then((v: string) => setAppVersion(v))
      .catch(() => {})
    window.electronAPI.getWidgetPosition().then((v: string) => {
      if (v === 'center' || v === 'right') setWidgetPosition(v)
    })
    api().getSurfaceAppearance?.()
      .then((v) => { if (v === 'system' || v === 'glass' || v === 'solid') setSurfaceAppearance(v) })
      .catch(() => {})
    window.electronAPI.getSoundFeedback().then((v: boolean) => setSoundFeedback(v))
    // These three were nested INSIDE the sound-feedback callback, which was an
    // accident of an earlier edit rather than a dependency — three unrelated
    // reads that silently never ran if that one promise rejected. Unnested; no
    // call, argument or key changed.
    api().getIphoneMicEnabled?.().then((on) => setIphoneMic(!!on)).catch(() => {})
    api().remoteGetScreenshotCapture?.().then((on) => setScreenshotCapture(!!on)).catch(() => {})
    api().remoteGetScratchpadEnabled?.().then((on) => setScratchpadEnabled(!!on)).catch(() => {})
    window.electronAPI.paywallGetOutputMode?.()
      .then((v: 'paste' | 'clipboard') => {
        if (v === 'paste' || v === 'clipboard') setOutputMode(v)
      })
      .catch(() => {})
    window.electronAPI.paywallGetLaunchAtLogin?.()
      .then((v: boolean) => setLaunchAtLogin(!!v))
      .catch(() => {})
    window.electronAPI.paywallGetLowercaseOutput?.()
      .then((v: boolean) => setLowercaseOutput(!!v))
      .catch(() => {})
    api().paywallGetDictationCleanup?.().then((v) => setDictationCleanup(!!v)).catch(() => {})
    window.electronAPI.getDictationKey().then((v: string) => {
      if (v === 'fn' || v === 'right-option') setDictationKey(v)
    })
    window.electronAPI.getActivationMode().then((v: string) => {
      if (v === 'tap-toggle' || v === 'push-to-talk' || v === 'double-tap-push') setActivationMode(v)
    })
    // Instruct on/off — falls back to true if the IPC isn't present
    // (e.g., running against an older main process during dev).
    window.electronAPI.paywallGetInstructionEnabled?.()
      .then((v: boolean) => setInstructionEnabled(v !== false))
      .catch(() => {})
    // The orchestrator's own settings snapshot. `!== false` mirrors main's own
    // reading of overlayAutoPresent, so an older main process (which returns
    // undefined) leaves the toggle on rather than silently flipping it off.
    api().remoteGetSettings?.().then((s) => {
      if (!s) return
      setNotchAutoPresent(s.overlayAutoPresent !== false)
      setNotchAutoExpand(s.notchAutoExpand !== false)
      setTerminalAutoExpand(s.notchTerminalAutoExpand === true)
      setVoiceFeedback(s.voiceFeedback === true)
      setSurfaceFill(typeof s.surfaceFill === 'number' ? s.surfaceFill : 0.8)
      setShowInScreenCapture(s.showInScreenCapture !== false)
      setLibrarianEnabled(s.librarianWriteEnabled === true)
      setCuratorEnabled(s.curatorEnabled === true)
    }).catch(() => {})
  }, [])

  // Orchestrator trigger: read once, then follow main's broadcasts so this
  // toggle can't drift from the Orchestrator screen's copy of it (or from an
  // entitlement change that lands while Settings is open).
  useEffect(() => {
    api().paywallGetRemoteTrigger?.().then((s) => s && setRemoteTrigger(s)).catch(() => {})
    const off = api().paywallOnRemoteTriggerChanged?.((s) => setRemoteTrigger(s))
    return () => off?.()
  }, [])

  function handleRemoteTriggerChange(next: boolean) {
    setRemoteTrigger((prev) => ({ ...prev, enabled: next })) // optimistic
    void api().paywallSetRemoteTriggerEnabled?.(next)
      .then((s) => s && setRemoteTrigger(s)) // main is the authority (plan gate)
      .catch(() => {})
  }

  async function loadAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      // MacBook-only by design: the iPhone/Continuity mic is selected via the
      // pill chip (Audio & behaviour → iPhone microphone), never from this list
      // — a second selector showing the phone here misled users into thinking
      // this picker routed capture. Built-in first; iPhone entries excluded.
      const audioInputs = devices
        .filter((d) => d.kind === 'audioinput' && !/iphone|continuity/i.test(d.label))
        .filter((d, _i, all) => {
          const builtIn = all.filter((x) => /built-in|macbook/i.test(x.label))
          return builtIn.length ? /built-in|macbook/i.test(d.label) : true
        })
        .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }))
      setAudioDevices(audioInputs)
      if (audioInputs.length > 0 && !selectedDevice) {
        setSelectedDevice(audioInputs[0].deviceId)
      }
    } catch (err) {
      console.error('Failed to enumerate audio devices:', err)
    }
  }

  function handleWidgetPositionChange(value: string) {
    const pos = value as 'center' | 'right'
    setWidgetPosition(pos)
    window.electronAPI.setWidgetPosition(pos)
  }

  function handleSurfaceAppearanceChange(value: string) {
    const v = (value === 'glass' || value === 'solid' ? value : 'system') as
      'system' | 'glass' | 'solid'
    setSurfaceAppearance(v)
    void api().setSurfaceAppearance?.(v)
  }

  function handleVoiceFeedbackChange(next: boolean): void {
    setVoiceFeedback(next)
    void api().remoteSetVoiceFeedback?.(next)
  }
  function handleNotchAutoExpandChange(next: boolean): void {
    setNotchAutoExpand(next)
    void api().remoteSetNotchAutoExpand?.(next)
  }
  function handleTerminalAutoExpandChange(next: boolean): void {
    setTerminalAutoExpand(next)
    void api().remoteSetTerminalAutoExpand?.(next)
  }
  function handleSurfaceFillChange(value: string): void {
    const v = Number(value)
    setSurfaceFill(v)
    // Main clamps to the three offered values and returns what it stored, so a
    // rejected value corrects the control rather than leaving it lying.
    void api().remoteSetSurfaceFill?.(v)?.then((stored) => { if (stored) setSurfaceFill(stored) })
  }
  function handleShowInScreenCaptureChange(next: boolean): void {
    setShowInScreenCapture(next)
    void api().remoteSetShowInScreenCapture?.(next)
  }
  function handleNotchAutoPresentChange(on: boolean) {
    setNotchAutoPresent(on)
    void api().remoteSetOverlayAutoPresent?.(on)
  }

  function handleSoundFeedbackChange(value: boolean) {
    setSoundFeedback(value)
    window.electronAPI.setSoundFeedback(value)
  }

  function handleLowercaseOutputChange(value: boolean) {
    setLowercaseOutput(value)
    window.electronAPI.paywallSetLowercaseOutput?.(value)?.catch(() => {})
  }

  function handleDictationCleanupChange(value: boolean) {
    setDictationCleanup(value)
    void api().paywallSetDictationCleanup?.(value)?.catch(() => {})
  }

  function handleOutputModeChange(value: string) {
    const next = value === 'clipboard' ? 'clipboard' : 'paste'
    setOutputMode(next)
    window.electronAPI.paywallSetOutputMode?.(next)
  }

  function handleLaunchAtLoginChange(value: boolean) {
    setLaunchAtLogin(value)
    window.electronAPI.paywallSetLaunchAtLogin?.(value)
  }

  function handleDictationKeyChange(value: string) {
    const key = value as 'fn' | 'right-option'
    setDictationKey(key)
    window.electronAPI.setDictationKey(key)
    onDictationKeyChange?.(key)
  }

  function handleActivationModeChange(value: string) {
    const mode = value as 'tap-toggle' | 'push-to-talk' | 'double-tap-push'
    setActivationMode(mode)
    window.electronAPI.setActivationMode(mode)
  }

  // The orchestrator always sits on whichever trigger dictation isn't using.
  const remoteKeyLabel = dictationKey === 'fn' ? 'Right Opt' : 'Fn'
  const sectionLabel = SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? 'Settings'
  // Language's picker is a three-column grid of every language; it needs more
  // room than a settings column. Everything else reads better narrow.
  const width = section === 'language' ? 'max-w-3xl' : 'max-w-lg'

  if (helpPage) {
    return (
      <div className={width}>
        <HelpPage id={helpPage} onBack={() => setHelpPage(null)} />
      </div>
    )
  }

  return (
    <div className={width}>
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-6">{sectionLabel}</h2>

      {/* ══════════════ 1 · Triggers ══════════════ */}
      {section === 'triggers' && (
        <div className="bg-ink rounded-[20px] mb-3 overflow-hidden shadow-lg relative">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgba(255,255,255,0.04)_0%,transparent_50%)] pointer-events-none" />
          <div className="px-6 pt-5">
            <div className="text-[10px] font-bold tracking-[0.12em] uppercase text-white/28 mb-1">Keyboard</div>
            <div className="text-[16px] font-extrabold tracking-tight text-white/90">Three keys, three jobs</div>
          </div>
          <div className="p-5 pt-4 flex flex-col gap-2.5">
            {/* Dictate */}
            <div className="px-4 py-3.5 bg-white/[0.055] border border-white/[0.08] rounded-[13px]">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-[13px] font-medium text-white/88 mb-0.5">Dictate</h4>
                  <p className="text-[11px] text-white/36">
                    {activationMode === 'tap-toggle' && 'Tap to start, tap again to stop'}
                    {activationMode === 'push-to-talk' && 'Hold to record, release to submit'}
                    {activationMode === 'double-tap-push' && 'Double-tap for hands-free, or hold for push-to-talk'}
                  </p>
                </div>
                <div className="flex items-center gap-2.5">
                  <MiniWave />
                  <HeroKey>{dictationKey === 'fn' ? 'Fn' : 'Right Opt'}</HeroKey>
                </div>
              </div>
              {/* Dictation key selector */}
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-white/44">Key</span>
                <SegmentedControlDark
                  options={[
                    { value: 'fn', label: 'Fn (Globe)' },
                    { value: 'right-option', label: 'Right Option' },
                  ]}
                  value={dictationKey}
                  onChange={handleDictationKeyChange}
                />
              </div>
              {/* Activation mode selector */}
              <div className="mt-2.5 flex items-center justify-between">
                <span className="text-[11px] text-white/44">Activation</span>
                <SegmentedControlDark
                  options={[
                    { value: 'tap-toggle', label: 'Tap toggle' },
                    { value: 'push-to-talk', label: 'Push to talk' },
                    { value: 'double-tap-push', label: 'Dual mode' },
                  ]}
                  value={activationMode}
                  onChange={handleActivationModeChange}
                />
              </div>
            </div>
            {/* Instruct */}
            <div className="flex items-center justify-between px-4 py-3.5 bg-white/[0.055] border border-white/[0.08] rounded-[13px] hover:bg-white/[0.085] transition-colors">
              <div>
                <h4 className="text-[13px] font-medium text-white/88 mb-0.5">Instruct</h4>
                <p className="text-[11px] text-white/36">
                  {instructionEnabled
                    ? 'Select something, then say what to do with it'
                    : 'Off — Caps Lock works as a normal key'}
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                {instructionEnabled && <MiniWave />}
                {instructionEnabled ? (
                  <HeroKey variant="red">Caps Lock</HeroKey>
                ) : (
                  <HeroKey>Off</HeroKey>
                )}
                <Toggle
                  checked={instructionEnabled}
                  onChange={(next) => {
                    setInstructionEnabled(next)
                    window.electronAPI.paywallSetInstructionEnabled?.(next)
                  }}
                />
              </div>
            </div>
            {/* Orchestrate — the trigger on the key NOT used for dictation. */}
            <div className="flex items-center justify-between px-4 py-3.5 bg-white/[0.055] border border-white/[0.08] rounded-[13px] hover:bg-white/[0.085] transition-colors">
              <div>
                <h4 className="text-[13px] font-medium text-white/88 mb-0.5 flex items-center gap-1.5">
                  Orchestrate
                  {remoteTrigger.locked && (
                    <span className="px-1.5 py-[1px] rounded-full bg-white/12 text-[10px] font-bold tracking-[0.08em] uppercase text-white/50">
                      Pro
                    </span>
                  )}
                </h4>
                <p className="text-[11px] text-white/36">
                  {remoteTrigger.locked
                    ? 'On the Unmute plan — upgrade to hand spoken jobs to an agent'
                    : remoteTrigger.enabled
                      ? 'Hold, say what you want done, let go'
                      : `Off — ${remoteKeyLabel} works as a normal key. Back on when you reopen unmute.`}
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                {remoteTrigger.enabled && <MiniWave />}
                {remoteTrigger.enabled ? (
                  <HeroKey variant="red">{remoteKeyLabel}</HeroKey>
                ) : (
                  <HeroKey>Off</HeroKey>
                )}
                <Toggle
                  checked={remoteTrigger.enabled}
                  disabled={remoteTrigger.locked}
                  title={remoteTrigger.locked ? 'Orchestrate is part of the Unmute plan' : undefined}
                  onChange={handleRemoteTriggerChange}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════ 2 · Audio & behaviour ══════════════ */}
      {section === 'audio' && (
        <>
          <SectionHeader icon={<MicIcon />} title="Audio" />
          <Card>
            <SettingRow label="Microphone" description="Which input device unmute listens to">
              <Picker
                value={selectedDevice}
                options={audioDevices.map((d) => ({ value: d.deviceId, label: d.label }))}
                placeholder="No microphone found"
                onChange={setSelectedDevice}
              />
            </SettingRow>
          </Card>

          <SectionHeader icon={<BehaviorIcon />} title="Behaviour" />
          <Card>
            <SettingRow
              label="Output mode"
              description={outputMode === 'paste'
                ? 'Auto-pastes at the cursor in whichever app is focused'
                : 'Copies to clipboard only — you press ⌘V yourself'}
            >
              <SegmentedControl
                options={[
                  { value: 'paste', label: 'Paste at cursor' },
                  { value: 'clipboard', label: 'Clipboard only' },
                ]}
                value={outputMode}
                onChange={handleOutputModeChange}
              />
            </SettingRow>
            <SettingRow label="Sound feedback" description="Play sounds on start / stop">
              <Toggle checked={soundFeedback} onChange={handleSoundFeedbackChange} />
            </SettingRow>
            <SettingRow
              label="Speak confirmations"
              description="Say short replies out loud when a task is created — “On it.” Off by default: the notch already shows what happened, and this uses your Mac's system voice."
            >
              <Toggle checked={voiceFeedback} onChange={handleVoiceFeedbackChange} />
            </SettingRow>
            {/* The label used to say "Screenshot capture", from when images were
                all this touched. It now governs TEXT too — anything you copy
                while the mic is hot — so the label says what it does. The four
                sentences that used to sit here are the Capture help page. */}
            <LinkedRow
              label="Capture while dictating"
              description="Things you copy or screenshot while the mic is on land in the text"
              onExplain={() => setHelpPage('capture')}
            >
              <Toggle checked={screenshotCapture} onChange={(on: boolean) => {
                setScreenshotCapture(on)
                void api().remoteSetScreenshotCapture?.(on)
              }} />
            </LinkedRow>
            <LinkedRow
              label="Scratchpad"
              description="Hold what you dictate instead of delivering it on stop"
              onExplain={() => setHelpPage('scratchpad')}
            >
              <Toggle checked={scratchpadEnabled} onChange={(on: boolean) => {
                setScratchpadEnabled(on)
                void api().remoteSetScratchpadEnabled?.(on)
              }} />
            </LinkedRow>
            <SettingRow label="iPhone microphone" description="Dictate through your iPhone over Continuity — nothing to install">
              <Toggle checked={iphoneMic} onChange={(on: boolean) => {
                setIphoneMic(on)
                void api().setIphoneMicEnabled?.(on)
              }} />
            </SettingRow>
            <SettingRow label="Launch at login" description="Start unmute automatically when you log in to your Mac">
              <Toggle checked={launchAtLogin} onChange={handleLaunchAtLoginChange} />
            </SettingRow>
            <SettingRow label="Lowercase output" description="Force everything pasted to be lowercase">
              <Toggle checked={lowercaseOutput} onChange={handleLowercaseOutputChange} />
            </SettingRow>
            <SettingRow label="Dictation cleanup" description="Remove filler words and stutters before pasting">
              <Toggle checked={dictationCleanup} onChange={handleDictationCleanupChange} />
            </SettingRow>
          </Card>
        </>
      )}

      {/* ══════════════ 3 · Appearance & notch ══════════════ */}
      {section === 'appearance' && (
        <>
          <SectionHeader icon={<AppearanceIcon />} title="The notch" />
          <Card>
            <SettingRow
              label="Show the notch automatically"
              description="Bring it forward when a task finishes or needs an answer"
            >
              <Toggle checked={notchAutoPresent} onChange={handleNotchAutoPresentChange} />
            </SettingRow>
            <SettingRow
              label="Open the task when it needs you"
              description="Expand straight to the task instead of just turning amber and waiting to be tapped. It never interrupts you mid-task — if you already have something open, the new one waits."
            >
              <Toggle checked={notchAutoExpand} onChange={handleNotchAutoExpandChange} />
            </SettingRow>
            <SettingRow
              label="Show the terminal straight away"
              description="For tasks running in the CLI, open with the terminal already showing instead of one tap away. Either way the icon toggles it, and a question that can only be answered in the terminal always opens it."
            >
              <Toggle checked={terminalAutoExpand} onChange={handleTerminalAutoExpandChange} />
            </SettingRow>
            <SettingRow
              label="Expanded size"
              description="How much of the screen the task view and the Orchestrator fill when they open."
            >
              <SegmentedControl
                options={[
                  { value: '0.7', label: '70%' },
                  { value: '0.8', label: '80%' },
                  { value: '0.9', label: '90%' },
                ]}
                value={String(surfaceFill)}
                onChange={handleSurfaceFillChange}
              />
            </SettingRow>
            <SettingRow
              label="Show in screen sharing and screenshots"
              description="Include the notch and recording pill when you share or capture your screen. Turn this off to keep them private."
            >
              <Toggle checked={showInScreenCapture} onChange={handleShowInScreenCaptureChange} />
            </SettingRow>
            {/* D5: this governs the expanded panel and the recording pill ONLY.
                The bar-level mass is always opaque black, because it is
                impersonating the physical notch and any translucency breaks the
                illusion at the join. The old description also named a macOS
                version and the bug behind the default; that is an internal
                detail and does not belong in front of a user. */}
            <SettingRow
              label="Surface material"
              description="How the expanded panel and the recording pill render. The notch itself is always solid."
            >
              <SegmentedControl
                options={[
                  { value: 'solid', label: 'Fixed' },
                  { value: 'glass', label: 'Live glass' },
                  { value: 'system', label: 'Follow system' },
                ]}
                value={surfaceAppearance}
                onChange={handleSurfaceAppearanceChange}
              />
            </SettingRow>
          </Card>

          <SectionHeader icon={<MicIcon />} title="The recording pill" />
          <Card>
            <SettingRow label="Widget position" description="Where the pill appears on screen">
              <SegmentedControl
                options={[
                  { value: 'center', label: 'Top center' },
                  { value: 'right', label: 'Top right' },
                ]}
                value={widgetPosition}
                onChange={handleWidgetPositionChange}
              />
            </SettingRow>
          </Card>
        </>
      )}

      {/* ══════════════ 4 · Permissions ══════════════ */}
      {section === 'permissions' && <Permissions />}

      {/* ══════════════ 5 · Language ══════════════ */}
      {section === 'language' && <Language />}

      {/* ══════════════ 6 · Privacy ══════════════ */}
      {section === 'privacy' && <Privacy />}

      {/* ══════════════ 7 · Help & about ══════════════ */}
      {section === 'help' && (
        <>
          <SectionHeader icon={<HelpIcon />} title="How things work" />
          <Card>
            {HELP_PAGES.map((page, i) => (
              <button
                key={page.id}
                onClick={() => setHelpPage(page.id)}
                className={`w-full text-left px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-cream-mid transition-colors ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">{page.title}</span>
                  <span className="block text-[11px] text-ink-35 mt-0.5">{page.blurb}</span>
                </span>
                <span className="text-[13px] text-ink-35 shrink-0">›</span>
              </button>
            ))}
          </Card>

          <SectionHeader icon={<ShieldIcon />} title="About" />
          <Card>
            {/* Written out rather than using SettingRow because the progress
                bar needs the FULL width of the row, and SettingRow's children
                slot is the narrow right-hand column. Same padding and divider
                classes, so it sits in the card identically. */}
            <div className="px-5 py-4 border-b border-border last:border-b-0">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13px] font-medium text-ink">
                    {`unmute ${appVersion ? `v${appVersion}` : ''}`.trim()}
                  </p>
                  <p className="text-[11px] text-ink-35 mt-0.5">
                    {updateNote ?? 'unmute updates itself in the background. Check now if you would rather not wait.'}
                  </p>
                </div>
                {/* One slot, three jobs. Once bytes are on disk the only useful
                    action is the restart that applies them, so the check button
                    steps aside rather than sitting next to a finished download. */}
                {readyVersion ? (
                  <button
                    disabled={installing}
                    onClick={() => { void runInstallUpdate() }}
                    className="px-4 py-2 rounded-full bg-ink text-white text-[12.5px] font-semibold hover:opacity-90 transition-all duration-200 disabled:opacity-50 shrink-0"
                  >
                    {installing ? 'Restarting…' : 'Restart to update'}
                  </button>
                ) : (
                  <button
                    disabled={updateBusy || !!downloading}
                    onClick={() => { void runUpdateCheck() }}
                    className="px-4 py-2 rounded-full border border-border text-[12.5px] font-semibold text-ink-60 hover:bg-cream-mid hover:border-border-md transition-all duration-200 disabled:opacity-50 shrink-0"
                  >
                    {downloading ? 'Downloading…' : updateBusy ? 'Checking…' : 'Check for updates'}
                  </button>
                )}
              </div>

              {downloading && (
                <div className="mt-3">
                  <div
                    role="progressbar"
                    aria-label="Downloading update"
                    aria-valuenow={Math.round(downloading.percent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-1.5 w-full rounded-full bg-ink-07 overflow-hidden"
                  >
                    <div
                      className="h-full rounded-full bg-ink transition-[width] duration-200 ease-out"
                      style={{ width: `${downloading.percent}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-ink-35 mt-1.5 tabular-nums">
                    {Math.round(downloading.percent)}%
                    {downloading.total > 0 && ` · ${mb(downloading.transferred)} of ${mb(downloading.total)}`}
                    {downloading.bytesPerSecond > 0 && ` · ${mb(downloading.bytesPerSecond)}/s`}
                  </p>
                </div>
              )}
            </div>
            <SettingRow label="Replay onboarding" description="Walk through the welcome and setup steps again">
              <button
                onClick={() => {
                  // Pack A's reset, not a hand-rolled removeItem: it clears the
                  // version key AND the legacy boolean, which is what puts you
                  // back at the start of the full flow rather than the
                  // three-screen what's-new.
                  resetOnboarding()
                  location.reload()
                }}
                className="px-4 py-2 rounded-full border border-border text-[12.5px] font-semibold text-ink-60 hover:bg-cream-mid hover:border-border-md transition-all duration-200"
              >
                Replay
              </button>
            </SettingRow>
          </Card>

          {/* ─── Advanced ───
              Two features being retired for launch (D7). They are shown rather
              than deleted because the skills they produced are still on disk
              and still work, and a user who wonders why nothing is being added
              deserves an answer in the app rather than none.

              Both are inert in this build — see KILL_SWITCHES_WIRED at the top
              of this file for exactly which three lines, in two files this pack
              does not own, make them live. The descriptions below say what each
              one DOES, never what state it is in, because for the curator the
              app cannot currently know. */}
          <SectionHeader icon={<EngineIcon />} title="Advanced" />
          <Card>
            <SettingRow
              label="Skill curator"
              description="Reviews finished tasks and proposes skills worth keeping"
            >
              <Toggle
                checked={curatorEnabled}
                disabled={!KILL_SWITCHES_WIRED}
                title="Not adjustable in this release"
                onChange={(on) => {
                  setCuratorEnabled(on)
                  void api().remoteSetCuratorEnabled?.(on)
                }}
              />
            </SettingRow>
            <SettingRow
              label="Librarian"
              description="Writes accepted proposals into your skill library"
            >
              <Toggle
                checked={librarianEnabled}
                disabled={!KILL_SWITCHES_WIRED}
                title="Not adjustable in this release"
                onChange={(on) => {
                  setLibrarianEnabled(on)
                  void api().remoteSetLibrarianWriteEnabled?.(on)
                }}
              />
            </SettingRow>
          </Card>
          <p className="text-[11px] text-ink-35 leading-relaxed px-1 mb-3">
            Both are being switched off for this release and are not adjustable
            here yet. Anything they already learned stays on disk and keeps
            working.
          </p>
        </>
      )}
    </div>
  )
}

/* ─── Local presentation ─── */

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
      {children}
    </div>
  )
}

/** A SettingRow whose explanation is a link rather than a paragraph.
 *
 *  `SettingRow` in _shared.tsx takes `description` as a plain string, so there
 *  is nowhere to put a link in it — and widening its signature would mean
 *  editing a file this pack does not own. The layout is deliberately identical
 *  to `SettingRow`'s so the two read as one row type, which is the point of D8:
 *  long explanations become a "What this does" link, never a paragraph inside a
 *  control row. */
function LinkedRow({ label, description, onExplain, children }: {
  label: string
  description: string
  onExplain: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between px-5 py-4 border-b border-border last:border-b-0">
      <div className="mr-4">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        <p className="text-[11px] text-ink-35 mt-0.5">
          {description}{' '}
          <button
            onClick={onExplain}
            className="font-semibold text-accent hover:underline"
          >
            What this does
          </button>
        </p>
      </div>
      <div>{children}</div>
    </div>
  )
}

/** The microphone menu, drawn in this app rather than in macOS.
 *
 *  D8 forbids the native dropdown element: it renders in the system's own
 *  chrome, ignores every token in this app, and was the one control in Settings
 *  that looked like a different program. This is the same behaviour in the app's
 *  own vocabulary — a button that opens a list of buttons. Same value, same
 *  onChange, same device ids. */
function Picker({ value, options, placeholder, onChange }: {
  value: string
  options: { value: string; label: string }[]
  placeholder: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={options.length === 0}
        className="flex items-center justify-between gap-2 bg-cream-mid border border-border-md rounded-full pl-3.5 pr-3 py-2 text-[12.5px] font-medium text-ink shadow-sm min-w-[180px] max-w-[220px] disabled:opacity-40"
      >
        <span className="truncate">{current?.label ?? placeholder}</span>
        <span className="text-[13px] text-ink-35 shrink-0">⌄</span>
      </button>
      {open && options.length > 0 && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[180px] max-w-[260px] bg-surface-2 border border-border rounded-[12px] shadow-lg overflow-hidden py-1">
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`w-full text-left px-3.5 py-2 text-[12.5px] truncate hover:bg-cream-mid transition-colors ${
                opt.value === value ? 'font-semibold text-ink' : 'text-ink-60'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
