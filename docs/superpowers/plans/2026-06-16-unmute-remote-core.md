# Unmute Remote — Core Vertical Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **READ THIS FIRST — non-dilution rule.** The canonical source of truth for *what* and *why* is the PRD ("Unmute Remote — Build Specification", in the conversation that produced this plan). This plan does **not** restate PRD decisions. It is purely the codebase-wiring delta the PRD intentionally left out: which real file, which seam, new-or-additive, and how to test. Every task cites the governing PRD section (e.g. `PRD §6.1`). If this plan and the PRD ever disagree on behavior, the PRD wins — fix the plan.

**Goal:** Build the sequential core vertical of Unmute Remote — press the Remote key → speak → dispatch to a PTY-owned interactive `claude` session → detect completion/needs-user via a status file + staleness backstop → surface as a task row with notification — additively, with zero regression to existing dictation.

**Architecture:** A new closed-source `remote/` module set under `desktop/electron/` (mirroring the existing `paywall/` additive pattern), wired into the OSS engine via the existing `engine-overrides/` mechanism. Execution is a swappable CLI-agent executor (PRD §11) whose default drives the interactive `claude` REPL inside a `node-pty` (PRD §4). Behavior is governed entirely by the PRD; this plan only maps it onto files. See `desktop/build/PATCHES.md` for how overrides land in `work/oss-engine/`.

**Tech Stack:** Electron (main + preload + renderer), TypeScript, `node-pty` (new native dep, packaged/signed like the existing `native-fn-listener`), existing STT pipeline + managed/BYOK LLM path (reused for intent-cleanup), Vitest/node:test for unit tests.

**Scope of THIS plan:** PRD §15.2 steps 1–3 + the §2.4.4 mode-routing/no-regression seam. The parallelizable breadth (recipes/librarian §8–9, MCP handoff §12, safety guards §10.6–10.7, full UI §13, portability second-adapter §11, extended §17) is **out of this plan** and listed in "Follow-on plans" at the end — each becomes its own plan once the core loop runs and contracts are frozen.

---

## File Structure (decomposition — locked here)

**New, closed-source (this repo) — built into `work/oss-engine/electron/remote/` by the build script (extend `wire-into-engine.sh` Stage 2, mirroring how `paywall/` files are copied):**

- `desktop/electron/remote/executor.ts` — the swappable CLI-agent interface (PRD §11.3: `spawn / writeStdin / onData / kill / isReady`). Default impl `ClaudeCodeExecutor`. This is the portability seam; everything above it is agent-agnostic.
- `desktop/electron/remote/pty-session.ts` — one `node-pty` running the interactive `claude` REPL (PRD §4.1). Spawn with no `ANTHROPIC_API_KEY` (PRD §3.2), readiness detection (PRD §5/decided), stdin write, data stream, kill.
- `desktop/electron/remote/status-file.ts` — the frozen wire protocol (PRD §6.1). Schema types, atomic-tolerant reader (PRD #2 decision), serializer for the *scaffold only*, mtime staleness watcher (PRD §6.3 decided = file-staleness, not terminal-silence).
- `desktop/electron/remote/task-manager.ts` — task model + lifecycle (PRD §5.3), concurrency map (PRD §4.4), owns file-path creation/scaffolding (PRD: Unmute creates, Claude fills), spawns sessions, emits completion (PRD §13.6: Unmute observes, Claude does not notify).
- `desktop/electron/remote/mode-router.ts` — **pure**: derive Remote key from the existing dictation-key setting + capture-time mutual-exclusion lock (PRD §2.4.4).
- `desktop/electron/remote/intent-cleanup.ts` — added STT→intent stage (PRD §13.7) via the existing managed/BYOK LLM path. NOT a new STT engine.
- `desktop/electron/remote/dispatch-prompt.ts` — builds the per-task *typed* stdin payload = per-task status-file path + the task intent (PRD #3 decision: only path + task are typed; the stable contract lives in the static file below).
- `desktop/electron/remote/contract/` — the static status-file/heartbeat contract content (PRD §8.1, §6.1) + installer that writes it where Claude Code auto-loads it (PRD #3 decision: CLAUDE.md / skill). Path convention decided in Task 4.
- `desktop/electron/remote-ipc.ts` — IPC channels (main↔renderer) for the task panel/rows. Mirrors existing `balance-ipc.ts`/`auth-ipc.ts`.
- `desktop/electron/remote-preload.ts` — preload bridge additions (spread into `electronAPI`, mirroring `preload-extensions.ts`).

**Additive edits to existing override files (extend, never alter dictation paths — PRD §2.4.1):**

- `desktop/engine-overrides/electron/keyListener.ts` — surface Remote-key capture start/stop with the mutual-exclusion lock. The override already emits `right-option-down/up` + `fn-down/up`; add Remote routing additively.
- `desktop/engine-overrides/electron/sessionManager.ts` — at capture dispatch, when the active capture is Remote-mode, route to `task-manager` instead of the paste path. Additive intercept at the top, exactly like the existing managed-cloud intercept (see `PATCHES.md`).
- `desktop/build/wire-into-engine.sh` — Stage 2: copy `desktop/electron/remote/` → `work/oss-engine/electron/remote/`; add the grep paranoia checks (per `PATCHES.md` convention); init Remote in `main.ts` (sed insert next to `initPaywall`, or a 5th full-file override of `main.ts`).
- `desktop/package.json` + `desktop/engine-overrides/electron-builder.yml` — add `node-pty`, package as a native module + sign/notarize like `native-fn-listener`.

**New renderer (minimal for core — full UI is a follow-on plan):**

- `desktop/engine-overrides/renderer/remote/AmbientIndicator.tsx` — pill-adjacent count/state (PRD §13.2). Additive to the existing widget; do not alter dictation pill states.
- `desktop/engine-overrides/renderer/remote/TaskRow.tsx` — minimal row: cleaned intent + status + result/failure (PRD §13.4 items 1–4). Cancel/re-run/render-on-demand are follow-on.

**Tests:** co-located `*.test.ts` next to each pure module (`mode-router`, `status-file`, `dispatch-prompt`, `intent-cleanup` contract shape).

---

## Task 0: Empirical probes (PRD §3.6 billing, §15.2 step 1 + the §6.3/#1 TUI check)

These produce *facts*, not code. They do not block the design (staleness is the load-bearing backstop, PRD §6.3) but must run before wiring anything on top. Record findings in `docs/superpowers/plans/2026-06-16-remote-probe-findings.md`.

**Files:**
- Create: `docs/superpowers/plans/2026-06-16-remote-probe-findings.md`

- [ ] **Step 1: Billing probe.** In a throwaway PTY (or even a real terminal for this one-time check), launch the interactive `claude` REPL under the user's subscription login with **no** `ANTHROPIC_API_KEY` in env. Run a trivial task. Then run `/status`. Record: does usage land on **subscription** (not Agent SDK credit)? Expected per PRD §3.3: yes.

- [ ] **Step 2: TUI idle-silence probe.** Spawn interactive `claude` in a `node-pty` (throwaway script). Observe the raw PTY data stream while Claude is (a) thinking/working and (b) idle at the prompt waiting for input. Record: does the stream go genuinely quiet when idle-waiting, or does the TUI keep repainting (spinner/cursor)? Per PRD §6.3 this is *bonus only* — if quiet, we may later use silence as a fast secondary "blocked" hint; if not, we lose nothing.

- [ ] **Step 3: Readiness-signature probe.** From the same spawn, capture the exact byte/ANSI signature that indicates "TUI booted and ready to accept input" (PRD §5 / #5 decision). Record the concrete marker `pty-session.ts` will wait for. This feeds Task 5.

- [ ] **Step 4: Write findings.** Fill the findings doc with the three answers + the readiness marker. Commit.

```bash
git add docs/superpowers/plans/2026-06-16-remote-probe-findings.md
git commit -m "chore(remote): record billing + TUI probe findings"
```

**Gate:** if Step 1 shows API/SDK billing, STOP and escalate to the user — the economic premise (PRD §3) needs revisiting before further build.

---

## Task 1: Status-file schema — DRAFT + SIGN-OFF GATE (PRD §6.1, #4 decision)

I author the schema (it's an implementation artifact), then get one quick user sign-off **before** any code keys off it (PRD: this is the only thing the user wants eyes on before it's load-bearing).

**Files:**
- Create: `docs/superpowers/plans/2026-06-16-remote-status-schema.md` (the proposed schema doc)

- [ ] **Step 1: Draft the schema doc.** Define: file format (JSON), exact fields, allowed `state` values (`processing | needs-user | done | failed` — PRD §5.3), `result` summary payload (on `done`), `error` reason (on `failed`), optional `question` payload (on `needs-user`, PRD §7), optional `recipe_suggestion` pointer (PRD §8.1 — points at the scratch file, not inline), `updated_at` (heartbeat mtime is authoritative but include a logical timestamp too), `schema_version`. Specify the per-user/per-task path convention (PRD #5). Specify the atomic-write contract Claude must follow: temp-file-then-rename (PRD #2).

- [ ] **Step 2: Present to user for sign-off. STOP.** Do not proceed to Task 2 until approved. This is the single human gate in the core build.

---

## Task 2: `mode-router.ts` — derived Remote key + mutual exclusion (PRD §2.4.4) — TDD

Pure logic, fully testable, zero Electron. Build first because it's the no-regression-critical seam and has no dependencies.

**Files:**
- Create: `desktop/electron/remote/mode-router.ts`
- Test: `desktop/electron/remote/mode-router.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRemoteKey, CaptureLock } from './mode-router'

test('remote key is the one not chosen for dictation', () => {
  assert.equal(deriveRemoteKey('fn'), 'right-option')        // PRD §2.4.4 default
  assert.equal(deriveRemoteKey('right-option'), 'fn')
})

test('mutual exclusion: only one capture may start at a time', () => {
  const lock = new CaptureLock()
  assert.equal(lock.tryStart('dictation'), true)   // dictation acquires
  assert.equal(lock.tryStart('remote'), false)     // remote blocked while dictation active
  lock.end('dictation')
  assert.equal(lock.tryStart('remote'), true)      // free again
})

test('remote capture blocks a new dictation capture', () => {
  const lock = new CaptureLock()
  assert.equal(lock.tryStart('remote'), true)
  assert.equal(lock.tryStart('dictation'), false)
})
```

- [ ] **Step 2: Run test, verify it fails.** Run: `cd desktop && npx tsx --test electron/remote/mode-router.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```ts
export type TriggerKey = 'fn' | 'right-option'
export type CaptureMode = 'dictation' | 'remote'

/** PRD §2.4.4: Remote key is always "the one not chosen for dictation". */
export function deriveRemoteKey(dictationKey: TriggerKey): TriggerKey {
  return dictationKey === 'fn' ? 'right-option' : 'fn'
}

/** PRD §2.4.4: capture-time lock — at most one capture mode active at an instant.
 *  NOTE: this locks starting a new *capture* only; already-dispatched background
 *  Remote tasks keep running (PRD §4 async). */
export class CaptureLock {
  private active: CaptureMode | null = null
  tryStart(mode: CaptureMode): boolean {
    if (this.active !== null) return false
    this.active = mode
    return true
  }
  end(mode: CaptureMode): void {
    if (this.active === mode) this.active = null
  }
  get current(): CaptureMode | null { return this.active }
}
```

- [ ] **Step 4: Run test, verify PASS.** Run: `cd desktop && npx tsx --test electron/remote/mode-router.test.ts` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add desktop/electron/remote/mode-router.ts desktop/electron/remote/mode-router.test.ts
git commit -m "feat(remote): mode-router — derived remote key + capture mutual-exclusion lock"
```

---

## Task 3: `status-file.ts` — reader + staleness watcher (PRD §6.1, §6.3, #2) — TDD

Uses the schema approved in Task 1. **Do not start until Task 1 is signed off.** Reader is atomic-tolerant; watcher keys on mtime (PRD §6.3 decided backstop).

**Files:**
- Create: `desktop/electron/remote/status-file.ts`
- Test: `desktop/electron/remote/status-file.test.ts`

- [ ] **Step 1: Write failing tests** (adjust field names to the Task-1-approved schema before running):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStatus, isStale } from './status-file'

test('reader returns null on a half-written file (tolerant, no throw)', async () => {
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'st-')), 'status.json')
  await fs.writeFile(f, '{ "state": "proce')   // truncated mid-write
  assert.equal(await readStatus(f), null)        // PRD #2: ignore + retry next poll
})

test('reader parses a valid done payload', async () => {
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'st-')), 'status.json')
  await fs.writeFile(f, JSON.stringify({ schema_version: 1, state: 'done', result: 'extracted 12 files' }))
  const s = await readStatus(f)
  assert.equal(s?.state, 'done')
  assert.equal(s?.result, 'extracted 12 files')
})

test('isStale: true when state=processing and mtime older than threshold', () => {
  const now = 1_000_000
  assert.equal(isStale({ state: 'processing' }, now - 6 * 60_000, now, 5 * 60_000), true)   // 6min > 5min
  assert.equal(isStale({ state: 'processing' }, now - 2 * 60_000, now, 5 * 60_000), false)  // fresh
  assert.equal(isStale({ state: 'done' },       now - 6 * 60_000, now, 5 * 60_000), false)  // terminal never stale
})
```

- [ ] **Step 2: Run, verify FAIL.** `cd desktop && npx tsx --test electron/remote/status-file.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (field names per Task 1 schema; shape below assumes the minimal schema):

```ts
import { promises as fs } from 'node:fs'

export type TaskState = 'processing' | 'needs-user' | 'done' | 'failed'   // PRD §5.3
export interface StatusPayload {
  schema_version?: number
  state: TaskState
  result?: string
  error?: string
  question?: { text: string }      // PRD §7
  recipe_suggestion?: string       // PRD §8.1 — pointer to scratch file
}

/** Atomic-tolerant read (PRD #2): returns null on missing/partial/invalid — caller retries next poll. */
export async function readStatus(filePath: string): Promise<StatusPayload | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as StatusPayload
    return parsed && typeof parsed.state === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** PRD §6.3: staleness backstop — TUI-independent. Only non-terminal states can be stale. */
export function isStale(
  status: Pick<StatusPayload, 'state'>,
  mtimeMs: number,
  nowMs: number,
  thresholdMs: number,
): boolean {
  if (status.state !== 'processing' && status.state !== 'needs-user') return false
  return nowMs - mtimeMs > thresholdMs
}
```

- [ ] **Step 4: Run, verify PASS.** `cd desktop && npx tsx --test electron/remote/status-file.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add desktop/electron/remote/status-file.ts desktop/electron/remote/status-file.test.ts
git commit -m "feat(remote): status-file reader (atomic-tolerant) + mtime staleness backstop"
```

---

## Task 4: Static contract installer + dispatch-prompt (PRD §8.1, #3) — TDD on the builder

The stable status/heartbeat contract is a file Claude Code auto-loads; only path+task get typed. Decide the install path here (per Task-0 findings on where `claude` auto-loads from — typically a `CLAUDE.md` in the session cwd and/or a skill dir).

**Files:**
- Create: `desktop/electron/remote/contract/contract.md` (the static contract text — cites PRD obligations: heartbeat status updates before/after each step + on completion, atomic temp-then-rename writes, ask-channel via status file, write recipe suggestion to scratch file)
- Create: `desktop/electron/remote/contract/installer.ts` (writes/refreshes the contract into the session working dir without clobbering a user's own CLAUDE.md — append-with-markers or separate skill file)
- Create: `desktop/electron/remote/dispatch-prompt.ts`
- Test: `desktop/electron/remote/dispatch-prompt.test.ts`

- [ ] **Step 1: Failing test for the typed payload builder.**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDispatch } from './dispatch-prompt'

test('typed payload carries only the per-task path + intent, not the full contract', () => {
  const out = buildDispatch({ intent: 'extract ~/Downloads/report.zip', statusPath: '/tmp/u/t1/status.json' })
  assert.match(out, /\/tmp\/u\/t1\/status\.json/)         // dynamic path present
  assert.match(out, /extract ~\/Downloads\/report\.zip/)  // intent present
  assert.ok(out.length < 600)                              // PRD #3: not a wall of contract text
})
```

- [ ] **Step 2: Run, verify FAIL.** `cd desktop && npx tsx --test electron/remote/dispatch-prompt.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `buildDispatch`** (terse — the contract obligations live in the static file, not here):

```ts
export interface DispatchInput { intent: string; statusPath: string }

/** PRD #3: only the per-task path + intent are typed into stdin; the stable
 *  status-file/heartbeat contract is auto-loaded from the installed contract file. */
export function buildDispatch({ intent, statusPath }: DispatchInput): string {
  return [
    `Task: ${intent}`,
    `Your status file for this task is: ${statusPath}`,
    `Follow the Unmute status-file contract (already loaded).`,
  ].join('\n')
}
```

- [ ] **Step 4: Run, verify PASS.** Expected: PASS.

- [ ] **Step 5: Write `contract/contract.md`.** Author the full static contract per PRD §8.1 (status states, heartbeat cadence, atomic writes, ask-channel, recipe-suggestion scratch file, "act don't ask unless truly blocked"). Cite PRD obligations; this is the prompt artifact and may iterate freely (PRD: not frozen, unlike the schema).

- [ ] **Step 6: Implement `installer.ts`** — writes the contract where `claude` auto-loads it (path from Task-0 findings), guarding against clobbering a user CLAUDE.md (marker-delimited append or dedicated skill file).

- [ ] **Step 7: Commit.**

```bash
git add desktop/electron/remote/contract desktop/electron/remote/dispatch-prompt.ts desktop/electron/remote/dispatch-prompt.test.ts
git commit -m "feat(remote): static contract installer + minimal typed dispatch payload"
```

---

## Task 5: `executor.ts` + `pty-session.ts` — owned PTY interactive `claude` (PRD §3.2, §4, §11) — integration

Native + process integration; validated by running a real session (not pure-unit). Uses the readiness marker from Task 0 Step 3.

**Files:**
- Modify: `desktop/package.json` (add `node-pty`), `desktop/engine-overrides/electron-builder.yml` (native packaging/signing like `native-fn-listener`)
- Create: `desktop/electron/remote/executor.ts`, `desktop/electron/remote/pty-session.ts`

- [ ] **Step 1: Add `node-pty` dependency.** Run: `cd desktop && npm install node-pty` — Expected: added to `dependencies`; native build succeeds. Ensure electron-builder rebuilds it for the Electron ABI (mirror `native-fn-listener` config).

- [ ] **Step 2: Define the executor interface (portability seam, PRD §11.3).**

```ts
export interface AgentExecutor {
  spawn(opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void>
  isReady(): Promise<void>                    // resolves when TUI accepts input (PRD §5/#5)
  writeStdin(text: string): void
  onData(cb: (chunk: string) => void): void
  kill(): void                                // PRD §10.4 instant kill
}
```

- [ ] **Step 3: Implement `ClaudeCodeExecutor` in `pty-session.ts`.** Spawn `claude` via `node-pty`. **Hard rules (PRD §3.2):** strip `ANTHROPIC_API_KEY` from `env`; never use `-p`/SDK. `isReady()` waits for the Task-0 readiness marker. `onData` forwards the raw stream (for render-on-demand later + optional silence hint).

- [ ] **Step 4: Manual integration validation.** Write a throwaway harness that spawns one session, waits `isReady()`, writes a `buildDispatch` payload for a trivial task ("create a file named hello.txt in cwd"), and confirms the task runs. Confirm env has no API key (`assert(!('ANTHROPIC_API_KEY' in passedEnv))`). Record result in the probe-findings doc.

- [ ] **Step 5: Commit.**

```bash
git add desktop/package.json desktop/package-lock.json desktop/engine-overrides/electron-builder.yml desktop/electron/remote/executor.ts desktop/electron/remote/pty-session.ts
git commit -m "feat(remote): node-pty executor running interactive claude (subscription auth, no API key)"
```

---

## Task 6: `task-manager.ts` — lifecycle, file scaffolding, completion detection (PRD §4.4, §5, §6, §13.6) — integration

Ties Tasks 3–5 together. Unmute creates+owns the status/scratch file paths (PRD: Unmute scaffolds, Claude fills). Detection = poll `readStatus` + `isStale`.

**Files:**
- Create: `desktop/electron/remote/task-manager.ts`
- Test: `desktop/electron/remote/task-manager.test.ts` (lifecycle transitions with a fake executor)

- [ ] **Step 1: Failing test — lifecycle with an injected fake executor + temp status file.** Assert: a task starts in `processing`; when the (fake) session writes `done` to its status file, the manager transitions to `done` and emits a completion event (PRD §13.6: manager observes). When mtime goes stale while `processing`, manager flags `stuck` (PRD §6.3).

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** `createTask(intent)`: generate id; **scaffold** `~/.unmute/remote/<user>/<taskId>/status.json` (empty `{state:"processing"}`) + scratch file — Unmute owns these paths (PRD decision); install/refresh contract (Task 4) in the session cwd; spawn executor (Task 5); `isReady()`; write `buildDispatch`. Poll the status file every N ms via `readStatus`; on terminal state emit completion; run `isStale` each poll → emit `stuck`. Track tasks in a `Map` (PRD §4.4 concurrency). Expose `kill(taskId)` (PRD §10.4).

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit.**

```bash
git add desktop/electron/remote/task-manager.ts desktop/electron/remote/task-manager.test.ts
git commit -m "feat(remote): task-manager — lifecycle, Unmute-owned status files, staleness detection"
```

---

## Task 7: `intent-cleanup.ts` — STT→intent stage (PRD §13.7) — TDD on the contract, manual on the LLM call

Reuses the existing managed/BYOK LLM path (PRD §2.4.2: same STT, added cleanup stage). Keep it light per PRD §13.7; exact aggressiveness is tune-in-build (PRD §15.4 #2).

**Files:**
- Create: `desktop/electron/remote/intent-cleanup.ts`
- Test: `desktop/electron/remote/intent-cleanup.test.ts`

- [ ] **Step 1: Failing test** asserting the function shape (takes raw transcript + an LLM-complete fn, returns a cleaned string; passthrough on LLM failure so a flaky cleanup never blocks dispatch).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — call the injected LLM-complete with a cleanup prompt; on error/empty, return the raw transcript unchanged (degrade gracefully).
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `feat(remote): intent-cleanup stage on top of existing STT`

---

## Task 8: Key-routing + capture seam (additive, PRD §2.4.4, §2.4.1) — integration, no-regression-critical

Wire the Remote key into the existing override files. **Additive only** — every existing dictation path stays byte-for-byte (PRD §2.4.1).

**Files:**
- Modify: `desktop/engine-overrides/electron/keyListener.ts`
- Modify: `desktop/engine-overrides/electron/sessionManager.ts`

- [ ] **Step 1: keyListener — derive Remote key + acquire/release the `CaptureLock` (Task 2).** On the Remote key down/up, start/stop a Remote capture; on the dictation key, acquire the lock first and *no-op the dictation path if the lock is held by Remote* (and vice versa). Existing dictation emission stays unchanged when the lock is free.
- [ ] **Step 2: sessionManager — additive intercept.** At the top of the capture-dispatch path, if the active capture mode is Remote, route the (STT → intent-cleanup → task-manager.createTask) flow and **return before** the paste path. Mirror the existing managed-cloud intercept structure (see `PATCHES.md`). Dictation path untouched.
- [ ] **Step 3: No-regression manual check.** With Remote never triggered, run a full dictation cycle (record → pill → paste-near-cursor). Confirm identical behavior. Then trigger Remote and confirm mutual exclusion (dictation key ignored mid-Remote-capture and vice versa).
- [ ] **Step 4: Update `wire-into-engine.sh`** to copy `electron/remote/` into the engine + add grep paranoia checks (PATCHES.md convention) + init the task-manager in `main.ts` next to `initPaywall`.
- [ ] **Step 5: Commit.** `feat(remote): additive Remote-key routing + capture intercept (dictation unchanged)`

---

## Task 9: Minimal UI — ambient indicator + task row + notification (PRD §13.2, §13.4, §13.6) — integration

Just enough to *see* the loop. Full panel/cancel/re-run/render-on-demand = follow-on plan.

**Files:**
- Create: `desktop/electron/remote-ipc.ts`, `desktop/electron/remote-preload.ts`
- Create: `desktop/engine-overrides/renderer/remote/AmbientIndicator.tsx`, `desktop/engine-overrides/renderer/remote/TaskRow.tsx`
- Modify: renderer mount point (additive, alongside the existing `<BalancePill/>` mount in the App override)

- [ ] **Step 1: IPC + preload** — expose task list + status events to the renderer (mirror `balance-ipc.ts`/`preload-extensions.ts`). Additive spread into `electronAPI`.
- [ ] **Step 2: AmbientIndicator** — subscribe to task events; show count + state (PRD §13.2). Never covers anything; do not touch dictation pill states.
- [ ] **Step 3: TaskRow** — render cleaned intent (PRD §13.4 #1 — the trust-builder), live status + duration (#2), inline result on done (#3), failure reason on fail (#4). Cancel/re-run/needs-user/render-on-demand deferred to follow-on.
- [ ] **Step 4: Notification** — on terminal state, task-manager fires an OS notification (PRD §13.6: Unmute observes & emits).
- [ ] **Step 5: End-to-end manual run.** Speak a real task → see ambient count → row shows cleaned intent → status progresses → done with inline result + notification. This is the §15.2 "thin end-to-end vertical" working.
- [ ] **Step 6: Commit.** `feat(remote): minimal ambient indicator + task row + completion notification`

---

## Self-Review (run against the PRD — completed during authoring)

- **Spec coverage (core scope §15.2 steps 1–3 + §2.4.4):** trigger/STT/intent/dispatch → Tasks 7,8,9; mode routing + mutual exclusion → Task 2,8; no-regression → Task 8 step 3; PTY interactive `claude` (no `-p`, no API key) → Task 5; status-file + staleness → Tasks 1,3,6; ambient + task row + notification → Task 9; billing/TUI probes → Task 0. **Deferred (explicitly, to follow-on plans, NOT dropped):** interactive needs-user round-trip (§7), recipes/librarian (§8–9), MCP handoff (§12), safety guards (§10.6–10.7), full UI (§13 items 5–8), portability second adapter (§11), §17 extended. These are listed below — none are scope cuts, all are PRD-required and sequenced later per §15.2.
- **Placeholder scan:** pure-unit tasks (2,3,4,7) carry real code + tests; integration tasks (0,5,6,8,9) carry concrete file/interface/validation steps and are honestly marked as run-and-observe rather than fabricating PTY output not yet measured (Task 0 produces those facts first). No "TBD"/"handle edge cases" placeholders.
- **Type consistency:** `TaskState`/`StatusPayload` (Task 3) reused in Task 6; `AgentExecutor` (Task 5) consumed by Task 6; `CaptureLock`/`deriveRemoteKey` (Task 2) consumed by Task 8; `buildDispatch` (Task 4) consumed by Tasks 5,6.

---

## Follow-on plans (PRD-required, sequenced after the core — each gets its own plan)

Per PRD §15: nothing here is optional; later = sequencing only. Build these once the core loop runs and the schema/executor interfaces are frozen — at which point several can run in **parallel** (independent modules on stable contracts):

1. **Interactive input / needs-user round-trip** (PRD §7) — amber row, answer by voice/tap, write to PTY stdin.
2. **Recipes + librarian** (PRD §8–9) — doer writes suggestion to scratch; serialized single-writer librarian; recipes-as-skills.
3. **MCP gap detection + Connections onboarding** (PRD §12, §17.4).
4. **Safety guards** (PRD §10) — permission-mode toggle, path/working-dir sandbox (§10.6), irreversible-action escalation (§10.7), reversible-op bias, kill switch in UI.
5. **Full task UI** (PRD §13.3–13.5) — summonable panel, cancel/re-run, render-on-demand xterm.js, history reuse.
6. **Portability second adapter** (PRD §11) — Codex executor behind `AgentExecutor`.
7. **Long-horizon support** (PRD §17.1) and **realtime conversational voice** (PRD §17.2).
8. **Correctness/verification frontier** (PRD §17.3) — open research direction.
