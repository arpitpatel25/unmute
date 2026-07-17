# Resident Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the warm routing classifier always-ready so follow-up utterances are never lost to a cold-start timeout, and keep that resident session lean over multi-day uptime.

**Architecture:** The router (`electron/remote/router.ts`) is a single tool-less `claude` REPL on the user's subscription that decides per utterance: new task vs. continue an existing one. Today it lazy-spawns on first use, pays a cold-start, times out at 8s, and fail-safes to "new" — discarding context. This plan pins it to a light model (`haiku`), makes it resident from app startup (idempotent `warm()` called at init and on Remote key-down), removes the idle-kill, keeps it fresh with a post-decision `/clear` plus a periodic background recycle, raises the timeout to 12s, and flips the fail-safe so a timeout with exactly one recent task continues that task instead of starting fresh.

**Tech Stack:** TypeScript, Node, `node:test` + `tsx`, Electron main process. Tests use the existing `fakeRouterExecutor` harness in `router.test.ts`. Build via `./build/wire-into-engine.sh compile`. Commit messages must contain NO backticks.

---

## File Structure

- `electron/remote/router.ts` — all router lifecycle + decision logic. Add `failsafeDecision()` pure helper; change `parseDecision` signature to take the task list; add `warm()`, post-decision `/clear`, background recycle, remove idle-kill; raise default timeout. This file owns the whole concern.
- `electron/remote/router.test.ts` — unit tests for `failsafeDecision`, updated `parseDecision`, `/clear`-after-decision, recycle, and resident `warm()`.
- `electron/remote/init.ts` — wiring only: pin `model: 'haiku'`; call `router.warm()` at init and on `remote-start`.

No new files. No change to `dispatchFromCapture` — it already honors whatever `decision.action` the router returns, so the flipped fail-safe flows through unchanged.

---

## Task 1: Pin the router to haiku

**Files:**
- Modify: `electron/remote/init.ts:166-168`

- [ ] **Step 1: Pin the model**

`ClaudeCodeExecutor` already supports `model` (passed as `--model <model>`, see `pty-session.ts:218`). Change `routerExecutorFactory`:

```ts
/** A minimal, tool-less classifier session for the router: no --chrome, no tmux;
 *  --dangerously-skip-permissions so it can write its decision file unprompted.
 *  Pinned to a light, fast model — classification is thin and must answer in ~1-2s,
 *  and we must NOT inherit the CLI default (the user can change it to Opus). */
function routerExecutorFactory() {
  return new ClaudeCodeExecutor({ model: 'haiku', extraArgs: ['--dangerously-skip-permissions'], chrome: false })
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.typecheck.json --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add electron/remote/init.ts
git commit -m "feat(router): pin classifier to haiku instead of CLI default"
```

---

## Task 2: Flip the fail-safe to continue-latest-if-single

**Files:**
- Modify: `electron/remote/router.ts:89-100` (`parseDecision`) and `:149-168` (`routeOnce`)
- Test: `electron/remote/router.test.ts`

- [ ] **Step 1: Write failing tests for `failsafeDecision` and the new `parseDecision` signature**

Add to `router.test.ts` (note: `parseDecision` will now take the task array, not a `Set`):

```ts
import { buildRoutingPrompt, parseDecision, failsafeDecision, Router, type RoutableTask } from './router.ts'

const ONE: RoutableTask[] = [{ id: 't1', intent: 'messi 2019 stats', state: 'done', category: 'info', ageSec: 30, surfaced: true }]
const TWO: RoutableTask[] = [
  { id: 't1', intent: 'messi 2019 stats', state: 'done', category: 'info', ageSec: 30, surfaced: true },
  { id: 't2', intent: 'open downloads', state: 'done', category: 'navigate', ageSec: 60, surfaced: false },
]

test('failsafeDecision: one recent task continues it; multiple or stale or none ⇒ new', () => {
  assert.deepEqual(failsafeDecision(ONE, 'and 2015?'), { action: 'continue', targetTaskId: 't1', intent: 'and 2015?' })
  assert.equal(failsafeDecision(TWO, 'x').action, 'new')               // ambiguous ⇒ new
  assert.equal(failsafeDecision([], 'x').action, 'new')                // nothing to continue
  const stale: RoutableTask[] = [{ ...ONE[0], ageSec: 99999 }]
  assert.equal(failsafeDecision(stale, 'x').action, 'new')             // too old ⇒ new
})

test('parseDecision: explicit decisions honored; failures use failsafe', () => {
  // explicit "new" is honored even with one open task
  assert.equal(parseDecision('{"action":"new","intent":"fresh"}', 'raw', ONE).action, 'new')
  // explicit continue to a known id
  assert.deepEqual(parseDecision('{"action":"continue","targetTaskId":"t1","intent":"reply"}', 'raw', ONE),
    { action: 'continue', targetTaskId: 't1', intent: 'reply' })
  // timeout (null) with one recent task ⇒ continue it (the flip)
  assert.deepEqual(parseDecision(null, 'and 2015?', ONE), { action: 'continue', targetTaskId: 't1', intent: 'and 2015?' })
  // malformed with one recent task ⇒ continue it
  assert.equal(parseDecision('not json', 'x', ONE).action, 'continue')
  // null with multiple tasks ⇒ new (can't guess)
  assert.equal(parseDecision(null, 'x', TWO).action, 'new')
  // unknown id ⇒ failsafe (single ⇒ continue latest)
  assert.equal(parseDecision('{"action":"continue","targetTaskId":"zzz","intent":"x"}', 'x', ONE).targetTaskId, 't1')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test electron/remote/router.test.ts`
Expected: FAIL — `failsafeDecision` is not exported; `parseDecision` still expects a `Set`.

- [ ] **Step 3: Implement `failsafeDecision` and rewrite `parseDecision`**

Replace `router.ts:89-100` with:

```ts
/** The default decision when the router gives us nothing usable (timeout, bad
 *  parse, unknown id). A follow-up is far likelier than a coincidental brand-new
 *  request when exactly ONE recent task is open — so continue it rather than
 *  start blind and lose its context. Anything ambiguous (0 or 2+ tasks, or a
 *  stale lone task) stays NEW. */
export function failsafeDecision(tasks: RoutableTask[], intent: string, maxAgeSec = 180): RouteDecision {
  const clean = (intent || '').trim()
  if (tasks.length === 1 && tasks[0].ageSec <= maxAgeSec) {
    return { action: 'continue', targetTaskId: tasks[0].id, intent: clean }
  }
  return { action: 'new', intent: clean }
}

/** Parse the decision file. EXPLICIT router decisions (new, or continue→known id)
 *  are honored. Everything else — null/malformed/unknown-action/unknown-id —
 *  routes through failsafeDecision (continue-latest-if-single). */
export function parseDecision(raw: string | null, fallbackIntent: string, tasks: RoutableTask[]): RouteDecision {
  const validIds = new Set(tasks.map((t) => t.id))
  if (!raw) return failsafeDecision(tasks, fallbackIntent)
  let obj: { action?: string; targetTaskId?: string; intent?: string }
  try { obj = JSON.parse(raw) } catch { return failsafeDecision(tasks, fallbackIntent) }
  const intent = (obj.intent && obj.intent.trim()) || fallbackIntent
  if (obj.action === 'continue' && obj.targetTaskId && validIds.has(obj.targetTaskId)) {
    return { action: 'continue', targetTaskId: obj.targetTaskId, intent }
  }
  if (obj.action === 'new') return { action: 'new', intent }
  return failsafeDecision(tasks, intent)
}
```

- [ ] **Step 4: Update `routeOnce` to pass tasks and failsafe on exception**

In `router.ts` `routeOnce` (~149-168): the `validIds` local is no longer needed; pass `tasks` to `parseDecision`, and use `failsafeDecision` in the catch.

```ts
  private async routeOnce(utterance: string, tasks: RoutableTask[]): Promise<RouteDecision> {
    const fallback = (utterance || '').trim()
    try {
      await this.ensureSession()
      await fs.mkdir(this.dir, { recursive: true })
      await fs.rm(this.decisionPath, { force: true }).catch(() => {})
      const prompt = buildRoutingPrompt(utterance, tasks, this.decisionPath)
      this.ex!.writeStdin(prompt)
      const raw = await this.waitForDecision()
      const decision = parseDecision(raw, fallback, tasks)
      log.event('route-decision', { action: decision.action, targetTaskId: decision.targetTaskId ?? null, tasks: tasks.length })
      return decision
    } catch (e) {
      log.warn('route failed — using failsafe', { error: (e as Error).message })
      return failsafeDecision(tasks, fallback)
    }
  }
```

(`touchIdle()` calls are removed here — Task 4 replaces the idle mechanism. Leave `touchIdle`/`idleTimer` defined for now so this step compiles; Task 4 deletes them.)

- [ ] **Step 5: Fix the pre-existing `parseDecision` test that used a `Set`**

The old test at `router.test.ts:19-27` passes `new Set(['t1'])`. Update its call sites to pass `ONE` (or a task array) instead, or delete it (superseded by the Step-1 test). Delete the old `test('parseDecision: continue only with a known id; else new (fail-safe)', ...)` block — the new test covers it.

- [ ] **Step 6: Run tests**

Run: `npx tsx --test electron/remote/router.test.ts`
Expected: PASS (new `failsafeDecision` + `parseDecision` tests green; existing route tests still green — `route()` passes `tasks` through).

- [ ] **Step 7: Commit**

```bash
git add electron/remote/router.ts electron/remote/router.test.ts
git commit -m "feat(router): flip fail-safe to continue the single recent task on timeout"
```

---

## Task 3: Add resident `warm()` + wire it at init and on key-down

**Files:**
- Modify: `electron/remote/router.ts` (add `warm()`)
- Modify: `electron/remote/init.ts:461` (warm at init) and `:468-471` (warm on remote-start)
- Test: `electron/remote/router.test.ts`

- [ ] **Step 1: Write a failing test that `warm()` spawns before any route**

```ts
test('Router.warm() spawns the session before the first route', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  let spawns = 0
  const factory = () => {
    let alive = true
    const ex: AgentExecutor = {
      get alive() { return alive },
      async spawn() { spawns++ }, async isReady() {},
      writeStdin(t: string) {
        if (t.includes('[Unmute router]')) void fs.mkdir(path.dirname(decisionPath), { recursive: true })
          .then(() => fs.writeFile(decisionPath, JSON.stringify({ action: 'new', intent: 'x' })))
      },
      write() {}, resize() {}, onData() {}, kill() { alive = false },
    }
    return ex
  }
  const router = new Router({ executorFactory: factory, baseDir, readyGraceMs: 0, decisionTimeoutMs: 1000, pollMs: 20 })
  await router.warm()
  assert.equal(spawns, 1)             // already up before any utterance
  await router.route('x', ONE)
  assert.equal(spawns, 1)             // route reused the warm session, no respawn
  router.dispose()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test electron/remote/router.test.ts`
Expected: FAIL — `router.warm is not a function`.

- [ ] **Step 3: Add the public `warm()` method**

In `router.ts`, add (right after `route()`):

```ts
  /** Bring the session up (or respawn it if it died) BEFORE it is needed, so a
   *  real utterance never pays cold-start. Idempotent and single-flighted: safe
   *  to call at app init and again on every Remote key-down. */
  warm(): Promise<void> {
    const run = this.chain.then(() => this.ensureSession())
    this.chain = run.catch(() => undefined)
    return run
  }
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test electron/remote/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Warm at init**

In `init.ts:461`, after constructing the router:

```ts
  router = new Router({ executorFactory: routerExecutorFactory })
  // Resident from startup — bring the classifier up now so the first follow-up
  // utterance hits a warm session, never a cold spawn. Fire-and-forget.
  void router.warm()
```

- [ ] **Step 6: Re-warm on Remote key-down**

In `init.ts` the `remote-start` branch (~468-471), add a warm call so a session that died between utterances is back up before the user finishes speaking:

```ts
    if (e.type === 'remote-start') {
      log.event('remote-key', { phase: 'start' })
      void router?.warm() // ensure the classifier is ready before the utterance lands
      pauseOverlayEscape() // capture owns Escape (cancel) while recording
      deps.sessionManager.startRemoteCapture()
    } else if (e.type === 'remote-stop') {
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p tsconfig.typecheck.json --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add electron/remote/router.ts electron/remote/init.ts
git commit -m "feat(router): resident warm() called at init and on Remote key-down"
```

---

## Task 4: Remove idle-kill; add post-decision /clear + background recycle

**Files:**
- Modify: `electron/remote/router.ts` (RouterOpts, constructor, `route()`, remove `touchIdle`/`idleTimer`, add `housekeep()`/`recycle()`/`spawnSession()`)
- Test: `electron/remote/router.test.ts`

- [ ] **Step 1: Write failing tests for /clear-after-decision and recycle**

```ts
test('Router sends /clear after each decision (keeps the resident session lean)', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const writes: string[] = []
  const factory = () => {
    let alive = true
    const ex: AgentExecutor = {
      get alive() { return alive },
      async spawn() {}, async isReady() {},
      writeStdin(t: string) {
        writes.push(t)
        if (t.includes('[Unmute router]')) void fs.mkdir(path.dirname(decisionPath), { recursive: true })
          .then(() => fs.writeFile(decisionPath, JSON.stringify({ action: 'new', intent: 'x' })))
      },
      write() {}, resize() {}, onData() {}, kill() { alive = false },
    }
    return ex
  }
  const router = new Router({ executorFactory: factory, baseDir, readyGraceMs: 0, decisionTimeoutMs: 1000, pollMs: 20 })
  await router.route('x', ONE)
  await router.settleHousekeeping() // test hook: awaits the chain's trailing housekeep
  assert.ok(writes.includes('/clear'))
  router.dispose()
})

test('Router recycles the session after recycleEvery decisions', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  let spawns = 0, kills = 0
  const factory = () => {
    let alive = true
    const ex: AgentExecutor = {
      get alive() { return alive },
      async spawn() { spawns++ }, async isReady() {},
      writeStdin(t: string) {
        if (t.includes('[Unmute router]')) void fs.mkdir(path.dirname(decisionPath), { recursive: true })
          .then(() => fs.writeFile(decisionPath, JSON.stringify({ action: 'new', intent: 'x' })))
      },
      write() {}, resize() {}, onData() {}, kill() { alive = false; kills++ },
    }
    return ex
  }
  const router = new Router({ executorFactory: factory, baseDir, readyGraceMs: 0, decisionTimeoutMs: 1000, pollMs: 20, recycleEvery: 2 })
  await router.warm()                 // spawns === 1
  await router.route('a', ONE); await router.settleHousekeeping()
  await router.route('b', ONE); await router.settleHousekeeping() // 2nd decision ⇒ recycle
  assert.equal(spawns, 2)             // one fresh session spun up
  assert.equal(kills, 1)              // old one killed
  router.dispose()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test electron/remote/router.test.ts`
Expected: FAIL — `settleHousekeeping`/`recycleEvery` don't exist; no `/clear` sent.

- [ ] **Step 3: Extend RouterOpts + constructor; add counters**

In `RouterOpts` add:

```ts
  /** Recycle (full respawn) the resident session after this many decisions. */
  recycleEvery?: number
  /** Recycle the resident session once it is older than this (ms). */
  maxSessionMs?: number
```

In the constructor `this.o = { ... }` add defaults and drop `idleMs`:

```ts
      decisionTimeoutMs: opts.decisionTimeoutMs ?? 12000,
      recycleEvery: opts.recycleEvery ?? 50,
      maxSessionMs: opts.maxSessionMs ?? 2 * 60 * 60_000,
```

Remove `idleMs` from `RouterOpts` and from the constructor defaults. Add instance fields near the other privates:

```ts
  private decisionCount = 0
  private spawnedAt = 0
```

- [ ] **Step 4: Stamp `spawnedAt` in `ensureSession`**

At the end of `ensureSession()` (after `await this.sleep(this.o.readyGraceMs)`), add:

```ts
    this.spawnedAt = this.clock()
    this.decisionCount = 0
```

- [ ] **Step 5: Replace idle-kill with chained housekeeping in `route()`**

Change `route()` so the returned promise is the decision, and a trailing `housekeep()` runs on the chain (idle gap, serialized before the next route):

```ts
  route(utterance: string, tasks: RoutableTask[]): Promise<RouteDecision> {
    const run = this.chain.then(() => this.routeOnce(utterance, tasks))
    // After the decision resolves to the caller, keep the chain alive with
    // housekeeping (/clear + maybe-recycle) — off the hot path, but serialized
    // so it can never overlap the next route.
    this.chain = run.then(() => this.housekeep(), () => this.housekeep())
    return run
  }
```

- [ ] **Step 6: Add `housekeep`, `recycle`, `spawnSession`, `settleHousekeeping`; delete `touchIdle`/`idleTimer`**

Delete the `touchIdle()` method and the `idleTimer` field. Add:

```ts
  /** Runs in the idle gap AFTER a decision (chained, never on the hot path):
   *  wipe the conversation context so the resident session stays lean, and
   *  periodically recycle the whole process to cap long-run drift. */
  private async housekeep(): Promise<void> {
    this.decisionCount++
    if (this.ex?.alive) {
      try { this.ex.writeStdin('/clear') } catch { /* best-effort */ }
    }
    const aged = this.spawnedAt > 0 && this.clock() - this.spawnedAt > this.o.maxSessionMs
    if (this.decisionCount >= this.o.recycleEvery || aged) {
      await this.recycle().catch(() => {})
    }
  }

  /** Proactive full respawn: bring a fresh session up, then kill the old one and
   *  swap. Done in idle time so a real decision never pays cold-start. */
  private async recycle(): Promise<void> {
    log.event('router-recycle', { decisions: this.decisionCount })
    const fresh = await this.spawnSession()
    const old = this.ex
    this.ex = fresh
    this.spawnedAt = this.clock()
    this.decisionCount = 0
    if (old?.alive) { try { old.kill() } catch { /* best-effort */ } }
  }

  /** Spawn + ready a new executor (shared by ensureSession and recycle). */
  private async spawnSession(): Promise<AgentExecutor> {
    const ex = this.o.executorFactory()
    await ex.spawn({ cwd: this.dir, env: process.env, taskId: 'router' })
    await fs.mkdir(this.dir, { recursive: true }).catch(() => {})
    await ex.isReady()
    ex.writeStdin('') // accept any folder-trust prompt
    await this.sleep(this.o.readyGraceMs)
    return ex
  }

  /** Test hook: await any trailing housekeeping queued on the chain. */
  settleHousekeeping(): Promise<void> { return this.chain.then(() => undefined, () => undefined) }
```

Then simplify `ensureSession()` to use `spawnSession()`:

```ts
  private async ensureSession(): Promise<void> {
    if (this.ex?.alive) return
    log.event('router-spawn', {})
    this.ex = await this.spawnSession()
    this.spawnedAt = this.clock()
    this.decisionCount = 0
  }
```

- [ ] **Step 7: Update `dispose()` to drop the idle timer reference**

```ts
  /** Kill the resident session (app shutdown). */
  dispose(): void {
    if (this.ex?.alive) { try { this.ex.kill() } catch { /* best-effort */ } }
    this.ex = null
  }
```

- [ ] **Step 8: Run tests**

Run: `npx tsx --test electron/remote/router.test.ts`
Expected: PASS (all: failsafe, parseDecision, route, warm, /clear, recycle).

- [ ] **Step 9: Full suite + typecheck**

Run: `npx tsc -p tsconfig.typecheck.json --noEmit && npx tsx --test electron/remote/*.test.ts`
Expected: typecheck clean; all tests pass.

- [ ] **Step 10: Commit**

```bash
git add electron/remote/router.ts electron/remote/router.test.ts
git commit -m "feat(router): resident session with post-decision clear and periodic recycle"
```

---

## Task 5: Compile, relaunch, verify on-device

**Files:** none (build + manual verify)

- [ ] **Step 1: Compile into the engine**

Run: `./build/wire-into-engine.sh compile`
Expected: builds clean; `grep -c warm work/oss-engine/electron/paywall/remote/router.ts` ≥ 1.

- [ ] **Step 2: Relaunch the dev app**

```bash
pkill -f 'oss-engine.*electron' 2>/dev/null; sleep 1
./run-dev.sh > /tmp/unmute-dev.log 2>&1 &
```

- [ ] **Step 3: Confirm the router warms at startup (not on first utterance)**

Run: `grep -nE 'router-spawn|repl-ready.*router|pty-spawn.*router' /tmp/unmute-dev.log`
Expected: a `router-spawn` / router `pty-spawn` appears shortly after init, BEFORE any Remote capture — and the spawn args include `--model haiku`.

- [ ] **Step 4: Manual two-task test**

Speak task 1 ("Messi 2019 stats"); wait for DONE. Within the warm window speak the follow-up ("and what about 2015?").
Expected in logs: `route-decision {"action":"continue","targetTaskId":"<task1 id>"}` (NOT `timed out` / `action:new`), and the follow-up lands on task 1's session with context. Also confirm a `/clear` write and, after enough turns, a `router-recycle` event.

- [ ] **Step 5: Final commit if any tweak was needed**

```bash
git add -A && git commit -m "fix(router): on-device verification tweaks for resident router"
```

---

## Self-Review

**Spec coverage:**
1. Pin model (haiku) → Task 1. ✓
2. Always-resident (warm at init) → Task 3 Step 5. ✓
3. No idle-kill → Task 4 (touchIdle/idleTimer deleted). ✓
4. Auto-respawn on death → `warm()`/`ensureSession` are idempotent-respawn (alive-check then spawn), called at init + every key-down → Task 3. ✓
5. /clear after each decision → Task 4 `housekeep()`. ✓
6. Background recycle (count/age) → Task 4 `recycle()` gated by `recycleEvery`/`maxSessionMs`. ✓
7. Flip fail-safe → Task 2 `failsafeDecision` + `parseDecision`. ✓
8. Timeout → 12s → Task 4 Step 3 (`decisionTimeoutMs ?? 12000`). ✓

**Placeholder scan:** none — every code step shows full code; commands have expected output.

**Type consistency:** `parseDecision(raw, fallbackIntent, tasks: RoutableTask[])` used consistently in `routeOnce` (Task 2) and tests. `failsafeDecision(tasks, intent, maxAgeSec?)` consistent across Task 2 + tests. `warm()`, `housekeep()`, `recycle()`, `spawnSession()`, `settleHousekeeping()` defined in Task 3/4 and referenced only after definition. `route()` returns `Promise<RouteDecision>` unchanged for callers. `dispatchFromCapture` untouched (honors `decision.action`).

**Note on billing constraint:** the resident session is still the interactive `claude` REPL on the user's subscription with `ANTHROPIC_API_KEY`/`AUTH_TOKEN`/`CLAUDE_API_KEY` stripped by `ClaudeCodeExecutor` — unchanged. Resident ≠ API; an idle REPL consumes no tokens.
