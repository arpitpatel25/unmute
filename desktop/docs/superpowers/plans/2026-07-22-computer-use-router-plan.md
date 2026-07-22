# Computer-Use Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn unmute's verbatim cua pass-through bridge into a multi-lane **router** so Claude Code can drive web/Electron apps via CDP (hidden, reliable) and scriptable native apps via Apple Events (invisible), while keeping the existing cua AX/pixel lanes as the universal fallback — all shipped in the normal build.

**Architecture:** Add new lane tools to the MCP surface and intercept them in `cua/server.ts`; everything not ours still forwards verbatim to the embedded `cua-driver`. The lanes are thin, powerful primitives the *agent* selects (guided by a CLAUDE.md steering block): CDP (`web_arm`/`web_eval`/`web_type`/`web_screenshot`), Apple Events (`run_applescript`), and — unchanged — cua's `get_window_state`/`click`/`type_text`/`scroll` for native/universal. No rewrite of the pass-through; it becomes "route ours, forward the rest."

**Tech stack:** TypeScript (Electron main process), `node:test`, Chrome DevTools Protocol over the `ws` package, macOS `osascript` (Apple Events), the existing `DriverManager`/`DriverClient` embedded cua-driver.

## Global Constraints

- Platform: macOS only (matches the existing cua path).
- The MCP name stays `unmute-computer` on `127.0.0.1:42118/ax`; **do not** rename or break existing registration (`ax/register.ts`).
- Pass-through is sacred: any tool the router does not own MUST forward to `cua-driver` byte-for-byte as today.
- Every router tool is gated by `policy.enabled` (master kill switch) and the `policy.allowAll`/`policy.allowed[]` app allowlist — same authority as the existing bridge.
- CDP debug port is **loopback only** (`127.0.0.1`); one fixed, collision-safe port per app. Armed apps keep their loopback port for the app's lifetime (documented, accepted local exposure — see design §12); `disposeAll()` clears tracking without quitting the user's apps.
- No new global cursor movement, no focus steal in the CDP/Apple-Events lanes (they don't use the screen at all).
- Test framework is `node:test` + `node:assert/strict`; tests run via `npm test` (`electron/remote/**/*.test.ts`). Backend integration that needs a live browser is a documented manual smoke, not a CI test.
- TypeScript must pass `npm run typecheck`.

---

## File Structure

- `electron/remote/cua/lanes/cdp.ts` — CDP client: connect to an armed app's debug port, pick the active page target, `eval`/`typeKeys`/`screenshot`. Transport (target-list fetch + WebSocket factory) injectable for tests.
- `electron/remote/cua/lanes/arming.ts` — launch/relaunch an app with `--remote-debugging-port`, wait for the endpoint, track app→port. Launcher + fetch injectable for tests.
- `electron/remote/cua/lanes/applescript.ts` — `runAppleScript(script)` via `osascript`. Exec injectable for tests.
- `electron/remote/cua/router.ts` — router tool definitions (schemas + descriptions), `isRouterTool(name)`, `handleRouterTool(name, args, ctx)`; owns policy allowlist checks for lane calls.
- `electron/remote/cua/server.ts` — MODIFY: merge `routerTools()` into `tools/list`; intercept `isRouterTool` in `tools/call`, else forward.
- `electron/remote/ax/register.ts` — MODIFY: extend the CLAUDE.md steering block to teach the lanes.
- `electron/remote/init.ts` — MODIFY: build the router context and pass it into `startCuaServer`.
- Tests: `cua/lanes/cdp.test.ts`, `cua/lanes/arming.test.ts`, `cua/lanes/applescript.test.ts`, `cua/router.test.ts`, and additions to `cua/cua-server.test.ts` and `ax/register.test.ts`.
- `package.json` — MODIFY: add `ws` dependency.

**Reference:** the proven POC is committed at `desktop/docs/superpowers/specs/2026-07-22-computer-use-router-poc/` (`cdp.mjs`, `cdp-launch.sh`, `MECHANISM.md`) — the CDP lane and arming productize it. Read `MECHANISM.md` first; it documents the gotchas (Notion discards `Input.insertText` → per-char keys; `Page.captureScreenshot` for true state; target matched by webContents **id** so it follows in-tab navigation).

---

### Task 1: `ws` dependency

**Files:** Modify: `desktop/package.json`

- [ ] **Step 1:** Add `"ws": "^8.18.0"` to `dependencies` and `"@types/ws": "^8.5.12"` to `devDependencies` in `desktop/package.json`.
- [ ] **Step 2:** Run `npm install` in `desktop/`. Expected: `ws` + types resolve, lockfile updates.
- [ ] **Step 3:** Verify import compiles: `node -e "require('ws')"` → no error.
- [ ] **Step 4:** Commit: `git add package.json package-lock.json && git commit -m "chore(computer-use): add ws for the CDP lane"`

---

### Task 2: CDP lane client (`cua/lanes/cdp.ts`)

**Files:**
- Create: `electron/remote/cua/lanes/cdp.ts`
- Test: `electron/remote/cua/lanes/cdp.test.ts`

**Interfaces:**
- Produces:
  - `type CdpTransport = { listTargets(port: number): Promise<CdpTarget[]>; connect(wsUrl: string): Promise<CdpSocket> }`
  - `type CdpTarget = { id: string; type: string; title: string; url: string; webSocketDebuggerUrl: string }`
  - `type CdpSocket = { send(method: string, params?: object): Promise<any>; close(): void }`
  - `class CdpLane { constructor(portFor: (app: string) => number | undefined, transport?: CdpTransport) ; eval(app: string, js: string): Promise<unknown>; typeKeys(app: string, text: string): Promise<void>; screenshot(app: string): Promise<Buffer>; scrollBottom(app: string): Promise<{before:number;after:number;atBottom:boolean}>; clickText(app: string, text: string): Promise<{clicked:string}> }`
  - The default transport uses the `ws` package and `fetch(http://127.0.0.1:${port}/json)`.
  - Target selection: pick the `type==='page'` target whose id was last used for this app, else the first non-"Tab Bar" titled page; **cache the chosen target id per app** so it follows in-tab navigation (see MECHANISM.md).
- Consumes: `portFor(app)` from the arming lane (Task 3) — returns the armed port or undefined.

- [ ] **Step 1: Write failing tests** (`cua/lanes/cdp.test.ts`) using a fake transport:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CdpLane, type CdpTransport, type CdpTarget } from './cdp'

function fakeTransport(targets: CdpTarget[], onSend: (m: string, p: any) => any): CdpTransport {
  return {
    async listTargets() { return targets },
    async connect() { return { async send(method, params) { return onSend(method, params) }, close() {} } },
  }
}
const target = (over: Partial<CdpTarget> = {}): CdpTarget =>
  ({ id: 'A1', type: 'page', title: 'Calorify AI', url: 'x', webSocketDebuggerUrl: 'ws://x', ...over })

test('eval returns the JS value via Runtime.evaluate', async () => {
  const seen: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => {
    seen.push([m, p]); return { result: { result: { value: 42 } } }
  }))
  const v = await lane.eval('Notion', '1+41')
  assert.equal(v, 42)
  assert.equal(seen[0][0], 'Runtime.evaluate')
  assert.equal(seen[0][1].expression, '1+41')
})

test('eval throws when the app is not armed', async () => {
  const lane = new CdpLane(() => undefined, fakeTransport([target()], () => ({})))
  await assert.rejects(() => lane.eval('Notion', '1'), /not armed/)
})

test('typeKeys dispatches one keyDown+keyUp per character', async () => {
  const calls: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => { calls.push([m, p]); return {} }))
  await lane.typeKeys('Notion', 'ab')
  const keyEvents = calls.filter(c => c[0] === 'Input.dispatchKeyEvent')
  assert.equal(keyEvents.length, 4) // a↓ a↑ b↓ b↑
  assert.equal(keyEvents[0][1].type, 'keyDown'); assert.equal(keyEvents[0][1].text, 'a')
})

test('scrollBottom sets scrollTop to scrollHeight and reports atBottom', async () => {
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) =>
    ({ result: { result: { value: { before: 0, after: 1577, atBottom: true } } } })))
  const r = await lane.scrollBottom('Notion')
  assert.equal(r.atBottom, true)
})

test('target selection follows the same webContents id across calls', async () => {
  const targets = [target({ id: 'A1', title: 'Calorify AI' }), target({ id: 'B2', title: 'Tab Bar' })]
  const seenUrls: string[] = []
  const tr: CdpTransport = {
    async listTargets() { return targets },
    async connect(url) { seenUrls.push(url); return { async send() { return { result: { result: { value: 1 } } } }, close() {} } },
  }
  const lane = new CdpLane(() => 9222, tr)
  await lane.eval('Notion', '1'); await lane.eval('Notion', '2')
  // Both calls target the SAME (non-"Tab Bar") page.
  assert.equal(seenUrls.length, 2)
})
```

- [ ] **Step 2:** Run `npm test -- cua/lanes/cdp.test.ts` (or `node --test electron/remote/cua/lanes/cdp.test.ts` after tsc) → FAIL (module missing).
- [ ] **Step 3: Implement `cua/lanes/cdp.ts`.** Port `cdp.mjs` logic to a class with an injectable transport. Default transport: `listTargets` = `fetch('http://127.0.0.1:'+port+'/json').then(r=>r.json())`; `connect` = wrap a `ws` `WebSocket` with an id→resolver map (JSON-RPC over the socket). `eval` = `Runtime.evaluate {expression, returnByValue:true, awaitPromise:true}`, throw on `exceptionDetails`. `typeKeys` = focus last `[contenteditable=true]` via a `Runtime.evaluate`, then per-char `Input.dispatchKeyEvent` keyDown(text)+keyUp. `screenshot` = `Page.enable` then `Page.captureScreenshot {format:'png'}` → `Buffer.from(data,'base64')`. `scrollBottom` = `Runtime.evaluate` of the scroller-find-and-set-scrollTop snippet from `cdp.mjs` (returns `{before,after,scrollHeight,clientHeight,atBottom}`). `clickText` = `Runtime.evaluate` of the click-best-text-match snippet. Cache chosen target id per app in a `Map<string,string>`; re-resolve if the id is gone.
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(computer-use): CDP lane client (eval/typeKeys/screenshot/scroll)"`

---

### Task 3: Arming lane (`cua/lanes/arming.ts`)

**Files:**
- Create: `electron/remote/cua/lanes/arming.ts`
- Test: `electron/remote/cua/lanes/arming.test.ts`

**Interfaces:**
- Produces:
  - `class Arming { constructor(deps?: { launch?: (app: string, port: number) => void; quit?: (app: string) => Promise<void>; probe?: (port: number) => Promise<boolean>; portBase?: number }) ; arm(app: string): Promise<{ app: string; port: number; alreadyArmed: boolean }>; portFor(app: string): number | undefined; disposeAll(): Promise<void> }`
  - `arm(app)`: if already armed and `probe(port)` true → return `alreadyArmed:true`. Else assign a fixed port (portBase + stableHash(app) % 1000), `quit(app)` then `launch(app, port)`, poll `probe(port)` up to ~20×500ms; on success record app→port and return; on timeout throw `"could not arm <app>: debug port never opened"`.
  - Default `launch` = `spawn('open', ['-g','-na', app, '--args', '--remote-debugging-port='+port])`; default `quit` = `osascript -e 'tell application "<app>" to quit'` then wait; default `probe` = `fetch('http://127.0.0.1:'+port+'/json/version').then(()=>true).catch(()=>false)`.
- Consumes: nothing.

- [ ] **Step 1: Write failing tests** with injected deps (no real apps):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Arming } from './arming'

test('arm launches with a port and returns it once the endpoint answers', async () => {
  let launched: any = null; let up = false
  const a = new Arming({
    launch: (app, port) => { launched = { app, port }; up = true },
    quit: async () => {}, probe: async () => up, portBase: 9222,
  })
  const r = await a.arm('Notion')
  assert.equal(r.app, 'Notion'); assert.ok(r.port >= 9222); assert.equal(r.alreadyArmed, false)
  assert.equal(launched.app, 'Notion'); assert.equal(a.portFor('Notion'), r.port)
})

test('arm is idempotent when the port is already answering', async () => {
  let launches = 0
  const a = new Arming({ launch: () => { launches++ }, quit: async () => {}, probe: async () => true })
  await a.arm('Notion'); const second = await a.arm('Notion')
  assert.equal(second.alreadyArmed, true); assert.equal(launches, 1)
})

test('arm throws if the endpoint never comes up', async () => {
  const a = new Arming({ launch: () => {}, quit: async () => {}, probe: async () => false })
  await assert.rejects(() => a.arm('Notion'), /could not arm/)
}) // implementation must cap retries fast in tests (inject a small retry budget via portBase-independent constant or a test hook)
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement `arming.ts`.** Deterministic port from a stable string hash. Retry loop with a small fixed budget (expose retry count/interval as constructor-overridable so the throw test runs fast — e.g. `retries?: number; intervalMs?: number`, default 20 / 500). `disposeAll` clears the armed map (does NOT quit the user's apps — leaving them running is fine; we only stop tracking).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(computer-use): app arming (relaunch with debug port)"`

---

### Task 4: Apple Events lane (`cua/lanes/applescript.ts`)

**Files:**
- Create: `electron/remote/cua/lanes/applescript.ts`
- Test: `electron/remote/cua/lanes/applescript.test.ts`

**Interfaces:**
- Produces: `function runAppleScript(script: string, exec?: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>): Promise<string>` — runs `osascript -e <script>` (single `-e`, script passed as one arg), returns trimmed stdout; throws `"applescript error: <stderr>"` on non-zero exit.
- Consumes: nothing.

- [ ] **Step 1: Write tests** — one with injected exec (unit), one real integration (safe, no side effects):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAppleScript } from './applescript'

test('returns trimmed stdout (injected exec)', async () => {
  const out = await runAppleScript('return 1+1', async (args) => {
    assert.deepEqual(args, ['-e', 'return 1+1']); return { stdout: '2\n', stderr: '', code: 0 }
  })
  assert.equal(out, '2')
})

test('throws on osascript error', async () => {
  await assert.rejects(() => runAppleScript('bad', async () => ({ stdout: '', stderr: 'boom', code: 1 })), /applescript error: boom/)
})

test('real osascript arithmetic (integration)', async () => {
  const out = await runAppleScript('return 6 * 7')
  assert.equal(out, '42')
})
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** using `child_process.execFile('osascript', ['-e', script])` wrapped in a promise; default exec adapter maps to `{stdout,stderr,code}`.
- [ ] **Step 4:** Run → PASS (all three, including the real integration).
- [ ] **Step 5:** Commit: `git commit -m "feat(computer-use): Apple Events lane (run_applescript)"`

---

### Task 5: Router (`cua/router.ts`)

**Files:**
- Create: `electron/remote/cua/router.ts`
- Test: `electron/remote/cua/router.test.ts`

**Interfaces:**
- Consumes: `CdpLane` (Task 2), `Arming` (Task 3), `runAppleScript` (Task 4), `AxPolicy` (`../ax/policy`).
- Produces:
  - `interface RouterCtx { cdp: CdpLane; arming: Arming; runAppleScript: typeof runAppleScript; getPolicy(): AxPolicy }`
  - `function routerTools(): McpTool[]` — the tool definitions (name/description/inputSchema) for: `web_arm`, `web_eval`, `web_type`, `web_screenshot`, `run_applescript`. Descriptions state when to use each (Electron/browser via web_*, scriptable native via run_applescript, everything else via the cua tools).
  - `function isRouterTool(name: string): boolean`
  - `async function handleRouterTool(name: string, args: any, ctx: RouterCtx): Promise<{ content: {type:'text';text:string}[]; isError?: boolean }>` — dispatches; wraps results as MCP tool results (text; screenshot returns a note + writes to a temp file path returned in text, mirroring cua's `screenshot_out_file` convention). Applies the allowlist: if `!policy.allowAll` and `args.app` not in `policy.allowed`, return an error tool result.
- `web_arm({app})` → `ctx.arming.arm(app)` → text with port + page titles (from `ctx.cdp` target list). `web_eval({app, js})` → `ctx.cdp.eval` → JSON text. `web_type({app, text})` → `ctx.cdp.typeKeys`. `web_screenshot({app, out_file?})` → `ctx.cdp.screenshot` → write PNG, return path. `run_applescript({script})` → `ctx.runAppleScript`.

- [ ] **Step 1: Write tests** with fake lanes:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routerTools, isRouterTool, handleRouterTool, type RouterCtx } from './router'
import type { AxPolicy } from '../ax/policy'

const ON: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: true, allowed: [] }
function ctx(over: Partial<RouterCtx> = {}): RouterCtx {
  return {
    cdp: { eval: async () => 42, typeKeys: async () => {}, screenshot: async () => Buffer.from('x'), scrollBottom: async () => ({}), clickText: async () => ({}) } as any,
    arming: { arm: async (app: string) => ({ app, port: 9222, alreadyArmed: false }), portFor: () => 9222, disposeAll: async () => {} } as any,
    runAppleScript: async () => 'ok',
    getPolicy: () => ON, ...over,
  }
}

test('routerTools exposes the five lane tools', () => {
  const names = routerTools().map(t => t.name)
  for (const n of ['web_arm','web_eval','web_type','web_screenshot','run_applescript']) assert.ok(names.includes(n), n)
})
test('isRouterTool matches our tools, not cua tools', () => {
  assert.ok(isRouterTool('web_eval')); assert.ok(!isRouterTool('get_window_state'))
})
test('web_eval dispatches to the CDP lane', async () => {
  const r = await handleRouterTool('web_eval', { app: 'Notion', js: '1' }, ctx())
  assert.match(r.content[0].text, /42/); assert.notEqual(r.isError, true)
})
test('run_applescript dispatches to the Apple Events lane', async () => {
  const r = await handleRouterTool('run_applescript', { script: 'x' }, ctx())
  assert.match(r.content[0].text, /ok/)
})
test('allowlist blocks a non-allowed app when allowAll is false', async () => {
  const r = await handleRouterTool('web_eval', { app: 'Secret', js: '1' },
    ctx({ getPolicy: () => ({ ...ON, allowAll: false, allowed: ['Notion'] }) }))
  assert.equal(r.isError, true); assert.match(r.content[0].text, /not allowed/i)
})
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(computer-use): lane router (web_* + run_applescript tools)"`

---

### Task 6: Wire the router into the bridge (`cua/server.ts`)

**Files:**
- Modify: `electron/remote/cua/server.ts` (extend `CuaServerDeps` with `router?: RouterCtx`; in `tools/list` merge `routerTools()`; in `tools/call` intercept `isRouterTool`)
- Modify test: `electron/remote/cua/cua-server.test.ts`

**Interfaces:**
- Consumes: `routerTools`, `isRouterTool`, `handleRouterTool`, `RouterCtx` (Task 5).
- `CuaServerDeps` gains `router?: RouterCtx` (optional → when absent, behaves exactly as today, so existing tests pass unchanged).

- [ ] **Step 1: Add tests to `cua-server.test.ts`** (fake router ctx): `tools/list` includes both a cua tool AND `web_eval`; a `tools/call` for `web_eval` is served by the router (never touches the fake driver — assert via a router spy); a `tools/call` for a cua tool still forwards to the driver; the kill switch (`policy.enabled=false`) also blocks router tools.
- [ ] **Step 2:** Run `npm test -- cua/cua-server.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement.** In `tools/list`: `const base = await ...request('tools/list', ...)` then `if (deps.router) base.tools = [...(base.tools ?? []), ...routerTools()]`. In `tools/call`: after the `getPolicy().enabled` gate, `if (deps.router && isRouterTool(toolName)) { const out = await handleRouterTool(toolName, msg.params?.arguments ?? {}, deps.router); deps.onActivity?.({ app, tool: toolName, ok: out.isError !== true }); respond(rpcResult(msg.id, out)); return }` — placed BEFORE the session-strip + driver forward.
- [ ] **Step 4:** Run full `npm test` → all PASS (old pass-through tests unchanged, new router tests green).
- [ ] **Step 5:** Commit: `git commit -m "feat(computer-use): route lane tools in the bridge, forward the rest"`

---

### Task 7: CLAUDE.md steering block (`ax/register.ts`)

**Files:**
- Modify: `electron/remote/ax/register.ts` (the steering text appended to `~/.claude/CLAUDE.md`)
- Modify test: `electron/remote/ax/register.test.ts`

- [ ] **Step 1: Add a test** to `register.test.ts` asserting the steering block now contains lane guidance — the strings `web_arm`, `run_applescript`, and a "browser or Electron app" cue.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Extend the existing steering block with a concise lane guide: "For a browser or Electron app (Notion, Slack, VS Code, Chrome, any website): `web_arm` the app once, then drive it with `web_eval` (scroll = set the scroller's scrollTop; click = el.click(); read the DOM), `web_type` (types via real key events — use it, not web_eval, to enter text into editors), and `web_screenshot`. For scriptable native apps (Notes, Mail, Calendar): `run_applescript`. For everything else: the `get_window_state`/`click`/`type_text`/`scroll` tools (they need the app on the current Space)."
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(computer-use): teach Claude Code the lanes via CLAUDE.md steering"`

---

### Task 8: Runtime wiring (`init.ts`)

**Files:** Modify: `electron/remote/init.ts` (around lines 1428–1452 where `startCuaServer` is called)

**Interfaces:**
- Consumes: `CdpLane`, `Arming`, `runAppleScript`, `startCuaServer`'s new `router` dep.

- [ ] **Step 1:** Construct the lanes and pass them in. Before `startCuaServer(...)`: `const arming = new Arming(); const cdp = new CdpLane((app) => arming.portFor(app)); const router = { cdp, arming, runAppleScript, getPolicy }` and add `router` to the `startCuaServer({...})` deps object. Add `arming.disposeAll()` to the dispose path near line 1629.
- [ ] **Step 2:** `npm run typecheck` → clean.
- [ ] **Step 3:** `npm test` → full suite green.
- [ ] **Step 4:** Commit: `git commit -m "feat(computer-use): wire lanes into the remote init"`

---

### Task 9: Build + live end-to-end smoke

**Files:** none (build + manual verification). Uses the `unmute-test-build` skill.

- [ ] **Step 1:** `desktop/vendor/cua-driver/fetch.sh` (once) so the binary is present.
- [ ] **Step 2:** Build a signed dev build per the `unmute-test-build` skill (version `-dev.N` that beats installed + published), install it, launch, confirm signed-in + Computer Use toggle present.
- [ ] **Step 3:** Enable Computer Use in settings. In a Claude Code session, run the proven task end-to-end **through the shipped MCP** (not the POC scripts): "in Notion, open the Calorify AI page, go to its last sub-page, scroll to the bottom, add a signature line, come back." Confirm via the tool results + a `web_screenshot` that it worked, in the background, no focus steal.
- [ ] **Step 4:** Run one `run_applescript` task (e.g., create a Notes note) and one cua-lane task (native app) to confirm all three lanes are live in the build.
- [ ] **Step 5:** Commit any fixes found; tag the plan complete.

---

## Notes for the executor

- **Read `desktop/docs/superpowers/specs/2026-07-22-computer-use-router-poc/MECHANISM.md` and `cdp.mjs` before Task 2** — they are the proven reference the CDP lane productizes.
- Keep the pass-through invariant: Task 6 must leave every non-router tool forwarding verbatim; the existing `cua-server.test.ts` cases must stay green unchanged.
- The lanes never touch the screen/cursor/focus — no `bring_to_front`, no `activate`, no session-tap events. Arming's relaunch is the one focus-affecting action (documented limitation); do not add others.
- Security: CDP ports are loopback-only; `web_*` tools honor the policy allowlist so only permitted apps are drivable.
