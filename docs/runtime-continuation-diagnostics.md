# Continuation confirmation and diagnostics

## 2026-09-10 field diagnosis and recovery

The job-listing task `35085ff1-08ed-4390-93dc-b249e6091941` retained parent
`01a08661-ed02-79a1-84e0-7bc476aac6fd` in both `sessionId` and `codexRolloutId`.
Its continuity-v4 fork receipt instead records child
`01a08681-5ffb-7410-a8e6-628443caf4f6`. The child's rollout also records this
parent, and contains the later work and a completed turn. The parent and child
are not interchangeable.

The surviving v4 runtime's log repeatedly reports an active-writer conflict on
the **parent**, including 2026-09-09 22:01:07 UTC. This was not merely a wrong
worker-generation route: Unmute reached v4 but supplied the stale thread ID.
The installed GUI had canonical-identity recovery code, but the surviving
runtime did not implement `codex.identity`; both advertised protocol version 4.
A GUI restart cannot replace code already loaded by a persistent process.

The upgrade now reads durable identity in the client as well. Task-specific
canonical records win; legacy non-operation forks use the exact hash of task ID,
source ID and operation kind. Anonymous receipts and transitive fork chains are
never adopted automatically: a different card can have forked the same source.
For this job, the verified receipt, edit backup, rollout and successful exact-child
attachment establish the explicit canonical migration. Contradictions fail closed.
No cwd/newest-file guessing is used. Normal task rehydration persists the repair.

Two additional registration defects are regression-tested:

- A live old runtime could acknowledge resume based on task ID while still
  bound to a different thread. New hubs compare thread IDs in the shortcut.
  Mismatched idle bindings are retired atomically using `codex.releaseIdle`
  before attachment, so old parent notifications cannot update the child card.
  Busy/blocked bindings and older workers without safe retirement fail closed.
  The client verifies the snapshot identity after attachment. The real old job
  had no registered binding, so its recovery needs no new retirement API.
- A resumed child must retain its saved fork ancestry. A stale parent resume is
  rejected before acquiring its writer, not only when saving identity afterward.

On this machine, an exact-child resume against the original surviving v4 daemon
succeeded: task state `done`, history `ready`, 619 blocks, follow-up gate `idle`.
No prompt, provider fork, or provider-process restart was submitted for this
recovery. This establishes the job's root cause and recoverability; it does not
establish that every historical disconnection had that cause.

History pagination is a separate boundary: `loadOlderMessages` previously only
increased an in-memory display limit. It now retries a failed/partial/missing
history load through the read-only history path. Tests verify that retry and
ordinary ten-message pagination. Both the job and lifetime task have readable
rollouts. Native UI verification remains separate from these backend checks.

New development events: `durable-client-identity-recovered`,
`runtime-resume-requested`, `runtime-resume-verified`, and
`stale-thread-patch-ignored`. Existing older daemons retain their older logging;
the upgraded GUI supplies recovery-boundary logging without terminating work.

The current router includes continuity-v4 (the older deployment notes below
describe the earlier v3 rollout). Message editing stays disabled for Codex and
Claude. Deliberate user removals are not undone, and completed prompts are never
automatically replayed.

## Fork identity is separate from history

The provider's exact `thread/fork` child/source pair is written to the worker's
durable receipt before loading or projecting history. The UI adapter returns
the identity without replaying every worker's snapshot. The task manager saves
and publishes that identity, then requests only that task's history.

If acknowledgement is lost, `codex.forkResult(taskId, sourceId)` queries the same
operation. It never invokes a new provider fork. A receipt can be read while
history is still loading and after a worker restart. Replaying the same worker
operation with a receipt resumes its existing child, not another fork.

History refresh failure leaves the confirmed card and child intact and exposes
a retryable history error. Unconfirmed operations remain subject to the existing
deduplication and unpublished-card protections. No automatic extra user prompt
is sent. No existing cards, provider histories or live processes are deleted.

## Logs

- GUI: `~/.unmute/remote/logs/remote-*.log` (existing sink).
- Worker: `<runtime-root>/logs/remote-runtime-<pid>-<time>.log`. This includes
  the main `persistent-runtime` root and versioned compatibility-worker roots
  under the app's user-data directory.
- Worker file writes are synchronous so records already emitted are not held in
  a userspace stream buffer when a worker exits. Disk failure, OS failure or a
  kill before an event reaches Unmute cannot be guaranteed away.
- Log files are created with owner-only permissions.

Useful events and correlation fields:

| Boundary | Events | Correlation |
| --- | --- | --- |
| Agent request | `agent-request-enqueued`, `agent-interaction-activity`, `agent-request-completed` | submission, interaction, run and provider session IDs |
| Agent MCP tools | `agent-tool-started`, `agent-tool-completed`, `mcp-tool-rejected` | call, run and interaction IDs; tool; duration; outcome |
| Native provider tools | Claude `tool-call` / `tool-result`; Codex `agent-provider-item` | provider, session, turn/item or tool-use ID |
| UI handoff | `agent-host-request-*`, `agent-host-response-undelivered` | request ID and method |
| Continuation | `continuation-requested`, `continuation-retry-deduplicated`, `continuation-result-persisted`, `continuation-failed` | interaction, operation and source/child IDs |
| Fork recovery | `codex-fork-identity-confirmed`, `fork-confirmation-recovery-started`, `fork-confirmation-recovered`, `task-history-refreshed`, `fork-history-refresh-failed` | task and exact source/child IDs |
| Transport | `runtime-request-*`, `runtime-connected`, `runtime-disconnected`, `runtime-socket-error`, `runtime-frame-*` | endpoint, connection/request IDs, frame byte counts, durations |

New audit records exclude prompts, raw tool arguments/results, environment
variables and credentials. Error records keep type/code, message fingerprint
and call sites, not potentially sensitive error text. A JSON parse failure and
an event-consumer exception have distinct events; a consumer exception no longer
destroys the connection and rejects unrelated requests.

## Deployment and limits

These are source changes, not a live worker patch. New forks route to
`persistent-runtime/continuity-v3`; the main worker and `continuity-v2` retain
their existing tasks. The router requires both `codex.forkResult` and
`codex.targetedSnapshot` before allowing a new fork. No old worker is killed to
enable this. Existing workers keep their loaded code until safely replaced.
In particular, a GUI-only relaunch cannot enable worker-side Agent logging in
an older Agent owner. During the next build and installation, verify
`runtime.info` and the Agent owner's file log; upgrade the Agent owner only at
a safe idle boundary, preserving its stored conversation. Do not kill active
sessions just to upgrade logging.

Previously created orphaned children and old loading cards are not automatically
removed by this change. The historical socket-close cause remains unproven;
these diagnostics distinguish future parser, callback, timeout and socket errors.
