# Provider Monitoring Architecture

## Goal

Keep task state and transcript updates immediate while making monitoring cost depend on live runtimes and actual file changes, not on the number or age of stored tasks.

## State model

Monitoring keeps four signals separate:

- runtime existence: whether a provider process/session still exists;
- turn state: processing, waiting, done, or errored;
- transcript delta: newly appended provider output;
- human-blocked state: approval, permission, or question waiting for the user.

No UI state may infer “working” solely from a stored runtime id or stale processing metadata.

## Event-first provider behavior

- Claude CLI: lifecycle hooks and PTY activity are authoritative; transcript file events refresh conversation content; reconciliation is a slow fallback.
- Codex CLI: app-server notifications are authoritative when available; rollout file events cover fallback sessions; reconciliation is a slow fallback.
- Claude Desktop: shared session-store and transcript file events are primary; Accessibility inspection is limited to active or ambiguous sessions.
- Codex Desktop: rollout file events are primary; CDP/sidebar inspection is limited to active or ambiguous sessions.

Watcher events are debounced for 120–150 ms and scheduled immediately. A missed watcher cannot leave state permanently stale because the shared reconciliation scheduler remains active.

## Shared reconciliation scheduler

Replace one interval per task with one scheduler. It serializes work per task, coalesces repeated triggers, and selects the next check from task/provider state:

- active or ambiguous task: 30 seconds;
- idle persistent runtime: 60 seconds;
- dormant external session: 5 minutes;
- finished one-off without a runtime: no polling.

Tests may override these intervals with the existing short `pollMs` option.

Opening a task, a provider file event, app activation, and system wake all trigger immediate reconciliation.

## Change-sensitive reads

Provider JSONL readers keep file identity, byte offset, size, partial trailing line, and cached content. They read only appended bytes. A complete read is allowed only on initial load, truncation, rotation/replacement, or explicit recovery. Unchanged files do no parsing work.

Claude Desktop session discovery is cached and invalidated by a shared store watcher so every task does not recursively rescan the entire provider store.

## Safety and compatibility

- Existing provider-specific state transitions, persistence rules, hooks, app-server behavior, and UI contracts remain unchanged.
- Watchers are accelerators, not the only correctness mechanism.
- File deletion, truncation, inode replacement, sleep/wake, and watcher failure fall back to a complete recovery read.
- Monitoring resources are removed when tasks are killed/removed and on manager shutdown.

## Acceptance criteria

- A provider file change is reflected after the watcher debounce, without waiting for fallback reconciliation.
- Missing a watcher event self-heals at the next reconciliation.
- The number of interval timers is constant as tasks grow.
- Unchanged completed tasks perform no transcript parsing.
- Appended-file bytes read are proportional to the append; truncation/rotation recovers correctly.
- Existing Claude CLI, Codex CLI, Claude Desktop, and Codex Desktop behavior tests remain green.
