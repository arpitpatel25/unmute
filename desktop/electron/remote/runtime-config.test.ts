import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MODELS, PROMPTS, MODEL_CATALOG, modelsFor } from './config.ts'
import { CONTRACT_TEXT } from './contract/contract-text.ts'
import {
  compiledDefaults, mergeConfig,
  initRuntimeConfig, refreshRemoteConfig, stopRuntimeConfig, __resetRuntimeConfigForTest,
  getModels, getPrompts, getKnobs, getEffectiveConfig, getModelCatalog, isSelectableModel,
  type RuntimeConfigData,
} from './runtime-config.ts'

function tmp(): string { return mkdtempSync(join(tmpdir(), 'unmute-rc-')) }

// A fetch double that returns one JSON body with a given status.
function fetchReturning(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch
}
function fetchThrowing(): typeof fetch {
  return (async () => { throw new Error('network down') }) as unknown as typeof fetch
}

afterEach(() => { __resetRuntimeConfigForTest() })

// ─── The compiled floor is byte-identical to config.ts (zero behavior change) ─

test('compiled floor mirrors config.ts + contract exactly', () => {
  const d = compiledDefaults()
  assert.equal(d.version, 0)
  assert.equal(d.models.doerDefault, MODELS.doerDefault)
  assert.equal(d.models.router, MODELS.router)
  assert.equal(d.models.librarian, MODELS.librarian)
  assert.deepEqual(d.models.available, MODEL_CATALOG) // floor catalog = the compiled catalog
  assert.equal(d.prompts.intentCleanup, PROMPTS.intentCleanup)
  assert.equal(d.prompts.taskName, PROMPTS.taskName)
  assert.equal(d.prompts.contract, CONTRACT_TEXT)
  // Knob defaults must equal the pre-refactor inline literals.
  assert.equal(d.knobs.hotThreadMs, 10 * 60_000)
  assert.equal(d.knobs.captureMaxAuto, 12)
  assert.equal(d.knobs.mcpMaxSpawnsPerTask, 5)
  assert.equal(d.knobs.mcpMinSpawnGapMs, 10_000)
  assert.equal(d.knobs.mcpPort, 42117)
  assert.equal(d.knobs.taskStaleMs, 4 * 60_000)
  assert.equal(d.knobs.taskWarmMs, 15 * 60_000)
  assert.equal(d.knobs.taskNavigateWarmMs, 8 * 60_000)
  assert.equal(d.knobs.taskPurgeAgeMs, 24 * 60 * 60_000)
  assert.equal(d.knobs.readyDecayMs, 60 * 60_000)
  assert.equal(d.knobs.routerDecisionTimeoutMs, 60_000)
  assert.equal(d.knobs.routerMaxSessionMs, 2 * 60 * 60_000)
})

test('curator sweep knob defaults to 12h (the twice-daily ceiling)', () => {
  assert.equal(compiledDefaults().knobs.curatorSweepIntervalMs, 12 * 60 * 60_000)
})

test('accessors return the compiled floor before any init', () => {
  assert.equal(getModels().doerDefault, MODELS.doerDefault)
  assert.equal(getPrompts().contract, CONTRACT_TEXT)
  assert.equal(getKnobs().mcpPort, 42117)
})

// ─── mergeConfig: valid overrides apply, invalid ones fall through ───────────

test('mergeConfig applies valid model/prompt/knob overrides and bumps version', () => {
  const base = compiledDefaults()
  const merged = mergeConfig(base, {
    version: 7,
    models: { doerDefault: 'opus' },
    prompts: { intentCleanup: 'NEW CLEANUP' },
    knobs: { hotThreadMs: 5 * 60_000, mcpPort: 51000 },
  }, 'test')
  assert.equal(merged.version, 7)
  assert.equal(merged.models.doerDefault, 'opus')
  assert.equal(merged.models.router, MODELS.router) // untouched key falls through
  assert.equal(merged.prompts.intentCleanup, 'NEW CLEANUP')
  assert.equal(merged.prompts.taskName, PROMPTS.taskName)
  assert.equal(merged.knobs.hotThreadMs, 5 * 60_000)
  assert.equal(merged.knobs.mcpPort, 51000)
  assert.equal(merged.knobs.captureMaxAuto, 12) // untouched knob falls through
})

test('mergeConfig drops an invalid model, keeping the base value', () => {
  const merged = mergeConfig(compiledDefaults(), { models: { doerDefault: 'gpt-4', router: 'haiku' } }, 'test')
  assert.equal(merged.models.doerDefault, MODELS.doerDefault) // invalid dropped
  assert.equal(merged.models.router, 'haiku')                 // valid applied
})

// ─── model catalog (config-driven selectable set) ───────────────────────────

test('config catalog REPLACES the selectable set and unlocks new picks', () => {
  const merged = mergeConfig(compiledDefaults(), {
    models: {
      available: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'claude-opus-4-8', label: 'Opus 4.8 (pinned)', description: 'exact version' },
      ],
      doerDefault: 'claude-opus-4-8', // a pinned id — valid ONLY because the catalog above added it
    },
  }, 'test')
  assert.deepEqual(merged.models.available.map((c) => c.id), ['sonnet', 'claude-opus-4-8'])
  assert.equal(merged.models.doerDefault, 'claude-opus-4-8')
})

test('a pick not present in the effective catalog is dropped', () => {
  // 'opus' is a compiled-catalog alias, but the override narrows the catalog to
  // exclude it, so picking 'opus' must fall back to the base default.
  const merged = mergeConfig(compiledDefaults(), {
    models: { available: [{ id: 'haiku', label: 'Haiku' }], doerDefault: 'opus' },
  }, 'test')
  assert.deepEqual(merged.models.available.map((c) => c.id), ['haiku'])
  assert.equal(merged.models.doerDefault, MODELS.doerDefault) // 'opus' not in catalog → dropped
})

test('malformed catalog entries are sanitized; a fully-invalid catalog keeps the base', () => {
  const merged = mergeConfig(compiledDefaults(), {
    models: { available: [
      { id: 'sonnet', label: 'Sonnet' },
      { id: '', label: 'no id' },
      { label: 'missing id' },
      { id: 'dupe', label: 'A' }, { id: 'dupe', label: 'B' }, // de-dup by id
      'garbage',
    ] },
  }, 'test')
  assert.deepEqual(merged.models.available.map((c) => c.id), ['sonnet', 'dupe'])

  const kept = mergeConfig(compiledDefaults(), { models: { available: [] } }, 'test')
  assert.deepEqual(kept.models.available, compiledDefaults().models.available) // empty → base kept
})

test('getModelCatalog + isSelectableModel reflect the effective catalog after a fetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unmute-rc-cat-'))
  initRuntimeConfig({
    userDataDir: dir, remoteUrl: 'https://x/config.json', autoRefresh: false,
    fetchImpl: fetchReturning({ version: 4, models: { available: [
      { id: 'sonnet', label: 'Sonnet' }, { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    ] } }),
  })
  // before refresh: the compiled catalog, SCOPED TO CLAUDE. The catalog carries
  // Codex entries too now, and getModelCatalog() defaults to Claude — an
  // unscoped read would put nine models in the picker, two called 'default'.
  assert.deepEqual(getModelCatalog().map((c) => c.id), modelsFor('claude').map((c) => c.id))
  assert.deepEqual(getModelCatalog('codex').map((c) => c.id), modelsFor('codex').map((c) => c.id))
  assert.equal(isSelectableModel('opus'), true)
  assert.equal(await refreshRemoteConfig(), 'updated')
  // after: the config catalog
  assert.deepEqual(getModelCatalog().map((c) => c.id), ['sonnet', 'claude-opus-4-8'])
  assert.equal(isSelectableModel('claude-opus-4-8'), true)
  assert.equal(isSelectableModel('opus'), false) // no longer in the effective catalog
  rmSync(dir, { recursive: true, force: true })
})

test('mergeConfig drops empty/non-string prompt overrides', () => {
  const merged = mergeConfig(compiledDefaults(), { prompts: { intentCleanup: '', taskName: '   ', contract: 42 } }, 'test')
  assert.equal(merged.prompts.intentCleanup, PROMPTS.intentCleanup)
  assert.equal(merged.prompts.taskName, PROMPTS.taskName)
  assert.equal(merged.prompts.contract, CONTRACT_TEXT)
})

test('mergeConfig drops out-of-bounds / non-numeric knobs', () => {
  const merged = mergeConfig(compiledDefaults(), {
    knobs: { mcpPort: 80, captureMaxAuto: -3, hotThreadMs: 'lots', routerMaxSessionMs: 999 * 24 * 60 * 60_000 },
  }, 'test')
  assert.equal(merged.knobs.mcpPort, 42117)          // 80 < 1024 → dropped
  assert.equal(merged.knobs.captureMaxAuto, 12)      // negative → dropped
  assert.equal(merged.knobs.hotThreadMs, 10 * 60_000)// string → dropped
  assert.equal(merged.knobs.routerMaxSessionMs, 2 * 60 * 60_000) // > max → dropped
})

test('mergeConfig tolerates garbage input without throwing', () => {
  for (const junk of [null, undefined, 42, 'x', [], { models: 'nope', knobs: 5 }]) {
    const merged = mergeConfig(compiledDefaults(), junk, 'test')
    assert.deepEqual(merged.models, compiledDefaults().models)
  }
})

// ─── init: cache + local override layering ───────────────────────────────────

test('init with no files uses the compiled floor', () => {
  const dir = tmp()
  initRuntimeConfig({ userDataDir: dir, remoteUrl: '', autoRefresh: false })
  assert.equal(getModels().doerDefault, MODELS.doerDefault)
  assert.equal(getEffectiveConfig().version, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('init reads a disk cache and applies it', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'unmute-remote-config.cache.json'),
    JSON.stringify({ version: 3, models: { doerDefault: 'opus' }, knobs: { mcpPort: 50000 } }))
  initRuntimeConfig({ userDataDir: dir, remoteUrl: '', autoRefresh: false })
  assert.equal(getModels().doerDefault, 'opus')
  assert.equal(getKnobs().mcpPort, 50000)
  assert.equal(getEffectiveConfig().version, 3)
  rmSync(dir, { recursive: true, force: true })
})

test('local override wins over cache (dev/power-user escape hatch)', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'unmute-remote-config.cache.json'),
    JSON.stringify({ version: 3, models: { doerDefault: 'opus' } }))
  writeFileSync(join(dir, 'unmute-remote-config.json'),
    JSON.stringify({ models: { doerDefault: 'haiku' } }))
  initRuntimeConfig({ userDataDir: dir, remoteUrl: '', autoRefresh: false })
  assert.equal(getModels().doerDefault, 'haiku') // override beats cache
  rmSync(dir, { recursive: true, force: true })
})

test('a corrupt cache file is ignored, not fatal', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'unmute-remote-config.cache.json'), '{ this is not json')
  initRuntimeConfig({ userDataDir: dir, remoteUrl: '', autoRefresh: false })
  assert.equal(getModels().doerDefault, MODELS.doerDefault) // fell through to floor
  rmSync(dir, { recursive: true, force: true })
})

// ─── refresh: version ratchet, persistence, fail-safety ──────────────────────

test('refresh accepts a newer version, writes the cache, folds it in', async () => {
  const dir = tmp()
  initRuntimeConfig({
    userDataDir: dir, remoteUrl: 'https://x/config.json', autoRefresh: false,
    fetchImpl: fetchReturning({ version: 5, prompts: { contract: 'REMOTE CONTRACT' }, knobs: { hotThreadMs: 30_000 } }),
  })
  const outcome = await refreshRemoteConfig()
  assert.equal(outcome, 'updated')
  assert.equal(getPrompts().contract, 'REMOTE CONTRACT')
  assert.equal(getKnobs().hotThreadMs, 30_000)
  assert.equal(getEffectiveConfig().version, 5)
  // Persisted for next launch.
  const cached = JSON.parse(readFileSync(join(dir, 'unmute-remote-config.cache.json'), 'utf8'))
  assert.equal(cached.version, 5)
  rmSync(dir, { recursive: true, force: true })
})

test('refresh ignores an older-or-equal version (monotonic ratchet)', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'unmute-remote-config.cache.json'),
    JSON.stringify({ version: 9, models: { doerDefault: 'opus' } }))
  initRuntimeConfig({
    userDataDir: dir, remoteUrl: 'https://x/config.json', autoRefresh: false,
    fetchImpl: fetchReturning({ version: 4, models: { doerDefault: 'haiku' } }),
  })
  assert.equal(await refreshRemoteConfig(), 'unchanged')
  assert.equal(getModels().doerDefault, 'opus') // stayed on the newer cache
  rmSync(dir, { recursive: true, force: true })
})

test('refresh survives a network failure without disturbing the live config', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'unmute-remote-config.cache.json'),
    JSON.stringify({ version: 2, models: { doerDefault: 'opus' } }))
  initRuntimeConfig({
    userDataDir: dir, remoteUrl: 'https://x/config.json', autoRefresh: false,
    fetchImpl: fetchThrowing(),
  })
  assert.equal(await refreshRemoteConfig(), 'unavailable')
  assert.equal(getModels().doerDefault, 'opus') // last-known-good preserved
  rmSync(dir, { recursive: true, force: true })
})

test('refresh treats a non-ok response and a version-less body as unavailable', async () => {
  const dir = tmp()
  initRuntimeConfig({
    userDataDir: dir, remoteUrl: 'https://x/config.json', autoRefresh: false,
    fetchImpl: fetchReturning({ error: 'nope' }, false, 503),
  })
  assert.equal(await refreshRemoteConfig(), 'unavailable')

  __resetRuntimeConfigForTest()
  initRuntimeConfig({
    userDataDir: dir, remoteUrl: 'https://x/config.json', autoRefresh: false,
    fetchImpl: fetchReturning({ models: { doerDefault: 'opus' } }), // no version field
  })
  assert.equal(await refreshRemoteConfig(), 'unavailable')
  assert.equal(getModels().doerDefault, MODELS.doerDefault) // not applied without a version
  rmSync(dir, { recursive: true, force: true })
})

test('an invalid remote value is dropped but the rest of the update applies', async () => {
  const dir = tmp()
  initRuntimeConfig({
    userDataDir: dir, remoteUrl: 'https://x/config.json', autoRefresh: false,
    fetchImpl: fetchReturning({ version: 1, models: { doerDefault: 'gpt-5', router: 'haiku' } }),
  })
  assert.equal(await refreshRemoteConfig(), 'updated')
  assert.equal(getModels().doerDefault, MODELS.doerDefault) // invalid dropped → floor
  assert.equal(getModels().router, 'haiku')                 // valid sibling applied
  rmSync(dir, { recursive: true, force: true })
})
