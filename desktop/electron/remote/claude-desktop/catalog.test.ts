import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCatalog, readCatalog, labelFor, offeredModels, __resetCatalogCache } from './catalog'

// A REAL excerpt from /Applications/Claude.app/Contents/Resources/app.asar,
// not an invention — the entire value of this parser is that it matches what
// Claude Desktop actually ships.
const REAL = `
{id:"claude-opus-4-8",family:"opus",display_name:"Opus 4.8",knowledge_cutoff:"May 2026",provider_ids:{first_party:"claude-opus-4-8"},context:{window:1e6,native_1m:!0},max_output_tokens:{default:64e3},pricing:"tier_5_25",capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking","fast_mode"],default_effort:"high",advisor_rank:4},
{id:"claude-opus-5",family:"opus",display_name:"Opus 5",knowledge_cutoff:"May 2026",provider_ids:{first_party:"claude-opus-5"},context:{window:1e6,native_1m:!0},max_output_tokens:{default:64e3},pricing:"tier_5_25",capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking"],default_effort:"high",advisor_rank:4},
{id:"claude-sonnet-4-5",family:"sonnet",display_name:"Sonnet 4.5",knowledge_cutoff:"August 2025",provider_ids:{first_party:"claude-sonnet-4-5"},context:{window:2e5},capabilities:["context_management"],advisor_rank:2},
{id:"claude-3-5-haiku",family:"haiku",display_name:"Haiku 3.5",knowledge_cutoff:"July 2024",provider_ids:{first_party:"claude-3-5-haiku"},context:{window:2e5},capabilities:[],advisor_rank:1}
`

test('ids are paired with the app OWN display names', () => {
  // This is the mapping, taken from the app rather than authored by us. Writing
  // it by hand is the thing this whole module exists to avoid.
  const m = parseCatalog(REAL)
  assert.deepEqual(
    m.map((x) => [x.id, x.label]).sort(),
    [['claude-3-5-haiku', 'Haiku 3.5'], ['claude-opus-4-8', 'Opus 4.8'],
     ['claude-opus-5', 'Opus 5'], ['claude-sonnet-4-5', 'Sonnet 4.5']].sort(),
  )
})

test('effort levels come from EACH model capabilities, not one global list', () => {
  const m = parseCatalog(REAL)
  const opus = m.find((x) => x.id === 'claude-opus-5')!
  assert.deepEqual(opus.effortLevels, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(opus.defaultEffort, 'high')
})

test('a model with no effort capability offers no effort axis', () => {
  // Offering effort where the app has none is the same lie as offering a model
  // it does not have.
  const haiku = parseCatalog(REAL).find((x) => x.id === 'claude-3-5-haiku')!
  assert.deepEqual(haiku.effortLevels, [])
  assert.equal(haiku.defaultEffort, null)
})

test('ordering follows the app own rank, most capable first', () => {
  const m = parseCatalog(REAL)
  assert.equal(m[0].family, 'opus')
  assert.equal(m[m.length - 1].id, 'claude-3-5-haiku')
})

test('a repeated entry is not duplicated', () => {
  // The bundle contains each entry more than once.
  assert.equal(parseCatalog(REAL + REAL).length, 4)
})

test('an unparseable bundle yields NOTHING rather than a guess', () => {
  // Empty is a real answer: "we do not know what this app offers". Callers then
  // show raw ids, which are ugly and true.
  assert.deepEqual(parseCatalog('function x(){return 1}'), [])
})

test('one malformed entry costs only that entry', () => {
  const broken = `{id:"claude-opus-5",family:"opus"}\n${REAL}`
  assert.equal(parseCatalog(broken).length, 4)
})

test('labelFor returns null for an unknown id — never a prettified guess', () => {
  const m = parseCatalog(REAL)
  assert.equal(labelFor(m, 'claude-opus-5'), 'Opus 5')
  assert.equal(labelFor(m, 'claude-something-new'), null)
  assert.equal(labelFor(m, null), null)
})

test('a missing bundle is empty, not a throw — Claude Desktop may not be installed', async () => {
  __resetCatalogCache()
  assert.deepEqual(await readCatalog(join(tmpdir(), 'no-such-app.asar')), [])
})

test('the parse is cached until the bundle itself changes', async () => {
  __resetCatalogCache()
  const dir = await mkdtemp(join(tmpdir(), 'cat-'))
  const p = join(dir, 'app.asar')
  await writeFile(p, REAL)
  assert.equal((await readCatalog(p)).length, 4)

  // Rewritten with one model removed: a new mtime/size must invalidate.
  await writeFile(p, REAL.split('\n').slice(0, 3).join('\n'))
  const after = await readCatalog(p)
  assert.ok(after.length < 4, 'a changed bundle must be re-read')
})

// ── the offered set ───────────────────────────────────────────────────────

let ord = 0
const mk = (label: string, family: string, rank: number, caps = 1, order = ord++) =>
  ({ id: `id-${label}`, label, family, effortLevels: [], defaultEffort: null, rank, order,
     capabilities: Array.from({ length: caps }, (_, i) => `cap${i}`), aliases: [] })

test('rank 0 is legacy and not offered', () => {
  // Sonnet 3.5, Opus 4, Opus 4.1, Opus 4.5, Haiku 3.5 — all rank 0, none in the menu.
  const got = offeredModels([mk('Opus 5', 'opus', 4), mk('Opus 4.1', 'opus', 0)])
  assert.deepEqual(got.map((m) => m.label), ['Opus 5'])
})

test('an EMPTY capabilities array means the app does not offer it', () => {
  // Mythos 5: advisor_rank 5, capabilities []. The one model in the bundle and
  // not in the menu, and this is the field that says so.
  const got = offeredModels([mk('Fable 5', 'fable', 5, 10), mk('Mythos 5', 'mythos', 5, 0)])
  assert.deepEqual(got.map((m) => m.label), ['Fable 5'])
})

test('several models from ONE family are all offered', () => {
  // newest-per-family hid these: Opus 4.8/4.7/4.6 are real, just behind
  // "More models ›".
  const got = offeredModels([
    mk('Opus 5', 'opus', 4), mk('Opus 4.8', 'opus', 4), mk('Opus 4.6', 'opus', 3),
  ])
  assert.equal(got.length, 3)
})

test('the REAL bundle reproduces the menu exactly', async () => {
  __resetCatalogCache()
  const all = await readCatalog()
  if (!all.length) return                 // no Claude Desktop on this machine
  const labels = offeredModels(all).map((m) => m.label).sort()
  // Read off-screen from Claude Desktop's own menu, including its submenu.
  assert.deepEqual(labels, ['Fable 5', 'Haiku 4.5', 'Opus 4.6', 'Opus 4.7',
                            'Opus 4.8', 'Opus 5', 'Sonnet 4.6', 'Sonnet 5'].sort())
})
