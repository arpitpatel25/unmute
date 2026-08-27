// Unmute Orchestrator — settings panel.
//
// Lives in the Orchestrator tab. Exposes the user-facing knobs whose IPC already
// exists in remote/init.ts: the agent that runs the work, that agent's own
// models, permission mode, and the path sandbox. Credentials are NEVER here
// (PRD §12.1) — MCP setup is done in the user's own agent.
//
// REBUILT (launch spec pack-c §6). This screen was raw HTML checkbox inputs, a
// native dropdown element and ad-hoc 12px text in an app that has a design
// system — the largest visual-quality gap in the product. It now uses the same
// primitives as every other settings surface (`SectionHeader`, `SettingRow`,
// `Toggle`, `SegmentedControl`), and three things were removed outright:
//
//   * the orchestrator trigger-key toggle — it also lives in Settings → Your
//     triggers, which is the one that stays (spec §6). Two switches for one gate
//     is two places to disagree.
//   * the memory-footprint readout and its cleanup button — decision D1: the
//     curator and librarian that filled that store are being switched off, so a
//     footprint readout for a store nothing writes to is furniture.
//   * `FALLBACK_CATALOG` — hardcoded Haiku/Sonnet/Opus, rendered even with
//     Codex desktop selected. Model chips follow the selected agent now, or
//     there are no chips. See `<Models>` below.

import { useCallback, useEffect, useState } from 'react'
import { ComputerUseSettings } from './ComputerUseSettings'
import { ProviderGlyph } from './ProviderMark'
import { SectionHeader, SettingRow, Toggle } from '../app/_shared'

interface Settings {
  permissionMode: 'prompt' | 'auto-approve'
  remoteKey: 'fn' | 'right-option'
  /** A provider id from the registry (electron/remote/providers.ts). The old
   *  comment here called 'codex' a legacy stub migrated away at startup; that
   *  stopped being true when the Codex CLI was wired, and the migration it
   *  described has been deleted. */
  agent: 'claude' | 'codex' | 'codex-desktop' | 'claude-code-desktop'
  sandboxRoots: string[]
  model: string
  browserEnabled: boolean
  overlayAutoPresent: boolean
  overlayDocked: boolean
  osNotifications: boolean
  forceRawMode: boolean
  // NO CAPTURE FIELD HERE. `remote:get-settings` still carries the capture
  // switch under its shipped wire key (`screenshotCapture`), but this screen
  // never drew a control for it — it only mirrored the old, image-only framing
  // in a type. The setting governs TEXT as well now and is surfaced in exactly
  // one place, Settings.tsx, under a label that says so ("Capture while
  // dictating"). One setting, one honest description.
  agentTasksEnabled?: boolean
  codexFullAccessConsent?: boolean
  logFile: string | null
}

interface ModelChoice { id: string; label: string; description?: string }
interface AgentOption { id: string; label: string; available: boolean; installed?: boolean; reason?: string }
interface AgentPicker { current: string; options: AgentOption[] }
type CodexAxis = 'Model' | 'Effort' | 'Speed'
interface CodexReasoning {
  label: string | null
  current: Partial<Record<CodexAxis, string>>
  options: Partial<Record<CodexAxis, string[]>>
}
interface SetupStep { key: string; title: string; detail: string; command?: string; status: 'done' | 'todo' }

type API = {
  remoteGetSettings?: () => Promise<Settings>
  remoteSetPermissionMode?: (m: 'prompt' | 'auto-approve') => Promise<boolean>
  remoteSetAgent?: (a: string) => Promise<boolean>
  remoteAgentOptions?: () => Promise<AgentPicker>
  remoteSetSandboxRoots?: (r: string[]) => Promise<boolean>
  remoteSetBrowserEnabled?: (enabled: boolean) => Promise<boolean>
  remoteSetModel?: (m: string) => Promise<string>
  remoteSetCodexFullAccess?: (on: boolean) => Promise<boolean>
  /** Models for ONE backend, in that backend's own vocabulary. */
  remoteModelOptions?: (agent: string) => Promise<{ agent: string; models: ModelChoice[] }>
  remoteOnModelChanged?: (cb: (model: string) => void) => () => void
  remoteCodexReasoning?: () => Promise<CodexReasoning>
  remoteCodexReasoningSet?: (axis: CodexAxis, value: string) => Promise<boolean>
  /** Codex CLI's own Model/Effort, read from the `codex` binary. Same shape as
   *  the desktop reader — see the preload note. */
  remoteCodexCliReasoning?: () => Promise<CodexReasoning>
  remoteCodexCliReasoningSet?: (axis: CodexAxis, value: string) => Promise<boolean>
  remoteSetOsNotifications?: (on: boolean) => Promise<boolean>
  remoteSetForceRaw?: (on: boolean) => Promise<boolean>
  remoteSetAgentTasks?: (v: boolean) => Promise<boolean>
  remoteListProjects?: () => Promise<Array<{ name: string; path: string }>>
  remoteGetSetupStatus?: () => Promise<{ steps: SetupStep[]; complete: boolean }>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

/** What each backend is actually good at — the sentence a bare dropdown never
 *  said. Keyed by the registry's provider id; an unknown backend simply gets no
 *  sentence rather than a guessed one. */
const AGENT_PITCH: Record<string, string> = {
  claude: 'Runs on your machine in a real terminal. Live output, and you can resume a session later.',
  codex: 'Runs on your machine in a real terminal, same as Claude Code — its own models, its own sessions.',
  'codex-desktop': 'Runs in the Codex app you already have open. No terminal here — the thread lives in Codex.',
  'claude-code-desktop': 'Runs in the Claude desktop app. The conversation lives there; Unmute conducts it.',
}

/* ─── Small primitives this screen needs and `_shared` does not have ─── */

/** A row of choice chips. The one control vocabulary the app uses for "pick one
 *  of a list that changes at runtime" — `SegmentedControl` assumes a short,
 *  fixed set, and a model catalogue is neither. */
function Chips({ options, value, onPick }: {
  options: Array<{ id: string; label: string; title?: string }>
  value: string | undefined
  onPick: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          title={o.title}
          onClick={() => onPick(o.id)}
          className={`px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium border transition-colors ${
            value === o.id
              ? 'bg-ink text-white border-ink'
              : 'bg-white text-ink-60 border-border hover:bg-cream-mid'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-cream-mid shrink-0"
      onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="bg-white border border-border rounded-[12px] overflow-hidden">{children}</div>
}

/* ─── Icons — one per concept (decision D8) ─── */

function AgentIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="4.5" width="11" height="8" rx="2" /><path d="M8 2v2.5M5.5 8h.01M10.5 8h.01M6 10.5h4" />
    </svg>
  )
}
function ModelIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z" /><path d="M8 8l5.5-3M8 8v6.5M8 8L2.5 5" />
    </svg>
  )
}
function ReachIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h3l1.5 2h4.5A1.5 1.5 0 0 1 14 7.5v4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  )
}
function LaneIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2C6.2 4 6.2 12 8 14" />
    </svg>
  )
}

/* ─── Model chips — THE BUG THIS SECTION EXISTS TO FIX ───────────────────────
 *
 * The old panel rendered `FALLBACK_CATALOG` (Haiku / Sonnet / Opus) whenever the
 * catalog IPC returned nothing — including when the selected agent was Codex
 * desktop, which has none of those models. Picking one wrote a Claude alias into
 * unmute's own setting; Codex ignored it, and the screen went on claiming the
 * task would run on Opus.
 *
 * Now: the chips are ASKED OF THE SELECTED BACKEND, in that backend's own
 * vocabulary, and an empty answer is a real answer — it means "we cannot know
 * what this app offers", so nothing selectable is drawn. One backend's models
 * are never shown under another's name.
 *
 * WHY THIS IS A TABLE AND NOT AN `=== 'codex-desktop'`. `remote:model-options`
 * looks like the per-backend answer, and it is — for 'claude-code-desktop'. For
 * every OTHER id it falls through to `getModelCatalog()` (init.ts:3703), which
 * is Claude Code's catalogue. So the dangerous default is not "ask Codex the
 * wrong way", it is "ask the catalogue about a backend it knows nothing about
 * and render Claude's tiers under that backend's name" — and a single
 * `agentId === 'codex-desktop'` guard fixes that for exactly one id while
 * leaving the next backend to reintroduce the bug on the day it lands.
 *
 * So the question asked here is "how does THIS backend report its models", and
 * an absent answer means we do not know — which draws nothing, rather than
 * something plausible and wrong.
 */

/** How each backend reports what it can run.
 *
 *  'catalog' — `remote:model-options` genuinely answers for this backend.
 *  'own-app' — the app itself is the only source (Codex reports Model / Effort /
 *              Speed through `remote:codex-reasoning`, read from the running
 *              app; it is the same source the pill's chip uses).
 *
 *  ABSENT is the important entry. A backend not listed here has no known model
 *  source, so this screen offers none — see the note above for why the
 *  alternative is another vendor's models under this one's name. Adding a
 *  backend to the registry should mean adding one line here; forgetting is
 *  visibly inert instead of quietly wrong. */
const MODEL_SOURCE: Record<string, 'catalog' | 'own-app' | 'own-binary'> = {
  claude: 'catalog',
  // MISSING ENTIRELY UNTIL 1.4.24, which is what "forgetting is visibly inert"
  // bought: Codex CLI drew the no-model-list paragraph on a backend that has
  // six, in words that read like a limitation rather than an omission.
  //
  // 'own-binary', NOT 'catalog'. Codex's models are Codex's — its line-up
  // turned over completely between two point releases — so they are read from
  // the `codex` on PATH, the same binary the task will run on. Its Model and
  // Effort are one choice, exactly as in `codex`'s own picker.
  codex: 'own-binary',
  'claude-code-desktop': 'catalog',
  'codex-desktop': 'own-app',
}

function Models({ agentId, model, onPickModel }: {
  agentId: string
  model: string
  /** Not Claude-specific, which is what its old name claimed while it wrote
   *  Claude's setting no matter which backend the picker was showing. The IPC
   *  now routes the write by the selected agent (setModelFor in init.ts). */
  onPickModel: (id: string) => void
}) {
  const source = MODEL_SOURCE[agentId]
  const [catalog, setCatalog] = useState<ModelChoice[] | null>(null)
  const [codex, setCodex] = useState<CodexReasoning | null>(null)

  useEffect(() => {
    let cancelled = false
    setCatalog(null)
    setCodex(null)
    if (source === 'own-app' || source === 'own-binary') {
      const read = source === 'own-app' ? api().remoteCodexReasoning : api().remoteCodexCliReasoning
      void read?.().then((r) => { if (!cancelled) setCodex(r ?? null) }).catch(() => { if (!cancelled) setCodex(null) })
      return () => { cancelled = true }
    }
    if (source === 'catalog') {
      void api().remoteModelOptions?.(agentId)
        .then((r) => { if (!cancelled) setCatalog(r?.models ?? []) })
        .catch(() => { if (!cancelled) setCatalog([]) })
    }
    return () => { cancelled = true }
  }, [agentId, source])

  if (!source) {
    return (
      <p className="text-[11px] text-ink-35 leading-relaxed">
        Unmute can&rsquo;t read this agent&rsquo;s model list, so it won&rsquo;t offer one.
        Tasks run on whatever the agent is already set to.
      </p>
    )
  }

  // ONE RENDERER FOR BOTH CODEX BACKENDS. They offer the same choice — Codex's
  // own picker is titled "Select Model and Effort" in the CLI and shows the same
  // axes in the app — and the two readers were deliberately given one shape so
  // this could not become two pickers that drift apart. Only the source of the
  // list and the empty-state sentence differ.
  if (source === 'own-app' || source === 'own-binary') {
    // Speed is the desktop app's alone; the CLI reader never sends it, and the
    // filter below drops an axis with no values rather than drawing an empty row.
    const axes = (['Model', 'Effort', 'Speed'] as const)
      .map((axis) => ({ axis, values: codex?.options[axis] ?? [], current: codex?.current[axis] }))
      .filter((a) => a.values.length)
    if (!axes.length) {
      return (
        <p className="text-[11px] text-ink-35 leading-relaxed">
          {source === 'own-binary' ? (
            <>
              Codex&rsquo;s models are read from the <code>codex</code> command itself, and it
              couldn&rsquo;t be reached. Once <code>codex</code> runs in your terminal, its own
              models appear here.
            </>
          ) : (
            <>
              Codex&rsquo;s models are read from the Codex app itself. Open Codex and connect it
              from <b>Agents &amp; setup</b> above, and its own choices appear here.
            </>
          )}
        </p>
      )
    }
    return (
      <div className="space-y-3">
        {axes.map((a) => (
          <div key={a.axis}>
            <p className="text-[11px] text-ink-35 mb-1.5">{a.axis}</p>
            <Chips
              options={a.values.map((v) => ({ id: v, label: v }))}
              value={a.current}
              onPick={(v) => {
                setCodex((prev) => (prev ? { ...prev, current: { ...prev.current, [a.axis]: v } } : prev))
                const write = source === 'own-app' ? api().remoteCodexReasoningSet : api().remoteCodexCliReasoningSet
                const done = write?.(a.axis, v)
                // Picking a MODEL changes which efforts exist — Sol offers six,
                // Luna five — so the panel re-reads rather than leaving the
                // previous model's levels on screen under the new model's name.
                if (a.axis === 'Model') {
                  const read = source === 'own-app' ? api().remoteCodexReasoning : api().remoteCodexCliReasoning
                  void Promise.resolve(done)
                    .then(() => read?.())
                    .then((r) => { if (r) setCodex(r) })
                    .catch(() => { /* leave what is on screen */ })
                }
              }}
            />
          </div>
        ))}
      </div>
    )
  }

  if (catalog === null) return <p className="text-[11px] text-ink-35">Reading this agent&rsquo;s models…</p>
  if (catalog.length === 0) {
    return (
      <p className="text-[11px] text-ink-35 leading-relaxed">
        Unmute can&rsquo;t read this agent&rsquo;s model list, so it won&rsquo;t offer one.
        Tasks run on whatever the agent is already set to.
      </p>
    )
  }
  return (
    <div>
      <Chips
        options={catalog.map((m) => ({ id: m.id, label: m.label, title: m.description }))}
        value={model}
        onPick={onPickModel}
      />
      <p className="mt-2 text-[11px] text-ink-35">
        {catalog.find((m) => m.id === model)?.description ?? model}
      </p>
    </div>
  )
}

/* ─── Sandbox ───────────────────────────────────────────────────────────────
 *
 * A LIMITATION, STATED. The spec asks for a directory picker. A real one needs
 * `dialog.showOpenDialog` in the main process, and no such IPC exists: neither
 * this repo's `remote-preload.ts` nor the OSS engine's `preload.ts` exposes a
 * folder chooser, and Pack C owns no main-process file that could add one.
 * The renderer-only substitute (`<input webkitdirectory>` plus `File.path`) does
 * not work either — the engine ships Electron 40, which removed `File.path` in
 * v32, so the button would open a chooser and then silently add nothing.
 *
 * What this does instead is offer real directories to CLICK: the projects
 * Unmute already knows about on disk (`remote:list-projects`), one tap each.
 * Typing a path is the fallback, not the primary control, and its field says
 * what it wants rather than showing a fictional example path.
 */
function Sandbox({ roots, onChange }: { roots: string[]; onChange: (roots: string[]) => void }) {
  const [projects, setProjects] = useState<Array<{ name: string; path: string }>>([])
  const [typed, setTyped] = useState('')
  useEffect(() => {
    void api().remoteListProjects?.().then((p) => setProjects(p ?? [])).catch(() => {})
  }, [])
  const add = (p: string) => {
    const v = p.trim()
    if (!v || roots.includes(v)) return
    onChange([...roots, v])
  }
  const suggestions = projects.filter((p) => !roots.includes(p.path))
  return (
    <div className="px-5 py-4 space-y-3">
      <div>
        <p className="text-[13px] font-medium text-ink">Folders tasks may reach</p>
        <p className="text-[11px] text-ink-35 mt-0.5">
          {roots.length === 0
            ? 'No fence right now — tasks can reach anywhere you can.'
            : `Tasks are fenced to ${roots.length} folder${roots.length === 1 ? '' : 's'}.`}
        </p>
      </div>

      {roots.length > 0 && (
        <div className="space-y-1">
          {roots.map((r) => (
            <div key={r} className="flex items-center gap-2">
              <code className="flex-1 px-2 py-1 bg-cream-mid border border-border rounded-md text-[11px] truncate" title={r}>{r}</code>
              <button
                className="text-[11px] px-2 py-1 rounded border border-border text-ink-60 hover:bg-cream-mid"
                onClick={() => onChange(roots.filter((x) => x !== r))}
              >Remove</button>
            </div>
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <div>
          <p className="text-[11px] text-ink-35 mb-1.5">Your projects — one tap to fence to one</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((p) => (
              <button
                key={p.path}
                title={p.path}
                onClick={() => add(p.path)}
                className="px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium border border-border bg-white text-ink-60 hover:bg-cream-mid"
              >+ {p.name}</button>
            ))}
          </div>
        </div>
      )}

      <form
        className="flex gap-1.5"
        onSubmit={(e) => { e.preventDefault(); add(typed); setTyped('') }}
      >
        <input
          className="flex-1 text-[12.5px] px-2.5 py-1.5 rounded-md border border-border bg-white"
          placeholder="Or type the full path to a folder"
          aria-label="Full path to a folder"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button className="text-[11px] px-3 py-1.5 rounded-md border border-border hover:bg-cream-mid" type="submit">Add</button>
      </form>
    </div>
  )
}

/* ─── No agent installed (spec §3.7) ─────────────────────────────────────────
 *
 * The most likely first-run state after launch, and the one the old panel
 * handled worst: it drew a model picker, a permission switch and a sandbox for a
 * thing that could not run at all. Nothing here is a control — it is what the
 * Orchestrator is, how to get each agent, and the reassurance that the app the
 * user actually bought (dictation) works without any of this.
 */
function NoAgents({ steps, onHowItWorks, onRecheck }: {
  steps: SetupStep[]
  /** Absent ⇒ no link is drawn. See `RemoteSettings`' prop doc. */
  onHowItWorks?: () => void
  onRecheck: () => void
}) {
  return (
    <div className="space-y-4">
      <div className="bg-white border border-border rounded-[12px] px-5 py-4">
        <p className="text-[14px] font-semibold text-ink">The Orchestrator needs an agent</p>
        <p className="text-[12.5px] text-ink-60 leading-relaxed mt-1.5">
          The Orchestrator is where you hand work to a coding agent by voice and watch
          it run — several at once, each on its own card. Unmute doesn&rsquo;t do the
          thinking; it hands your words to an agent on this machine and brings the
          answer back. So it needs one installed first.
        </p>
        <p className="text-[12.5px] text-ink-60 leading-relaxed mt-2">
          <b>Dictation works without any of this.</b> Everything you already use —
          hold-to-talk, Instruct, the pill — is unaffected by what&rsquo;s on this page.
        </p>
        {onHowItWorks && (
          <button
            className="mt-3 text-[11px] font-semibold px-3 py-1.5 rounded-full border border-border text-ink-60 hover:bg-cream-mid"
            onClick={onHowItWorks}
          >
            How it works
          </button>
        )}
      </div>

      {steps.length > 0 && (
        <Panel>
          {steps.map((s, i) => (
            <div key={s.key} className={`px-5 py-4 ${i ? 'border-t border-border' : ''}`}>
              <p className="text-[13px] font-medium text-ink">{s.title}</p>
              <p className="text-[11px] text-ink-35 mt-0.5 leading-relaxed">{s.detail}</p>
              {s.command && (
                <div className="flex items-center gap-1.5 mt-2">
                  <code className="flex-1 px-2 py-1 bg-cream-mid border border-border rounded-md text-[11px] truncate">{s.command}</code>
                  <CopyButton text={s.command} />
                </div>
              )}
            </div>
          ))}
        </Panel>
      )}

      <button
        className="text-[11px] px-3 py-1.5 rounded-md border border-border hover:bg-cream-mid"
        onClick={onRecheck}
      >
        Re-check
      </button>
    </div>
  )
}

/* ─── The panel ─── */

export function RemoteSettings({ onOpenHowItWorks }: {
  /** Navigate the Orchestrator tab to its "How it works" page.
   *
   *  THIS PANEL KEEPS NO PAGE STATE. The tab above owns which sub-page is
   *  selected. An earlier cut of this file fell back to swapping ITSELF for the
   *  trust page when this prop was absent — and since the Orchestrator tab
   *  mounts `<RemoteSettings />` with no props, that fallback is what would
   *  actually run: the panel would show the trust page while the segmented
   *  control above it still read "Settings". That is precisely the two-navigations
   *  -over-one-selection bug this pack removed from `TaskPanel`, and shipping it
   *  one screen over on the promise of a wiring line elsewhere is not a fix.
   *
   *  So: given the callback, the link drives the real selection. Absent it, the
   *  link is NOT DRAWN — a caller with no sub-nav loses nothing that works, and
   *  the tab's own "How it works" segment is the route in the shipped app.
   *  A control that navigates somewhere the user cannot see they have gone is a
   *  dead control by another name. */
  onOpenHowItWorks?: () => void
} = {}) {
  const [s, setS] = useState<Settings | null>(null)
  const [picker, setPicker] = useState<AgentPicker | null>(null)
  const [setupSteps, setSetupSteps] = useState<SetupStep[] | null>(null)

  const loadBackends = useCallback(() => {
    void api().remoteAgentOptions?.().then((p) => p && setPicker(p)).catch(() => {})
    void api().remoteGetSetupStatus?.()
      .then((v) => setSetupSteps((v?.steps ?? []).filter((step) => step.key.startsWith('backend-'))))
      .catch(() => setSetupSteps([]))
  }, [])

  useEffect(() => {
    void api().remoteGetSettings?.().then((v) => v && setS(v))
    loadBackends()
    // Stay in sync when the model is changed from the capture-widget badge.
    const off = api().remoteOnModelChanged?.((model) => setS((prev) => (prev ? { ...prev, model } : prev)))
    return () => { off?.() }
  }, [loadBackends])

  if (!s) return null

  const update = (patch: Partial<Settings>) => setS((prev) => (prev ? { ...prev, ...patch } : prev))

  // Offered = usable right now, or installed and one step from usable. An
  // installed-but-unarmed backend must stay visible: hiding it leaves the user
  // with no way to connect it.
  const offered = (picker?.options ?? []).filter((o) => o.available || o.installed)
  // NOTHING INSTALLED (spec §3.7). Only once the probe has actually answered —
  // an empty `picker` before the first reply is "not known yet", not "none".
  if (picker && offered.length === 0) {
    return <NoAgents steps={setupSteps ?? []} onHowItWorks={onOpenHowItWorks} onRecheck={loadBackends} />
  }

  // 'codex' is the unwired CLI adapter; startup migrates a stored one back to
  // claude, so it is never the selected value here.
  const agentId = picker?.current ?? (s.agent === 'codex' ? 'claude' : s.agent)
  const selected = offered.find((o) => o.id === agentId)

  const pickAgent = (id: string) => {
    update({ agent: id as Settings['agent'] })
    setPicker((prev) => (prev ? { ...prev, current: id } : prev))
    void api().remoteSetAgent?.(id)
  }

  return (
    <div>
      {/* The Agent's settings moved to their own destination in the sidebar.
          They were three levels down here — Orchestrator → Settings → scroll —
          which is the wrong depth for the one part of Unmute you address
          directly, and it made the Agent read like a feature of task routing
          rather than its own thing. */}

      <div className="flex items-center justify-between">
        <SectionHeader icon={<AgentIcon />} title="Orchestrator agent" />
        {/* Drawn only when the tab above can actually be navigated. Unwired, the
            tab's own "How it works" segment is the route — this would only be a
            link that moves the content and leaves the selection behind. */}
        {onOpenHowItWorks && (
          <button
            className="text-[11px] font-medium text-ink-35 hover:text-ink mt-5 mb-2.5"
            onClick={onOpenHowItWorks}
          >
            How it works →
          </button>
        )}
      </div>
      <Panel>
        <div className="px-5 py-4">
          <p className="text-[13px] font-medium text-ink mb-2.5">Where your tasks run</p>
          {/* NOT a native dropdown. Each backend states what it is good at,
              because "Claude Code CLI vs Codex desktop" is a real difference in
              what the ticket can then do — one has a live terminal and a Resume,
              the other has a thread in another app. */}
          <div className="space-y-1.5">
            {offered.map((o) => {
              const on = o.id === agentId
              return (
                <button
                  key={o.id}
                  onClick={() => pickAgent(o.id)}
                  className={`w-full text-left px-3.5 py-3 rounded-[10px] border transition-colors ${
                    on ? 'border-ink bg-cream-mid' : 'border-border bg-white hover:bg-cream-mid'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {/* THE MARK, THEN THE NAME. This row is where a backend is
                        chosen, so it should look like the cards the choice
                        produces. The availability dot stays — unlike the pill,
                        this list shows backends you have NOT connected, and
                        "which of these is ready" is the question the row is
                        answering. */}
                    <ProviderGlyph backend={o.id} title={o.label}
                                   style={{ opacity: o.available ? 1 : 0.4 }} />
                    <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${o.available ? 'bg-success' : 'bg-ink-35'}`} />
                    <span className="text-[13px] font-medium text-ink">{o.label}</span>
                    {!o.available && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-ink-35">not connected</span>
                    )}
                  </span>
                  {AGENT_PITCH[o.id] && (
                    <span className="block text-[11px] text-ink-35 mt-1 leading-relaxed">{AGENT_PITCH[o.id]}</span>
                  )}
                </button>
              )
            })}
          </div>
          {selected && !selected.available && (
            <p className="text-[11px] text-ink-35 mt-2.5 leading-relaxed">
              {selected.label} is installed but not connected. Open <b>Agents &amp; setup</b> above
              to connect it — until then, tasks fall back to whichever agent is ready.
            </p>
          )}
        </div>
      </Panel>

      <SectionHeader icon={<ModelIcon />} title="Model" />
      <Panel>
        <div className="px-5 py-4">
          <p className="text-[13px] font-medium text-ink">Applies to the next task</p>
          <p className="text-[11px] text-ink-35 mt-0.5 mb-2.5">
            Tasks already running keep the model they started on — a card always says what it ran.
          </p>          <Models
            agentId={agentId}
            model={s.model}
            onPickModel={(id) => { update({ model: id }); void api().remoteSetModel?.(id) }}
          />

          {agentId === 'codex' && (
            <div className="mt-4 pt-4 border-t border-border">
              <SettingRow
                label="Let unmute's Codex tasks use your whole Mac"
                description="Codex normally asks before touching anything outside the task folder, and has no network. Turn this on and unmute's own Codex tasks run without stopping to ask. Your own codex sessions are never affected. If you've set allowed folders under Reach, those win and this does nothing."
              >
                <Toggle
                  checked={s.codexFullAccessConsent === true}
                  onChange={(on) => { update({ codexFullAccessConsent: on }); void api().remoteSetCodexFullAccess?.(on) }}
                />
              </SettingRow>
            </div>
          )}
        </div>
      </Panel>

      <SectionHeader icon={<ReachIcon />} title="Reach" />
      <Panel>
        <SettingRow
          label="Auto-approve actions"
          description="No per-action prompts. Off means the agent asks before it acts."
        >
          <Toggle
            checked={s.permissionMode === 'auto-approve'}
            onChange={(on) => {
              const mode = on ? 'auto-approve' : 'prompt'
              update({ permissionMode: mode })
              void api().remoteSetPermissionMode?.(mode)
            }}
          />
        </SettingRow>
        <Sandbox
          roots={s.sandboxRoots}
          onChange={(roots) => { update({ sandboxRoots: roots }); void api().remoteSetSandboxRoots?.(roots) }}
        />
      </Panel>

      <SectionHeader icon={<LaneIcon />} title="What tasks can drive" />
      <Panel>
        <SettingRow
          label="Browser tasks"
          description="Drives your real, already-signed-in Chrome through the extension."
        >
          <Toggle
            checked={s.browserEnabled}
            onChange={(browserEnabled) => { update({ browserEnabled }); void api().remoteSetBrowserEnabled?.(browserEnabled) }}
          />
        </SettingRow>
        {/* Computer Use owns its own IPC and renders its own row. Browser drives
            Chrome; this drives every other desktop app. */}
        <ComputerUseSettings />
        <SettingRow
          label="Agent-created tasks"
          description="Lets a running task put new tasks on the wall — always labelled, rate-limited, never able to touch existing work."
        >
          <Toggle
            checked={s.agentTasksEnabled ?? true}
            onChange={(on) => { update({ agentTasksEnabled: on }); void api().remoteSetAgentTasks?.(on) }}
          />
        </SettingRow>
        <SettingRow
          label="Raw mode"
          description="Start each session clean, with no Unmute context injected. The pill can flip this for one session."
        >
          <Toggle
            checked={s.forceRawMode}
            onChange={(on) => { update({ forceRawMode: on }); void api().remoteSetForceRaw?.(on) }}
          />
        </SettingRow>
        <SettingRow
          label="macOS notifications"
          description="Off by default — the notch already tells you when a task needs you."
        >
          <Toggle
            checked={s.osNotifications}
            onChange={(on) => { update({ osNotifications: on }); void api().remoteSetOsNotifications?.(on) }}
          />
        </SettingRow>
      </Panel>
    </div>
  )
}
