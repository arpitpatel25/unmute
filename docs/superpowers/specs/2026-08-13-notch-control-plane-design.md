# Notch Control Plane Design

## Goal

Preserve the existing Unmute notch UI and product behavior while replacing competing local, SwiftUI, AppKit, and Electron authorities with one deterministic control plane.

## Ownership

- Electron owns task data, pocket contents, capture routing, persisted settings, and agent configuration.
- The native helper owns immediate interaction, navigation, visit-scoped sizing, transition progress, and feedback presentation.
- SwiftUI renders derived presentation and emits actions. It does not retain a second copy of product-relevant interaction state.
- AppKit applies the derived frame and input policy. It does not infer state from the current physical frame.

## State flow

Inputs are reduced on the main thread into one native interaction state. A presentation selector derives controls, window frame, semantic hit envelope, terminal intent, and capture policy from the resulting state. Repeating an equivalent input is a no-op.

Terminal streaming and other side effects are reconciled by comparing the previous and next desired effects. Views must not independently emit lifecycle effects that an explicit user action also emits.

## Transitions

One transition coordinator owns the requested native frame and its completion. Content handoff remains mounted until geometry finishes, and generation-guarded completion callbacks cannot mutate a newer transition. Hover acceptance is based on the same derived presentation whose controls are visible.

## Lifecycle

The native helper receives a complete preference bootstrap followed by deterministic latest-state replay before first presentation. Electron supervises unexpected helper exits, restarts with bounded delay, and repeats that handshake. A deliberate dispose never restarts the helper.

## Compatibility contract

No existing feature, visual layout, shortcut, routing rule, provider integration, or user-facing workflow is removed. The migration changes ownership and eliminates races, duplicate effects, invisible errors, and inconsistent intermediate states.

## Required invariants

1. Pocket controls and pocket height are derived from the same state.
2. One pointer interaction settles in one stable presentation.
3. Repeated domain snapshots do not reset visit-scoped choices.
4. At most one terminal subscription exists for a task.
5. Only the current transition may reveal its destination content.
6. Screen-capture policy is applied before first presentation and after restart.
7. Collapsed-surface failures produce visible feedback.
8. Unexpected helper exit is recoverable without restarting Electron.
