// Unmute Remote — Claude desktop's OWN model catalogue, read from its bundle.
//
// The picker must offer exactly what Claude Desktop offers. Anything else is a
// picker that lies: choose a model the app does not have and either nothing
// happens or you silently get something else.
//
// ── Where this comes from, and why ────────────────────────────────────────
//
// /Applications/Claude.app/Contents/Resources/app.asar — a local file, part of
// the app already installed on this machine. No network, no API, no auth. An
// .asar is Electron's archive format (JSON index + concatenated files), and the
// catalogue is an object literal compiled into the app's bundled JavaScript:
//
//   {id:"claude-opus-5",family:"opus",display_name:"Opus 5",
//    capabilities:["effort","max_effort","xhigh_effort",…],default_effort:"high"}
//
// It is the SAME table the app reads to draw its own dropdown, which is exactly
// why it cannot drift from what the user sees.
//
// READ ONLY. Nothing here writes to, patches, or injects into that bundle.
//
// ── Why not the other sources ─────────────────────────────────────────────
//
//   The dropdown itself   Not exposed over accessibility. Pressing the popup
//                         produced ZERO new nodes — backgrounded AND frontmost
//                         (measured 2026-08-01). AXWindows is empty on this app,
//                         so a popover in its own window is invisible to us. Not
//                         expensive: impossible.
//   A hardcoded list      Authored by us, and wrong the day a model ships.
//   The session store     Gives the id a task USES (claude-opus-5) but never the
//                         display name, and never what is selectable.
//
// ── The catch, and how this file handles it ───────────────────────────────
//
// This is an implementation detail of another app, not a contract. A future
// build can restructure that JavaScript and the parse breaks. So it MUST fail
// visibly: an empty catalogue means callers fall back to raw ids, which are
// ugly but true. Silently serving a stale list would be the lying picker again,
// which is the one outcome worth avoiding.
//
// Also: this lists what the APP knows, which may exceed what the user's plan can
// select. Where the catalogue and the live composer disagree, the composer wins
// — it is the only thing that knows what actually happened.

import { promises as nodeFs } from 'node:fs'
import { createLogger } from '../log'

/**
 * Unpatched fs, because the file we read IS an .asar.
 *
 * Electron patches `fs` so any path containing `.asar` is treated as an ARCHIVE
 * TO LOOK INSIDE rather than a file to read. Reading Claude Desktop's bundle
 * with the normal fs therefore asks for an empty path *within* that archive and
 * fails:
 *
 *   ENOENT,  not found in /Applications/Claude.app/Contents/Resources/app.asar
 *
 * `original-fs` is Electron's own escape hatch and is unpatched. Resolved
 * through a variable so a bundler cannot try to follow it, and falling back to
 * node:fs outside Electron — which is exactly where the tests run, and why this
 * bug could not surface until the code was inside a packaged app.
 */
function archiveFs(): typeof nodeFs {
  try {
    const req = eval('require') as NodeRequire
    const mod = req('original-fs') as { promises: typeof nodeFs }
    return mod.promises ?? nodeFs
  } catch {
    return nodeFs
  }
}

const log = createLogger('claude-desktop-catalog')

export const DEFAULT_ASAR_PATH = '/Applications/Claude.app/Contents/Resources/app.asar'

export interface ClaudeModel {
  /** e.g. 'claude-opus-5' — matches the `model` field in the session store. */
  id: string
  /** e.g. 'Opus 5' — what the app calls it. */
  label: string
  /** e.g. 'opus'. */
  family: string
  /** Effort levels this model accepts, [] when it has no effort axis. */
  effortLevels: string[]
  /** The effort it starts on, null when it has no effort axis. */
  defaultEffort: string | null
  /** The app's own ordering hint; higher = more capable. 0 when absent — not
   *  every entry carries one, and requiring it silently dropped real models. */
  rank: number
  /** Everything the bundle says this model can do. Emptiness is meaningful:
   *  a model with NO capabilities is not offered by the app. */
  capabilities: string[]
  /** Position in the bundle, oldest-first. The tiebreak within a family: three
   *  Opus models share advisor_rank 4, so rank alone cannot say which is
   *  newest, and sorting by label makes "Opus 4.7" beat "Opus 5" alphabetically.
   *  Source order is the app's own answer and needs no version parsing. */
  order: number
  /** Every id this model is ALSO known by — the dated and per-provider forms
   *  from `provider_ids`. The session store records the dated one
   *  ('claude-opus-4-5-20251101'), so without these the label never resolves. */
  aliases: string[]
}

/**
 * Effort vocabularies as the bundle spells them.
 *
 * Taken from the bundle rather than invented — it carries several variants
 * (["low","medium","high","xhigh","max"], ["low","medium","high","max"], …), so
 * the levels a model offers are derived from ITS capabilities, not from one
 * global list.
 */
const EFFORT_BASE = ['low', 'medium', 'high']

function effortFor(capabilities: readonly string[]): string[] {
  if (!capabilities.includes('effort')) return []
  const out = [...EFFORT_BASE]
  // Order matters: xhigh sits between high and max wherever both appear.
  if (capabilities.includes('xhigh_effort')) out.push('xhigh')
  if (capabilities.includes('max_effort')) out.push('max')
  return out
}

/**
 * Parse the catalogue out of the bundled JavaScript.
 *
 * Deliberately tolerant: it matches one ENTRY at a time and skips anything that
 * does not fit, so a new field or a reordered object costs us that entry rather
 * than the whole list. Exported for tests — the fixture is a real excerpt.
 */
export function parseCatalog(source: string): ClaudeModel[] {
  const out = new Map<string, ClaudeModel>()
  // An entry begins at `{id:"claude-…",family:"…",display_name:"…"`. Everything
  // after is optional and matched within the entry's own span, which ends where
  // the next entry begins. advisor_rank is NOT required: several real models
  // (Opus 4.6 among them) carry a display_name and no rank, and demanding one
  // dropped them from the catalogue entirely.
  const head = /\{id:"(claude-[a-z0-9.\-[\]]+)",family:"(\w+)",display_name:"([^"]+)"/g
  const starts: Array<{ id: string; family: string; label: string; at: number }> = []
  let m: RegExpExecArray | null
  while ((m = head.exec(source)) !== null) {
    starts.push({ id: m[1], family: m[2], label: m[3], at: m.index })
  }

  for (let i = 0; i < starts.length; i++) {
    const s0 = starts[i]
    if (out.has(s0.id)) continue                    // the bundle repeats entries
    const body = source.slice(s0.at, starts[i + 1]?.at ?? Math.min(source.length, s0.at + 2400))

    const caps = /capabilities:\[([^\]]*)\]/.exec(body)
    const capabilities = caps ? caps[1].split(',').map((c) => c.trim().replace(/"/g, '')).filter(Boolean) : []
    const deff = /default_effort:"(\w+)"/.exec(body)
    const rank = /advisor_rank:(\d+)/.exec(body)

    // Every id under provider_ids — first_party is usually the DATED form, and
    // that is exactly what the session store writes.
    const aliases = new Set<string>()
    const pid = /provider_ids:\{([^}]*)\}/.exec(body)
    if (pid) {
      for (const v of pid[1].matchAll(/"([^"]+)"/g)) {
        const raw = v[1]
        if (raw && raw !== 'null') aliases.add(raw)
      }
    }
    aliases.delete(s0.id)

    out.set(s0.id, {
      id: s0.id,
      label: s0.label,
      family: s0.family,
      order: i,
      capabilities,
      effortLevels: effortFor(capabilities),
      defaultEffort: deff ? deff[1] : null,
      rank: rank ? Number(rank[1]) : 0,
      aliases: [...aliases],
    })
  }
  return [...out.values()].sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label))
}

/** Cache key: a re-parse is only needed when the bundle itself changes, which
 *  happens on a Claude Desktop update and at no other time. */
let cache: { key: string; models: ClaudeModel[] } | null = null

/**
 * The catalogue, or [] when it cannot be read or understood.
 *
 * [] is a real answer meaning "we do not know what this app offers", and callers
 * must degrade to raw ids rather than substituting a list of their own.
 */
export async function readCatalog(asarPath = DEFAULT_ASAR_PATH): Promise<ClaudeModel[]> {
  const fs = archiveFs()
  let key: string
  try {
    const st = await fs.stat(asarPath)
    key = `${asarPath}:${st.mtimeMs}:${st.size}`
  } catch {
    log.debug('catalog-no-bundle', { asarPath })
    return []
  }
  if (cache && cache.key === key) return cache.models

  let models: ClaudeModel[] = []
  try {
    // 37MB, read once per app update. Read as latin1: we only ever match ASCII
    // and this avoids the cost and failure modes of decoding a binary archive
    // as UTF-8.
    const buf = await fs.readFile(asarPath)
    models = parseCatalog(buf.toString('latin1'))
  } catch (e) {
    log.warn('catalog-read-failed', { error: (e as Error).message })
    return []
  }

  if (!models.length) {
    // LOUD on purpose. An empty catalogue means Claude Desktop restructured its
    // bundle and this parser needs updating; the UI degrades to raw ids, which
    // is survivable, but it must not be invisible.
    log.warn('catalog-empty', { asarPath, note: 'bundle shape may have changed — picker falls back to raw model ids' })
  } else {
    log.event('catalog-read', { models: models.length })
  }
  cache = { key, models }
  return models
}

/** The app's display name for a model id, or null when we cannot know it.
 *  Null means "show the raw id" — never a guessed prettification. */
export function labelFor(models: readonly ClaudeModel[], id: string | null | undefined): string | null {
  if (!id) return null
  // '[1m]' is the bundle's own marker for the 1M-context variant of a model
  // (`supports_1m_suffix`), not a different model — so it is stripped when
  // resolving a label. Stripping anything else would be inventing a mapping.
  const bare = id.replace(/\[1m\]$/, '')
  const hit = models.find((m) => m.id === bare || m.aliases.includes(bare))
  return hit?.label ?? null
}

/**
 * The models the app actually offers — matched exactly, not guessed.
 *
 * Claude Desktop's own menu was read off-screen and holds EIGHT: four at the
 * top level and four behind "More models >".
 *
 *     Fable 5  Opus 5  Sonnet 5  Haiku 4.5
 *     More models >  Opus 4.8  Opus 4.7  Opus 4.6  Sonnet 4.6
 *
 * Two fields reproduce that set exactly across all 17 in the bundle — nothing
 * missing, nothing extra:
 *
 *   advisor_rank >= 1       drops the legacy models (Sonnet 3.5, Opus 4,
 *                           Opus 4.1, Opus 4.5, Sonnet 4, Sonnet 4.5,
 *                           Haiku 3.5 — all rank 0)
 *   capabilities non-empty  drops Mythos 5, which is rank 5 with an EMPTY
 *                           capabilities array. It is the one model in the
 *                           bundle and not in the menu, and this is the field
 *                           that distinguishes it.
 *
 * Three earlier rules were wrong and the app disagreed with each: top-two-ranks
 * (offered Opus 4.7/4.8 while hiding Sonnet 5 and Haiku 4.5), newest-per-family
 * (hid five real models — Opus 4.8/4.7/4.6 and Sonnet 4.6 are real, just behind
 * the submenu), and an alphabetical tiebreak (picked Opus 4.7 over Opus 5).
 * This one was derived the other way round: read the menu first, then find the
 * fields that reproduce it.
 *
 * If a future build disagrees again, re-read the menu — do not add a third
 * condition here.
 */
export function offeredModels(models: readonly ClaudeModel[]): ClaudeModel[] {
  return models
    .filter((m) => m.rank >= 1 && m.capabilities.length > 0)
    .sort((a, b) => b.rank - a.rank || b.order - a.order)
}

/** Reset the cache. Tests only. *//** Reset the cache. Tests only. */
export function __resetCatalogCache(): void { cache = null }
