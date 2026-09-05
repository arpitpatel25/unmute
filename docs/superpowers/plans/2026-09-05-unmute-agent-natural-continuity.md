# Unmute Agent Natural Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Unmute Agent choose and execute identity-correct resume, fork, synthesis, or fresh continuation without exposing session mechanics to the user.

**Architecture:** A shared continuation service maps semantic operations onto provider-native structured transports. Explicit MCP verbs enforce identity invariants; TaskManager and CodexHub attach or fork exact provider conversations, while `task_create` carries bounded multi-session context and durable provenance.

**Tech Stack:** TypeScript, Electron main process, Node test runner, Claude stream-json transport, Codex app-server JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-09-05-unmute-agent-natural-continuity-design.md`

## Global Constraints

- Resume preserves the exact provider session/thread ID.
- Fork passes the exact source ID and persists the provider-returned child ID.
- An omitted intent submits no user turn.
- Synthesis is the only continuation mode that intentionally creates a blank provider session from multiple or cross-provider sources.
- No terminal UI, PTY, or terminal-output parsing may be added.
- Existing Unmute Agent persona, MCP authorization, memory, and lifecycle behavior remain intact.

---

### Task 1: Split continuation semantics at the MCP boundary

**Files:**
- Modify: `desktop/electron/remote/agent/capabilities/sessions.ts`
- Modify: `desktop/electron/remote/agent/capabilities/sessions.test.ts`
- Modify: `desktop/electron/remote/agent/sessions/resume.ts`
- Modify: `desktop/electron/remote/agent/sessions/resume.test.ts`

**Interfaces:**
- Produces: `SessionAdapters.resume`, `SessionAdapters.fork`, and operation-specific result identities.
- Produces: pure `planResume` and `planFork` decisions with no synthetic intent.

- [ ] Write failing tests proving unowned resume stays resume, fork is explicit, absent intent stays absent, and result identity invariants are returned.
- [ ] Run the two focused test files and confirm the old fork-on-resume expectations fail.
- [ ] Add `session_fork`, split adapter methods, remove `REOPEN_INTENT`, and make plans operation-specific.
- [ ] Run focused tests and confirm both capability and planner suites pass.
- [ ] Commit as `feat: separate agent resume and fork semantics`.

### Task 2: Implement exact provider operations in the structured runtime

**Files:**
- Modify: `desktop/electron/remote/codex/hub.ts`
- Modify: `desktop/electron/remote/codex/hub.test.ts`
- Modify: `desktop/electron/remote/task-manager.ts`
- Modify: `desktop/electron/remote/task-manager.test.ts`
- Modify: `desktop/electron/remote/claude/task-session.test.ts`

**Interfaces:**
- Produces: `CodexHub.forkThread(taskId, sourceThreadId, options)` returning the child thread ID.
- Produces: TaskManager exact attach/resume and native fork entry points.

- [ ] Write failing CodexHub tests asserting `thread/fork` receives the exact source and registers only the returned child.
- [ ] Implement `forkThread` by sharing thread registration/history hydration with start/resume.
- [ ] Write failing TaskManager tests: external Claude resume pins source ID; external Codex resume calls only `thread/resume`; forks preserve source provenance and accept provider child IDs.
- [ ] Implement explicit attach/fork methods without routing through fresh `dispatch()` semantics.
- [ ] Run the focused hub, manager, and Claude structured-session tests.
- [ ] Commit as `feat: execute native structured session continuity`.

### Task 3: Centralize Unmute Agent continuation wiring

**Files:**
- Create: `desktop/electron/remote/agent/sessions/service.ts`
- Create: `desktop/electron/remote/agent/sessions/service.test.ts`
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/electron/remote/runtime/agent-service.ts`
- Modify: `desktop/electron/remote/runtime/agent-client.ts`

**Interfaces:**
- Produces: `AgentContinuationService.resume()` and `.fork()` used by both local and persistent-runtime adapters.

- [ ] Write service tests for existing-card wake, external exact attach, explicit fork, scratch recovery, missing cwd, and provider identity mismatch.
- [ ] Implement the shared service around `locateSession` and TaskManager’s operation-specific methods.
- [ ] Replace both duplicated `remote/init.ts` adapters with the service.
- [ ] Add runtime RPC for fork and operation-rich results; keep resume backward compatible for queued calls.
- [ ] Run the service, runtime, and agent capability tests.
- [ ] Commit as `refactor: centralize agent continuation execution`.

### Task 4: Add durable multi-session synthesis provenance

**Files:**
- Modify: `desktop/electron/remote/agent/capabilities/handoff.ts`
- Modify: `desktop/electron/remote/agent/capabilities/handoff.test.ts`
- Modify: `desktop/electron/remote/task-manager.ts`
- Modify: `desktop/electron/remote/task-manager.test.ts`

**Interfaces:**
- Produces: validated `sourceSessions`, `artifacts`, and `cwd` on `task_create`.
- Produces: persisted `continuationMode`, sources, and artifacts on task metadata.

- [ ] Write failing schema tests for source count, exact IDs, providers, artifact kinds, length bounds, and invalid cwd.
- [ ] Extend `task_create` while keeping intent and background context separate.
- [ ] Persist provenance as task metadata and keep it out of the user-visible prompt body.
- [ ] Build the receiving prompt from background context plus current request; preserve artifact values losslessly.
- [ ] Run handoff and task metadata tests.
- [ ] Commit as `feat: preserve synthesized continuation provenance`.

### Task 5: Teach and evaluate the natural decision policy

**Files:**
- Modify: `desktop/electron/remote/agent/constitution.ts`
- Modify: `desktop/electron/remote/agent/constitution.test.ts`
- Modify: `desktop/electron/remote/agent/evals/corpus.ts`

**Interfaces:**
- Consumes: distinct `session_resume`, `session_fork`, and enriched `task_create` tools.

- [ ] Add prompt contract tests that forbid fork language under resume and forbid the removed synthetic continuation prompt.
- [ ] Rewrite only the past-work continuation paragraphs with the approved decision ladder.
- [ ] Add eval cases for exact follow-up, reopen-only, alternate branch, cross-provider continuation, several related sessions, oversized history, and no match.
- [ ] Run constitution tests and the smallest available eval harness subset.
- [ ] Commit as `feat: teach agent natural work continuity`.

### Task 6: Focused integration verification

**Files:**
- Modify only if a focused test exposes a defect in Tasks 1–5.

**Interfaces:**
- Verifies all spec acceptance criteria.

- [ ] Run the focused session capability, planner, continuation service, CodexHub, TaskManager, handoff, provider-contract, and constitution suites.
- [ ] Run TypeScript compilation for the desktop Electron package.
- [ ] Inspect `git diff --check`, commit history, and worktree status; do not stage pre-existing local validation/design files other than this feature’s approved documents.
- [ ] Record any unverified manual behavior in the existing local validation note without committing that note.
