# Unmute Agent Provider Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Unmute Agent provider changes reliable, contextual, visible in the Swift notch, and pinned to Codex `gpt-5.6-sol` or Claude Code `opus` without silent fallback.

**Architecture:** Add a central per-provider model policy, carry it through the daemon into every provider start/resume, and make provider switching an explicit lifecycle transition. Preserve continuity with the existing bounded recent-exchange mechanism plus a handoff summary, expose selected/active/pending provider state to the notch, and remove automatic provider fallback from Agent-owned background calls.

**Tech Stack:** TypeScript/Electron, Node test runner, encrypted Agent journal/snapshot storage, SwiftUI native notch, shell build/check scripts.

**Spec:** `docs/superpowers/specs/2026-09-15-unmute-agent-provider-switching-design.md`

## Global Constraints

- The branch is based on `main`; do not include Agent Routines.
- Codex CLI uses the exact model `gpt-5.6-sol`.
- Claude Code CLI uses the exact argument `opus` and displays “Opus 5”.
- Never silently fall back to another model or provider.
- Keep acceptance-uncertain work blocked from automatic replay.
- Archive prior provider identity and transcript; do not destructively delete it.
- A switch requested during an accepted turn takes effect only after that turn settles.
- Carry at most six complete recent exchanges, bounded by the existing transcript budget.

---

### Task 1: Explicit model policy and no provider fallback

**Files:**
- Create: `desktop/electron/remote/agent/modelPolicy.ts`
- Create: `desktop/electron/remote/agent/modelPolicy.test.ts`
- Modify: `desktop/electron/remote/agent/controller.ts`
- Modify: `desktop/electron/remote/agent/controller.test.ts`
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/electron/remote/agent/providerHealth.test.ts`

**Interfaces:**
- Produces: `agentModel(provider: AgentProviderId): string` and `agentModelLabel(provider: AgentProviderId): string`.
- Consumes: `AgentProviderId` and existing `AgentResumeInput.model` support.

- [ ] **Step 1: Write failing policy and controller tests**

```ts
assert.equal(agentModel('codex'), 'gpt-5.6-sol')
assert.equal(agentModel('claude'), 'opus')
assert.equal(agentModelLabel('claude'), 'Opus 5')
assert.equal(capturedStart.model, 'opus')
```

- [ ] **Step 2: Run the focused tests and verify model propagation fails**

Run: `cd desktop && node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/agent/modelPolicy.test.ts electron/remote/agent/controller.test.ts`

Expected: FAIL because the policy module does not exist and controller start input has no model.

- [ ] **Step 3: Add the policy and pass its result in `turnInput.model`**

```ts
export const AGENT_MODELS = { codex: 'gpt-5.6-sol', claude: 'opus' } as const
export function agentModel(provider: AgentProviderId): string { return AGENT_MODELS[provider] }
export function agentModelLabel(provider: AgentProviderId): string {
  return provider === 'claude' ? 'Opus 5' : 'GPT-5.6 Sol'
}
```

`UnmuteAgentController.submit()` sets `model: agentModel(provider)` before calling either `supervisor.start()` or `supervisor.resume()`.

- [ ] **Step 4: Remove cross-provider retry from `runAgentHeadless`**

Change the helper to call only `settings.get('unmuteAgentProvider')`; retain health reporting for diagnostics but never iterate into the other provider. Update tests so a failed preferred provider returns its failure and records no second call.

- [ ] **Step 5: Run focused tests and commit**

Run: `cd desktop && node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/agent/modelPolicy.test.ts electron/remote/agent/controller.test.ts electron/remote/agent/providerHealth.test.ts`

Commit: `fix(agent): pin provider models without fallback`

### Task 2: Recoverable provider switching and bounded handoff

**Files:**
- Modify: `desktop/electron/remote/agent/journal.ts`
- Modify: `desktop/electron/remote/agent/conversation-store.ts`
- Modify: `desktop/electron/remote/agent/lifecycle.ts`
- Modify: `desktop/electron/remote/agent/lifecycle.test.ts`
- Modify: `desktop/electron/remote/agent/controller.ts`
- Modify: `desktop/electron/remote/agent/controller.test.ts`

**Interfaces:**
- Produces: `AgentConversationRecord.selectedProvider`, existing `pendingProvider`, and a bounded `handoff` on the snapshot.
- Produces: `requestProvider(provider)` that clears recoverable error state and schedules an accepted-turn-safe rotation.
- Consumes: existing `carryoverRunId` and `recentExchanges()` mechanisms.

- [ ] **Step 1: Write failing idle-switch and failed-switch tests**

```ts
await lifecycle.requestProvider('codex')
assert.equal(lifecycle.view().record.selectedProvider, 'codex')
assert.equal(lifecycle.view().snapshot.error, undefined)
await lifecycle.retry()
assert.equal(lastSubmission.provider, 'codex')
assert.equal(lastSubmission.priorRunId, undefined)
```

Cover an empty queue, a retained failed queue, and selecting the already-active provider.

- [ ] **Step 2: Run the lifecycle test and verify the retained-error case fails**

Run: `cd desktop && node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/agent/lifecycle.test.ts`

Expected: FAIL because `requestProvider()` leaves `snapshot.error` latched and exposes no durable selected provider.

- [ ] **Step 3: Implement selected/active/pending lifecycle state**

Persist the selected provider immediately. When idle, mark a fresh rotation. When a turn is accepted/running, retain `pendingProvider` until settlement. Clear only recoverable interaction errors; never clear `phase === 'recovery-required'`. Keep retained input queued for explicit Retry rather than resending it when the picker is clicked.

- [ ] **Step 4: Write failing handoff tests**

Assert that a provider rotation sends exactly the prior run's last six complete exchanges and a bounded handoff summary, and that a switch requested during a turn includes that turn's settled assistant response.

- [ ] **Step 5: Implement the handoff packet**

Store the archived conversation's summary/turn window before changing `snapshot.chat.runId`. Inject it into `providerTranscript()` as clearly delimited background context. Preserve the visible historical chat and provider run record; do not send the handoff as a user-authored message.

- [ ] **Step 6: Run lifecycle/controller tests and commit**

Run: `cd desktop && node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/agent/lifecycle.test.ts electron/remote/agent/controller.test.ts electron/remote/agent/journal.test.ts electron/remote/agent/conversation-store.test.ts`

Commit: `fix(agent): switch providers with retained context`

### Task 3: Runtime IPC and actionable failure identity

**Files:**
- Modify: `desktop/electron/remote/runtime/agent-service.ts`
- Modify: `desktop/electron/remote/runtime/agent-routing.ts`
- Modify: `desktop/electron/remote/runtime/agent-client.ts`
- Modify: `desktop/electron/remote/runtime/agent-runtime.test.ts`
- Modify: `desktop/electron/remote/agent/provider.ts`
- Modify: `desktop/electron/remote/agent/provider.test.ts`
- Modify: `desktop/electron/remote/init.ts`

**Interfaces:**
- `AgentRuntimeConfig` carries explicit provider model policy.
- Runtime snapshots expose selected, active, and pending provider through the conversation view.
- `AgentProviderError` distinguishes `model-unavailable`, `authentication-required`, `resume-failed`, and `provider-unavailable` where the adapter has evidence.

- [ ] **Step 1: Write failing daemon reconfiguration tests**

Verify a reused daemon receives a provider/model update, does not preserve an obsolete model on a fresh run, and does not rotate when configuration is unchanged.

- [ ] **Step 2: Run focused runtime tests and verify failure**

Run: `cd desktop && node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/runtime/agent-runtime.test.ts electron/remote/agent/provider.test.ts`

- [ ] **Step 3: Implement config propagation and safe diagnostics**

Pass model policy through configure/update RPC. Preserve the public typed error while logging provider, model, operation stage, and a bounded driver message. Never log prompts, transcript text, environment values, or tokens.

- [ ] **Step 4: Run focused tests and commit**

Run: `cd desktop && node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/runtime/agent-runtime.test.ts electron/remote/agent/provider.test.ts electron/remote/runtime/agent-routing.test.ts`

Commit: `fix(agent): reconfigure provider identity safely`

### Task 4: Swift notch provider switch control

**Files:**
- Modify: `desktop/electron/remote/notch/notch-controller.ts`
- Modify: `desktop/electron/remote/notch/notch-controller.test.ts`
- Modify: `desktop/native-notch/Sources/unmute-notch/IPC.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/ComposerControls.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/ConversationPanel.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/TaskSurfaceView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/PillView.swift`
- Modify: `desktop/native-notch/Tests/unmute-notchTests/IPCContractTests.swift`

**Interfaces:**
- Electron detail payload provides selected/active/pending provider, provider choices, labels, and configured model label.
- Swift emits `agentSwitchProvider(provider:)` only after confirmation.

- [ ] **Step 1: Write failing Electron payload tests**

Assert the Agent detail contains both provider choices, the active provider mark, the selected provider, pending copy when applicable, and `GPT-5.6 Sol`/`Opus 5` model labels.

- [ ] **Step 2: Write failing Swift IPC contract tests**

```swift
XCTAssertEqual(ClientEvent.agentSwitchProvider(provider: "claude").json["type"] as? String,
               "agentSwitchProvider")
```

Also assert the provider choice payload decodes when optional switching state is absent for backward compatibility.

- [ ] **Step 3: Run focused tests and verify failure**

Run Electron: `cd desktop && node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/notch/notch-controller.test.ts`

Run Swift: `sh desktop/native-notch/Checks/run.sh`

- [ ] **Step 4: Implement the notch control and confirmation**

Make the displayed provider mark a menu/button in the Agent chat. Choosing the other provider presents the archive-and-handoff confirmation. Keep the control enabled while busy; display “Switching to {provider} after this response…” after confirmation. Route the event through Electron to `requestProvider()` and persist the setting only after runtime acknowledgement.

- [ ] **Step 5: Run Electron and Swift tests and commit**

Run Electron: `cd desktop && node --import tsx --import ./electron/remote/test-setup.ts --test electron/remote/notch/notch-controller.test.ts electron/remote/runtime/agent-runtime.test.ts`

Run Swift: `sh desktop/native-notch/Checks/run.sh`

Commit: `feat(agent): switch provider from the notch`

### Task 5: Integrated verification, signed install, launch, and merge

**Files:**
- Modify only files required by failures attributable to Tasks 1–4.

**Interfaces:**
- Consumes all prior tasks; produces a verified installed build and a merge commit on `main`.

- [ ] **Step 1: Install worktree dependencies and run all automated checks**

Run: `cd desktop && npm install`

Run: `cd desktop && npm test`

Run: `cd desktop && npm run typecheck`

Run: `sh desktop/native-notch/Checks/run.sh`

- [ ] **Step 2: Build using the signed local build procedure**

Follow `docs/ONBOARDING.md`: choose a development version greater than the installed build, make only the documented temporary dev-build/version changes, run `cd desktop && npm run build`, and verify the artifact signature.

- [ ] **Step 3: Install and launch**

Run the repository-owned `desktop/build/install-local.sh` against the verified artifact, open `/Applications/unmute.app`, and verify the installed version, process stability, and latest startup log.

- [ ] **Step 4: Verify source state and commit any required build metadata**

Run: `git diff --check`, `git status --short`, and `git log --oneline main..HEAD`. Revert temporary build-only flags that the runbook says must not remain committed.

- [ ] **Step 5: Merge into main without disturbing unrelated work**

The main worktree currently contains unrelated user changes. Merge only when Git can preserve those files untouched. Use a non-destructive merge; do not reset, clean, stash, or overwrite user work. Re-run the focused tests from the merged source before reporting completion.

