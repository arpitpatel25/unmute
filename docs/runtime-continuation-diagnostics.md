# Continuation confirmation and diagnostics

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
