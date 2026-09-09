# Session Continuity Hardening Design

## Goal

Make task continuity invisible and reliable across application restarts, runtime reconnects, idle eviction, card removal, and provider-process replacement. Opening any existing task must immediately show its durable conversation and either attach to its live provider session or restore that exact session once, without exposing internal attach, detach, or resume mechanics.

## Scope

This change hardens the existing persistent-runtime architecture; it does not replace it. It covers Unmute-managed Claude and Codex sessions, task rehydration, provider identity persistence, conversation-history recovery, automatic restoration, task-state reconciliation, diagnostics, and temporarily disabling message editing for both providers.

## Product Invariants

1. A task ID is stable for the lifetime of the task.
2. Each task has exactly one canonical current provider session ID.
3. Only the persistent runtime owns provider processes and writable provider sessions. The Electron application is a reconnecting client.
4. An application restart never creates a second provider writer while a healthy registered owner exists.
5. Removing an idle task from the pocket is presentation-only. It does not release its session or conversation.
6. Opening a task never creates a new provider session. It joins one in-flight restoration operation for the canonical session.
7. Conversation history is readable without acquiring provider writer ownership.
8. Task outcome (`processing`, `needs-user`, `done`, `failed`) is independent of runtime availability (`live`, `restoring`, `cold`, `unrecoverable`).
9. Internal attach, detach, and resume states are not user-facing. A recoverable task shows its conversation and a neutral loading state while restoration occurs.
10. A provider identity transition is atomic: durable identity receipt and task metadata either agree on the child session or the child is abandoned before further input is accepted.

## Architecture

### Canonical identity reconciliation

The task metadata remains the durable product record. Before tasks become actionable, the task manager asks the persistent runtime for a targeted snapshot containing the runtime's current task-to-provider-session mapping and any durable identity-transition receipt. A pure reconciliation function compares metadata, runtime identity, and receipts. Confirmed provider identities repair stale metadata atomically; ambiguous or contradictory identities fail closed and preserve history without submitting input.

Durable fork receipts remain operation receipts, but rehydration now consumes them as recovery evidence. They can no longer exist only inside the runtime while `meta.json` points at the superseded source.

### Single provider ownership

The persistent runtime is the sole owner of Claude drivers and the Codex app-server. Runtime startup records an ownership generation and provider endpoint. A reconnect adopts the healthy registered server. A replacement server may start only after the old owner is proven absent or explicitly stopped and released. Generation checks fence stale owners from publishing patches after replacement.

Codex active-writer conflicts are treated as ownership-recovery signals, not ordinary retryable resume errors. Recovery first refreshes ownership and targeted runtime state. It never loops `thread/resume` against another live writer. Claude uses the same task-level restoration contract even though its provider process model differs.

### Startup and restoration barrier

Task rehydration has two phases:

1. Load durable task metadata and immediately expose durable conversation history as read-only UI state.
2. Connect to the persistent runtime, obtain its snapshot, reconcile provider identities and task outcomes, then enable submission and restoration.

`opened()` may request restoration only after reconciliation completes. Restoration is single-flight per task and identified by an operation ID. Repeated open/reconcile events join the same promise. Failure uses bounded retries with backoff and then records an exact recoverability reason; it does not continuously retry because the card remains visible.

### History independent of writer attachment

Claude chat frames/transcripts, Codex rollouts, and durable task blocks are loaded directly from disk before provider restoration. A complete Codex rollout parser becomes the fallback when app-server history APIs cannot be used. “Load earlier messages” therefore performs read-only pagination/recovery and never calls `thread/resume`.

### State settlement

Provider events and durable rollouts settle task outcomes independently from executor attachment. Rehydration does not convert a non-terminal task to `failed` merely because the application lacks an in-process executor. The rollout settlement path accepts any recoverable runtime state, resolves the canonical provider identity first, and updates `status.json` and `meta.json` together.

Completed tasks remain continuable. A new follow-up changes the current turn state to `processing`; completion returns it to `done`. Runtime availability is tracked separately and is not rendered as a task error unless recovery is proven impossible.

### Message editing

Editing existing messages is disabled for both Claude and Codex in the product UI and command surfaces. Existing implementation remains behind one feature flag so it can be restored later. New tests assert that no edit affordance or edit IPC operation is available while the flag is off.

Re-enabling editing requires a separate change proving atomic identity transition across fork confirmation, rollback, metadata publication, runtime disconnect, process crash, and application restart.

### Diagnostics

Add a dedicated session-lifecycle development logger, disabled by default in source. The private test build enables it only in the build working tree. Records use task IDs, provider/session IDs, operation IDs, ownership generation, runtime PID/endpoint, state transition, retry count, and deterministic outcome/reason codes. Raw prompts, transcript text, credentials, environment values, and attachment contents are never logged.

Required lifecycle events include startup barrier begin/end, runtime snapshot, identity reconciliation decision, owner adoption/replacement/refusal, restoration requested/joined/succeeded/failed, read-only history source/result, task settlement source/result, and suppressed duplicate UI restoration.

## Failure Handling

- Healthy owner found: adopt it and do not spawn.
- Stale owner record with no live process: clear it atomically and start one replacement generation.
- Live but unreachable owner: fail closed, preserve history and drafts, and expose one actionable recovery error; never create a competing writer.
- Active-writer conflict: refresh ownership and identity once; do not blind-retry.
- Identity receipt newer than metadata: atomically repair metadata before accepting input.
- Contradictory identities without a provable transition: preserve all records and block submission.
- Missing provider process: restore the exact canonical session through one single-flight operation.
- Missing/corrupt history: show the available durable fallback and an exact history diagnostic without starting a provider.

## Testing

Tests are written first and cover:

- App restart with a healthy persistent runtime and live Claude/Codex sessions.
- Runtime reconnect while tasks are idle, processing, needs-user, and done.
- Opening the same card repeatedly during startup produces one restoration.
- An existing Codex writer is adopted or fails closed; no second app-server is spawned.
- Stale owner replacement uses a new generation and fences late events.
- Durable fork receipt repairs stale task metadata.
- Rollback/fork ambiguity never leaves runtime and metadata on different IDs.
- History loads while the provider writer is unavailable or locked.
- Rollout completion settles a task regardless of prior rehydrated state.
- Pocket removal and reopening do not alter session identity.
- Claude and Codex satisfy the same lifecycle contract.
- Edit affordances and operations are disabled for both providers.
- Development logs contain correlation fields and exclude sensitive content.

End-to-end verification includes focused lifecycle suites, the complete desktop test suite, a production-identical signed/notarized private build, installation, signature/version verification, restart testing, and inspection of lifecycle logs.

## Delivery

Work is based on commit `efc3eaf1` in branch `arpit/session-continuity-hardening`. The private build uses the repository `unmute-test-build` procedure: a version above installed/published versions, copied `.env.dev`, temporary development logging flags, the full signed and notarized pipeline, local installation, signature verification, and cleanup of all working-tree-only logging flips.
