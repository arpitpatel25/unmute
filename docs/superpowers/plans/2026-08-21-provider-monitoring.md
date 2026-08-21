# Provider Monitoring Implementation Plan

> Approved design: `docs/superpowers/specs/2026-08-21-provider-monitoring.md`

**Goal:** Replace per-task full-file polling with shared adaptive reconciliation plus provider-native change events, without changing task semantics.

**Architecture:** A single scheduler owns fallback reconciliation. Provider hooks/app-server notifications/file watchers trigger the same serialized poll functions immediately. A reusable append-aware file cache prevents unchanged/full-file rereads, while a shared Claude Desktop store cache prevents recursive discovery per task.

**Tech stack:** Electron, Node.js, TypeScript, `node:test`.

---

### Task 1: Shared scheduler

**Files:**
- Create: `desktop/electron/remote/reconcile-scheduler.ts`
- Test: `desktop/electron/remote/reconcile-scheduler.test.ts`
- Modify: `desktop/electron/remote/task-manager.ts`

1. Add failing tests for constant timer count, per-key serialization, immediate trigger coalescing, adaptive rescheduling, and unregister.
2. Implement the minimal scheduler.
3. Replace `TaskManager`'s per-task interval map while preserving task enumeration and cleanup behavior.

### Task 2: Append-aware provider files

**Files:**
- Create: `desktop/electron/remote/append-file-cache.ts`
- Test: `desktop/electron/remote/append-file-cache.test.ts`
- Modify: `desktop/electron/remote/task-manager.ts`
- Modify: `desktop/electron/remote/codex/rollout.ts`

1. Add failing tests for unchanged, append, partial line, truncation, and replacement behavior.
2. Implement offset/inode-aware reads and recovery.
3. Route transcript/block refresh through the cache and skip parsing when unchanged.

### Task 3: Event-first task reconciliation

**Files:**
- Modify: `desktop/electron/remote/task-manager.ts`
- Modify: `desktop/electron/remote/claude-desktop/driver.ts`
- Modify: `desktop/electron/remote/claude-desktop/sessions.ts`
- Test: `desktop/electron/remote/task-manager.test.ts`

1. Add failing tests proving a watcher event triggers immediate refresh and a missed event self-heals.
2. Attach CLI transcript/rollout watchers, reuse desktop watchers, and route all callbacks through scheduler triggers.
3. Cache Claude Desktop discovery and invalidate it from one shared store watcher.

### Task 4: Lifecycle wakeups and provider policies

**Files:**
- Modify: `desktop/electron/remote/task-manager.ts`
- Modify: `desktop/electron/remote/init.ts`
- Test: `desktop/electron/remote/task-manager-liveness.test.ts`

1. Add failing tests for finished one-offs not being scheduled and dormant external sessions using the slow interval.
2. Add task/provider interval policy and public immediate reconciliation for app activation/system wake.
3. Wire activation/wake events and verify cleanup.

### Task 5: Verification and commit

1. Run focused red/green tests throughout.
2. Run the complete desktop test suite.
3. Run both TypeScript typecheck projects.
4. Inspect the diff for unrelated functional changes and commit once with a descriptive message.
