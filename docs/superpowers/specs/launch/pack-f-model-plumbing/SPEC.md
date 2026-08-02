# Pack F — Model on the task

**Branch:** `arpit/launch-model-plumbing`
**Owns:** `desktop/electron/remote/task-manager.ts`, `desktop/electron/remote/init.ts`, `desktop/engine-overrides/renderer/remote/useRemoteTasks.ts`
**Blocks:** Pack C — the Orchestrator UI renders this field
**Depends on:** nothing. Start immediately.
**Read first:** `../00-OVERVIEW.md`

---

## 1. What is missing

`RemoteTask` carries `agent`, `provider`, `cwd`, `codexProject`, `kind`, `group` — **and no model**. Every task card can honestly name its backend and cannot name the model that ran it.

The provider side is already solved: `providerOf(t.agent)` is resolved in main from the registry and sent with each task (`init.ts:806`), and the renderer keeps no table of its own. This pack extends the same pattern to the model.

## 2. Decision D6 — the model is a historical fact

**Record it at dispatch. Never derive it at render.**

A task started yesterday under Sonnet must not claim Opus because the picker has moved since. Reading the current setting when drawing a card would produce exactly that lie, and it would be invisible — the card would look right and be wrong.

Consequences:
- `model` is written once, when the task is created.
- It is persisted in `meta.json` alongside `agent`, so it survives restart and rehydrate.
- Nothing re-reads settings to fill it in later.
- A task created before this change has no model. That is correct and must stay correct — see §5.

## 3. Where the value comes from, per backend

| Backend | Source | Notes |
|---|---|---|
| **`claude`** (Claude Code CLI) | the `--model` we passed | Already known at spawn — `executorFactory` in `init.ts` resolves it from settings or `getModels().doerDefault`. Capture it there. |
| **`codex-desktop`** | the Codex app's own axes | The app-server already exposes a model list (`codex/appserver.ts`, `model/list`). Read the active model at task creation. |
| **`claude-code-desktop`** | the app's own catalogue | `claude-desktop/catalog.ts` reads models from the bundle; the AX layer reads the active one. |
| **`codex`** (Codex CLI) | not applicable | Not dispatchable — `isDispatchable()` excludes it. Do not add a path for it. |

**If the model cannot be determined, store nothing.** An absent field is honest; a guessed one is not. Never substitute a default, a settings value, or the string "unknown".

## 4. The changes

### 4.1 `task-manager.ts`
- Add `model?: string` to the `Task` interface, beside `agent`.
- `dispatch()` accepts a model in its options and records it on the task.
- Write it into `meta.json` in the same object that already carries `agent`, `sessionId`, `kind`.
- `rehydrate()` reads it back. A `meta.json` without the key yields `undefined` — not a default.
- The driver-backed creation paths (`dispatchCodexDesktop`, `createClaudeDesktop`) record it too, from their own sources.

### 4.2 `init.ts`
- The dispatch wrapper resolves the model for the chosen backend and passes it through, exactly as it already injects the per-task MCP env.
- Include `model` in the per-task payload sent to the renderer, next to `provider`.

### 4.3 `useRemoteTasks.ts`
- Add `model?: string` to `RemoteTask`, documented in the same style as the `provider` block: what it is, where it is resolved, and **why it is not re-derived**.

## 5. Backward compatibility

Tasks created before this change have no model in their `meta.json`. They must:
- rehydrate without error
- carry `model: undefined`
- render as agent-only in Pack C

**Do not backfill.** There is no way to know what model an old task used, and inventing one is worse than leaving it blank.

## 6. Constraints

- Do not touch anything under `renderer/remote/` except `useRemoteTasks.ts` — Pack C owns the rest.
- Do not touch `renderer/app/**` (Packs A/B).
- Do not change the provider registry. `providers.ts` is not owned by this pack and its ids are an append-only disk format.
- Do not change existing `meta.json` keys. This is additive only; an older engine reading a newer `meta.json` must still work.
- `npm run typecheck` passes. The existing remote tests must pass, including `providers.test.ts`, `codex/lifecycle.test.ts`, `claude-desktop/lifecycle.test.ts`.

## 7. Definition of done

A newly dispatched task carries the model that actually ran it, from dispatch through `meta.json` through restart to the renderer's `RemoteTask`. An old task carries nothing and does not break. No code path derives the model from current settings at render time.
