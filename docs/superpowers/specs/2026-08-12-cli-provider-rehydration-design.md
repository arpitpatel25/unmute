# CLI Provider Rehydration

**Status:** approved for implementation

## Problem

Every task records its provider in `meta.json` when it is created. The generic
CLI branch of `TaskManager.rehydrate()` reads that receipt but does not restore
the `agent` field onto the in-memory task. A persisted Codex CLI task therefore
becomes an untagged task after relaunch. Untagged tasks intentionally default to
Claude for legacy compatibility, so every consumer receives the wrong provider:
inactive cards display the Claude icon and reopening the task constructs a
Claude executor.

Desktop-backed providers are unaffected because they have explicit rehydration
branches that restore their provider identifiers.

## Design

The persisted receipt remains the source of truth. The generic CLI rehydration
branch restores `agent` from `meta.json`, defaulting to `claude` only when the
field is absent. It also restores `codexRolloutId`, the Codex CLI continuation
handle already written by the Codex dispatch path.

No renderer or notch code changes. React, Electron, and Swift notch surfaces all
consume the same rehydrated task payload and resolve provider presentation from
the shared provider registry. Correcting the task before it is emitted fixes
the inactive dashboard, pocket, rail, expanded task, and resume paths together.

## Compatibility and failure behavior

- New Claude and Codex CLI receipts retain their recorded provider.
- Legacy receipts without `agent` remain Claude tasks.
- Codex Desktop and Claude Desktop keep their existing dedicated paths.
- Unknown provider values continue to be constrained by the persisted
  `AgentKind` contract; this change adds no inference from titles, icons, or
  transcript locations.

## Verification

An integration-style `TaskManager` test will seed receipts on disk, rehydrate
them through production code, and assert both the inactive task identity and
the provider requested during resume. It will cover Codex CLI, Claude CLI, and
an untagged legacy receipt. Existing provider registry and surface tests remain
the guard that all views map a task's provider to the same icon and behavior.
