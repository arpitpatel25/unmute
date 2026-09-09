# Video-Led Immersive Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a resumable founder-video onboarding that begins before sign-in and advances only when users complete real Unmute actions across permissions, Apple Notes, Orchestrator, the Unmute Agent, and Notetaker.

**Architecture:** A pure main-process state machine owns progress and consumes normalized events from existing product systems. A dedicated transparent presenter window renders modular local clips and one contextual glass card; shipping notch, pill, capture, task, Agent, and Notetaker paths remain authoritative. Work is delivered in vertical slices so every task leaves a separately testable capability.

**Tech Stack:** Electron, TypeScript, React 19, SwiftUI/native-notch IPC, Node test runner, Cloudflare Workers, Supabase-backed managed entitlement, macOS TCC, AppleScript/System Events.

**Spec:** `docs/superpowers/specs/2026-09-10-video-led-immersive-onboarding-design.md`

## Global Constraints

- The real native notch, pill, Dictation, Instruct, Orchestrator, Unmute Agent, Notetaker, and Apple Notes are used; no onboarding copies or simulated successes.
- The closed notch remains opaque black; presenter visuals reuse the current adaptive dark-glass language without changing native notch material behavior.
- Onboarding begins before sign-in; anonymous managed access is limited to prescribed onboarding transcription calls.
- Claude Code and Codex credentials remain provider-owned and never pass through Unmute.
- Product events, never timers or video completion, prove action success.
- Progress survives quit, crash, System Settings, and relaunch; external mutations are never repeated automatically after uncertain completion.
- Founder audio stops before every user voice capture.
- Final founder footage is not required for implementation; stable clip IDs and caption copy are required.
- Signed/notarized clean-account verification is a release gate for macOS permissions and global triggers.

## File Structure

New main-process files live in `desktop/electron/onboarding/`:

- `types.ts` — shared chapter, action, event, progress, and presenter-command types.
- `chapters.ts` — declarative chapter manifest and stable clip/caption IDs.
- `machine.ts` — pure transition reducer; no Electron, filesystem, or clock access.
- `progress-store.ts` — atomic durable progress with schema migration and reset.
- `permissions.ts` — TCC probing, settings routes, System Audio preflight, and relaunch decision.
- `provider-probe.ts` — disposable Claude Code/Codex readiness probes.
- `notes-practice.ts` — Apple Notes launch/focus and practice target verification.
- `coordinator.ts` — adapters, arming, event normalization, recovery, and presenter commands.
- `presenter-window.ts` — transparent window lifecycle, placement, focus policy, and route loading.
- `register.ts` — IPC handlers and initialization seam used by the wired Electron main process.

New renderer files live in `desktop/engine-overrides/renderer/onboarding/`:

- `OnboardingPresenter.tsx` — video/caption surface and contextual card shell.
- `presenter.css` — scoped glass material, typography, layout, and reduced-motion rules.
- `presenterState.ts` — pure renderer reducer for commands and user actions.
- `presenterState.test.ts` — route-level state tests.
- `clips.ts` — stable local placeholder/final asset lookup.

Existing files are changed only at seams:

- `desktop/engine-overrides/renderer/main.tsx` — add `#/onboarding-presenter` route.
- `desktop/electron/preload-extensions.ts` — presenter IPC commands/events.
- `desktop/engine-overrides/renderer/app/App.tsx` — replace page gate with coordinator status and final sign-in handoff.
- `desktop/engine-overrides/renderer/app/Settings.tsx` — Replay calls coordinator reset.
- `desktop/build/wire-into-engine.sh` — inject onboarding initialization beside the existing `initRemote(...)` integration.
- `desktop/engine-overrides/electron/keyboard.ts` — forward authoritative trigger lifecycle events.
- `desktop/engine-overrides/renderer/widget/useAudioRecorder.ts` and `desktop/electron/remote/init.ts` — emit normalized delivery/capture/task lifecycle receipts.
- `desktop/engine-overrides/electron/notetakerInit.ts` — expose start/save/failure receipts and System Audio preflight.
- `desktop/electron/remote/agent/capabilities/handoff.ts` and `desktop/electron/remote/agent/controller.ts` — expose structured task-link receipt without parsing rendered prose.
- `backend/cloudflare/pipeline/src/index.ts` plus a focused allowance module — verify bounded onboarding tokens before normal subscription entitlement.

---

### Task 1: Pure Journey Contract and State Machine

**Files:**
- Create: `desktop/electron/onboarding/types.ts`
- Create: `desktop/electron/onboarding/chapters.ts`
- Create: `desktop/electron/onboarding/machine.ts`
- Create: `desktop/electron/onboarding/machine.test.ts`

**Interfaces:**
- Produces: `OnboardingProgress`, `OnboardingEvent`, `PresenterCommand`, `initialProgress(overrides?)`, and `reduceOnboarding(progress, event)`.
- Consumes: no runtime dependencies.

- [ ] **Step 1: Write failing transition tests**

```ts
test('delivery, not transcription, completes Notes dictation', () => {
  let p = atAction('notes-dictation')
  p = reduceOnboarding(p, { type: 'transcription-ready', captureId: 'c1' })
  assert.equal(p.action, 'notes-dictation')
  p = reduceOnboarding(p, { type: 'dictation-delivered', captureId: 'c1', target: 'com.apple.Notes' })
  assert.equal(p.action, 'notes-instruct')
})

test('restart resumes the first incomplete capability', () => {
  const p = initialProgress({ completed: ['privacy', 'microphone'], action: 'accessibility' })
  assert.equal(reduceOnboarding(p, { type: 'boot-revalidated', satisfied: ['privacy', 'microphone'] }).action, 'accessibility')
})
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/machine.test.ts`

Expected: FAIL because the onboarding contract modules do not exist.

- [ ] **Step 3: Define the stable journey types and manifest**

```ts
export type ActionId =
  | 'privacy' | 'microphone' | 'accessibility' | 'input-monitoring' | 'system-audio'
  | 'provider-choice' | 'notes-dictation' | 'notes-instruct' | 'clipboard-capture'
  | 'screenshot-capture' | 'orchestrator-task' | 'agent-task-link'
  | 'notetaker-save' | 'product-orientation' | 'sign-in' | 'complete'

export interface OnboardingProgress {
  schema: 1
  action: ActionId
  completed: ActionId[]
  provider?: 'claude' | 'codex'
  captureId?: string
  taskIds: { orchestrator?: string; agent?: string }
  updatedAt: number
}

export type OnboardingEvent =
  | { type: 'capability-satisfied'; action: ActionId }
  | { type: 'transcription-ready'; captureId: string }
  | { type: 'dictation-delivered'; captureId: string; target: string }
  | { type: 'instruction-delivered'; captureId: string; target: string; changedSelection: boolean }
  | { type: 'capture-observed'; captureId: string; kind: 'clipboard-text' | 'screenshot'; itemId: string }
  | { type: 'capture-delivered'; captureId: string; includedItemIds: string[] }
  | { type: 'task-created'; source: 'orchestrator' | 'agent'; taskId: string }
  | { type: 'task-completed'; taskId: string }
  | { type: 'agent-task-linked'; taskId: string; href: string }
  | { type: 'agent-text'; text: string }
  | { type: 'task-link-opened'; taskId: string }
  | { type: 'notetaker-started'; meetingId: string }
  | { type: 'notetaker-stopped'; meetingId: string }
  | { type: 'notetaker-saved'; meetingId: string }
  | { type: 'notetaker-failed'; meetingId?: string; reason: string }
  | { type: 'boot-revalidated'; satisfied: ActionId[] }
  | { type: 'retry-requested' }
  | { type: 'reset-requested' }

export type PresenterCommand = {
  type: 'snapshot'
  action: ActionId
  clipId: string
  caption: string
  card: null | { kind: 'permission' | 'speak' | 'provider' | 'repair' | 'success'; title?: string; phrase?: string; detail?: string }
}
```

Implement `CHAPTERS` with stable clip IDs and a `reduceOnboarding` switch that accepts only the authoritative completion event for the current action.

- [ ] **Step 4: Run the state-machine tests**

Run: `cd desktop && node --import tsx --test electron/onboarding/machine.test.ts`

Expected: PASS for ordered progression, unrelated-event rejection, retries, reset, and boot revalidation.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding/{types,chapters,machine,machine.test}.ts
git commit -m "feat(onboarding): add event-driven journey machine"
```

### Task 2: Durable Capability Progress

**Files:**
- Create: `desktop/electron/onboarding/progress-store.ts`
- Create: `desktop/electron/onboarding/progress-store.test.ts`
- Modify: `desktop/electron/onboarding/coordinator.ts` (created in this task as the minimal owner)

**Interfaces:**
- Consumes: `OnboardingProgress`, `initialProgress()`.
- Produces: `ProgressStore.load()`, `save(progress)`, `reset()`, and `OnboardingCoordinator.snapshot()`.

- [ ] **Step 1: Write persistence and crash-safety tests**

```ts
test('a saved action resumes after a new store instance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unmute-onboarding-'))
  const first = new ProgressStore(join(dir, 'progress.json'))
  await first.save({ ...initialProgress(), action: 'system-audio', completed: ['privacy', 'microphone', 'accessibility'] })
  const second = new ProgressStore(join(dir, 'progress.json'))
  assert.equal((await second.load()).action, 'system-audio')
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/progress-store.test.ts`

Expected: FAIL because `ProgressStore` is missing.

- [ ] **Step 3: Implement atomic storage and minimal coordinator**

```ts
export class ProgressStore {
  constructor(private readonly path: string) {}
  async load(): Promise<OnboardingProgress> {
    try { return migrate(JSON.parse(await fs.readFile(this.path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialProgress(); throw error }
  }
  async save(value: OnboardingProgress): Promise<void> {
    await writeFileAtomic(this.path, JSON.stringify(value))
    await fs.chmod(this.path, 0o600)
  }
  async reset(): Promise<void> { await fs.rm(this.path, { force: true }) }
}
```

Store under `app.getPath('userData')/onboarding/progress-v1.json`. Save before opening System Settings, launching a provider probe, creating a task, or triggering relaunch.

- [ ] **Step 4: Run persistence tests**

Run: `cd desktop && node --import tsx --test electron/onboarding/progress-store.test.ts electron/onboarding/machine.test.ts`

Expected: PASS, including corrupt-file recovery to a safe first incomplete action.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding/{progress-store,progress-store.test,coordinator}.ts
git commit -m "feat(onboarding): persist capability checkpoints"
```

### Task 3: Permission Audit, Preflight, and Relaunch Recovery

**Files:**
- Create: `desktop/electron/onboarding/permissions.ts`
- Create: `desktop/electron/onboarding/permissions.test.ts`
- Modify: `desktop/engine-overrides/electron/notetakerInit.ts`
- Modify: `desktop/engine-overrides/electron/keyListener.ts`
- Modify: `desktop/electron/onboarding/coordinator.ts`
- Modify: `desktop/electron/preload-extensions.ts`

**Interfaces:**
- Produces: `PermissionSnapshot`, `probePermissions()`, `requestPermission(kind)`, and `preflightSystemAudio()`.
- Consumes: injected mic, AX, global-key, system-audio, shell-settings, and relaunch adapters.

- [ ] **Step 1: Write tests for real-state revalidation and relaunch checkpoints**

```ts
test('system audio preflight starts and stops the native tap exactly once', async () => {
  const calls: string[] = []
  const result = await preflightSystemAudio({ start: async () => calls.push('start'), stop: async () => calls.push('stop'), status: async () => 'granted' })
  assert.deepEqual(calls, ['start', 'stop'])
  assert.equal(result, 'granted')
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/permissions.test.ts`

Expected: FAIL because permission adapters are missing.

- [ ] **Step 3: Implement permission orchestration**

```ts
export interface PermissionSnapshot {
  microphone: 'unknown' | 'not-determined' | 'granted' | 'denied' | 'restricted'
  accessibility: boolean
  inputMonitoring: boolean
  systemAudio: 'unknown' | 'granted' | 'denied' | 'restart-required'
}
```

Add an explicit native global-key readiness probe rather than reusing the misleading `isAccessibilityTrusted` name. Preserve backwards compatibility at the addon seam. Expose a controlled Notetaker tap preflight that never creates a meeting row. Save progress before any `app.relaunch(); app.exit(0)` path.

- [ ] **Step 4: Run permission and keyboard suites**

Run: `cd desktop && node --import tsx --test electron/onboarding/permissions.test.ts engine-overrides/electron/keyboard.*.test.ts`

Expected: PASS; preflight always stops on success, denial, and thrown start.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding desktop/engine-overrides/electron/{notetakerInit,keyListener}.ts desktop/electron/preload-extensions.ts
git commit -m "feat(onboarding): orchestrate macOS permission preflight"
```

### Task 4: Disposable Claude Code and Codex Readiness Probes

**Files:**
- Create: `desktop/electron/onboarding/provider-probe.ts`
- Create: `desktop/electron/onboarding/provider-probe.test.ts`
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/electron/remote/setup-status.ts`
- Modify: `desktop/electron/onboarding/coordinator.ts`

**Interfaces:**
- Produces: `probeProvider('claude' | 'codex') => Promise<ProviderProbeResult>` and `probeProviders()`.
- Consumes: existing `resolveClaudeCli`, `resolveCodexCli`, process spawning, and temporary-directory adapters.

- [ ] **Step 1: Write binary, auth, timeout, and cleanup tests**

```ts
test('a valid response marks a provider ready and removes the workspace', async () => {
  const h = probeHarness({ stdout: '{"type":"result","result":"READY"}\n', exitCode: 0 })
  assert.deepEqual(await h.probe('codex'), { provider: 'codex', state: 'ready' })
  assert.equal(h.workspaceRemoved, true)
  assert.equal(h.processKilled, true)
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/provider-probe.test.ts`

Expected: FAIL because the probe module is missing.

- [ ] **Step 3: Implement bounded real probes**

```ts
export type ProviderProbeResult =
  | { provider: 'claude' | 'codex'; state: 'ready' }
  | { provider: 'claude' | 'codex'; state: 'missing' | 'auth-required' | 'timed-out' | 'failed'; detail: string }
```

Use one empty `mkdtemp` workspace per provider, a fixed no-write prompt that returns `READY`, provider-native machine-readable output, a 20-second timeout, and a `finally` block that terminates the child and removes the workspace. Start both probes at coordinator initialization with `Promise.allSettled`. Do not create `TaskManager` tasks or notch cards for probes.

- [ ] **Step 4: Run provider and setup-status tests**

Run: `cd desktop && node --import tsx --test electron/onboarding/provider-probe.test.ts electron/remote/setup-status.test.ts electron/remote/providers.test.ts`

Expected: PASS with Claude-only, Codex-only, both-ready, neither-ready, and retry-one-provider cases.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding desktop/electron/remote/{init,setup-status}.ts
git commit -m "feat(onboarding): verify local agent readiness"
```

### Task 5: Presenter Window and Glass Renderer

**Files:**
- Create: `desktop/electron/onboarding/presenter-window.ts`
- Create: `desktop/electron/onboarding/presenter-window.test.ts`
- Create: `desktop/engine-overrides/renderer/onboarding/OnboardingPresenter.tsx`
- Create: `desktop/engine-overrides/renderer/onboarding/presenter.css`
- Create: `desktop/engine-overrides/renderer/onboarding/presenterState.ts`
- Create: `desktop/engine-overrides/renderer/onboarding/presenterState.test.ts`
- Create: `desktop/engine-overrides/renderer/onboarding/clips.ts`
- Modify: `desktop/engine-overrides/renderer/main.tsx`
- Modify: `desktop/electron/preload-extensions.ts`

**Interfaces:**
- Consumes: `PresenterCommand` snapshots from the coordinator.
- Produces: `showPresenter()`, `sendPresenter(command)`, and user events `continue`, `retry`, `choose-provider`, `open-settings`, `replay-clip`.

- [ ] **Step 1: Write route and renderer reducer tests**

```ts
test('action change swaps caption and one companion card', () => {
  const next = reducePresenter(emptyPresenter(), { type: 'snapshot', action: 'notes-dictation', clipId: 'dictation-explain-v1', caption: 'Put your cursor in Notes.', card: { kind: 'speak', phrase: 'My first Unmute dictation.' } })
  assert.equal(next.clipId, 'dictation-explain-v1')
  assert.equal(next.card?.kind, 'speak')
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test engine-overrides/renderer/onboarding/presenterState.test.ts electron/onboarding/presenter-window.test.ts`

Expected: FAIL because presenter files and route are missing.

- [ ] **Step 3: Implement the presenter surface**

```tsx
export function OnboardingPresenter() {
  const [state, dispatch] = useReducer(reducePresenter, emptyPresenter())
  useEffect(() => window.electronAPI.onOnboardingPresenterCommand(dispatch), [])
  return <main className="ob-presenter" data-action={state.action}>
    <video key={state.clipId} src={clipUrl(state.clipId)} autoPlay playsInline />
    <div className="ob-caption" aria-live="polite">{state.caption}</div>
    {state.card && <CompanionCard card={state.card} />}
  </main>
}
```

Create a frameless transparent, always-on-top window loaded at `#/onboarding-presenter`. Use a nonactivating focus policy until the current card requires a click. Position it away from the physical notch and current target window. Scope all CSS under `.ob-presenter`; implement `prefers-reduced-motion`, captions, keyboard controls, bright-wallpaper contrast, and missing-video fallback.

- [ ] **Step 4: Run presenter tests and renderer typecheck**

Run: `cd desktop && node --import tsx --test engine-overrides/renderer/onboarding/presenterState.test.ts electron/onboarding/presenter-window.test.ts && npm run typecheck`

Expected: focused tests PASS; typecheck introduces no new errors beyond the repository's recorded baseline.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding/presenter-window* desktop/engine-overrides/renderer/{main.tsx,onboarding} desktop/electron/preload-extensions.ts
git commit -m "feat(onboarding): add adaptive glass founder presenter"
```

### Task 6: Installation-Scoped Onboarding Transcription Allowance

**Files:**
- Create: `backend/cloudflare/pipeline/src/onboardingAllowance.ts`
- Create: `backend/cloudflare/pipeline/src/onboardingAllowance.test.ts`
- Modify: `backend/cloudflare/pipeline/src/index.ts`
- Create: `desktop/electron/onboarding/allowance.ts`
- Create: `desktop/electron/onboarding/allowance.test.ts`
- Modify: `desktop/electron/managed-client.ts`
- Modify: `desktop/electron/paywall-route.ts`
- Modify: `desktop/electron/paywall-stream.ts`

**Interfaces:**
- Produces: one signed onboarding grant bound to an installation ID, action ID, expiry, request count, and audio-second ceiling.
- Consumes: the same managed STT endpoint with an `X-Unmute-Onboarding-Grant` header.

- [ ] **Step 1: Write fail-closed allowance tests**

```ts
test('a grant cannot be replayed for an unlisted action', async () => {
  const grant = await issueGrant({ installationId: 'i1', actions: ['notes-dictation'], maxRequests: 2, maxAudioSeconds: 30, expiresAt: now + 600_000 })
  assert.equal(await authorizeGrant(grant, { installationId: 'i1', action: 'orchestrator-task', audioSeconds: 2 }), false)
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test ../backend/cloudflare/pipeline/src/onboardingAllowance.test.ts electron/onboarding/allowance.test.ts`

Expected: FAIL because allowance modules and grant handling are missing.

- [ ] **Step 3: Implement bounded grants**

```ts
export interface OnboardingGrantClaims {
  installationId: string
  actions: Array<'notes-dictation' | 'notes-instruct' | 'clipboard-capture' | 'screenshot-capture' | 'orchestrator-task' | 'agent-task-link'>
  maxRequests: 8
  maxAudioSeconds: 180
  expiresAt: number
  nonce: string
}
```

Sign claims server-side, store nonce consumption with TTL, reject unknown actions, expired grants, mismatched installation IDs, excessive audio, and replay past the request limit. Never permit managed LLM calls through this grant. Desktop requests one grant per fresh installation and attaches it only while the coordinator has armed the matching action.

- [ ] **Step 4: Run worker and desktop allowance tests**

Run: `cd desktop && node --import tsx --test electron/onboarding/allowance.test.ts ../backend/cloudflare/pipeline/src/onboardingAllowance.test.ts && cd ../backend/cloudflare/pipeline && npm run typecheck`

Expected: PASS for expiry, replay, count, duration, action binding, and signed-in entitlement remaining unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/cloudflare/pipeline/src desktop/electron/onboarding/allowance* desktop/electron/{managed-client,paywall-route,paywall-stream}.ts
git commit -m "feat(onboarding): add bounded pre-sign-in transcription grant"
```

### Task 7: Apple Notes Dictation and Instruct Exercises

**Files:**
- Create: `desktop/electron/onboarding/notes-practice.ts`
- Create: `desktop/electron/onboarding/notes-practice.test.ts`
- Modify: `desktop/engine-overrides/electron/keyboard.ts`
- Modify: `desktop/engine-overrides/renderer/widget/useAudioRecorder.ts`
- Modify: `desktop/engine-overrides/electron/sessionManager.ts`
- Modify: `desktop/electron/onboarding/coordinator.ts`

**Interfaces:**
- Produces: `openNotesPractice()`, `verifyNotesDelivery(captureId)`, `dictation-delivered`, and `instruction-delivered` events.
- Consumes: existing capture/session IDs, delivery results, and frontmost-app metadata.

- [ ] **Step 1: Write tests that reject transcription-only success**

```ts
test('Notes exercise waits for target delivery', async () => {
  const c = coordinatorAt('notes-dictation')
  c.accept({ type: 'transcription-ready', captureId: 'c1' })
  assert.equal(c.snapshot().action, 'notes-dictation')
  c.accept({ type: 'dictation-delivered', captureId: 'c1', target: 'com.apple.Notes' })
  assert.equal(c.snapshot().action, 'notes-instruct')
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/notes-practice.test.ts`

Expected: FAIL because delivery receipts are not wired to onboarding.

- [ ] **Step 3: Implement Notes arming and delivery receipts**

```ts
export interface DeliveryReceipt {
  captureId: string
  mode: 'dictation' | 'instruction'
  targetBundleId: string | null
  delivered: boolean
  changedSelection?: boolean
}
```

Open Notes with Launch Services, bring it forward, and wait until
`com.apple.Notes` is frontmost before enabling the phrase card. Generate one
capture ID at recording start and preserve it through transcription and paste.
Emit success only after the shipping paste path returns success; for Instruct,
also require a nonempty captured selection and successful replacement.

- [ ] **Step 4: Run Notes, keyboard, and recorder tests**

Run: `cd desktop && node --import tsx --test electron/onboarding/notes-practice.test.ts engine-overrides/electron/keyboard.*.test.ts engine-overrides/renderer/widget/*.test.ts`

Expected: PASS with wrong-app delivery, empty selection, cancellation, and retry remaining on the current action.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding desktop/engine-overrides/electron/{keyboard,sessionManager}.ts desktop/engine-overrides/renderer/widget/useAudioRecorder.ts
git commit -m "feat(onboarding): verify live Notes voice exercises"
```

### Task 8: Clipboard and Screenshot Composition Exercises

**Files:**
- Create: `desktop/electron/onboarding/capture-practice.ts`
- Create: `desktop/electron/onboarding/capture-practice.test.ts`
- Modify: `desktop/electron/remote/capture/index.ts`
- Modify: `desktop/electron/remote/capture/history-store.ts`
- Modify: `desktop/engine-overrides/renderer/widget/useAudioRecorder.ts`
- Modify: `desktop/electron/onboarding/coordinator.ts`

**Interfaces:**
- Produces: `capture-observed` and `capture-delivered` receipts keyed by capture ID and kind.
- Consumes: existing clipboard/screenshot composition records and final delivery receipts.

- [ ] **Step 1: Write paired capture/delivery tests**

```ts
test('a screenshot observed but omitted from delivery does not advance', () => {
  const c = coordinatorAt('screenshot-capture')
  c.accept({ type: 'capture-observed', captureId: 'c2', kind: 'screenshot', itemId: 's1' })
  c.accept({ type: 'capture-delivered', captureId: 'c2', includedItemIds: [] })
  assert.equal(c.snapshot().action, 'screenshot-capture')
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/capture-practice.test.ts`

Expected: FAIL because composition receipts are missing.

- [ ] **Step 3: Add structured receipts without changing capture behavior**

```ts
export interface CompositionReceipt {
  captureId: string
  observed: Array<{ id: string; kind: 'clipboard-text' | 'screenshot' }>
  deliveredItemIds: string[]
  targetBundleId: string | null
}
```

Forward existing capture IDs from watcher to composer and delivery. Verify the
correct kind was observed during the armed capture and its item ID appears in
the final Notes delivery. Surface Desktop-folder denial as its own recovery
reason rather than a generic screenshot timeout.

- [ ] **Step 4: Run capture suites**

Run: `cd desktop && node --import tsx --test electron/onboarding/capture-practice.test.ts electron/remote/capture/*.test.ts`

Expected: PASS for clipboard, screenshot, duplicate watcher event, omitted item, folder denial, and retry.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding desktop/electron/remote/capture desktop/engine-overrides/renderer/widget/useAudioRecorder.ts
git commit -m "feat(onboarding): prove clipboard and screenshot delivery"
```

### Task 9: Real Orchestrator Exercise

**Files:**
- Create: `desktop/electron/onboarding/orchestrator-exercise.ts`
- Create: `desktop/electron/onboarding/orchestrator-exercise.test.ts`
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/electron/remote/task-manager.ts`
- Modify: `desktop/electron/onboarding/coordinator.ts`

**Interfaces:**
- Produces: an isolated onboarding workspace and `verifyHelloTask(taskId)`.
- Consumes: selected provider, existing voice dispatch, task creation/update events.

- [ ] **Step 1: Write task ownership and file verification tests**

```ts
test('only the armed onboarding task with expected output advances', async () => {
  const h = orchestratorHarness()
  const task = await h.create('Create a file called hello-unmute.txt and write "My first Unmute task" inside it.')
  await h.write(task, 'hello-unmute.txt', 'My first Unmute task')
  assert.equal(await h.verify(task.id), true)
  assert.equal(await h.verify('unrelated-task'), false)
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/orchestrator-exercise.test.ts`

Expected: FAIL because the onboarding workspace verifier is missing.

- [ ] **Step 3: Implement the isolated real task**

```ts
export const HELLO_TASK_PHRASE = 'Create a file called hello-unmute.txt and write "My first Unmute task" inside it.'
export async function verifyHelloTask(root: string): Promise<boolean> {
  return (await fs.readFile(join(root, 'hello-unmute.txt'), 'utf8')).trim() === 'My first Unmute task'
}
```

Arm the coordinator with the next task created from the task capture route and
force its cwd to `userData/onboarding/workspace`. Do not bypass TaskManager,
provider selection, notch presentation, or normal task events. Advance only
after the owned task completes and `verifyHelloTask` succeeds.

- [ ] **Step 4: Run Orchestrator and TaskManager tests**

Run: `cd desktop && node --import tsx --test electron/onboarding/orchestrator-exercise.test.ts electron/remote/task-manager*.test.ts electron/remote/routing.test.ts`

Expected: PASS; unrelated tasks, failed tasks, and correct text in the wrong directory do not advance.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding desktop/electron/remote/{init,task-manager}.ts
git commit -m "feat(onboarding): add verified Orchestrator exercise"
```

### Task 10: Unmute Agent Task-Link Exercise

**Files:**
- Create: `desktop/electron/onboarding/agent-exercise.ts`
- Create: `desktop/electron/onboarding/agent-exercise.test.ts`
- Modify: `desktop/electron/remote/agent/capabilities/handoff.ts`
- Modify: `desktop/electron/remote/agent/controller.ts`
- Modify: `desktop/electron/remote/notch/notch-controller.ts`
- Modify: `desktop/electron/onboarding/coordinator.ts`

**Interfaces:**
- Produces: structured `{ source: 'unmute-agent', taskId, href }` receipt.
- Consumes: real `task_create` capability result and notch artifact-open event.

- [ ] **Step 1: Write tests that reject prose-only links**

```ts
test('Agent chapter requires a structured task receipt and matching open', () => {
  const c = coordinatorAt('agent-task-link')
  c.accept({ type: 'agent-text', text: 'I created a task: unmute://task/fake' })
  assert.equal(c.snapshot().action, 'agent-task-link')
  c.accept({ type: 'agent-task-linked', taskId: 't2', href: 'unmute://task/t2' })
  c.accept({ type: 'task-link-opened', taskId: 't2' })
  assert.equal(c.snapshot().action, 'notetaker-save')
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/agent-exercise.test.ts`

Expected: FAIL because structured Agent receipts are missing.

- [ ] **Step 3: Emit and verify real task links**

```ts
export interface AgentTaskReceipt {
  source: 'unmute-agent'
  taskId: string
  href: `unmute://task/${string}`
}
```

Return this receipt from the existing `task_create` capability alongside its
human response. Forward it through the Agent worker and coordinator. Require the
task to use the onboarding workspace and request adding today's local date to
`hello-unmute.txt`. Require the matching native link-open event before advancing.

- [ ] **Step 4: Run Agent and notch tests**

Run: `cd desktop && node --import tsx --test electron/onboarding/agent-exercise.test.ts electron/remote/agent/**/*.test.ts electron/remote/notch/notch-controller.test.ts`

Expected: PASS for real receipt/open, mismatched link, failed task creation, and retry without duplicate task.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding desktop/electron/remote/agent/capabilities/handoff.ts desktop/electron/remote/agent/controller.ts desktop/electron/remote/notch/notch-controller.ts
git commit -m "feat(onboarding): verify Agent-created linked tasks"
```

### Task 11: Real Notetaker Save Exercise

**Files:**
- Create: `desktop/electron/onboarding/notetaker-exercise.ts`
- Create: `desktop/electron/onboarding/notetaker-exercise.test.ts`
- Modify: `desktop/engine-overrides/electron/notetakerInit.ts`
- Modify: `desktop/electron/remote/notetakerWidget.ts`
- Modify: `desktop/electron/remote-preload.ts`
- Modify: `desktop/electron/onboarding/coordinator.ts`

**Interfaces:**
- Produces: `notetaker-started`, `notetaker-saved`, and `notetaker-failed` receipts with meeting ID.
- Consumes: existing Left Control gesture, native widget actions, and meeting persistence result.

- [ ] **Step 1: Write save-not-start completion tests**

```ts
test('starting and stopping without Save does not complete Notetaker', () => {
  const c = coordinatorAt('notetaker-save')
  c.accept({ type: 'notetaker-started', meetingId: 'm1' })
  c.accept({ type: 'notetaker-stopped', meetingId: 'm1' })
  assert.equal(c.snapshot().action, 'notetaker-save')
  c.accept({ type: 'notetaker-saved', meetingId: 'm1' })
  assert.equal(c.snapshot().action, 'product-orientation')
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/notetaker-exercise.test.ts`

Expected: FAIL because save receipts are not exposed to onboarding.

- [ ] **Step 3: Wire the real Left Control and Save lifecycle**

```ts
export type NotetakerExerciseEvent =
  | { type: 'notetaker-started'; meetingId: string }
  | { type: 'notetaker-stopped'; meetingId: string }
  | { type: 'notetaker-saved'; meetingId: string }
  | { type: 'notetaker-failed'; meetingId?: string; reason: string }
```

Arm the chapter before asking for the double-tap. Preserve the existing
Notetaker trigger and widget controls. Emit `saved` only after meeting metadata
and retained audio state are persisted. Do not wait for transcript cleanup or
summary generation. The orientation snapshot may show `processing` honestly.

- [ ] **Step 4: Run Notetaker suites**

Run: `cd desktop && node --import tsx --test electron/onboarding/notetaker-exercise.test.ts engine-overrides/electron/notetaker/*.test.ts electron/remote/notetaker*.test.ts`

Expected: PASS for save, discard, start failure, asynchronous summary, and retry.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding desktop/engine-overrides/electron/notetakerInit.ts desktop/electron/remote/notetakerWidget.ts desktop/electron/remote-preload.ts
git commit -m "feat(onboarding): require a real saved Notetaker recording"
```

### Task 12: App Gate, Orientation, Sign-In Handoff, and Replay

**Files:**
- Create: `desktop/electron/onboarding/register.ts`
- Create: `desktop/electron/onboarding/register.test.ts`
- Modify: `desktop/build/wire-into-engine.sh`
- Modify: `desktop/engine-overrides/renderer/app/App.tsx`
- Modify: `desktop/engine-overrides/renderer/app/Settings.tsx`
- Modify: `desktop/electron/preload-extensions.ts`
- Delete: `desktop/engine-overrides/renderer/app/Onboarding.tsx`

**Interfaces:**
- Produces: `onboardingGetSnapshot`, `onboardingReset`, `onboardingCompleteOrientation`, and `onboardingFinishAfterSignIn` IPC.
- Consumes: coordinator, presenter window, existing app section navigation, AuthContext, and subscription flow.

- [ ] **Step 1: Write gate and replay tests**

```ts
test('first launch opens presenter before sign-in and completion waits for sign-in', async () => {
  const h = registerHarness({ signedIn: false, progress: progressAt('sign-in') })
  await h.boot()
  assert.equal(h.presenterShown, true)
  assert.equal(h.finished, false)
  await h.signIn()
  assert.equal(h.finished, true)
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd desktop && node --import tsx --test electron/onboarding/register.test.ts`

Expected: FAIL because registration and coordinator-backed gate are missing.

- [ ] **Step 3: Replace the page gate**

```ts
export function registerOnboarding(deps: OnboardingDeps): OnboardingCoordinator {
  const coordinator = new OnboardingCoordinator(deps)
  ipcMain.handle('onboarding:snapshot', () => coordinator.snapshot())
  ipcMain.handle('onboarding:reset', () => coordinator.reset())
  ipcMain.handle('onboarding:orientation-complete', () => coordinator.accept({ type: 'capability-satisfied', action: 'product-orientation' }))
  return coordinator
}
```

Extend the existing deterministic `main.ts` patch in `wire-into-engine.sh` to
initialize onboarding after core capture, Remote, Agent, and Notetaker dependencies exist,
but show the presenter before the main app asks for sign-in. During orientation,
open the real Electron app at Orchestrator and then Notetaker using existing
navigation state. Replace legacy localStorage version gating and make Replay
reset instructional progress through main. Delete the page-based onboarding
component after all imports and tests are migrated.

- [ ] **Step 4: Run gate tests and typecheck**

Run: `cd desktop && node --import tsx --test electron/onboarding/*.test.ts && npm run typecheck`

Expected: onboarding tests PASS; no new type errors; no runtime import of `app/Onboarding.tsx` remains.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/onboarding desktop/build/wire-into-engine.sh desktop/engine-overrides/renderer/app/{App,Settings}.tsx desktop/electron/preload-extensions.ts
git rm desktop/engine-overrides/renderer/app/Onboarding.tsx
git commit -m "feat(onboarding): replace page wizard with live first run"
```

### Task 13: End-to-End Contract, Visual Matrix, and Signed-Build Runbook

**Files:**
- Create: `desktop/electron/onboarding/end-to-end.test.ts`
- Create: `desktop/docs/onboarding/FOUNDER-SCRIPT.md`
- Create: `desktop/docs/onboarding/SIGNED-BUILD-VERIFICATION.md`
- Modify: `desktop/build/install-local.sh`

**Interfaces:**
- Consumes: every public onboarding interface from Tasks 1–12.
- Produces: deterministic placeholder script/cue contract and reproducible signed-build acceptance procedure.

- [ ] **Step 1: Write the full synthetic-adapter journey test**

```ts
test('fresh install completes only after every real receipt and sign-in', async () => {
  const h = endToEndHarness()
  await h.boot()
  await h.grantAllPermissions()
  await h.completeNotesExercises()
  await h.completeOrchestratorTask()
  await h.completeAgentLinkedTask()
  await h.saveNotetakerRecording()
  await h.completeOrientation()
  assert.equal(h.snapshot().action, 'sign-in')
  await h.signInAndSubscribe()
  assert.equal(h.snapshot().action, 'complete')
})
```

- [ ] **Step 2: Run and confirm any missing integration fails**

Run: `cd desktop && node --import tsx --test electron/onboarding/end-to-end.test.ts`

Expected: FAIL until every adapter emits the exact contract required by the machine.

- [ ] **Step 3: Complete the script and signed-build matrices**

`FOUNDER-SCRIPT.md` must contain, for every stable clip ID: spoken copy,
caption copy, visible card, arming condition, completion event, failure clip,
and maximum spoken duration. `SIGNED-BUILD-VERIFICATION.md` must contain clean
account setup plus a result table for:

```md
| Matrix | Values |
|---|---|
| Display | notched MacBook; external notchless display |
| Background | white page; black page; saturated wallpaper; photograph |
| Transparency | system on; Reduce Transparency; forced live glass |
| Motion | normal; Reduce Motion |
| Providers | Claude only; Codex only; both; neither; signed out |
| Permissions | fresh; already granted; denied; grant requiring relaunch |
| Recovery | quit at every action; provider timeout; offline video fallback |
```

Add an `install-local.sh --fresh-onboarding` option that removes only the
documented onboarding progress/grant files after printing their exact paths and
requires the existing explicit install confirmation; it must not alter TCC or
provider credentials.

- [ ] **Step 4: Run automated verification**

Run: `cd desktop && node --import tsx --test electron/onboarding/*.test.ts && npm run test:keyboard && npm run typecheck`

Expected: all onboarding and keyboard tests PASS; typecheck introduces no errors beyond the recorded baseline.

- [ ] **Step 5: Run the signed clean-account acceptance pass**

Run: `cd desktop && npm run build`, install the signed/notarized DMG on a clean macOS account, and execute every row in `desktop/docs/onboarding/SIGNED-BUILD-VERIFICATION.md`.

Expected: one uninterrupted real journey completes; required relaunch resumes at the exact action; no page wizard or simulated surface appears; screenshots are saved with timestamps in the runbook.

- [ ] **Step 6: Commit**

```bash
git add desktop/electron/onboarding/end-to-end.test.ts desktop/docs/onboarding desktop/build/install-local.sh
git commit -m "test(onboarding): add signed first-run release gate"
```

## Final Release Checks

- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Run every focused command from Tasks 1–13 again from a clean checkout.
- [ ] Confirm the old page onboarding has no imports or routes with `rg -n "Onboarding|unmute_onboarding_version|unmute_onboarding_complete" desktop/engine-overrides/renderer` and classify every remaining match.
- [ ] Confirm no onboarding-only fake notch, pill, task, transcription, or Notetaker success exists with a manual code review against the design spec.
- [ ] Confirm no provider credential or token is logged in desktop or worker diagnostics.
- [ ] Confirm the anonymous allowance rejects managed LLM calls and requests after completion.
- [ ] Record the signed-build version, commit SHA, macOS version, hardware, and TCC outcomes in the verification document.
