# Unmute Agent session relay — design

## Outcome

People run several conversations at once, and what one of them worked out is
what another one needs. They say so in one sentence: "tell the video edit to use
the approach from the other session", "the migration one needs the project id we
settled on yesterday". The destination is a card they can see; the source is a
session they half remember.

The Unmute Agent resolves both, reads the source, composes the message, and says
it in the destination. The reply happens there.

## The fourth verb

The constitution already sorts a request into three verbs: ABOUT past work is
answered by reading, CONTINUING work is delivered to the session that owns it,
and SPANNING several sessions is composed into one new task. CARRYING is the
fourth, and the only one with two sessions in it:

| Verb | Source | Destination | Tool |
|---|---|---|---|
| About | a transcript | the Agent's own reply | none |
| Continuing | the person's request | the session that owns the thread | `session_resume` |
| Spanning | several transcripts | a NEW session | `task_create` |
| Carrying | another session | an EXISTING card they named | `session_send` |

The tell for carrying is that the destination is named and is *not* where the
information is. `task_create` is the wrong answer to "put this in the migration
one", because the thing they named is the one place a new session is not.

## MCP contract

```ts
session_send({
  taskId: string        // destination card, from sessions_open — never a provider session id
  intent: string        // what they want done there now, in their words (≤ 2,000)
  context?: string      // what you read elsewhere: decisions, the approach, state (≤ 24,000)
  sourceSessions?: Array<{ sessionId: string; provider: 'claude' | 'codex' }>
  artifacts?: Array<{ kind: 'file' | 'url' | 'identifier'; value: string; label?: string }>
}) => { taskId, operation: 'send', delivered: boolean }
```

`consequence: 'reversible-write'`, role `unmute-agent` only, so a task session
cannot reach it: tasks resolve against a different MCP server with its own token
store and only the three `unmute_*` tools.

Carried context requires exact `sourceSessions`, the rule `task_create` already
enforces — background a session cannot trace is worse than none. Session ids
never go in the prose; the receiving session cannot resolve them.

The message is assembled by `buildHandoffPrompt`, the same shape a handoff uses:
carried background labelled as background, exact artifacts preserved verbatim,
and the person's current request last. A relay and a handoff therefore read the
same way to a receiving session, which is the point — only the destination
differs.

## Delivery

`AgentContinuationService.send()` reuses the resume ladder, which exists because
of two field failures: `resume()` only marks a card resumable, `opened()` is what
respawns a cold one, and delivery has to wait for a process that is still coming
up. So: wake, unshelve, `opened()`, promote to `session`, wait up to 20s for
live, then the delivery backoff (~23s). If the session still will not take it,
the words are parked in that card's composer and `delivered:false` says so.

Bounds are inherited, not chosen: the runtime host RPC times out at 30s, and a
timeout reports an unknown outcome, which is worse than a parked draft.

Guards:

- A `taskId` Unmute is not holding is refused. A relay never creates a card.
- A relay never renames a card or changes its workspace. Resume does both
  because it may be opening a card for the first time; a relay never is.
- Deduplicated per interaction on the destination *and* the words, so a retry is
  one relay while two things said are two.

## Provenance

`Task.agentRelays` appends `{ at, agentRunId?, sources?, artifacts? }`, capped at
32, persisted in `meta.json` and hydrated on restart. It is deliberately not
`mergeContinuationProvenance`, which *replaces*: that field says where a
conversation came from, and a relay must not overwrite a card's own ancestry.
The host logs `agent-session-relay`.

## Known limitations

- A busy destination is retried, not queued behind the turn fence the composer
  uses. After ~23s the message parks in the composer.
- The relayed message renders as an ordinary user bubble. Nothing in the chat
  says the Agent wrote it; only the task record knows.

## Acceptance criteria

- A relay into an existing card delivers without creating a card, renaming one,
  or changing its workspace.
- An unheld `taskId` is refused rather than replaced with a new session.
- Context without exact sources is refused before anything is woken.
- An undeliverable relay parks in the destination composer and reports
  `delivered:false`.
- A repeated call in one interaction delivers once; two different messages
  deliver twice.
- `session_send` is absent from the tool list of a task principal.
