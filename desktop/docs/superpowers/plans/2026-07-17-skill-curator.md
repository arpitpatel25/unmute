# Skill Curator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Skill Curator per `desktop/docs/superpowers/specs/2026-07-17-skill-curator-design.md` — an observation layer over Unmute-spawned persistent Claude Code sessions that drafts, suggests, and maintains user-facing Agent Skills, with a conversational review inbox, collision-guarded writes to `~/.claude/skills`, and a provenance ledger.

**Architecture:** A main-process `Curator` (scheduler → deterministic triage → reduce-to-file → distill/synthesize one-shot Claude Code sessions → evidence-carrying proposals) over an Unmute-owned store at `~/.unmute/remote/curator/`. UI = two new rail sections + a center review popup in the cockpit. Router gains a `skill` field and a `skill_feedback` action. The librarian is parked.

**Tech Stack:** TypeScript (Electron main + React renderer), node:test + tsx, existing `AgentExecutor`/PTY plumbing, no new dependencies.

## Global Constraints

(Every task's requirements implicitly include these — from the spec's decisions of record.)

- **Never auto-invoke a curated skill, by any component, ever.** Every curated SKILL.md is written with `disable-model-invocation: true` (D8).
- **The curator touches only skills it authored** — ledger lookup is the authority, never naming convention (D10). Hard stop on any name collision with a non-ledger skill.
- Skills land in **global** `~/.claude/skills/<name>/SKILL.md` as directories — never project-level, never loose `.md` files (D7).
- **Clean names, no prefix**; provenance lives in the ledger (D9).
- **No confidence field anywhere** (D5).
- **Fire-and-forget:** the curator never blocks the UI, a session, an utterance, or shutdown. Failure ⇒ zero proposals + a log line, never a partial artifact.
- **Cursor advances only on sweep success**; rate-limit ⇒ abort without advancing (§4.2, §9).
- **Triage is over-inclusive and controls cost, never merit** (D6).
- All store writes: serialized write-chain + atomic tmp-rename (the `skill-usage.ts` pattern).
- Curator sessions are invisible workers — never on the wall, never touch the wall (§3).
- Facts/preferences are never captured — procedures only (D4).
- Tests: `npm test` (node --test via tsx). Single file: `node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/<file>.test.ts`. Typecheck: `npm run typecheck`. All commands run from `desktop/`.
- Renderer files live in `engine-overrides/renderer/` — they are copied into the engine at launch, so manual verification of UI changes requires a relaunch (`npm run dev`).
- Commit after every task (at minimum); commit messages follow repo style (`feat(curator): …`, `docs: …`), each ending with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

### Task 1: Preflight verifications (spec §11)

Three cheap runtime checks the design depends on. No app code — a findings doc committed to the repo. **If any check fails, STOP and surface to the user before continuing — the design has an explicit fallback for #1 only.**

**Files:**
- Create: `desktop/docs/superpowers/specs/2026-07-17-curator-preflight.md`

**Interfaces:**
- Produces: verified facts later tasks rely on: unknown-frontmatter tolerance (Task 6 writes `origin: unmute` only if this passed), `disable-model-invocation` end-to-end behavior, `/name`-via-PTY-text invocation (Task 12's tap-to-invoke).

- [ ] **Step 1: Create a disposable test skill**

```bash
mkdir -p ~/.claude/skills/unmute-preflight-test
cat > ~/.claude/skills/unmute-preflight-test/SKILL.md <<'EOF'
---
name: unmute-preflight-test
description: Preflight test skill for Unmute curator. When invoked, reply exactly PREFLIGHT-OK and stop.
disable-model-invocation: true
origin: unmute
---

When this skill is invoked, reply with exactly the text `PREFLIGHT-OK` and do nothing else.
EOF
```

- [ ] **Step 2: Verify parsing + listing with the unknown `origin:` key (check #1)**

Run: `claude` (interactive, any directory) → type `/unmute-preflight-test` — before submitting, confirm it appears in the `/` autocomplete menu.
Expected: the skill is listed and invocable → unknown keys tolerated. If it is absent or `claude` reports a parse error → **check #1 FAILED**: record it; Task 6 must then omit the `origin:` line (ledger-only provenance — the design's stated fallback).

- [ ] **Step 3: Verify `disable-model-invocation` semantics (check #2)**

In the same session: submit `/unmute-preflight-test`. Expected: `PREFLIGHT-OK`.
Then run `/context` in a fresh `claude` session. Expected: the Skills listing does NOT include `unmute-preflight-test`'s description (excluded from context). Then ask in plain words "run the unmute preflight test procedure" — expected: the model does NOT auto-invoke the skill.

- [ ] **Step 4: Verify `/name` lands as an invocation when typed into a PTY (check #3)**

This simulates D14 (tap writes `/name` unsubmitted). In a running `claude` session: paste the text `/unmute-preflight-test ` (with trailing space, no Enter), then press Enter manually.
Expected: the skill invokes (`PREFLIGHT-OK`), not a literal-text chat message. Record the exact behavior (menu popup vs direct).

- [ ] **Step 5: Clean up and write findings**

```bash
rm -rf ~/.claude/skills/unmute-preflight-test
```

Write `desktop/docs/superpowers/specs/2026-07-17-curator-preflight.md` recording, for each check: PASS/FAIL, the Claude Code version tested (`claude --version`), and exact observed behavior. State explicitly whether Task 6 includes the `origin:` stamp.

- [ ] **Step 6: Commit**

```bash
git add desktop/docs/superpowers/specs/2026-07-17-curator-preflight.md
git commit -m "docs(curator): preflight findings — origin key, disable-model-invocation, /name via PTY"
```

---

### Task 2: `curator-store.ts` — types, paths, atomic IO, ledger, delta reads

The single owner of `~/.unmute/remote/curator/`. Pure-ish (all paths injectable for tests). Everything downstream imports its types.

**Files:**
- Create: `desktop/electron/remote/curator-store.ts`
- Test: `desktop/electron/remote/curator-store.test.ts`

**Interfaces:**
- Produces (exact exports later tasks consume):

```ts
export interface CuratorPaths { root: string; cursor: string; candidates: string; ledger: string; rejections: string; feedback: string; proposalsDir: string; tracesDir: string }
export function curatorPaths(baseDir?: string): CuratorPaths            // default root: ~/.unmute/remote/curator
export interface SessionCursor { transcriptPath: string; lineOffset: number; lastSweptAt: number; sweeps: number }
export interface CursorFile { version: 1; lastSweepAt: number; sessions: Record<string, SessionCursor> }
export interface CandidateOccurrence { taskId: string; sweepId: string; count: number; at: string; tracePointer: string }
export interface Candidate { key: string; title: string; skeleton: string; total: number; struggle: boolean; firstSeen: string; lastSeen: string; occurrences: CandidateOccurrence[] }
export interface CandidatesFile { version: 1; candidates: Record<string, Candidate> }
export type LedgerAction = 'proposed' | 'created' | 'updated' | 'user-edited-accept' | 'rejected' | 'user-modified-detected'
export interface LedgerEntry { at: string; skill: string; action: LedgerAction; proposalId?: string; sweepId?: string; contentHash?: string; diff?: string }
export interface LedgerFile { version: 1; entries: LedgerEntry[] }
export interface ProposalDraft { name: string; description: string; body: string }
export interface ProposalEvidence { occurrences: number; sessions: Array<{ id: string; intent: string; at: string; tracePointer: string }>; firstSeen: string; lastSeen: string; struggle: { errors: number; recoveries: number; wallClockMin: number } }
export interface Proposal { id: string; sweepId: string; proposedAt: string; kind: 'create' | 'update'; draft: ProposalDraft; evidence: ProposalEvidence; rationale: string; targetSkill?: string; diff?: string; triggeringEvidence?: string[]; affectedSessions?: Array<{ id: string; invokedAt: string }>; resolution: null | { action: 'accepted' | 'rejected'; at: string; userEdited: boolean; reason?: string } }
export interface FeedbackEntry { at: string; skill: string; note: string; consumedBySweep?: string }
export async function readCursor(p: CuratorPaths): Promise<CursorFile>
export async function writeCursor(p: CuratorPaths, f: CursorFile): Promise<void>
export async function readCandidates(p: CuratorPaths): Promise<CandidatesFile>
export async function writeCandidates(p: CuratorPaths, f: CandidatesFile): Promise<void>
export async function readLedger(p: CuratorPaths): Promise<LedgerFile>
export async function appendLedger(p: CuratorPaths, e: LedgerEntry): Promise<void>
export function curatedSkillNames(l: LedgerFile): Set<string>           // names with a 'created' entry not superseded — the D10 authority
export async function readRejections(p: CuratorPaths): Promise<Array<{ at: string; name: string; reason?: string }>>
export async function appendRejection(p: CuratorPaths, r: { at: string; name: string; reason?: string }): Promise<void>
export async function readFeedback(p: CuratorPaths): Promise<FeedbackEntry[]>
export async function appendFeedback(p: CuratorPaths, f: FeedbackEntry): Promise<void>
export async function markFeedbackConsumed(p: CuratorPaths, sweepId: string): Promise<void>
export async function writeProposal(p: CuratorPaths, prop: Proposal): Promise<void>   // proposals/<id>/proposal.json (a DIR — draft.md + conversation live beside it)
export async function readProposal(p: CuratorPaths, id: string): Promise<Proposal | null>
export async function listPendingProposals(p: CuratorPaths): Promise<Proposal[]>
export async function resolveProposal(p: CuratorPaths, id: string, res: NonNullable<Proposal['resolution']>): Promise<void>
export async function readTranscriptDelta(transcriptPath: string, fromLine: number, lookbackLines?: number): Promise<{ lines: string[]; lookback: string[]; newOffset: number }>
```

All writes go through a module-level serialized write-chain (copy the `writeChain` pattern from `skill-usage.ts:92-148`) and end in atomic tmp-write + rename.

- [ ] **Step 1: Write the failing tests**

Create `curator-store.test.ts` (conventions: `node:test`, `assert/strict`, `fs.mkdtemp` temp roots — mirror `skill-usage.test.ts`):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  curatorPaths, readCursor, writeCursor, readLedger, appendLedger, curatedSkillNames,
  writeProposal, readProposal, listPendingProposals, resolveProposal,
  appendFeedback, readFeedback, markFeedbackConsumed, readTranscriptDelta,
  type Proposal,
} from './curator-store.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cur-'))

const prop = (id: string, over: Partial<Proposal> = {}): Proposal => ({
  id, sweepId: 'sweep_1', proposedAt: '2026-07-17T00:00:00Z', kind: 'create',
  draft: { name: 'pr-review', description: 'd', body: 'b' },
  evidence: { occurrences: 2, sessions: [], firstSeen: '', lastSeen: '', struggle: { errors: 0, recoveries: 0, wallClockMin: 0 } },
  rationale: 'r', resolution: null, ...over,
})

test('cursor round-trips and defaults to empty', async () => {
  const p = curatorPaths(await tmp())
  const empty = await readCursor(p)
  assert.equal(empty.lastSweepAt, 0)
  assert.deepEqual(empty.sessions, {})
  await writeCursor(p, { version: 1, lastSweepAt: 5, sessions: { t1: { transcriptPath: '/x', lineOffset: 10, lastSweptAt: 5, sweeps: 1 } } })
  const back = await readCursor(p)
  assert.equal(back.sessions.t1.lineOffset, 10)
})

test('ledger appends and curatedSkillNames reflects created skills', async () => {
  const p = curatorPaths(await tmp())
  await appendLedger(p, { at: 't', skill: 'pr-review', action: 'proposed', proposalId: 'p1' })
  await appendLedger(p, { at: 't', skill: 'pr-review', action: 'created', contentHash: 'h' })
  const l = await readLedger(p)
  assert.equal(l.entries.length, 2)
  assert.ok(curatedSkillNames(l).has('pr-review'))
  assert.ok(!curatedSkillNames({ version: 1, entries: [{ at: 't', skill: 'x', action: 'proposed' }] }).has('x'))
})

test('proposal lifecycle: write → list pending → resolve → no longer pending', async () => {
  const p = curatorPaths(await tmp())
  await writeProposal(p, prop('prop_a'))
  await writeProposal(p, prop('prop_b'))
  assert.equal((await listPendingProposals(p)).length, 2)
  await resolveProposal(p, 'prop_a', { action: 'rejected', at: 't', userEdited: false, reason: 'too niche' })
  const pending = await listPendingProposals(p)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, 'prop_b')
  assert.equal((await readProposal(p, 'prop_a'))?.resolution?.reason, 'too niche')
})

test('feedback appends and is marked consumed by sweep', async () => {
  const p = curatorPaths(await tmp())
  await appendFeedback(p, { at: 't', skill: 'pr-review', note: 'misses lockfiles' })
  await markFeedbackConsumed(p, 'sweep_9')
  const f = await readFeedback(p)
  assert.equal(f[0].consumedBySweep, 'sweep_9')
})

test('readTranscriptDelta returns lines from offset with lookback and new offset', async () => {
  const dir = await tmp()
  const t = path.join(dir, 'x.jsonl')
  await fs.writeFile(t, ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'].join('\n') + '\n')
  const d = await readTranscriptDelta(t, 2, 1)
  assert.deepEqual(d.lines, ['{"n":3}', '{"n":4}'])
  assert.deepEqual(d.lookback, ['{"n":2}'])
  assert.equal(d.newOffset, 4)
  const none = await readTranscriptDelta(t, 4, 1)
  assert.deepEqual(none.lines, [])
  assert.equal(none.newOffset, 4)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/curator-store.test.ts`
Expected: FAIL — `Cannot find module './curator-store.ts'`.

- [ ] **Step 3: Implement `curator-store.ts`**

Implementation notes (complete the exported surface from the Interfaces block):
- `curatorPaths(baseDir)` → root = `baseDir ?? join(homedir(), '.unmute', 'remote', 'curator')`; the other paths are `join(root, 'cursor.json')` etc.; `proposalsDir`/`tracesDir` are subdirs.
- Generic helpers: `async function readJson<T>(file: string, empty: T): Promise<T>` (parse-or-empty, tolerate missing file) and `async function writeJsonAtomic(file, value)` — `mkdir(dirname, {recursive:true})`, write `file + '.tmp'`, `rename`. Wrap every mutator in the serialized chain:

```ts
let chain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.catch(() => {})
  return p
}
```

- `appendLedger` = serialized read → push → writeJsonAtomic.
- `curatedSkillNames`: iterate entries in order; `created`/`updated`/`user-edited-accept` adds the name; (no removal action exists yet — retirement is out of scope D15).
- Proposal dir layout: `proposals/<id>/proposal.json`. `writeProposal` creates the dir. `listPendingProposals` = readdir `proposalsDir`, read each `proposal.json`, keep `resolution === null`, sort by `proposedAt` desc. `resolveProposal` = serialized read-modify-write of that one file.
- `markFeedbackConsumed(p, sweepId)`: sets `consumedBySweep = sweepId` on every entry that has none.
- `readTranscriptDelta`: read file as utf8, split `'\n'`, drop trailing empty; `lines = all.slice(fromLine)`, `lookback = all.slice(Math.max(0, fromLine - (lookbackLines ?? 200)), fromLine)`, `newOffset = all.length`. Missing file → `{ lines: [], lookback: [], newOffset: fromLine }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/curator-store.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add electron/remote/curator-store.ts electron/remote/curator-store.test.ts
git commit -m "feat(curator): store — types, atomic serialized IO, ledger, proposals, transcript deltas"
```

---

### Task 3: `curator-triage.ts` — deterministic metrics + gate

Answers "is this delta worth an LLM's attention?" from JSONL lines. No LLM, no fs. Over-inclusive.

**Files:**
- Create: `desktop/electron/remote/curator-triage.ts`
- Test: `desktop/electron/remote/curator-triage.test.ts`

**Interfaces:**
- Consumes: `string[]` JSONL lines (from `readTranscriptDelta`).
- Produces:

```ts
export interface TriageMetrics { wallClockMs: number; toolCalls: number; distinctTools: number; errors: number; recoveries: number; userTurns: number; lines: number }
export function computeTriageMetrics(lines: string[]): TriageMetrics
export interface TriageThresholds { minWallClockMs: number; minToolCalls: number; minErrors: number; minUserTurns: number }
export const DEFAULT_TRIAGE: TriageThresholds   // { minWallClockMs: 10*60_000, minToolCalls: 15, minErrors: 3, minUserTurns: 5 }
export function passesTriage(m: TriageMetrics, t?: TriageThresholds): boolean
// passes if (wallClockMs >= minWallClockMs && toolCalls >= minToolCalls) || errors >= minErrors || userTurns >= minUserTurns
```

- [ ] **Step 1: Write the failing tests**

Transcript-entry facts (mirror what `extractSkillUses` in `skill-usage.ts:74-88` and `reduceTranscript` parse): each line is JSON with optional `timestamp` (ISO string), `message.role`, and `message.content[]` blocks of `{type:'tool_use', name}` / `{type:'tool_result', is_error}`.

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTriageMetrics, passesTriage, DEFAULT_TRIAGE } from './curator-triage.ts'

const line = (o: object) => JSON.stringify(o)
const tool = (name: string, ts: string) => line({ timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] } })
const result = (isErr: boolean, ts: string) => line({ timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', is_error: isErr, content: 'x' }] } })
const userMsg = (ts: string) => line({ timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'do it differently' }] } })

test('metrics: counts tools, errors, recoveries, user turns, wall clock', () => {
  const m = computeTriageMetrics([
    userMsg('2026-07-17T10:00:00Z'),
    tool('Bash', '2026-07-17T10:01:00Z'),
    result(true, '2026-07-17T10:01:10Z'),   // error…
    tool('Bash', '2026-07-17T10:02:00Z'),
    result(false, '2026-07-17T10:02:10Z'),  // …then recovery
    tool('Read', '2026-07-17T10:20:00Z'),
    'not json — skipped',
  ])
  assert.equal(m.toolCalls, 3)
  assert.equal(m.distinctTools, 2)
  assert.equal(m.errors, 1)
  assert.equal(m.recoveries, 1)             // error followed by a later non-error result
  assert.equal(m.userTurns, 1)              // tool_result carriers are not user turns
  assert.equal(m.wallClockMs, 20 * 60_000)  // first→last timestamp
})

test('gate: expensive-and-long passes; short-and-clean fails; error-heavy passes alone', () => {
  const base = { wallClockMs: 0, toolCalls: 0, distinctTools: 0, errors: 0, recoveries: 0, userTurns: 0, lines: 0 }
  assert.equal(passesTriage({ ...base, wallClockMs: 11 * 60_000, toolCalls: 20 }), true)
  assert.equal(passesTriage({ ...base, wallClockMs: 2 * 60_000, toolCalls: 4 }), false)
  assert.equal(passesTriage({ ...base, errors: DEFAULT_TRIAGE.minErrors }), true)
  assert.equal(passesTriage({ ...base, userTurns: DEFAULT_TRIAGE.minUserTurns }), true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/curator-triage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Parsing rules: skip unparseable lines. A "user turn" = `message.role === 'user'` whose content has NO `tool_result` block (tool results ride user-role messages in CC transcripts). Recoveries: count an error→(any later non-error tool_result) transition — track a `pendingError` flag: set on `is_error:true`, on next non-error result increment `recoveries` and clear. Wall clock: last parseable `timestamp` minus first (0 if <2). Distinct tools via a `Set`.

- [ ] **Step 4: Run tests to verify they pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add electron/remote/curator-triage.ts electron/remote/curator-triage.test.ts
git commit -m "feat(curator): deterministic triage — struggle metrics + over-inclusive gate"
```

---

### Task 4: Accumulator merge — cross-sweep occurrence memory (in `curator-store.ts`)

Repetition = ledger arithmetic (§4.6). Merge distill reports into `candidates.json`, idempotently per (key, taskId, sweepId) so a retried sweep never double-counts.

**Files:**
- Modify: `desktop/electron/remote/curator-store.ts`
- Test: `desktop/electron/remote/curator-store.test.ts` (append)

**Interfaces:**
- Produces:

```ts
export interface DistillProcedure { title: string; skeleton: string; count: number; struggle: boolean; usedCuratedSkill?: { name: string; friction: string } }
export function occurrenceKey(title: string): string   // lowercase, non-alnum→'-', collapse repeats, trim '-', max 60 chars
export function mergeDistill(file: CandidatesFile, procs: DistillProcedure[], ctx: { taskId: string; sweepId: string; at: string; tracePointer: string }): CandidatesFile
```

- [ ] **Step 1: Write the failing tests** (append to `curator-store.test.ts`)

```ts
import { occurrenceKey, mergeDistill, type CandidatesFile } from './curator-store.ts'

test('occurrenceKey normalizes stably', () => {
  assert.equal(occurrenceKey('Load video → Premiere via MCP!'), 'load-video-premiere-via-mcp')
  assert.equal(occurrenceKey('load VIDEO premiere via mcp'), 'load-video-premiere-via-mcp')
})

test('mergeDistill accumulates across sweeps and sessions, idempotent per (key,task,sweep)', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const proc = { title: 'Load video Premiere via MCP', skeleton: 's', count: 2, struggle: true }
  const a = mergeDistill(empty, [proc], { taskId: 't1', sweepId: 'sw1', at: '2026-07-14', tracePointer: 'traces/a' })
  const b = mergeDistill(a, [proc], { taskId: 't2', sweepId: 'sw2', at: '2026-07-17', tracePointer: 'traces/b' })
  const c = mergeDistill(b, [proc], { taskId: 't2', sweepId: 'sw2', at: '2026-07-17', tracePointer: 'traces/b' }) // retry — no-op
  const cand = c.candidates[occurrenceKey(proc.title)]
  assert.equal(cand.total, 4)                       // 2 + 2, retry ignored
  assert.equal(cand.occurrences.length, 2)
  assert.equal(cand.firstSeen, '2026-07-14')
  assert.equal(cand.lastSeen, '2026-07-17')
  assert.equal(cand.struggle, true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/curator-store.test.ts`
Expected: FAIL — `occurrenceKey` not exported.

- [ ] **Step 3: Implement**

`mergeDistill` returns a new object (no in-place mutation): for each proc, compute key; get-or-create candidate (`title`/`skeleton` from first sighting, keep existing thereafter); skip if `occurrences` already has an entry with same `taskId + sweepId`; else push occurrence `{taskId, sweepId, count: proc.count, at, tracePointer}`, recompute `total` as sum of occurrence counts, `struggle = struggle || proc.struggle`, min/max firstSeen/lastSeen.

- [ ] **Step 4: Run tests to verify they pass** — same command, PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add electron/remote/curator-store.ts electron/remote/curator-store.test.ts
git commit -m "feat(curator): occurrence accumulator — cross-sweep repetition memory, retry-idempotent"
```

---

### Task 5: `curator-prompts.ts` — distill + synthesize prompt builders and output parsers

Pure functions: build the exact prompts the one-shot sessions receive; parse/validate their JSON output files. The librarian's filter language (`librarian.ts:163-197`) is inherited here nearly verbatim — that wording is battle-tested.

**Files:**
- Create: `desktop/electron/remote/curator-prompts.ts`
- Test: `desktop/electron/remote/curator-prompts.test.ts`

**Interfaces:**
- Consumes: `DistillProcedure`, `Candidate`, `Proposal`, `FeedbackEntry` from `curator-store.ts`.
- Produces:

```ts
export function buildDistillPrompt(i: { taskId: string; intent: string; tracePath: string; outPath: string; curatedNames: string[] }): string
export function parseDistillOutput(raw: string | null): DistillProcedure[]          // [] on null/malformed; drops entries missing title/skeleton
export function buildSynthesizePrompt(i: {
  sweepId: string
  candidates: Candidate[]
  curatedIndex: Array<{ name: string; description: string }>       // the curator's OWN library only (D10)
  rejections: Array<{ name: string; reason?: string }>
  feedback: Array<{ skill: string; note: string }>
  outPath: string
}): string
export function parseSynthesizeOutput(raw: string | null, sweepId: string, now: () => number): Proposal[]  // validates shape; fills id (`prop_<ts>_<n>`), sweepId, proposedAt, resolution:null; drops invalid entries
```

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDistillPrompt, parseDistillOutput, buildSynthesizePrompt, parseSynthesizeOutput } from './curator-prompts.ts'

test('distill prompt: points at trace file, demands JSON at outPath, forbids facts/preferences', () => {
  const p = buildDistillPrompt({ taskId: 't1', intent: 'edit video', tracePath: '/tr/a.txt', outPath: '/out/distill.json', curatedNames: ['pr-review'] })
  assert.ok(p.includes('/tr/a.txt'))
  assert.ok(p.includes('/out/distill.json'))
  assert.ok(/never|not/i.test(p) && /fact|preference/i.test(p))   // D4 stated in-prompt
  assert.ok(p.includes('pr-review'))                              // curated names for friction spotting
})

test('parseDistillOutput: tolerates junk, validates entries', () => {
  assert.deepEqual(parseDistillOutput(null), [])
  assert.deepEqual(parseDistillOutput('not json'), [])
  const ok = parseDistillOutput(JSON.stringify({ procedures: [
    { title: 'T', skeleton: 'S', count: 2, struggle: true },
    { title: '', skeleton: 'S', count: 1, struggle: false },      // dropped: no title
  ] }))
  assert.equal(ok.length, 1)
  assert.equal(ok[0].count, 2)
})

test('synthesize prompt: carries filter language, candidates with totals, rejections, feedback', () => {
  const p = buildSynthesizePrompt({
    sweepId: 'sw1',
    candidates: [{ key: 'k', title: 'T', skeleton: 'S', total: 3, struggle: true, firstSeen: 'a', lastSeen: 'b', occurrences: [] }],
    curatedIndex: [{ name: 'pr-review', description: 'd' }],
    rejections: [{ name: 'noise-skill', reason: 'too niche' }],
    feedback: [{ skill: 'pr-review', note: 'misses lockfiles' }],
    outPath: '/out/synth.json',
  })
  assert.ok(/CONSEQUENTIAL/.test(p) && /NON-OBVIOUS/.test(p) && /DURABLE/.test(p))
  assert.ok(/default is NO|when unsure, DON'T/i.test(p))
  assert.ok(p.includes('seen 3x') || p.includes('total: 3'))
  assert.ok(p.includes('too niche'))
  assert.ok(p.includes('misses lockfiles'))
})

test('parseSynthesizeOutput: validates, stamps ids/resolution, drops invalid', () => {
  assert.deepEqual(parseSynthesizeOutput(null, 'sw1', () => 1), [])
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'b' },
      evidence: { occurrences: 3, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 2, recoveries: 1, wallClockMin: 40 } },
      rationale: 'why' },
    { kind: 'create', draft: { name: '', description: 'd', body: 'b' }, evidence: null, rationale: '' },  // dropped
  ] }), 'sw1', () => 1700000)
  assert.equal(out.length, 1)
  assert.equal(out[0].sweepId, 'sw1')
  assert.equal(out[0].resolution, null)
  assert.ok(out[0].id.startsWith('prop_'))
})
```

- [ ] **Step 2: Run to verify FAIL** — module not found.

- [ ] **Step 3: Implement**

Distill prompt shape (build as a joined string array, router/librarian style):

```
[Unmute curator — distill] You are analyzing ONE work session's reduced trace.
Read the trace file at <tracePath> (use the Read tool; read it fully, in chunks if large).
Session intent: "<intent>"

Report every MULTI-STEP PROCEDURE that occurred — a reusable method someone
would follow again: what it accomplishes, its semantic skeleton
(preconditions → ordered steps by intent → definition of done → gotchas
discovered), how many separate times it occurred in THIS trace, and whether
it involved visible struggle (errors, backtracking, re-derivation).
NEVER report bare facts or preferences — they are not procedures and are out
of scope. NEVER store raw coordinates, pixel positions, tab ids, or one-off
values — distill to the durable skeleton.
These curated skills already exist: <curatedNames or "(none)">. If the trace
shows one being invoked, report what happened AROUND the invocation
(extra steps appended, corrections, failure) as usedCuratedSkill.
Reply ONLY by writing JSON to <outPath> (write <outPath>.tmp then rename):
{"procedures":[{"title":"…","skeleton":"…","count":N,"struggle":true|false,
  "usedCuratedSkill":{"name":"…","friction":"…"}?}]}
No procedures found → {"procedures":[]}. Do nothing else — no other tools than Read and the file write.
```

Synthesize prompt: sections for (1) role + the librarian filter block — copy the CONSEQUENTIAL/NON-OBVIOUS/DURABLE + "default is NO change… when unsure, DON'T" wording from `librarian.ts:163-169`; (2) admission criteria verbatim from spec D3 (repetition ≥2 total occurrences OR expensive one-off with struggle); (3) candidates listed as `- [key] "title" — seen <total>x (<firstSeen>→<lastSeen>), struggle:<y/n>\n  skeleton: …`; (4) existing curated index → instruct: overlap ⇒ propose kind:"update" with targetSkill + unified diff of the body, never a duplicate; (5) rejections with reasons → never re-offer these or close variants; (6) user feedback → first-class update evidence; (7) output contract: write `{"proposals":[…]}` to outPath atomically, each proposal `{kind, draft:{name (kebab-case, 2-4 words), description, body (full SKILL.md body per the template below)}, evidence:{occurrences, sessions:[{id,intent,at,tracePointer}], firstSeen, lastSeen, struggle:{errors,recoveries,wallClockMin}}, rationale, targetSkill?, diff?, triggeringEvidence?, affectedSessions?}`; (8) the SKILL.md body template from spec §5.1 (Goal/When to use/Preconditions/Steps/Verify/Gotchas headings); (9) "Zero proposals is the expected common case."

`parseSynthesizeOutput` validation: entry valid iff `kind` ∈ {create,update}, `draft.name` non-empty kebab-ish (`/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/`), `draft.description` and `draft.body` non-empty, `evidence` object with numeric `occurrences`, `rationale` non-empty; `kind:'update'` additionally requires `targetSkill`. Stamp `id: 'prop_' + now() + '_' + index`, `sweepId`, `proposedAt: new Date(now()).toISOString()`, `resolution: null`.

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add electron/remote/curator-prompts.ts electron/remote/curator-prompts.test.ts
git commit -m "feat(curator): distill + synthesize prompts and validating parsers (librarian filter inherited)"
```

---

### Task 6: `curator-writer.ts` — collision-guarded, ledger-first skill writes

The only code in the system that touches `~/.claude/skills`. Enforces D7–D10 mechanically.

**Files:**
- Create: `desktop/electron/remote/curator-writer.ts`
- Test: `desktop/electron/remote/curator-writer.test.ts`

**Interfaces:**
- Consumes: `curatorPaths`, `readLedger`, `appendLedger`, `curatedSkillNames`, `ProposalDraft` from `curator-store.ts`.
- Produces:

```ts
export function renderSkillMd(d: ProposalDraft, opts?: { originStamp?: boolean }): string  // frontmatter (name, description, disable-model-invocation: true, origin: unmute if opts) + body
export function contentHash(s: string): string                                             // sha256 hex
export interface WriteResult { ok: boolean; error?: 'collision' | 'io'; detail?: string }
export async function writeSkill(o: {
  draft: ProposalDraft; kind: 'create' | 'update'; userEdited: boolean
  proposalId: string; paths: CuratorPaths; skillsRoot?: string                             // default ~/.claude/skills; injectable for tests
  originStamp: boolean; diff?: string
}): Promise<WriteResult>
export async function detectDrift(paths: CuratorPaths, skillsRoot?: string): Promise<string[]>  // curated skills whose on-disk hash ≠ last ledger hash → appends 'user-modified-detected' entries, returns names
```

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderSkillMd, contentHash, writeSkill, detectDrift } from './curator-writer.ts'
import { curatorPaths, readLedger, appendLedger } from './curator-store.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cw-'))
const draft = { name: 'pr-review', description: 'Reviews PRs the way this user does', body: '# pr-review\n\n**Goal** — …' }

test('renderSkillMd: frontmatter carries the flag; origin stamp is conditional', () => {
  const md = renderSkillMd(draft, { originStamp: true })
  assert.ok(md.startsWith('---\n'))
  assert.ok(md.includes('disable-model-invocation: true'))   // D8 — always
  assert.ok(md.includes('origin: unmute'))
  assert.ok(!renderSkillMd(draft, { originStamp: false }).includes('origin:'))
  assert.ok(md.includes(draft.body))
})

test('writeSkill create: ledger-first, atomic dir write, hash recorded', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  const r = await writeSkill({ draft, kind: 'create', userEdited: false, proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: true })
  assert.equal(r.ok, true)
  const onDisk = await fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8')
  const l = await readLedger(p)
  const created = l.entries.find((e) => e.action === 'created')
  assert.equal(created?.skill, 'pr-review')
  assert.equal(created?.contentHash, contentHash(onDisk))
})

test('writeSkill: HARD STOP on collision with a skill we did not author (D10)', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  await fs.mkdir(path.join(skills, 'pr-review'), { recursive: true })
  await fs.writeFile(path.join(skills, 'pr-review', 'SKILL.md'), 'user-owned')
  const r = await writeSkill({ draft, kind: 'create', userEdited: false, proposalId: 'p1', paths: curatorPaths(root), skillsRoot: skills, originStamp: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'collision')
  assert.equal(await fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8'), 'user-owned')  // untouched
})

test('writeSkill update: allowed only for ledger-owned names; user-edited accept recorded', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  await writeSkill({ draft, kind: 'create', userEdited: false, proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  const r2 = await writeSkill({ draft: { ...draft, body: 'v2' }, kind: 'update', userEdited: true, proposalId: 'p2', paths: p, skillsRoot: skills, originStamp: false, diff: '-a+b' })
  assert.equal(r2.ok, true)
  const l = await readLedger(p)
  assert.ok(l.entries.some((e) => e.action === 'user-edited-accept' && e.diff === '-a+b'))
})

test('detectDrift: hand-edited curated skill flagged once', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  await writeSkill({ draft, kind: 'create', userEdited: false, proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  await fs.appendFile(path.join(skills, 'pr-review', 'SKILL.md'), '\nhand edit')
  assert.deepEqual(await detectDrift(p, skills), ['pr-review'])
  assert.deepEqual(await detectDrift(p, skills), [])   // already flagged at this hash — not re-flagged
})
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement**

- `renderSkillMd`: frontmatter lines `name`, `description` (single-line, quotes stripped), `disable-model-invocation: true`, optional `origin: unmute`; then `---`, blank line, body. Import `createHash` from `node:crypto` for `contentHash`.
- `writeSkill` order (all under the store's serialized chain via exported helpers):
  1. Guard: read ledger → `owned = curatedSkillNames(ledger)`. For `create`: if `owned.has(name)` OR dir `skillsRoot/name` exists → collision. For `update`: if `!owned.has(name)` → collision (we never edit what we don't own).
  2. `appendLedger` FIRST: action `create→'created'`, `update→(userEdited ? 'user-edited-accept' : 'updated')`, with `proposalId`, `diff`, and `contentHash` of the rendered content.
  3. Write file atomically: `mkdir -p skillsRoot/name`, write `SKILL.md.tmp`, rename to `SKILL.md`. On IO failure return `{ok:false, error:'io'}` (ledger has the intent recorded; drift detection reconciles).
- `detectDrift`: for each owned name, read `SKILL.md`, compare `contentHash` with the LAST ledger entry for that skill that has a `contentHash`. Mismatch AND that last entry is not already `user-modified-detected` at the current hash → append `{action:'user-modified-detected', contentHash: currentHash}` and include in result.

- [ ] **Step 4: Run to verify PASS (5/5).**

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add electron/remote/curator-writer.ts electron/remote/curator-writer.test.ts
git commit -m "feat(curator): writer — collision-guarded ledger-first SKILL.md writes + drift detection"
```

---

### Task 7: Knob + librarian parking

**Files:**
- Modify: `desktop/electron/remote/runtime-config.ts` (knob)
- Modify: `desktop/electron/remote/init.ts` (parking)
- Test: `desktop/electron/remote/runtime-config.test.ts` (append, if the file exists — else create with just this test)

**Interfaces:**
- Produces: `getKnobs().curatorSweepIntervalMs` (default 12 h — the twice-daily ceiling, D11), consumed by Task 8. `LIBRARIAN_PARKED` behavior: no librarian sessions spawn.

- [ ] **Step 1: Add the knob**

In `runtime-config.ts`: add to `ConfigKnobs`:

```ts
  /** Curator: minimum gap between sweeps (the twice-daily ceiling). */
  curatorSweepIntervalMs: number
```

and to `KNOB_SPEC`:

```ts
  curatorSweepIntervalMs:  { def: 12 * 60 * 60_000, min: 60_000, max: 30 * DAY },
```

- [ ] **Step 2: Test the knob default**

Append (or create) `runtime-config.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compiledDefaults } from './runtime-config.ts'

test('curator sweep knob defaults to 12h', () => {
  assert.equal(compiledDefaults().knobs.curatorSweepIntervalMs, 12 * 60 * 60_000)
})
```

Run: `node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/runtime-config.test.ts` → PASS.

- [ ] **Step 3: Park the librarian (spec §12)**

In `init.ts`: locate the librarian construction (`init.ts:1372`, `const librarian = new Librarian({...})`) and the gardening timer (`init.ts:~1450`). Add at the top of the remote-init module scope:

```ts
// Librarian PARKED (skill-curator spec §12): no librarian sessions spawn — the
// curator supersedes it. Code + recipes stay on disk; flip to false to revive.
const LIBRARIAN_PARKED = true
```

Then: (a) the `TaskManager` options object currently passing `librarian` passes `librarian: LIBRARIAN_PARKED ? undefined : librarian` (the `handToLibrarian` gate `!this.opts.librarian` then short-circuits every handoff — zero sessions spawned); (b) the gardening timer callback gets a first line `if (LIBRARIAN_PARKED) return`.

- [ ] **Step 4: Verify nothing broke**

Run: `npm test` → all existing suites PASS (librarian's own unit tests still pass — the class is untouched). Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add electron/remote/runtime-config.ts electron/remote/runtime-config.test.ts electron/remote/init.ts
git commit -m "feat(curator): curatorSweepIntervalMs knob; park the librarian (no sessions spawn, code retained)"
```

---

### Task 8: `curator.ts` — scheduler, material gate, single-flight

The `Curator` class shell: catch-up-on-wake scheduling (never a bare interval-since-launch), material gate over session tasks, idle-preference, single-flight. Sweep *pipeline* is Task 9 — here `runSweep` is an injected function so scheduling is testable in isolation.

**Files:**
- Create: `desktop/electron/remote/curator.ts`
- Test: `desktop/electron/remote/curator.test.ts`

**Interfaces:**
- Consumes: `curator-store` (cursor, paths), `curator-triage`, `locateTranscript` (trace-reducer.ts).
- Produces:

```ts
export interface SessionInfo { taskId: string; intent: string; cwd: string; kind: 'oneoff' | 'session' }
export interface CuratorOpts {
  paths?: CuratorPaths
  sweepIntervalMs: () => number                    // wire to getKnobs().curatorSweepIntervalMs
  listSessions: () => Promise<SessionInfo[]>       // Unmute session-kind tasks (init wires: scan ~/.unmute/remote/local/*/meta.json kind==='session')
  isBusy: () => boolean                            // idle-preference: utterance/dispatch in flight
  runSweep: (material: MaterialSession[]) => Promise<void>   // Task 9 provides the real one
  checkEveryMs?: number                            // default 10 * 60_000
  quiescentMs?: number                             // wake-scan checkpoint proxy: transcript mtime older than this. default 10 * 60_000
  now?: () => number
}
export interface MaterialSession { taskId: string; intent: string; transcriptPath: string; fromLine: number; lines: string[]; lookback: string[]; newOffset: number }
export class Curator {
  constructor(opts: CuratorOpts)
  start(): void                                    // launch catch-up check + interval (unref'd)
  stop(): void
  notifyCheckpoint(taskId: string): void           // event-driven checkpoint (init wires task-manager 'done'/'ready'/kill)
  checkNow(): Promise<boolean>                     // due + material + not busy → sweep ran. Exposed for tests + harness.
}
```

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Curator, type MaterialSession } from './curator.ts'
import { curatorPaths, readCursor, writeCursor } from './curator-store.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cu-'))
// A transcript delta that clears triage: 16 tool calls over 11 minutes.
const busyLines = () => {
  const lines: string[] = []
  for (let i = 0; i < 16; i++) lines.push(JSON.stringify({ timestamp: new Date(1_000_000 + i * 44_000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }))
  return lines.join('\n') + '\n'
}

function make(root: string, over: Partial<ConstructorParameters<typeof Curator>[0]> = {}) {
  const swept: MaterialSession[][] = []
  const sessDir = path.join(root, 'sess')
  const opts = {
    paths: curatorPaths(root),
    sweepIntervalMs: () => 12 * 60 * 60_000,
    listSessions: async () => [{ taskId: 't1', intent: 'work', cwd: sessDir, kind: 'session' as const }],
    isBusy: () => false,
    runSweep: async (m: MaterialSession[]) => { swept.push(m) },
    now: () => Date.now(),
    ...over,
  }
  return { curator: new Curator(opts), swept, sessDir }
}

test('checkNow: no material → no sweep; new checkpointed delta clearing triage → sweep', async () => {
  const root = await tmp()
  const { curator, swept, sessDir } = make(root)
  assert.equal(await curator.checkNow(), false)         // no transcript at all
  // create the transcript where locateTranscript would… simpler: transcriptPath resolution is injectable
  const t = path.join(root, 't1.jsonl')
  await fs.writeFile(t, busyLines())
  const { curator: c2, swept: s2 } = make(root, {
    listSessions: async () => [{ taskId: 't1', intent: 'work', cwd: sessDir, kind: 'session' }],
    locateTranscriptFor: async () => t,
  } as never)
  c2.notifyCheckpoint('t1')
  assert.equal(await c2.checkNow(), true)
  assert.equal(s2.length, 1)
  assert.equal(s2[0][0].taskId, 't1')
  assert.ok(s2[0][0].lines.length >= 16)
})

test('interval gate: a sweep within sweepIntervalMs of the last is refused', async () => {
  const root = await tmp()
  const t = path.join(root, 't1.jsonl'); await fs.writeFile(t, busyLines())
  let nowMs = 1_000_000
  const { curator } = make(root, { locateTranscriptFor: async () => t, now: () => nowMs } as never)
  const p = curatorPaths(root)
  await writeCursor(p, { version: 1, lastSweepAt: nowMs - 60_000, sessions: {} })  // swept a minute ago
  curator.notifyCheckpoint('t1')
  assert.equal(await curator.checkNow(), false)
  nowMs += 13 * 60 * 60_000                                                        // 13h later — due
  assert.equal(await curator.checkNow(), true)
})

test('busy → deferred; single-flight; short/clean delta fails triage → cursor untouched, no sweep', async () => {
  const root = await tmp()
  const t = path.join(root, 't1.jsonl')
  await fs.writeFile(t, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }) + '\n')
  let busy = true
  const { curator, swept } = make(root, { locateTranscriptFor: async () => t, isBusy: () => busy } as never)
  curator.notifyCheckpoint('t1')
  assert.equal(await curator.checkNow(), false)   // busy
  busy = false
  assert.equal(await curator.checkNow(), false)   // idle but delta fails triage
  assert.equal(swept.length, 0)
  assert.equal((await readCursor(curatorPaths(root))).sessions.t1?.lineOffset ?? 0, 0)  // triage-fail advances nothing
})
```

Note: the tests use an extra injectable `locateTranscriptFor?: (s: SessionInfo) => Promise<string | null>` — add it to `CuratorOpts` (default: `(s) => locateTranscript(s.cwd)`).

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement**

`checkNow()` logic, in order (each step logs its refusal reason via `createLogger('curator')`):
1. Single-flight: if a check/sweep is in progress → false.
2. Due: `now - cursor.lastSweepAt >= sweepIntervalMs()` → else false.
3. Busy: `isBusy()` → false (idle-preference; the interval retries).
4. Material scan: for each `listSessions()` entry — resolve transcript (`locateTranscriptFor`); read cursor offset; `readTranscriptDelta`; skip if no new lines; **checkpoint requirement**: taskId ∈ the `notifyCheckpoint` pending set, OR transcript mtime older than `quiescentMs` (wake-scan proxy for "not mid-flight"); compute `computeTriageMetrics(lines)`; keep if `passesTriage`.
5. No material → false. Else `await runSweep(material)`; on success clear consumed checkpoint marks. **Cursor writes belong to the sweep (Task 9), not the scheduler** — a failed sweep leaves everything re-readable.
6. `start()`: `setImmediate(checkNow)` (catch-up-on-wake) + `setInterval(checkNow, checkEveryMs).unref()`. `stop()` clears.

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add electron/remote/curator.ts electron/remote/curator.test.ts
git commit -m "feat(curator): scheduler — catch-up-on-wake, material gate, idle-preference, single-flight"
```

---

### Task 9: Sweep pipeline — reduce → distill → accumulate → synthesize → proposals (+ rate-limit backoff)

The real `runSweep`. One-shot Claude Code sessions via `ExecutorFactory`, decision-file pattern (the router's), librarian's submit-confirm quirks handled.

**Files:**
- Modify: `desktop/electron/remote/curator.ts`
- Test: `desktop/electron/remote/curator.test.ts` (append)

**Interfaces:**
- Consumes: `ExecutorFactory` (executor.ts), `reduceTranscript` (trace-reducer.ts), Task 5 prompts/parsers, Task 4 merge, Task 2 store.
- Produces:

```ts
export interface SweepDeps {
  executorFactory: ExecutorFactory
  paths: CuratorPaths
  curatedIndex: () => Promise<Array<{ name: string; description: string }>>  // init wires: ledger names + on-disk descriptions
  sessionTimeoutMs?: number      // per one-shot, default 5 * 60_000
  submitConfirmMs?: number       // default 450 (the router/task-lane paste quirk)
  pollMs?: number                // default 250
  now?: () => number
}
export function makeRunSweep(deps: SweepDeps): (material: MaterialSession[]) => Promise<void>
export class RateLimitedError extends Error {}
```

- [ ] **Step 1: Write the failing tests** (append)

Fake executor: a minimal `AgentExecutor` whose `writeStdin` captures the prompt, extracts the `outPath` from it (regex `/(\/\S+\/(?:distill|synth)\.json)/`), and writes a canned JSON file there — simulating the model's file write. A second variant emits `"limit reached"` on `onData` and writes nothing.

```ts
import { makeRunSweep, RateLimitedError } from './curator.ts'
import { readCandidates, listPendingProposals } from './curator-store.ts'
import type { AgentExecutor } from './executor'

function fakeExecutor(behavior: (prompt: string) => Promise<void>, emit?: (cb: (c: string) => void) => void): AgentExecutor {
  let dataCb: (c: string) => void = () => {}
  return {
    alive: true,
    spawn: async () => { if (emit) emit((c) => dataCb(c)) },
    isReady: async () => {},
    writeStdin: (text: string) => { void behavior(text) },
    write: () => {}, resize: () => {}, onData: (cb) => { dataCb = cb }, kill: () => {},
  } as unknown as AgentExecutor
}

const distillJson = { procedures: [{ title: 'Load video Premiere', skeleton: 'S', count: 2, struggle: true }] }
const synthJson = { proposals: [{ kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'Goal…' }, evidence: { occurrences: 2, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 1, recoveries: 1, wallClockMin: 30 } }, rationale: 'seen twice with struggle' }] }

test('runSweep: distills, accumulates, synthesizes, writes proposal + ledger, advances cursor', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|synth)\.json)/)
    if (!m) return
    const payload = m[1].endsWith('distill.json') ? distillJson : synthJson
    await fs.mkdir(path.dirname(m[1]), { recursive: true })
    await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
  }
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writes), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run([{ taskId: 't1', intent: 'video work', transcriptPath: path.join(root, 't1.jsonl'), fromLine: 0, lines: [JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })], lookback: [], newOffset: 1 }])
  const cands = await readCandidates(p)
  assert.equal(Object.values(cands.candidates)[0]?.total, 2)
  const pending = await listPendingProposals(p)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].draft.name, 'video-load-premiere')
  const cursor = await readCursor(p)
  assert.equal(cursor.sessions.t1.lineOffset, 1)                       // advanced on success
  assert.ok((await readLedger(p)).entries.some((e) => e.action === 'proposed' && e.skill === 'video-load-premiere'))
})

test('runSweep: rate-limit aborts — cursor NOT advanced, no proposals', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  const run = makeRunSweep({
    executorFactory: () => fakeExecutor(async () => {}, (cb) => setTimeout(() => cb('You have reached your usage limit'), 30)),
    paths: p, curatedIndex: async () => [], sessionTimeoutMs: 3_000, pollMs: 20,
  })
  await assert.rejects(
    run([{ taskId: 't1', intent: 'x', transcriptPath: '/nope', fromLine: 0, lines: ['{}'], lookback: [], newOffset: 1 }]),
    RateLimitedError,
  )
  assert.equal((await readCursor(p)).sessions.t1?.lineOffset ?? 0, 0)  // untouched
  assert.equal((await listPendingProposals(p)).length, 0)
})
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `makeRunSweep`**

Per material session:
1. Reduce: `reduceTranscript(lookback.concat(lines).join('\n'), { maxChars: 200_000 })` → write to `tracesDir/<taskId>-<sweepId>.txt`.
2. One-shot session (shared helper `runOneShot(prompt, outPath, workDir)` — the librarian pattern condensed): mkdir a scratch dir under `paths.root/work/<sweepId>/<label>`; spawn executor `{cwd, env: process.env, taskId: 'curator-<label>'}`; `isReady()`; `writeStdin('')` (folder-trust); sleep `readyGraceMs≈1500`; `writeStdin(prompt)`; sleep `submitConfirmMs`; `write('\r')` (the paste-confirm quirk — `router.ts:485-488`); poll `outPath` until `sessionTimeoutMs` (the router's `waitForDecision` shape, including one re-inject at 15 s: `write('\x15')`, re-`writeStdin(prompt)`, confirm-Enter); `kill()` in a `finally`. **Rate-limit watch:** accumulate `onData` chunks (tail-capped 64 k); if `/usage limit|rate limit|limit reached|out of.*(credits|usage)/i` matches → throw `RateLimitedError` immediately (kill first).
3. Distill each material session sequentially (sessions are cheap; parallelism is a later optimization and would multiply peak quota draw): `parseDistillOutput` → collect.
4. `mergeDistill` into candidates (serialized store write) with `tracePointer` = the trace file's store-relative path.
5. Synthesize once: `buildSynthesizePrompt` with all candidates (read back post-merge), `curatedIndex()`, rejections, unconsumed feedback → `runOneShot` → `parseSynthesizeOutput`.
6. Persist: for each proposal — `writeProposal` + write `draft.md` beside it (`proposals/<id>/draft.md` = `proposal.draft.body`; the conversation edits this file) + `appendLedger({action:'proposed', skill: draft.name, proposalId, sweepId})`.
7. Success bookkeeping (ONLY now): update cursor (`sessions[taskId] = {transcriptPath, lineOffset: newOffset, lastSweptAt: now, sweeps: +1}`, `lastSweepAt = now`), `markFeedbackConsumed(sweepId)`.
8. Any throw (incl. `RateLimitedError`) propagates BEFORE step 7 — the scheduler logs it; nothing advanced. (Candidates may already contain this sweep's merges — harmless by Task 4's (key,task,sweep) idempotency on retry.)

`sweepId = 'sw_' + now()`.

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add electron/remote/curator.ts electron/remote/curator.test.ts
git commit -m "feat(curator): sweep pipeline — reduce/distill/accumulate/synthesize, rate-limit backoff, cursor-on-success"
```

---

### Task 10: Conversation backend + `typeUnsubmitted`

Two independent PTY features: (a) the review popup's conversation session; (b) D14 tap-to-invoke plumbing.

**Files:**
- Modify: `desktop/electron/remote/curator.ts` (conversation manager)
- Modify: `desktop/electron/remote/task-manager.ts` (`typeUnsubmitted`)
- Test: `desktop/electron/remote/curator.test.ts`, `desktop/electron/remote/task-manager.test.ts` (append)

**Interfaces:**
- Produces:

```ts
// curator.ts
export class ProposalConversation {
  constructor(o: { executorFactory: ExecutorFactory; paths: CuratorPaths; proposalId: string; onData: (chunk: string) => void })
  start(): Promise<boolean>        // spawns a CC session in proposals/<id>/ primed with the proposal; streams via onData
  write(data: string): void        // raw keystrokes from the popup terminal
  stop(): void
  readonly alive: boolean
}
// task-manager.ts
typeUnsubmitted(taskId: string, text: string): boolean   // executor.write(text) — NO carriage return. false if task/executor gone.
```

- [ ] **Step 1: Write the failing tests**

`task-manager.test.ts` (append — follow that file's existing fake-executor helpers):

```ts
test('typeUnsubmitted writes raw text with no CR to the task executor', async () => {
  // use the file's existing harness to create a manager + dispatched task with a fake executor
  // capture: fake executor records write() payloads separately from writeStdin()
  const ok = manager.typeUnsubmitted(taskId, '/pr-review ')
  assert.equal(ok, true)
  assert.deepEqual(fake.rawWrites, ['/pr-review '])       // no '\r' appended anywhere
  assert.equal(manager.typeUnsubmitted('nope', 'x'), false)
})
```

`curator.test.ts` (append):

```ts
test('ProposalConversation: spawns in the proposal dir, primes with draft, streams, forwards keys', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  await writeProposal(p, prop('prop_c'))
  await fs.writeFile(path.join(p.proposalsDir, 'prop_c', 'draft.md'), 'body v1')
  const chunks: string[] = []; const typed: string[] = []; const raw: string[] = []
  let emit: (c: string) => void = () => {}
  const ex = {
    alive: true, spawn: async (o: { cwd: string }) => { assert.ok(o.cwd.endsWith('prop_c')) },
    isReady: async () => {}, writeStdin: (t: string) => typed.push(t), write: (d: string) => raw.push(d),
    resize: () => {}, onData: (cb: (c: string) => void) => { emit = cb }, kill: () => {},
  } as unknown as AgentExecutor
  const conv = new ProposalConversation({ executorFactory: () => ex, paths: p, proposalId: 'prop_c', onData: (c) => chunks.push(c) })
  assert.equal(await conv.start(), true)
  emit('hello')
  assert.deepEqual(chunks, ['hello'])
  assert.ok(typed.join('\n').includes('draft.md'))        // primer points the session at the draft file + evidence
  conv.write('why?')
  assert.deepEqual(raw.filter((r) => r === 'why?'), ['why?'])
})
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement**

- `typeUnsubmitted`: look up the task's live executor (same map `attach-image` typing uses — find the handler for `remote:attach-image` in `init.ts` and mirror how it reaches the executor to type an unsubmitted path); call `executor.write(text)` (raw, no CR). Return false when task unknown/dead.
- `ProposalConversation.start()`: read the proposal; spawn in `proposals/<id>/`; `isReady()`; `writeStdin('')` + grace (trust prompt); prime with one `writeStdin(primer)` where primer =

```
[Unmute curator — proposal review] You are discussing ONE proposed skill with the user.
The proposal: ./proposal.json (evidence pointers inside reference reduced traces under <tracesDir>).
The editable draft: ./draft.md — when the user asks for changes, EDIT that file in place and confirm what changed.
Answer questions about why this skill was proposed (read proposal.json's evidence + rationale).
Never touch any file outside this directory. Start by summarizing the proposal in two sentences.
```

- `onData` pipes straight through (the popup renders raw PTY output). `write` = raw passthrough. `stop()` kills. Curator holds a `Map<proposalId, ProposalConversation>` with accessors `startConversation/writeConversation/stopConversation` used by IPC in Task 12; starting a second conversation for the same id stops the first.

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add electron/remote/curator.ts electron/remote/curator.test.ts electron/remote/task-manager.ts electron/remote/task-manager.test.ts
git commit -m "feat(curator): proposal conversation sessions + typeUnsubmitted (tap-to-invoke plumbing)"
```

---

### Task 11: Router — `skill` field + `skill_feedback` action

**Files:**
- Modify: `desktop/electron/remote/router.ts`
- Test: `desktop/electron/remote/router.test.ts` (append — the file exists; follow its harness)

**Interfaces:**
- Produces: `RouteDecision.skill?: string`; `RouteDecision.action` union gains `'skill_feedback'`; `buildRoutingPrompt(...)` and `parseDecision(...)` each gain a trailing `skillNames: string[] = []` parameter. **All existing call sites keep working (new params default to `[]`).**

- [ ] **Step 1: Write the failing tests** (append to `router.test.ts`)

```ts
test('prompt lists skills and instructs skill/skill_feedback when names supplied', () => {
  const p = buildRoutingPrompt('u', [], '/d.json', [], [], [], [], ['pr-review', 'video-load-premiere'])
  assert.ok(p.includes('pr-review'))
  assert.ok(/skill_feedback/.test(p))
  const bare = buildRoutingPrompt('u', [], '/d.json')
  assert.ok(!/skill_feedback/.test(bare))              // section only renders when skills exist
})

test('parseDecision: skill honored only when known; junk dropped', () => {
  const d = parseDecision(JSON.stringify({ action: 'new', intent: 'i', skill: 'pr-review' }), 'i', [], [], [], [], [], ['pr-review'])
  assert.equal(d.skill, 'pr-review')
  const junk = parseDecision(JSON.stringify({ action: 'new', intent: 'i', skill: 'made-up' }), 'i', [], [], [], [], [], ['pr-review'])
  assert.equal(junk.skill, undefined)
})

test('parseDecision: skill_feedback requires a known skill, else failsafe', () => {
  const fb = parseDecision(JSON.stringify({ action: 'skill_feedback', intent: 'it misses lockfiles', skill: 'pr-review' }), 'x', [], [], [], [], [], ['pr-review'])
  assert.equal(fb.action, 'skill_feedback')
  assert.equal(fb.skill, 'pr-review')
  const bad = parseDecision(JSON.stringify({ action: 'skill_feedback', intent: 'x', skill: 'unknown' }), 'x', [], [], [], [], [], ['pr-review'])
  assert.equal(bad.action, 'new')                      // failsafe — never invent a feedback target
})
```

(Match `buildRoutingPrompt`/`parseDecision`'s real current signatures when appending the params — the calls above show the trailing-argument position, after `wall`.)

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement**

- `RouteDecision`: `action: 'new' | 'continue' | 'resume' | 'speak' | 'curate' | 'skill_feedback'`; add `skill?: string` with docstring: *"Skill the user explicitly asked to use by name (validated against the offered list) — or, for skill_feedback, the skill the feedback is about. Unmute never chooses one unprompted."*
- `buildRoutingPrompt(…, wall, skillNames: string[] = [])`: when non-empty, append a section:

```
THE USER'S SKILLS (reference list — names only): <comma-joined names>
If the command EXPLICITLY asks to use one of these by (fuzzy) name — "use my
PR review skill", "run the video load skill" — set "skill" to that EXACT
listed name on your normal WORK decision. Only when the user names one;
never volunteer a skill.
SKILL FEEDBACK: if the command is feedback ABOUT one of these skills — a
complaint, correction, or suggestion about how the skill itself behaves
("the pr-review skill keeps missing lockfiles") — choose action
"skill_feedback" with "skill" set to that name and intent = the feedback,
cleaned. Nothing is spawned.
```

  and extend the JSON shape line with `"skill":"<listed skill name or omit>"`.
- `parseDecision(…, wall, skillNames: string[] = [])`: `const knownSkills = new Set(skillNames)`; sanitize `obj.skill` (trim/de-quote) → `skill` only if known. Handle `action === 'skill_feedback'`: valid skill → `{ action: 'skill_feedback', skill, intent }`; else `failsafeDecision`. Thread validated `skill` into the returned `new`/`continue`/`resume` decisions.

- [ ] **Step 4: Run to verify PASS** (whole router suite: `node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/router.test.ts`).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add electron/remote/router.ts electron/remote/router.test.ts
git commit -m "feat(router): skill field (explicit user ask only) + skill_feedback species"
```

---

### Task 12: init.ts wiring + preload — curator IPC, dispatch prefix, feedback, provenance on the rail

The integration task. No new logic — everything wired is already tested; verification here is typecheck + targeted greps + the E2E task.

**Files:**
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/electron/remote-preload.ts`

**Interfaces:**
- Produces (renderer-facing, all mirrored in preload):

```ts
curatorListProposals(): Promise<Proposal[]>
curatorGetProposal(id: string): Promise<Proposal | null>
curatorAccept(id: string): Promise<{ ok: boolean; error?: string }>
curatorReject(id: string, reason?: string): Promise<boolean>
curatorLedger(): Promise<LedgerEntry[]>
curatorConverseStart(id: string): Promise<boolean>       // stream arrives on 'curator:conv-data' events {id, chunk}
curatorConverseWrite(id: string, data: string): Promise<void>
curatorConverseStop(id: string): Promise<void>
curatorTapSkill(taskId: string, name: string): Promise<boolean>   // typeUnsubmitted(taskId, `/${name} `)
// remote:list-skills entries gain: origin?: 'unmute'
```

- [ ] **Step 1: Instantiate + start the curator** (in `init.ts`, after the router construction ~line 1470):

```ts
const curatorPathsV = curatorPaths()
const curator = new Curator({
  paths: curatorPathsV,
  sweepIntervalMs: () => getKnobs().curatorSweepIntervalMs,
  listSessions: async () => {
    // session-kind tasks from disk: ~/.unmute/remote/local/*/meta.json
    const base = join(homedir(), '.unmute', 'remote', 'local')
    const out: SessionInfo[] = []
    for (const id of await fs.readdir(base).catch(() => [] as string[])) {
      try {
        const m = JSON.parse(await fs.readFile(join(base, id, 'meta.json'), 'utf8'))
        if (m.kind === 'session') out.push({ taskId: id, intent: m.intent ?? '', cwd: m.cwd ?? join(base, id), kind: 'session' })
      } catch { /* skip */ }
    }
    return out
  },
  isBusy: () => manager.hasProcessingTask() /* add this tiny accessor if absent: any task in state 'processing' */ ,
  runSweep: makeRunSweep({ executorFactory: librarianExecutorFactory, paths: curatorPathsV, curatedIndex: async () => { /* ledger names + read each SKILL.md description */ } }),
})
curator.start()
```

(Reuse the exact executor factory the librarian was constructed with — same tool-less spawn profile; grep `librarianExecutorFactory` in `init.ts` for its definition.) Wire checkpoints where task events are handled (the `manager.on('done')`/`'updated'` subscriptions in init.ts): on `done`, `ready`, and kill → `curator.notifyCheckpoint(task.id)`.

- [ ] **Step 2: Register the IPC handlers** next to the existing `remote:list-skills` block, each a thin call into Task 2/6/10 functions. `curator:accept`: read proposal → read `proposals/<id>/draft.md` (if present and ≠ `proposal.draft.body` → `userEdited = true`, body = file) → `writeSkill({draft, kind, userEdited, proposalId, paths, originStamp: <Task 1 finding>, diff})` → on ok `resolveProposal(id, {action:'accepted', …})`; on collision return the error string for the popup. `curator:reject`: `appendRejection` + `appendLedger({action:'rejected'})` + `resolveProposal`. `curator:conv-data` events: forward `ProposalConversation.onData` chunks via `overlayWindow.webContents.send('curator:conv-data', { id, chunk })` (mirror how task terminal data reaches `LiveTerminal` — grep `term-data` for the channel pattern).

- [ ] **Step 3: Route wiring** — at the `router.route(...)` call site in init.ts: build `skillNames` from the same list `remote:list-skills` produces (cache it; refresh per route call is fine — it's a disk walk) and pass as the new trailing arg to both `route()` internals (thread through `Router.route` → `routeOnce` → `buildRoutingPrompt`/`parseDecision` — add the passthrough param to those Router methods). Handle the decision:
  - `decision.skill && (action new/continue/resume)` → prefix the dispatched/injected intent: `const finalIntent = decision.skill ? `/${decision.skill} ${decision.intent}` : decision.intent`.
  - `action === 'skill_feedback'` → if `curatedSkillNames(await readLedger(curatorPathsV)).has(decision.skill!)` → `appendFeedback({at: new Date().toISOString(), skill: decision.skill!, note: decision.intent})` + speak "Noted — I'll factor that into the skill's next review."; else speak "Noted, but that skill isn't one I manage." Nothing spawned either way.

- [ ] **Step 4: Provenance on the rail** — in the `remote:list-skills` handler's final `.map`, add `origin: curatedNames.has(s.name) ? 'unmute' as const : undefined` (read the ledger once at handler start).

- [ ] **Step 5: Preload** — add the nine `curator*` bindings next to `remoteListSkills` (`remote-preload.ts:95`), plus a `curatorOnConvData(cb)` subscription following the file's existing `.on`-wrapper pattern.

- [ ] **Step 6: Verify**

Run: `npm run typecheck` → clean. Run: `npm test` → all suites pass. Grep-audit: `grep -n "curator:" electron/remote/init.ts electron/remote-preload.ts` shows every channel registered + mirrored.

- [ ] **Step 7: Commit**

```bash
git add electron/remote/init.ts electron/remote-preload.ts
git commit -m "feat(curator): wire scheduler, IPC surface, route skill-prefixing, feedback capture, rail provenance"
```

---

### Task 13: Rail sections — SUGGESTIONS + UNMUTE SKILLS (`OrchestrateWall.tsx`)

**Files:**
- Modify: `desktop/engine-overrides/renderer/remote/OrchestrateWall.tsx`

**Interfaces:**
- Consumes: `curatorListProposals`, `curatorTapSkill`, `origin` flag on `remoteListSkills` entries (Task 12). Produces: `onOpenProposal(id)` state consumed by Task 14's popup.

- [ ] **Step 1: State + load.** In the existing skills-rail block (anchor: the `const [skills, setSkills]` declaration near line 478): extend the skill row type with `origin?: 'unmute'`; add `const [proposals, setProposals] = useState<Array<{ id: string; kind: 'create' | 'update'; draft: { name: string; description: string } }>>([])` and `const [openProposalId, setOpenProposalId] = useState<string | null>(null)`; in the existing 5-minute `load()` effect add `void api?.curatorListProposals?.().then((p) => setProposals(p ?? [])).catch(() => {})`.

- [ ] **Step 2: Render.** Locate the rail's render region (search for `skillsExpanded` usage in JSX). Insert ABOVE the existing skills list, matching the rail's visual idiom (uppercase micro-headers, `text-[9px] tracking-[0.12em] text-white/30`, rows `text-[12px]`):

```tsx
{proposals.length > 0 && (
  <div className="mb-3">
    <div className="text-[9px] uppercase tracking-[0.12em] text-amber-200/70 mb-1">
      suggestions <span className="text-amber-200/40">({proposals.length})</span>
    </div>
    {proposals.map((p) => (
      <button key={p.id} className="w-full text-left px-1.5 py-1 rounded-lg hover:bg-white/[0.06]"
        onClick={() => setOpenProposalId(p.id)}>
        <span className="text-[10px] uppercase mr-1.5 text-amber-200/60">{p.kind === 'update' ? 'edit' : 'new'}</span>
        <span className="text-[12px] text-white/85">{p.draft.name}</span>
      </button>
    ))}
  </div>
)}
```

Then partition the existing `skills` array: `const unmuteSkills = skills.filter((s) => s.origin === 'unmute')`, `const otherSkills = skills.filter((s) => s.origin !== 'unmute')`. Render an `unmute skills` header + rows for `unmuteSkills` (same row component as today, plus the tap-to-invoke click below), then the existing list over `otherSkills` unchanged.

- [ ] **Step 3: Tap-to-invoke (D14).** On an unmute-skill row click: enabled only when a task terminal is open (the component already tracks the focused/expanded task with a visible terminal — reuse that state; if none, the row is inert with `title="open a task's terminal to insert this skill"`):

```tsx
onClick={() => { if (openTerminalTaskId) void api?.curatorTapSkill?.(openTerminalTaskId, s.name) }}
```

Writes `/name ` unsubmitted — the user presses Enter (never us).

- [ ] **Step 4: Verify.** `npm run typecheck` (renderer config) → clean. Manual: `npm run dev`, open cockpit — with no proposals the rail is unchanged; seed a fake proposal dir under `~/.unmute/remote/curator/proposals/` (copy the shape from a Task 2 test) and confirm the SUGGESTIONS section renders and opens state.

- [ ] **Step 5: Commit**

```bash
git add engine-overrides/renderer/remote/OrchestrateWall.tsx
git commit -m "feat(curator): rail — SUGGESTIONS inbox + UNMUTE SKILLS section + tap-to-invoke (unsubmitted)"
```

---

### Task 14: `SkillReviewPopup.tsx` — the center review popup

**Files:**
- Create: `desktop/engine-overrides/renderer/remote/SkillReviewPopup.tsx`
- Modify: `desktop/engine-overrides/renderer/remote/OrchestrateWall.tsx` (mount)

**Interfaces:**
- Consumes: `curatorGetProposal`, `curatorAccept`, `curatorReject`, `curatorConverse*`, `curatorOnConvData` (Task 12). Props: `{ proposalId: string; onClose: () => void }`.

- [ ] **Step 1: Component.** Fixed-center overlay card (`position:fixed inset-0` scrim + centered `max-w-2xl max-h-[80vh]` panel, `bg-[#111] border border-white/10 rounded-2xl`, matching cockpit dark idiom). Content:
  - Header: kind chip (`new skill` / `skill edit`), `draft.name`, close (=Cancel: `onClose()` — proposal stays pending).
  - Evidence strip: `seen {evidence.occurrences}× · {sessions.length} sessions · {struggle.wallClockMin}min of work` + rationale paragraph.
  - Body: `kind==='create'` → the draft body in a `whitespace-pre-wrap` scroll pane; `kind==='update'` → the unified `diff` rendered line-by-line (`+` rows `text-emerald-300/80`, `-` rows `text-rose-300/70`).
  - Conversation pane (collapsed behind a "discuss / edit" button): on open → `curatorConverseStart(id)`; a `<pre>` scrollback appending `curatorOnConvData` chunks for this id (strip ANSI: `.replace(/\[[0-9;?]*[A-Za-z]|\][^]*/g, '')`); an input line sending on Enter via `curatorConverseWrite(id, value + '\r')`. `curatorConverseStop(id)` on unmount.
  - Footer: **Accept** → `curatorAccept(id)`; on `{ok:false,error}` show the error inline (collision → "name already exists — discuss a rename"); on ok `onClose()`. **Reject** → a one-line optional reason input + `curatorReject(id, reason)` → `onClose()`.
- [ ] **Step 2: Mount** in `OrchestrateWall`: `{openProposalId && <SkillReviewPopup proposalId={openProposalId} onClose={() => { setOpenProposalId(null); void api?.curatorListProposals?.().then((p) => setProposals(p ?? [])) }} />}`.
- [ ] **Step 3: Verify.** `npm run typecheck` → clean. Manual (`npm run dev` + seeded proposal): open popup, read draft, start conversation (a real CC session spawns — type "make the description shorter", watch `draft.md` change), Cancel keeps it pending, Reject with a reason resolves it, Accept writes `~/.claude/skills/<name>/SKILL.md` and it appears under UNMUTE SKILLS on next rail refresh.
- [ ] **Step 4: Commit**

```bash
git add engine-overrides/renderer/remote/SkillReviewPopup.tsx engine-overrides/renderer/remote/OrchestrateWall.tsx
git commit -m "feat(curator): review popup — draft/diff + evidence + conversational edit + accept/reject"
```

---

### Task 15: Calibration harness (dev-only, never ships)

**Files:**
- Create: `desktop/scripts/curator-calibrate.ts`

**Interfaces:**
- Consumes: `curator-triage`, `curator-store.readTranscriptDelta`, `reduceTranscript`, prompts + `makeRunSweep` internals (import the one-shot helper if exported, else the executor factory pattern).

- [ ] **Step 1: Write the script.** `npx tsx scripts/curator-calibrate.ts [--distill N] [--out FILE]`:
  1. Enumerate `~/.claude/projects/*unmute-remote-local*` dirs, **excluding `*-librarian`** (and `-router`/`-curator` suffixed); for each, take the largest `.jsonl`.
  2. Per transcript: `readTranscriptDelta(path, 0)` → `computeTriageMetrics` → print a sorted table `taskId | MB | wallClock | tools | errors | recoveries | userTurns | PASS/fail`, plus totals (`N transcripts, M pass triage`). (No `meta.json` filter — purged history; duration/size proxy per spec §10.)
  3. With `--distill N`: for the top N passing transcripts, run reduce→distill→synthesize using the real PTY executor (construct it exactly as init.ts's `librarianExecutorFactory` does — copy that construction; interactive REPL spawn, the subscription-billing path) with `paths = curatorPaths(join(os.tmpdir(), 'curator-calib'))` so **nothing touches the real store**, and write resulting proposals to `--out` (default `curator-calibration-proposals.json`).
  4. Print the proposals as a readable digest (name, occurrences, rationale) — the artifact the user reads to tune `DEFAULT_TRIAGE` and the synthesize prompt until it reads "yes, I'd take these".
- [ ] **Step 2: Verify phase 1 runs.** Run: `npx tsx scripts/curator-calibrate.ts` → table over real history, no errors, no writes outside tmp.
- [ ] **Step 3: Commit**

```bash
git add scripts/curator-calibrate.ts
git commit -m "feat(curator): calibration harness — triage survey + optional distill/synthesize over history (tmp store)"
```

---

### Task 16: End-to-end proof (spec §10 — the librarian lesson)

One real accept must travel the whole loop before this branch is done. Manual, with exact steps; record results in the preflight doc.

- [ ] **Step 1:** Run the calibration harness with `--distill 3`; pick its best proposal; copy that proposal dir into the real store `~/.unmute/remote/curator/proposals/` (or lower `DEFAULT_TRIAGE`/knob and let a real sweep produce one).
- [ ] **Step 2:** `npm run dev` → cockpit shows SUGGESTIONS(1) → open popup → ask the conversation one "why?" → request one edit → confirm `draft.md` changed → **Accept**.
- [ ] **Step 3:** Verify on disk: `cat ~/.claude/skills/<name>/SKILL.md` — frontmatter has `disable-model-invocation: true`; ledger (`~/.unmute/remote/curator/ledger.json`) shows `proposed` → `user-edited-accept`/`created` with hash; rail shows it under UNMUTE SKILLS.
- [ ] **Step 4:** Invoke it all three ways: (a) type `/name` in a terminal `claude` session → runs; (b) open a cockpit task terminal, tap the skill → `/name ` appears **unsubmitted**, press Enter → runs; (c) say "use my <name> skill to …" → router decision carries `skill`, task receives the prefixed intent.
- [ ] **Step 5:** Say "the <name> skill should also …" → confirm `feedback.json` gained the note and Unmute acknowledged aloud. Then hand-edit the SKILL.md, wait/trigger `detectDrift` (or call it from a node REPL) → ledger gains `user-modified-detected`.
- [ ] **Step 6:** Append the E2E results to `desktop/docs/superpowers/specs/2026-07-17-curator-preflight.md`; commit:

```bash
git add desktop/docs/superpowers/specs/2026-07-17-curator-preflight.md
git commit -m "docs(curator): end-to-end proof — full loop exercised (sweep→popup→accept→invoke→feedback→drift)"
```

---

## Self-Review (performed at write time)

- **Spec coverage:** D1–D16 → D1/D2 (Task 8 material gate + Task 4 per-instance counts), D3/D4 (Task 5 prompts), D5 (no confidence anywhere; runs come from existing `skill-usage.ts`), D6 (Tasks 3+5), D7–D10 (Task 6), D11 (Tasks 7+8), D12 (Tasks 13+14), D13 (Tasks 2+5 evidence), D14 (Tasks 10+13), D15 (data-only: ledger + existing usage ledger), D16 (Task 15 + ordering). Spec §6.4 feedback (Tasks 11+12), §8 update detection (Task 5 distill `usedCuratedSkill` + synthesize update-vs-duplicate rule + Task 12 feedback path), §9 invariants (Tasks 2/8/9), §11 preflight (Task 1), §12 parking (Task 7). Retirement *action*: intentionally absent (D15).
- **Placeholder scan:** no TBDs; the two "grep and mirror" steps (attach-image executor access, librarianExecutorFactory construction) name the exact anchor to copy from — discovery steps, not omissions.
- **Type consistency:** `MaterialSession`, `Proposal`, `DistillProcedure`, `CuratorPaths` flow Task 2 → 4 → 5 → 8 → 9 → 12 with matching names; router params trail after `wall` in both functions; `origin: 'unmute'` shape identical in init (Task 12) and rail (Task 13).
