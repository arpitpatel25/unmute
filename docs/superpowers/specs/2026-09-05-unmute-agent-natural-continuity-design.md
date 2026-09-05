# Unmute Agent natural continuity — design

## Outcome

People describe work they want to continue. They do not need to choose or
understand provider sessions. The Unmute Agent finds the relevant prior work
and selects one precise operation:

- **resume** one exact provider conversation;
- **fork** one exact provider conversation into an independent child;
- **synthesize** relevant context from several conversations or another
  provider into a new conversation;
- **fresh** when no prior context applies or the person asks to start clean.

This applies only to work initiated through the Unmute Agent. Ordinary task
creation and the right-Option task path keep their existing behavior.

The interactive companion is
[`unmute-agent-continuity-architecture.html`](../../../unmute-agent-continuity-architecture.html).

## Identity contract

Unmute task-card identity and provider conversation identity are separate.
A new card may be required to display an existing provider conversation, but
that must not create a new provider conversation.

| Operation | Source provider ID | Result provider ID | User turn |
|---|---|---|---|
| Resume | exact, validated | identical to source | optional; exact current request |
| Reopen | exact, validated | identical to source | none |
| Fork | exact, validated | child returned by provider | optional; exact current request |
| Synthesize | one or more exact sources | new provider ID | current request, separate from background |
| Fresh | none | new provider ID | current request |

No runtime layer may silently replace one operation with another. In
particular, resume must never become fork, and an omitted intent must never
become “Continue from where we left off.”

## Provider operations

Claude uses its structured print-mode transport, not a terminal UI:

- resume: `--resume SOURCE_ID`
- fork: `--resume SOURCE_ID --fork-session`; the child ID is distinct

Codex uses the existing app-server connection, not a terminal UI:

- resume: `thread/resume { threadId: SOURCE_ID }`
- fork: `thread/fork { threadId: SOURCE_ID }`; use the returned child thread ID

The Codex app-server response is authoritative. For a fork, persist both the
child thread ID and `forkedFromId`. Never guess a child from rollout mtime.

## Continuation decision

The Unmute Agent prompt teaches a small policy:

1. One strong same-provider match and the person wants the same conversation:
   resume it.
2. The same session already has an Unmute card: wake that card and deliver the
   current request there.
3. The person asks for an alternative, branch, or preserved original: fork it.
4. Several sessions are relevant, providers differ, or inherited history is
   too large to be useful: create a synthesized continuation.
5. No relevant source, or the person asks for a clean start: create fresh.

High-confidence matches act automatically. If several are close, use the
closest compatible sources and say that other related work existed. Ask one
short clarification only when competing matches imply materially different
targets or consequences.

## MCP contract

`session_resume` and `session_fork` are separate tools. Both take a full exact
provider session ID and an optional intent. Each returns:

```ts
{
  taskId: string
  operation: 'resume' | 'fork'
  sourceSessionId: string
  sessionId: string
}
```

For resume, `sessionId === sourceSessionId`. For fork, they must differ.

`task_create` remains the fresh/synthesis primitive. It gains:

```ts
{
  intent: string
  context?: string
  sourceSessions?: Array<{ sessionId: string; provider: 'claude' | 'codex' }>
  artifacts?: Array<{ kind: 'file' | 'url' | 'identifier'; value: string; label?: string }>
  cwd?: string
  kind: 'oneoff' | 'session'
  provider?: ProviderId
}
```

`intent` remains the person’s current request. `context` is bounded background,
not instructions. Sources and artifacts are validated and persisted as
provenance; they are not flattened into prose or exposed as bare IDs to the
receiving model.

## Runtime boundaries

A shared continuation service owns locate, resume, fork, scratch-directory
recovery, card creation, provenance, and provider dispatch. Both the in-process
MCP adapter and daemon runtime host call this service. This removes the two
currently duplicated implementations in `remote/init.ts`.

TaskManager exposes explicit operations for attaching an existing provider
session and forking one. `dispatch()` remains the fresh-task primitive.

CodexHub gains `forkThread()`. It uses `thread/fork`, registers the returned
thread exactly once, hydrates copied history, and then starts a turn only when
an intent was supplied.

Claude’s existing structured fork is retained. Exact resume creates or updates
an Unmute task record pinned to the source session ID and starts the structured
driver with `resume: true`.

## Finding and synthesizing work

Raw Claude and Codex transcripts remain the source of truth. Natural matching
uses a deterministic, incrementally refreshed projection of cheap facts:

- full provider session ID and harness;
- cwd/project, timestamps, and session title/opening request;
- user-turn text suitable for lexical search;
- artifact references (files, URLs, document/sheet IDs);
- parent/fork provenance when available.

There is no periodic model-generated sweep. The Agent may use Glob/Grep/Read
for full-fidelity fallback. Synthesis is written on demand from selected source
transcripts and capped by the existing context budget.

A synthesis packet contains decisions, constraints, completed work, current
state, unresolved items, and exact artifact references. It excludes complete
transcripts and unrelated material.

## Failure behavior

- Unknown or truncated source ID: refuse; never prefix-match.
- Missing user-owned cwd: refuse resume/fork and explain the missing folder.
- Missing Unmute-owned scratch cwd: recreate it.
- Provider returns a different ID on resume: fail closed.
- Provider returns the source ID on fork: fail closed.
- Source already active: wake the existing card; do not duplicate ownership.
- Native fork unavailable: report failure; never fall back to fresh.
- Synthesis source cannot be read: omit it only if other sources still satisfy
  the request and report that omission; otherwise ask for direction.

## User-facing provenance

The task card stays quiet. A synthesized or forked task may show “Continued
from earlier work” with expandable details. Exact internal session IDs are for
diagnostics, not primary UI copy.

Persist `continuationMode`, source provider IDs, confidence, and artifact
references in task metadata so behavior survives app restarts and can be
audited without reading prompts.

## Acceptance criteria

- Exact Claude and Codex resumes preserve provider IDs.
- Claude and Codex forks call their native fork mechanisms and persist the
  provider-returned child IDs.
- Reopen without intent submits no user turn.
- Existing active cards receive follow-ups without duplicate tasks.
- Same-provider, cross-provider, and multi-source decisions follow the policy.
- Synthesis preserves exact artifacts while bounding prose context.
- Prompt and MCP evals distinguish resume, fork, synthesis, and fresh work.
- No terminal, PTY, terminal-output parsing, or synthetic continuation prompt
  is introduced.

