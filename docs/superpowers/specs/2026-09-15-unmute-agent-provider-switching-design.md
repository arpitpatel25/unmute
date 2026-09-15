# Unmute Agent provider switching and model policy — design

## Outcome

The Unmute Agent always uses the provider and model the person selected. A
provider change starts a new provider-native conversation without making the
experience feel blank: the new conversation receives a bounded handoff made
from the prior conversation's rolling summary and latest complete exchanges.

This change is based on `main` and does not include Agent Routines.

## Model policy

The Agent runtime resolves one explicit model for each provider and passes it
on both new-conversation and resume requests:

- Codex CLI: `gpt-5.6-sol`.
- Claude Code CLI: `opus`, displayed as “Opus 5”. The stable CLI alias is used
  instead of guessing a dated or versioned model ID.

There is no automatic fallback to another model or provider. If the requested
model or provider is unavailable, the interaction fails visibly and retains
the person's input. The available actions are Retry and Change Provider.

The runtime records the actual model returned by the provider for diagnostics,
but that response cannot silently change the requested model policy.

## Provider-switch flow

The Swift notch exposes the current Agent provider mark as a button. Selecting
a different provider presents a confirmation:

> Switch to Claude? This conversation will be archived. A new conversation
> will start with a summary and your latest messages.

The equivalent copy names Codex when switching in the other direction. No
confirmation is needed when the selected provider is already active or the
conversation is empty.

After confirmation:

1. If no turn is running, archive the current provider run and start the new
   provider conversation for the next submitted message.
2. If a turn is running, save the requested provider as pending. Let the
   accepted turn finish, persist its final response, then archive and rotate.
3. Display “Switching to Claude after this response…” while pending.
4. Keep the prior conversation available in history; “clear” means remove it
   from the active surface, never delete its durable transcript.

The Settings provider picker uses the same operation and semantics as the
notch. Settings no longer changes only a preference while leaving the active
conversation indefinitely on another provider.

## Handoff context

Provider rotation creates a structured handoff packet containing:

- the latest persisted rolling conversation summary;
- up to six latest complete user/assistant exchanges, subject to a fixed token
  budget;
- unresolved work, decisions, constraints, and relevant artifact references;
- the final response of an in-flight turn when switching was requested during
  that turn.

The packet is injected as bounded background context for the first turn of the
new provider conversation. It is not shown as a synthetic user message and it
cannot override the person's current request.

Summary creation must not depend on the provider being replaced. The runtime
uses the already persisted rolling summary. If it is absent or stale, the new
selected provider may produce a hidden bounded summary from the stored local
transcript before answering. The latest exchanges are copied directly rather
than paraphrased.

## State and failure behavior

Selected, active, and pending provider are distinct fields:

- `selectedProvider`: the person's durable choice;
- `activeProvider`: the provider owning the current run;
- `pendingProvider`: a confirmed switch waiting for an accepted turn to end.

A confirmed provider switch clears recoverable conversation errors such as
provider unavailable, provider crashed, authentication required, model
unavailable, or resume failed. It retains queued input and forces a fresh run
with the selected provider.

An acceptance-uncertain failure is not automatically replayed or cleared. The
UI must explain that the provider might already have accepted the action and
require an explicit recovery choice, preventing duplicate side effects.

Provider adapters preserve safe underlying failure information. Startup and
resume errors are classified separately instead of converting every exception
to `provider-unavailable`. Logs include provider, requested model, operation
stage, and a bounded error message without transcript contents or credentials.

## Runtime compatibility

The persistent Agent runtime outlives Electron relaunches. Its configuration
therefore includes the explicit model policy, and the daemon must accept model
updates without retaining an obsolete model from a previous app build. A fresh
provider run never inherits a model from the archived run.

## UI contract

The Agent notch shows:

- the active provider mark while a conversation is active;
- a pending-switch indicator and destination provider while a switch waits;
- the selected provider and configured model for an empty/new conversation;
- actionable provider/model errors without claiming that another provider was
  used.

The provider button remains accessible while a response is running because a
switch can be scheduled. Model selection is not exposed in this change; the
per-provider model policy is explicit and centrally owned by the runtime.

## Verification

Automated tests cover:

- Codex starts and resumes with `gpt-5.6-sol`.
- Claude starts and resumes with the CLI model `opus`.
- Neither provider nor model silently falls back after failure.
- An idle switch archives the active run and makes the selected provider active
  for the next interaction.
- An in-flight switch waits for settlement and includes the final response in
  the handoff.
- A failed provider conversation can switch and retry on a fresh provider run.
- Acceptance-uncertain work is never replayed automatically.
- The handoff includes the rolling summary and no more than six bounded recent
  exchanges.
- Notch confirmation, pending copy, provider marks, and accessibility labels
  reflect the lifecycle state.

The full Electron test suite, TypeScript checks, Swift notch checks, unsigned
build, installation, and launch smoke test must pass before merging to `main`.

