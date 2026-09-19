// Unmute Remote — runtime config (remote-hosted, self-updating, fail-safe).
//
// WHY this exists
// ---------------
// config.ts holds the COMPILED FLOOR: the model aliases, the two static
// prompts, and (via the knob defaults below) the behavioral tuning numbers,
// all baked into the bundle. Changing any of them used to require shipping a
// new app build. This module lifts that ceiling: the same values can be
// overridden at RUNTIME from a small JSON we host, so we can retune models,
// prompts (incl. the whole operating contract), and behavioral knobs across
// the fleet WITHOUT a build.
//
// THE MODEL (settled with the user)
// ---------------------------------
// Three layers, each only ever OVERRIDES the one beneath — never breaks it:
//
//     compiled floor (config.ts, version 0)         ← ships in the build
//       ← disk cache (last-fetched remote)           ← ratchets forward
//         ← live remote fetch (non-blocking)         ← what we push
//           ← optional local override file            ← dev / power-user escape
//
// Boot is INSTANT: getModels()/getPrompts()/getKnobs() read an in-memory object
// that is populated synchronously from (floor ⊕ cache ⊕ local-override) before
// initRuntimeConfig() returns. The network fetch happens in the BACKGROUND and,
// if a newer version arrives, is written to the cache and folded into the live
// object. So there is never a per-request network wait — only eventual
// propagation across users, which is fine for config like this.
//
// FAIL-SAFE: a missing file, dead server, malformed JSON, or an invalid value
// each simply falls through to the layer beneath — ultimately the compiled
// floor. Config can only ever make the app DIFFERENT, never BROKEN. Every
// override is validated per-key (models via isDoerModel, prompts non-empty,
// knobs finite + within bounds); anything invalid is logged and dropped.
//
// This module is pure/injectable (fs dir + fetch + clock are all parameters),
// so it is unit-tested without Electron — see runtime-config.test.ts.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { MODELS, PROMPTS, MODEL_CATALOG, modelsFor, providerOfModel, type DoerModel, type ModelChoice } from './config'
import { CONTRACT_TEXT } from './contract/contract-text'
import { createLogger } from './log'

const log = createLogger('runtime-config')

// ─── The overridable surface (Tier A: models + prompts, Tier B: knobs) ───────

export interface ConfigModels {
  doerDefault: DoerModel
  router: DoerModel
  librarian: DoerModel
  /** The selectable model catalog (config-driven). The doer selector renders
   *  this; picks (doerDefault/router/librarian) must be one of these ids. */
  available: ModelChoice[]
}

/** Static, self-contained prompts — safe to override as whole strings. The
 *  dynamically-assembled templates (buildRoutingPrompt/buildLibrarianPrompt/
 *  buildDispatch) interpolate live state and stay in code by design. */
export interface ConfigPrompts {
  intentCleanup: string
  taskName: string
  /** The entire executor operating contract auto-loaded into every task. */
  contract: string
}

export interface ConfigKnobs {
  /** Consent: how long a user interaction keeps a session auto-routable. */
  hotThreadMs: number
  /** Max screenshots auto-staged per remote capture. */
  captureMaxAuto: number
  /** MCP intercom: max tasks one task may spawn. */
  mcpMaxSpawnsPerTask: number
  /** MCP intercom: min gap between task creations. */
  mcpMinSpawnGapMs: number
  /** Local MCP server port. */
  mcpPort: number
  /** Heartbeat-silence window before a task is flagged possibly-stuck. */
  taskStaleMs: number
  /** Idle keep-alive for a parked session before hard-kill. */
  taskWarmMs: number
  /** Shorter warm window for navigate-category tasks. */
  taskNavigateWarmMs: number
  /** Retire a one-off untouched this long (sessions and renamed tasks are exempt). */
  taskPurgeAgeMs: number
  /** A ready ONE-OFF ignored this long decays to done (ready-inflation valve). */
  readyDecayMs: number
  /** Router: max wait for a routing decision. */
  routerDecisionTimeoutMs: number
  /** Router: max lifetime of a router session before recycle. */
  routerMaxSessionMs: number
  /** Curator: minimum gap between sweeps (the twice-daily ceiling). */
  curatorSweepIntervalMs: number
  /**
   * Router transport: 1 = headless (pipe + schema), 0 = the PTY REPL.
   *
   * A number because this tier is numeric-only, and worth the ugliness: it
   * rides the same remote-config path as everything else here, so if headless
   * ever stops being covered by the CLI subscription this reverts across the
   * fleet WITHOUT shipping a build. The REPL path stays whole and tested for
   * exactly that reason.
   */
  routerHeadless: number
}

export interface RuntimeConfigData {
  version: number
  models: ConfigModels
  prompts: ConfigPrompts
  knobs: ConfigKnobs
}

// ─── Knob spec: default + accepted bounds (out-of-bounds ⇒ dropped) ──────────

interface KnobSpec { def: number; min: number; max: number }
const DAY = 24 * 60 * 60_000
const KNOB_SPEC: Record<keyof ConfigKnobs, KnobSpec> = {
  hotThreadMs:             { def: 10 * 60_000,   min: 1_000,  max: DAY },
  captureMaxAuto:          { def: 12,            min: 1,      max: 1_000 },
  mcpMaxSpawnsPerTask:     { def: 5,             min: 1,      max: 1_000 },
  mcpMinSpawnGapMs:        { def: 10_000,        min: 0,      max: DAY },
  mcpPort:                 { def: 42117,         min: 1_024,  max: 65_535 },
  taskStaleMs:             { def: 4 * 60_000,    min: 1_000,  max: DAY },
  taskWarmMs:              { def: 15 * 60_000,   min: 1_000,  max: 7 * DAY },
  taskNavigateWarmMs:      { def: 8 * 60_000,    min: 1_000,  max: 7 * DAY },
  taskPurgeAgeMs:          { def: 3 * DAY,       min: 60_000, max: 30 * DAY }, // one-offs only; sessions + renamed are exempt
  readyDecayMs:            { def: 60 * 60_000,   min: 60_000, max: 7 * DAY },
  routerDecisionTimeoutMs: { def: 60_000,        min: 1_000,  max: 10 * 60_000 },
  routerMaxSessionMs:      { def: 2 * 60 * 60_000, min: 60_000, max: DAY },
  curatorSweepIntervalMs:  { def: 12 * 60 * 60_000, min: 60_000, max: 30 * DAY },
  routerHeadless:          { def: 1,             min: 0,      max: 1 },
}

function knobDefaults(): ConfigKnobs {
  const out = {} as ConfigKnobs
  for (const k of Object.keys(KNOB_SPEC) as Array<keyof ConfigKnobs>) out[k] = KNOB_SPEC[k].def
  return out
}

/** The compiled floor — the bundled source-of-truth, version 0. Deep-cloned on
 *  read so a mutation of the live config can never scribble on the floor. */
export function compiledDefaults(): RuntimeConfigData {
  return {
    version: 0,
    models: {
      doerDefault: MODELS.doerDefault, router: MODELS.router, librarian: MODELS.librarian,
      available: MODEL_CATALOG.map((c) => ({ ...c })), // clone so the live config can't scribble the floor
    },
    prompts: { intentCleanup: PROMPTS.intentCleanup, taskName: PROMPTS.taskName, contract: CONTRACT_TEXT },
    knobs: knobDefaults(),
  }
}

// ─── Validation + merge (each override only ever refines the base) ───────────

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** Validate a config-provided model catalog: keep only entries with a non-empty
 *  string id + label, de-duplicated. Anything malformed is skipped.
 *
 *  `provider` IS CARRIED THROUGH, and the de-dup key is (provider, id) rather
 *  than id. Both used to be otherwise, and both were silent data loss:
 *
 *  • Dropping the tag meant a config could never describe a non-Claude model —
 *    every entry came back untagged, which `modelsFor` reads as Claude. Adding
 *    Codex models to the served config would have put them in Claude's picker.
 *  • De-duping on the bare id meant the SECOND 'default' lost. Every backend
 *    has a 'default'; on any config carrying two backends, one of them silently
 *    had its default entry deleted.
 *
 *  An UNRECOGNISED provider is kept as-is, not coerced to Claude. It then
 *  belongs to no backend that exists yet and shows up nowhere — which is what a
 *  config from a newer app should do on an older one, rather than leaking a
 *  future backend's models into today's menu. */
function sanitizeCatalog(v: unknown): ModelChoice[] {
  if (!Array.isArray(v)) return []
  const out: ModelChoice[] = []
  const seen = new Set<string>()
  for (const e of v) {
    if (!e || typeof e !== 'object') continue
    const { id, label, description, provider } = e as Record<string, unknown>
    if (!isNonEmptyString(id) || !isNonEmptyString(label)) continue
    const p = isNonEmptyString(provider) ? provider.trim() : undefined
    const key = `${p ?? 'claude'} ${id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id, label,
      description: isNonEmptyString(description) ? description : undefined,
      ...(p ? { provider: p as ModelChoice['provider'] } : {}),
    })
  }
  return out
}

/**
 * Fold a config catalog over the compiled one, PER BACKEND.
 *
 * A config layer replaces the models of every backend it mentions, and leaves
 * every backend it does not mention exactly as it found it.
 *
 * IT USED TO REPLACE THE WHOLE LIST, and that is what emptied Codex CLI's
 * picker in 1.4.24-dev.4. The served config (version 2) lists eight Claude
 * models and knows nothing about Codex — it was written before Codex CLI was a
 * backend. Replacing wholesale deleted the four compiled Codex entries, so
 * `modelsFor('codex')` returned nothing: no models in the menu, and the pill
 * fell back to showing the raw id 'default' because there was no entry left to
 * read a label from.
 *
 * The shape of that bug matters more than the instance. Every backend added
 * from here on is born into a served config that predates it, so a whole-list
 * replace deletes each new backend's models the moment the app fetches — which
 * reads as "the feature was never built" and cannot be fixed from the app.
 * Per-provider means a config only ever speaks for what it names.
 */
function foldCatalog(base: readonly ModelChoice[], override: readonly ModelChoice[]): ModelChoice[] {
  const spokenFor = new Set(override.map(providerOfModel))
  const kept = base.filter((c) => !spokenFor.has(providerOfModel(c)))
  return [...override.map((c) => ({ ...c })), ...kept]
}

/** Fold a partial override over a base, dropping (and logging) any invalid key.
 *  Never throws — a bad layer degrades to the base, never to a crash. */
export function mergeConfig(base: RuntimeConfigData, override: unknown, source: string): RuntimeConfigData {
  const out: RuntimeConfigData = {
    version: base.version,
    models: { ...base.models },
    prompts: { ...base.prompts },
    knobs: { ...base.knobs },
  }
  if (!override || typeof override !== 'object') return out
  const o = override as Record<string, unknown>

  if (typeof o.version === 'number' && Number.isFinite(o.version)) out.version = o.version

  const m = o.models as Record<string, unknown> | undefined
  if (m && typeof m === 'object') {
    // 1. Catalog: a valid non-empty array replaces the selectable set FOR THE
    //    BACKENDS IT NAMES (config defines the catalog — that's how new models
    //    arrive without a build). Invalid/empty → keep the base catalog.
    if ('available' in m) {
      const sanitized = sanitizeCatalog(m.available)
      if (sanitized.length) out.models.available = foldCatalog(out.models.available, sanitized)
      else log.warn('dropped invalid model catalog override', { source })
    }
    // 2. Picks: accept a model only if it's in the EFFECTIVE catalog just set.
    //    CLAUDE'S HALF of it — these three keys name Claude models (see MODELS
    //    in config.ts), and an unscoped check would accept a Codex id for the
    //    router, which then runs every classification against a model the
    //    Claude CLI does not have.
    const allowed = new Set(modelsFor('claude', out.models.available).map((c) => c.id))
    for (const k of ['doerDefault', 'router', 'librarian'] as const) {
      if (k in m) {
        if (typeof m[k] === 'string' && allowed.has(m[k] as string)) out.models[k] = m[k] as string
        else log.warn('dropped model override not in catalog', { source, key: k, value: m[k] })
      }
    }
  }

  const p = o.prompts as Record<string, unknown> | undefined
  if (p && typeof p === 'object') {
    for (const k of ['intentCleanup', 'taskName', 'contract'] as const) {
      if (k in p) {
        if (isNonEmptyString(p[k])) out.prompts[k] = p[k] as string
        else log.warn('dropped invalid prompt override', { source, key: k })
      }
    }
  }

  const kn = o.knobs as Record<string, unknown> | undefined
  if (kn && typeof kn === 'object') {
    for (const k of Object.keys(KNOB_SPEC) as Array<keyof ConfigKnobs>) {
      if (k in kn) {
        const v = kn[k]
        const spec = KNOB_SPEC[k]
        if (typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max) out.knobs[k] = v
        else log.warn('dropped out-of-bounds knob override', { source, key: k, value: v, min: spec.min, max: spec.max })
      }
    }
  }

  return out
}

// ─── Live state ──────────────────────────────────────────────────────────────

// The hosted config lives on the pipeline worker (same origin as /v1/stt|llm|me),
// but on a PUBLIC route — fetched with no auth so offline-first / not-signed-in
// apps still get it. Served from backend/cloudflare/shared/remoteConfig.ts.
const REMOTE_URL = 'https://unmute-pipeline.zodpatel.workers.dev/v1/remote-config'
const CACHE_FILE = 'unmute-remote-config.cache.json'   // written by the fetcher (last-known-good)
const OVERRIDE_FILE = 'unmute-remote-config.json'      // optional, user-hand-edited
const REFRESH_INTERVAL_MS = 6 * 60 * 60_000            // slow background refresh

interface RuntimeConfigOpts {
  /** Directory for the cache + optional override file (app.getPath('userData')). */
  userDataDir: string
  /** Remote config URL. Defaults to the hosted endpoint; '' disables fetching. */
  remoteUrl?: string
  /** Injected fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injected clock (tests). */
  now?: () => number
  /** Start the background refresh timer. Off in tests. */
  autoRefresh?: boolean
}

let opts: Required<RuntimeConfigOpts> | null = null
let live: RuntimeConfigData = compiledDefaults()
let cache: RuntimeConfigData | null = null      // last accepted remote layer
let localOverride: unknown = null               // parsed override file (raw)
let refreshTimer: ReturnType<typeof setInterval> | null = null

function cachePath(): string { return join(opts!.userDataDir, CACHE_FILE) }
function overridePath(): string { return join(opts!.userDataDir, OVERRIDE_FILE) }

/** Recompute the live object: floor ⊕ cache ⊕ local-override. */
function recompute(): void {
  let next = compiledDefaults()
  if (cache) next = mergeConfig(next, cache, 'cache')
  if (localOverride) next = mergeConfig(next, localOverride, 'local-override')
  live = next
}

function readJsonFile(path: string): unknown {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    log.warn('unreadable config file — ignoring', { path, error: (e as Error).message })
    return null
  }
}

/**
 * Load cache + local override synchronously and populate the live object, then
 * (if autoRefresh) kick off a NON-BLOCKING remote fetch + slow refresh timer.
 * Safe to call once at startup. Idempotent-ish: re-calling re-inits.
 */
export function initRuntimeConfig(o: RuntimeConfigOpts): void {
  opts = {
    userDataDir: o.userDataDir,
    remoteUrl: o.remoteUrl ?? REMOTE_URL,
    fetchImpl: o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
    now: o.now ?? Date.now,
    autoRefresh: o.autoRefresh ?? false,
  }
  // Layer 2: last-known-good remote, persisted to disk.
  const cached = readJsonFile(cachePath())
  cache = cached ? mergeConfig(compiledDefaults(), cached, 'cache') : null
  // Layer 4: optional hand-edited override.
  localOverride = readJsonFile(overridePath())
  recompute()
  log.event('runtime-config-init', { version: live.version, hasCache: !!cache, hasOverride: !!localOverride })

  if (opts.autoRefresh && opts.remoteUrl) {
    void refreshRemoteConfig()
    refreshTimer = setInterval(() => { void refreshRemoteConfig() }, REFRESH_INTERVAL_MS)
    ;(refreshTimer as { unref?: () => void }).unref?.()
  }
}

/**
 * Fetch the remote config once. Accepts it ONLY if it parses, validates, and
 * carries a version STRICTLY NEWER than the current cache (monotonic ratchet).
 * On accept: writes the cache file and folds it into the live object. Any
 * failure is swallowed — the live object is untouched. Returns the outcome.
 */
export async function refreshRemoteConfig(): Promise<'updated' | 'unchanged' | 'unavailable'> {
  if (!opts || !opts.remoteUrl) return 'unavailable'
  const currentVersion = cache?.version ?? 0
  try {
    const res = await opts.fetchImpl(opts.remoteUrl, { headers: { accept: 'application/json' } })
    if (!res.ok) { log.warn('remote config fetch non-ok', { status: res.status }); return 'unavailable' }
    const raw = await res.json()
    const incomingVersion = (raw && typeof raw === 'object' && typeof (raw as { version?: unknown }).version === 'number')
      ? (raw as { version: number }).version : NaN
    if (!Number.isFinite(incomingVersion)) { log.warn('remote config missing numeric version — ignored'); return 'unavailable' }
    if (incomingVersion <= currentVersion) { log.event('runtime-config-unchanged', { version: currentVersion }); return 'unchanged' }
    // Accept: validate into a cache layer, persist raw, fold in.
    cache = mergeConfig(compiledDefaults(), raw, 'remote')
    persistCache(raw)
    recompute()
    log.event('runtime-config-updated', { from: currentVersion, to: live.version })
    return 'updated'
  } catch (e) {
    log.warn('remote config fetch failed — keeping current', { error: (e as Error).message })
    return 'unavailable'
  }
}

function persistCache(raw: unknown): void {
  try {
    const p = cachePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(raw), 'utf8')
  } catch (e) {
    log.warn('could not persist config cache', { error: (e as Error).message })
  }
}

/** Stop the background refresh timer (teardown / tests). */
export function stopRuntimeConfig(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
}

/** TEST ONLY: reset module state to the compiled floor. */
export function __resetRuntimeConfigForTest(): void {
  stopRuntimeConfig()
  opts = null; cache = null; localOverride = null; live = compiledDefaults()
}

// ─── Synchronous accessors (the hot path — never touch the network) ──────────

export function getModels(): ConfigModels { return live.models }
/** The effective (config-extended) selectable model catalog — for the selector.
 *
 *  SCOPED TO A BACKEND, and defaulting to Claude. The catalog gained Codex
 *  entries when Codex CLI became a provider, so an unscoped read started
 *  returning both sets — nine models in the picker, two of them called
 *  'default'. Every existing caller wants Claude's, and gets it by asking for
 *  nothing, which is the same contract `modelsFor` uses. */
export function getModelCatalog(provider?: string): ModelChoice[] {
  return modelsFor(provider, live.models.available)
}
/** True if `id` is a model a user may currently select ON THIS BACKEND.
 *
 *  Scoped for the same reason getModelCatalog is: unscoped, this said yes to a
 *  Codex id being written into Claude's `model` setting — a menu showing one
 *  backend silently changing what the other one runs on. Defaults to Claude,
 *  which is what both callers mean. */
export function isSelectableModel(id: unknown, provider?: string): id is string {
  return typeof id === 'string' && modelsFor(provider, live.models.available).some((c) => c.id === id)
}
export function getPrompts(): ConfigPrompts { return live.prompts }
export function getKnobs(): ConfigKnobs { return live.knobs }
/** The full effective config — for IPC/debug surfaces. */
export function getEffectiveConfig(): RuntimeConfigData { return live }
