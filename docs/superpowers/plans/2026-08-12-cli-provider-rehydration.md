# CLI Provider Rehydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each CLI task's provider identity across an Unmute restart so every inactive surface and every resume uses the original provider.

**Architecture:** Repair the shared `TaskManager.rehydrate()` boundary rather than individual renderers. Rehydrated tasks will carry the persisted `agent` and Codex continuation handle before the `created` event reaches Electron, React, or the Swift notch.

**Tech Stack:** TypeScript, Node.js test runner, Electron task lifecycle

## Global Constraints

- The persisted task receipt is the provider source of truth.
- A receipt without `agent` remains Claude for backward compatibility.
- Do not add renderer- or notch-specific provider inference.
- Do not change shutdown, task-state, or desktop-provider behavior.

---

### Task 1: Restore CLI provider identity at rehydration

**Files:**
- Modify: `desktop/electron/remote/task-manager.ts:2737-2894`
- Test: `desktop/electron/remote/task-manager.test.ts`

**Interfaces:**
- Consumes: persisted `meta.agent`, `meta.codexRolloutId`, and `meta.sessionId`
- Produces: a rehydrated `Task` whose `agent` and Codex continuation handle are correct before `created` is emitted

- [x] **Step 1: Write the failing regression test**

Seed a Codex CLI receipt containing `agent: 'codex'` and
`codexRolloutId`, then call the real `TaskManager.rehydrate()`. Assert that the
inactive task reports `agent === 'codex'` and that `resume()` requests a Codex
executor. Add table assertions showing explicit Claude and legacy untagged
receipts still resolve to Claude.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --import ./electron/remote/test-setup.ts --test --test-name-pattern='rehydrate preserves each CLI provider' electron/remote/task-manager.test.ts
```

Expected: failure because the restored Codex task has no `agent` and resume
requests `claude`.

- [x] **Step 3: Implement the minimal repair**

Extend the receipt type with `codexRolloutId`, and add these fields to the
generic rehydrated task:

```typescript
agent: meta.agent ?? 'claude',
...(meta.codexRolloutId ? { codexRolloutId: meta.codexRolloutId } : {}),
```

- [x] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all matching tests pass.

- [x] **Step 5: Verify shared consumers and the full suite**

Run:

```bash
npm test
npm run typecheck
```

Expected: tests pass; typecheck introduces no new errors beyond any documented
baseline errors.

- [ ] **Step 6: Commit the isolated repair**

```bash
git add docs/superpowers/specs/2026-08-12-cli-provider-rehydration-design.md \
  docs/superpowers/plans/2026-08-12-cli-provider-rehydration.md \
  desktop/electron/remote/task-manager.ts \
  desktop/electron/remote/task-manager.test.ts
git commit -m "fix(remote): preserve CLI provider across restarts"
```
