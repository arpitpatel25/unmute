# Session Continuity Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude and Codex task continuation reliable and invisible across app/runtime restarts while disabling unsafe message editing.

**Architecture:** Preserve the existing detached runtime and task-manager architecture. Add durable Codex server/identity recovery at its existing boundaries, read history from durable files without acquiring a writer, and serialize UI restoration behind startup reconciliation.

**Tech Stack:** Electron, TypeScript, Node test runner, Swift notch client, Codex app-server JSON-RPC, filesystem-backed runtime records.

**Spec:** `docs/superpowers/specs/2026-09-10-session-continuity-hardening-design.md`

## Global Constraints

- Existing task IDs remain stable.
- No provider input may be replayed during recovery.
- No second Codex writer may start while a recorded healthy owner exists.
- History viewing cannot require provider writer ownership.
- Message editing is disabled for Claude and Codex.
- Lifecycle diagnostic logs are gated off in production and never contain prompt text, credentials, environment values, or attachment content.
- Existing unrelated work and baseline test failures remain untouched.

---

### Task 1: Disable message editing across providers

**Files:**
- Modify: `desktop/electron/remote/task-manager.ts`
- Modify: `desktop/electron/remote/init.ts`
- Test: `desktop/electron/remote/claude/task-integration.test.ts`
- Test: `desktop/electron/remote/notch/notch-controller.test.ts`

**Interfaces:**
- Produces: `canEditLatestMessage(id): false` while editing is disabled.
- Produces: edit submissions fail closed without invoking Claude or Codex fork APIs.

- [ ] Write tests proving both provider task types expose no edit affordance and direct edit requests cannot mutate provider state.
- [ ] Run the focused tests and verify they fail because editing is currently enabled.
- [ ] Add one disabled-by-default message-edit gate at the task-manager boundary and remove the edit capability advertisement from the runtime.
- [ ] Run the focused tests and verify they pass.
- [ ] Commit the change.

### Task 2: Recover canonical Codex identity

**Files:**
- Create: `desktop/electron/remote/runtime/codex-identity.ts`
- Create: `desktop/electron/remote/runtime/codex-identity.test.ts`
- Modify: `desktop/electron/remote/runtime/codex-service.ts`
- Modify: `desktop/electron/remote/runtime/codex-client.ts`
- Modify: `desktop/electron/remote/runtime/codex-routing.ts`
- Modify: `desktop/electron/remote/runtime/main.ts`
- Modify: `desktop/electron/remote/task-manager.ts`
- Test: `desktop/electron/remote/task-manager-continuity.test.ts`

**Interfaces:**
- Produces: `CodexHub.recoverIdentity(taskId, sourceThreadId): Promise<{threadId:string; forkedFromId?:string}|null>`.
- Produces: a per-task canonical identity record written before fork success is returned.

- [ ] Write tests for durable identity recovery, stale metadata repair, and contradiction fail-closed behavior.
- [ ] Run them and verify the missing recovery API/behavior fails.
- [ ] Persist canonical identity alongside fork receipts and expose it through the runtime/router/client.
- [ ] Reconcile task metadata before Codex history, resume, or submission and persist any proven repair atomically.
- [ ] Run focused identity and continuity tests.
- [ ] Commit the change.

### Task 3: Adopt or fence the Codex app-server owner

**Files:**
- Create: `desktop/electron/remote/codex/app-server-owner.ts`
- Create: `desktop/electron/remote/codex/app-server-owner.test.ts`
- Modify: `desktop/electron/remote/codex/app-server-client.ts`
- Modify: `desktop/electron/remote/runtime/codex-service.ts`
- Test: `desktop/electron/remote/codex/app-server-client.test.ts`

**Interfaces:**
- Produces: durable `{pid, port, generation}` ownership descriptor per persistent-runtime root.
- Produces: app-server startup that adopts a verified healthy owner, clears a proven stale record, or refuses a live unverified owner.

- [ ] Write tests proving a healthy existing owner is adopted without spawn, a stale owner is replaced once, and a live unreachable owner blocks replacement.
- [ ] Run them and verify current startup always spawns.
- [ ] Add atomic ownership storage and verified process/health checks.
- [ ] Add app-server adoption and reconnect behavior; clear only the matching ownership generation on deliberate stop/exit.
- [ ] Run focused ownership, app-server, runtime, and routing tests.
- [ ] Commit the change.

### Task 4: Read history without resuming

**Files:**
- Modify: `desktop/electron/remote/task-manager.ts`
- Test: `desktop/electron/remote/task-manager-history.test.ts`
- Test: `desktop/electron/remote/codex/blocks-rollout.test.ts`

**Interfaces:**
- Produces: `loadBlocksFor(id, retry)` that reads Claude frames or Codex rollouts without calling provider resume.

- [ ] Write a regression test where Codex resume would throw an active-writer conflict but complete rollout history still loads.
- [ ] Run it and verify the current history path fails.
- [ ] Route Codex history loading through the rollout parser and durable conversation fallback only.
- [ ] Run focused history tests.
- [ ] Commit the change.

### Task 5: Serialize startup restoration and settle provider truth

**Files:**
- Modify: `desktop/electron/remote/task-manager.ts`
- Modify: `desktop/electron/remote/init.ts`
- Test: `desktop/electron/remote/task-manager-orphan-settle.test.ts`
- Create: `desktop/electron/remote/task-manager-startup-recovery.test.ts`

**Interfaces:**
- Produces: `beginStartupRecovery()` and `completeStartupRecovery()` barrier methods.
- Produces: single-flight restoration with bounded failure cooldown.
- Produces: rollout settlement for interrupted/failed rehydrated tasks when completion is provable.

- [ ] Write tests proving early repeated opens wait and coalesce, failed opens do not loop, and a rehydrated failed task settles from its rollout.
- [ ] Run tests and verify current behavior retries or refuses settlement.
- [ ] Add the startup barrier, restoration single-flight/cooldown, and exact lifecycle state logs.
- [ ] Reconcile Codex/Claude runtime snapshots before completing the barrier.
- [ ] Broaden rollout settlement only where terminal provider evidence is conclusive and persist status/meta consistently.
- [ ] Run focused startup and settlement tests.
- [ ] Commit the change.

### Task 6: Development lifecycle diagnostics and complete verification

**Files:**
- Create: `desktop/electron/remote/session-lifecycle-devlog.ts`
- Create: `desktop/electron/remote/session-lifecycle-devlog.test.ts`
- Modify: lifecycle call sites in `desktop/electron/remote/task-manager.ts`, `desktop/electron/remote/runtime/*.ts`, and `desktop/electron/remote/codex/app-server-client.ts`

**Interfaces:**
- Produces: gated structured lifecycle logging with task/session/operation/owner correlation and safe enumerated outcomes.

- [ ] Write tests proving logs are disabled by default and sensitive/free-form fields are rejected or redacted.
- [ ] Run them and verify the logger does not exist.
- [ ] Implement the dev-only logger and instrument startup, identity, ownership, history, restoration, and settlement boundaries.
- [ ] Run all focused lifecycle tests, TypeScript checks, native Swift tests, and the complete desktop suite; record unrelated baseline failures separately.
- [ ] Commit production code with the logging gate off.
- [ ] Use `unmute-test-build`: select a unique dev version, copy `.env.dev`, enable all test-build logging gates only in the build working tree, run the full signed/notarized build, restore logging source flags, install, verify version/team signature, and launch.
