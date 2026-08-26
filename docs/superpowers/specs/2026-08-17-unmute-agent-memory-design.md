# Unmute Agent and Personal Memory — design

**Status:** approved for implementation

**Branch:** `unmute-agent-memory-codex`

**Base:** `origin/main` at `d472eb1`

**Date:** 2026-08-17

## 1. Purpose

Unmute Agent is a dedicated, voice-addressed agent that operates Unmute on the
user's behalf. The user selects Claude Code CLI or Codex CLI as its default
provider. Unmute gives that provider a dedicated runtime, Unmute-specific
instructions and context, and authenticated access to a growing set of local
capabilities.

Personal Memory is the first capability built for that Agent. It lets a user
explicitly store arbitrary material and later retrieve or use it through natural
language. Examples include facts, links, files, images, resumes, templates,
writing styles, project vocabularies, and reusable procedures.

Memory is not the Agent's identity and is not embedded into its runtime. It is
one independent domain behind the same capability boundary that will later
expose dictation history, dictionary editing, settings, tasks, groups,
diagnostics, capture, and other Unmute features.

This design is additive. Existing dictation, Instruct, Orchestrator tasks,
provider routing, task observation, capture, and notch behavior remain intact.

## 2. Product principles

### 2.1 The Agent is a general Unmute control plane

The Agent interprets natural language and composes capabilities. It is not a
memory search box and must not acquire memory-specific assumptions in its core.

Adding a future Unmute feature means registering another capability module, not
rewriting the Agent, its provider adapters, or its prompt.

### 2.2 Storage is explicit

Nothing is remembered merely because it appeared in a dictation, task,
clipboard, or conversation. A store or update begins with an intentional user
request such as "remember this," "store this," or "replace my launch template."

No background summarizer, passive surveillance, or automatic profile building
is part of this system.

### 2.3 Retrieval ranges from deterministic to agentic

An exact lookup should feel immediate. Ambiguous or compositional requests may
use the selected coding agent. Both paths live behind the same Unmute Agent
address; the user does not choose a mode.

### 2.4 The session is not the memory

Agent sessions may be resumed for conversational continuity, but durable truth
lives in domain services. A session may compact, crash, expire, or be replaced
without losing memory, recent exchanges, or application state.

### 2.5 Capabilities, not promises, enforce authority

The model receives typed tools for allowed operations. It does not receive a
generic host command, arbitrary access to Unmute internals, or raw memory paths.
The host validates identity, arguments, scope, confirmation, and interaction
liveness before executing a tool call.

### 2.6 The wall remains an attention surface

Instant reads and internal memory writes do not create persistent task cards.
Multi-step or consequential work does. Every card created by the Agent carries
one shared `unmute-agent` origin identity across the wall, pocket, rail, task
stage, and history.

## 3. Scope

### 3.1 First vertical slice

The first usable release includes:

- A separate setting for the user's Unmute Agent provider: Claude Code CLI or
  Codex CLI.
- A dedicated voice address for Unmute Agent, integrated with the existing
  capture machinery without changing ordinary dictation or Orchestrator
  routing.
- Concurrent, isolated Agent runs with provider-neutral lifecycle management.
- A modular authenticated MCP capability registry.
- Personal Memory as the first registered domain.
- Explicit store, search, get, update, forget, restore, attachment-open, and
  attachment-delivery primitives.
- Text, links, local files, and images.
- Natural-language retrieval, including complex queries and retrieval for use
  in a subsequent action.
- A conservative no-model fast path for exact, unambiguous lookups.
- An inspectable "What Unmute keeps" management surface.
- Consistent Unmute Agent identity on consequential task cards.
- Audit events that never log sensitive content.

### 3.2 Designed extension points, not first-release implementations

The architecture supports but the first memory slice does not need to ship:

- Dictionary and vocabulary mutation.
- Dictation retry/copy/history tools.
- Task grouping and group renaming.
- General settings and diagnostics control.
- Semantic embeddings.
- Cloud sync or multi-device replication.
- OCR/transcription for every proprietary media format.
- Automatic workflow extraction from past sessions.

These must be addable as capability modules without changing the Agent core.

### 3.3 Non-goals

- Replacing the current Orchestrator router or TaskManager.
- Merging the historical `arpit/unmute-addressable` branch wholesale.
- Turning ordinary task sessions into privileged Unmute Agents.
- Making a coding-agent conversation the source of durable state.
- Giving the model unrestricted filesystem, database, or application access.
- Indexing raw passwords, tokens, or secrets as searchable plaintext.
- Silently sending messages, submitting forms, or performing irreversible
  external actions.

## 4. System architecture

```text
Voice capture / addressed follow-up
                |
                v
       UnmuteAgentController
       |        |          |
       |        |          +-- AgentJournal
       |        +------------- FastPathRouter
       +---------------------- AgentRunSupervisor
                                      |
                         +------------+------------+
                         |                         |
                 ClaudeCodeProvider          CodexCliProvider
                         |                         |
                         +------------+------------+
                                      |
                            Authenticated MCP
                              CapabilityGateway
                                      |
                   +------------------+------------------+
                   |                  |                  |
              MemoryCapability   Future domains   Existing task MCP
                   |
              MemoryService
             /      |       \
      records   attachments   SQLite/FTS index
```

### 4.1 `UnmuteAgentController`

The controller is the single entry point for an Agent interaction. It:

1. Accepts the transcript, captured attachments, selected text, and an optional
   prior Agent run target.
2. Creates an interaction lease and correlation ID.
3. Attempts a conservative deterministic fast path.
4. Otherwise asks `AgentRunSupervisor` for an isolated logical run.
5. Supplies recent exchange summaries, available capability descriptions, and
   current Unmute context.
6. Streams activity and the final result to the native surfaces.
7. Records a redacted exchange summary outside the provider session.
8. Classifies the outcome as transient internal activity or consequential work
   that should produce or update a task card.

It does not implement domain operations itself.

### 4.2 `AgentProvider`

Both providers implement one interface:

```ts
interface AgentProvider {
  readonly id: 'claude' | 'codex'
  probe(): Promise<ProviderProbe>
  start(input: AgentStartInput): Promise<AgentSession>
  resume(handle: AgentSessionHandle, input: AgentStartInput): Promise<AgentSession>
  interrupt(handle: AgentSessionHandle): Promise<void>
  close(handle: AgentSessionHandle): Promise<void>
}
```

An `AgentSession` exposes streamed events, a final result, and a durable provider
handle. Provider-specific process management and protocol details remain inside
the adapter.

The Agent provider setting is separate from the normal Orchestrator task
provider. Changing it affects new Agent runs only; active runs finish on the
provider that created them.

The adapters should prefer structured, non-interactive protocols over typing
into an interactive TUI. A logical Agent session may be backed by a resumed CLI
conversation, a provider daemon hosting multiple threads, or a short-lived
process. The controller must not depend on which.

### 4.3 `AgentRunSupervisor`

One global coding-agent conversation is forbidden. Multiple unrelated requests
must not share context, stdin, output files, or cancellation.

The supervisor maintains logical runs:

```ts
interface AgentRun {
  id: string
  provider: 'claude' | 'codex'
  providerHandle: string
  state: 'starting' | 'running' | 'waiting' | 'complete' | 'failed' | 'closed'
  createdAt: number
  lastUserAt: number
  lastActivityAt: number
  completedAt?: number
}
```

Rules:

- A new unrelated request receives a new run.
- An explicitly addressed or clearly resolved follow-up resumes the relevant
  recent run.
- Two active requests never share one provider session.
- No request waits behind a busy logical run. The supervisor creates another
  run or reports resource pressure visibly.
- Completed quick runs remain resumable for an initial 15-minute idle window.
- A run is reaped only after its turn has ended and the idle window has passed.
- Waiting-on-user runs are not reaped as completed work.
- Durable exchange summaries survive process cleanup.
- A resource guard limits simultaneously running heavy provider processes. This
  is an implementation safety limit, not a product limit on stored memories or
  total historical Agent runs.

For providers that support many logical threads in one daemon, process count
and run count remain separate concepts.

### 4.4 `AgentJournal`

The journal stores a bounded, redacted record of recent Agent exchanges and run
handles. It exists for pronoun resolution, follow-up routing, recovery, and
provider switching. It is not personal memory and has a short retention policy.

It must not contain attachment payloads, decrypted sensitive values, provider
tokens, or arbitrary model context.

## 5. Capability gateway

### 5.1 One gateway, different principals

The existing local MCP service is extended through a registry rather than
replaced. Authentication resolves a bearer token into a principal:

```ts
type McpPrincipal =
  | { kind: 'task'; taskId: string }
  | { kind: 'unmute-agent'; runId: string; interactionId: string }
```

Ordinary task principals keep their existing restricted tool set. They do not
gain access to personal memory or application-control domains.

The Unmute Agent principal sees tools registered for its role. Its token is
short-lived, scoped to one run and active interaction, and rotated for later
turns. Possessing an old token after the interaction closes grants nothing.

### 5.2 Modular registry

```ts
interface CapabilityModule {
  id: string
  tools(principal: McpPrincipal): readonly ToolDefinition[]
  resources?(principal: McpPrincipal): readonly ResourceDefinition[]
  call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult>
}
```

The gateway aggregates modules for `tools/list` and dispatches calls by module.
Adding dictionary or dictation tools later means registering a module.

There is no generic `unmute_execute(action, args)` escape hatch. Each tool keeps
a discoverable schema, bounded behavior, typed errors, and an auditable policy.

### 5.3 Policy classes

Every operation declares one consequence class:

- `read`: no confirmation for ordinary, non-sensitive data.
- `reversible-write`: allowed during an explicit user interaction; result is
  reported and remains undoable.
- `sensitive-read`: requires an explicit request to reveal or deliver the
  selected item.
- `destructive`: requires confirmation and uses recoverable trash first.
- `external-consequence`: defaults to draft/prepare and stop; sending or
  committing requires explicit confirmation.

The Memory module uses `read` and `reversible-write`; it does not classify
records into separate access tiers. Future modules may reuse the other policy
classes where their external consequences require them.

## 6. Personal Memory domain

### 6.1 One user-facing concept

Users store "things." Internal kinds improve extraction and presentation but do
not create separate products. The initial internal kinds are:

```ts
type MemoryKind =
  | 'note'
  | 'document'
  | 'image'
  | 'reference'
  | 'guidance'
  | 'template'
  | 'credential-ref'
```

`guidance` covers writing style, tone, preferences, and project vocabulary.
`template` covers reusable material with placeholders. The taxonomy is
append-only and must not constrain retrieval; unknown future kinds degrade to a
generic record.

### 6.2 Canonical storage

Canonical records and attachments are the truth. SQLite is a rebuildable
projection.

```text
~/Library/Application Support/Unmute/agent/
  memory/
    records/
      <memory-id>.md.enc
    attachments/
      <sha256>/
        original.enc
        metadata.json
        preview.enc
        extracted.txt.enc
    versions/
      <memory-id>/
        <version-id>.json.enc
    trash/
    index/
      memory.sqlite
    audit/
      access.jsonl
  journal/
  runtime/
```

The `.enc` suffix represents the strong privacy posture: payloads and managed
attachments are encrypted at rest using an application key protected through
macOS Keychain. The SQLite index must use a SQLCipher-compatible encrypted
database keyed through the same application key boundary; a plaintext FTS
database beside encrypted records would defeat the design. There is no
plaintext fallback. Searchable fields are limited to what retrieval needs, and
raw credential/secret values are never written to the FTS index even inside the
encrypted database.

A record contains stable identity, title, canonical content or description,
kind, tags, scope, provenance, timestamps, attachment handles, and external
references.

```ts
interface MemoryRecord {
  id: string
  kind: MemoryKind
  title: string
  content?: string
  tags: string[]
  scope?: { app?: string; project?: string; purpose?: string }
  attachments: string[]
  references: Array<{ type: 'url' | 'path' | 'external'; value: string }>
  provenance: { source: 'voice' | 'selection' | 'attachment' | 'import'; original?: string }
  createdAt: number
  updatedAt: number
  version: number
  deletedAt?: number
}
```

### 6.3 Copy versus reference

- "Store/save/keep this file or image" creates a managed copy.
- "Remember where this is" stores a reference with metadata and a content hash
  when readable.
- URLs store the live URL, metadata, and an optional extracted snapshot.
- Live cloud documents remain references unless the user explicitly requests a
  snapshot.
- Large files, directories, applications, and media default to references and
  explain why.
- Secret values live in Keychain or an encrypted secret store. Memory retains a
  searchable label and opaque handle, never a plaintext indexed secret.

Managed attachments are content-addressed by SHA-256. Multiple memories may
refer to one physical payload. Deleting one memory removes the payload only when
no live or trashed record references it.

### 6.4 Index

SQLite with FTS5 provides lexical retrieval. The initial logical schema has:

- `memories`: identity, kind, title, timestamps, deleted state, and metadata.
- `memory_fts`: memory ID, title, body, tags, extracted text.
- `memory_tags`: normalized tags.
- `attachments`: opaque handle, owning/referring memory IDs, MIME type, hash,
  and extraction status.
- `memory_versions`: version metadata and encrypted snapshot path.

All writes are serialized and transactional:

1. Validate and normalize input.
2. Stage encrypted record and attachments.
3. Begin SQLite transaction.
4. Move staged files atomically into place.
5. Update metadata and FTS rows.
6. Commit.
7. On failure, roll back the database and remove staged files.

On startup, integrity checks may rebuild the index from canonical records. An
index failure never destroys a memory.

The index implementation sits behind a `MemoryIndex` interface so its native
SQLCipher binding and packaging remain isolated from record, attachment, and
retrieval semantics. The binding must be compiled, signed, and exercised in the
same Electron build pipeline as the existing native modules.

Embeddings are deliberately absent in v1. A future ranker may combine vector
results without changing the service or MCP contracts.

### 6.5 Retrieval pipeline

`MemoryService.search` combines:

1. Exact normalized title and alias matches.
2. Exact-value matches for indexed values.
3. FTS5 lexical ranking.
4. Title, tag, app, project, and purpose boosts.
5. Modest recency/use boosts.
6. Deduplication.

It returns compact evidence cards, not full files:

```ts
interface MemorySearchResult {
  id: string
  title: string
  kind: MemoryKind
  snippet: string
  score: number
  attachmentCount: number
  scopes: string[]
}
```

The Agent may perform several searches, inspect selected records with
`memory_get`, and combine evidence for a complex query. Full attachment payloads
are opened only after a record is selected.

### 6.6 Fast path

The controller may answer without a model only when every condition holds:

- The utterance is read-only.
- It matches a conservative retrieval grammar.
- Exactly one record wins above a strict threshold.
- No composition, explanation, delivery, or external action is requested.

Ambiguity or additional intent falls through to the coding agent. The fast path
may decline; it must never guess.

### 6.7 Memory MCP tools

The first module exposes:

- `memory_search(query, kinds?, tags?, scope?, limit?)`
- `memory_get(id, include_content?, include_attachments?)`
- `memory_store(title, content?, attachments?, tags?, scope?)`
- `memory_update(id, patch)`
- `memory_forget(id)`
- `memory_restore(id)`
- `memory_open_attachment(attachment_id)`

`memory_forget` moves the record to recoverable trash and removes it from normal
search. Permanent purge is separate maintenance with an explicit retention
window.

Attachment inputs to `memory_store` are opaque handles minted for the current
capture/selection interaction, never model-supplied filesystem paths.
`memory_open_attachment` returns another short-lived opaque handle, not the
managed path. The Agent composes that handle with a destination capability: the
initial slice supports clipboard/cursor delivery and the existing task-composer
attachment layer. A future email module accepts the same handle through its own
typed tool. Memory therefore never needs to understand email, Slack, Codex, or
any arbitrary destination.

## 7. Retrieval followed by action

Memory does not know how to send email, edit Slack, or control a task. The Agent
composes domains:

```text
"Reply using my Slack style"
  memory_search -> memory_get -> future message/draft capability

"Attach my resume to this email"
  memory_search -> memory_open_attachment -> future email draft capability

"Use the vocabulary for Project Atlas in this Codex task"
  memory_search(scope.project = Atlas) -> memory_get -> existing task draft delivery
```

Until a destination capability exists, the Agent may return the material, copy
it to the clipboard, or dispatch visible work. It must not pretend an action was
completed.

Stored content is untrusted data. A document or web snapshot cannot grant itself
tool authority or override the Agent constitution. Guidance and templates are
treated as instructions only when the user explicitly selects or invokes them.

## 8. Surfaces and identity

### 8.1 Agent activity

The existing native surface shows Agent capture and progress without creating a
permanent card for every lookup. It must distinguish:

- listening to Unmute Agent,
- searching memory,
- thinking through a complex request,
- waiting for confirmation,
- completed transient action,
- consequential work represented by a task card.

### 8.2 Cards

Tasks created or adopted by the Agent carry:

```ts
origin: 'unmute-agent'
agentRunId: string
```

One shared renderer helper derives the Unmute badge and provenance copy. Native
and React surfaces receive the same wire fields; neither infers origin from a
name or provider.

### 8.3 Memory management

"What Unmute keeps" shows records, types, scopes, attachment presence, source,
update time, versions, trash, and delete/restore controls. It is an audit and
management surface, not a text-based alternative to speaking to the Agent.

## 9. Failure behavior

- Provider unavailable: explain which selected provider is unavailable and
  offer the existing setup route. Never silently switch providers for a
  privileged Agent run.
- Agent run crashes: preserve the interaction and allow retry in a fresh run.
- MCP tool validation fails: return a typed, corrective error to the same run.
- Interaction token expires: reject the mutation and ask the user to retry.
- Ambiguous retrieval: return candidates or ask one precise question.
- Attachment copy fails: create no record that claims to own the missing file.
- Extraction/OCR fails: retain the original; index metadata and report limited
  searchability.
- SQLite corruption: quarantine and rebuild from canonical records.
- Keychain unavailable: fail closed for encrypted reads/writes without deleting
  data.
- Consequential destination unavailable: preserve the retrieved material and
  report that delivery did not happen.
- Resource pressure: deterministic reads continue; new model runs receive an
  honest busy state rather than sharing another run.

## 10. Observability and privacy

Every interaction carries `interactionId`, `agentRunId`, provider, capability,
duration, outcome, and error code. Logs exclude:

- dictated text,
- memory content,
- extracted document text,
- secret values,
- provider or MCP tokens,
- attachment bytes.

Memory audit rows record which principal accessed which record, operation type,
time, and outcome. Sensitive content is never included.

Metrics distinguish fast-path latency, provider startup, model time, MCP tool
time, search time, extraction time, and delivery time so regressions are
attributable.

## 11. Additive integration strategy

New code is organized under focused modules, for example:

```text
desktop/electron/remote/agent/
  controller.ts
  provider.ts
  supervisor.ts
  journal.ts
  fast-path.ts
  policy.ts
  capabilities/
    registry.ts
    memory.ts
  memory/
    service.ts
    store.ts
    index.ts
    attachments.ts
    crypto.ts
    search.ts
    versions.ts
```

Existing files receive only integration seams:

- `init.ts`: construct and dispose the Agent subsystem.
- `mcp-server.ts`: delegate tool discovery/calls through the registry while
  preserving current task tools and identity rules.
- capture/session wiring: hand an explicitly addressed capture to the Agent.
- preload/settings: provider selection and memory-management IPC.
- notch IPC and shared task payload: activity plus structured Agent origin.

The old `arpit/unmute-addressable` code is evidence and test material. Useful
pure logic may be selectively adapted, but its branch is not merged as an
architectural base.

The feature begins behind an internal availability gate until its provider,
storage, security, and signed-build flows pass verification. The gate does not
fork existing behavior; when unavailable, current Unmute works exactly as it
does on `main`.

## 12. Test strategy

### 12.1 Pure and service tests

- Capability registration and principal-specific visibility.
- Token scope, expiry, cross-run rejection, and ordinary-task denial.
- Provider selection, run isolation, concurrent runs, resumption, interruption,
  reaping, and provider switching.
- Explicit-store enforcement.
- Record validation, encryption round trips, atomic writes, recovery, and index
  rebuilding.
- FTS ranking, exact matches, scope/tag boosts, ambiguity, and deleted records.
- Attachment copying, hashing, deduplication, reference counting, and failed
  copy rollback.
- Version creation, update, forget, restore, and purge boundaries.
- Conservative fast-path acceptance and refusal cases.
- Prompt-injection content treated as data.

### 12.2 Integration tests

- Claude and Codex provider adapters satisfy one contract suite.
- Two simultaneous Agent requests never share a handle or receive each other's
  results.
- A memory result can be delivered through a mocked task-composer capability.
- Existing task principals continue to see exactly their prior MCP tools.
- Existing dictation and Orchestrator capture paths remain unchanged.
- Structured Agent origin renders consistently in shared payloads.
- Provider crash, MCP rejection, SQLite rebuild, and Keychain failure recover
  honestly.

### 12.3 Baseline and native verification

- The current desktop baseline of 1,830 tests remains green throughout.
- Typecheck introduces no new errors beyond the repository's documented
  baseline.
- Native Swift tests cover Agent activity and origin presentation.
- A signed/notarized build verifies trigger behavior, Accessibility identity,
  Keychain access, file/image storage, concurrent requests, session reaping,
  and attachment delivery.
- Unsigned builds are compile gates only and are never installed.

## 13. Implementation sequencing

The implementation plan should split this design into independently reviewable
slices:

1. Agent types, provider contract, capability registry, principals, and policy.
2. Memory canonical store, encryption, attachments, versions, and SQLite index.
3. Memory MCP module and natural-language evidence contracts.
4. Provider adapters and concurrent run supervisor.
5. Controller, journal, fast path, and capture integration.
6. Native activity, structured Agent identity, and memory-management surface.
7. Retrieval-to-delivery integration, fault handling, and signed-build field
   verification.

Each slice begins with tests, preserves the full baseline, and does not rely on
later UI work to make failures observable.

## 14. Acceptance criteria

The first vertical slice is complete when:

- The user can select Claude Code or Codex CLI specifically for Unmute Agent.
- Two unrelated Agent requests can run concurrently without shared state.
- The user can explicitly store text, a link, an image, and a local file.
- Exact retrieval completes locally without a model.
- Complex natural-language retrieval uses the selected provider and grounded
  Memory MCP evidence.
- The user can update, forget, restore, open, copy, and deliver a stored item.
- A writing style, template, or project vocabulary can be retrieved and applied
  to a downstream draft without changing the stored original.
- Ordinary task sessions cannot list, search, read, or mutate personal memory.
- Credential-reference bodies are not present in FTS, while the selected
  record remains retrievable by title and readable through `memory_get`.
- Completed Agent runs are reaped safely after the idle window while durable
  state remains available.
- Consequential Agent-created work is tagged `Unmute` consistently across all
  task surfaces.
- Existing Unmute functionality and its baseline tests remain unchanged.
