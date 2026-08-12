# Unified task composer — design

**Status:** approved in principle; implementation review pending.
**Date:** 2026-08-12
**Branch:** `fix/cli-provider-rehydrate`

## Goal

Every way a person contributes to an already-open task builds the same draft:
multiline text plus ordered image attachments. This applies to manual input,
paste/drop, and Right-Option capture (including screenshots/copies made during
that capture), regardless of whether the task was opened from dashboard,
pocket, notch, or stage.

## Current fault

`answerText` is a text-only IPC event. Native expanded views use independent
single-line `TextField`s. The Electron fallback calls `TaskManager.attachFile`,
which saves an image then writes its filesystem path into a PTY. Codex Desktop
delivery only inserts text in Codex's contenteditable composer. Consequently
there is no shared draft, attachment identity, preview, removal, or reliable
provider delivery contract.

## Design

### Draft contract

Add a task-scoped draft owned by Remote, with:

```ts
type TaskDraft = {
  text: string
  attachments: Array<{
    id: string
    path: string
    mimeType: string
    name: string
  }>
}
```

The native UI sends draft mutations and an explicit send request; it does not
clear local text until Remote confirms accepted delivery. An attachment is
first copied into Unmute-owned task storage, then added to the draft. Removing
one removes it from the draft and its owned file.

### Native composer

Replace the shared expanded `TextField` and free-text question `TextField`
with one AppKit-backed multiline composer. It supports:

- Enter sends a non-empty draft.
- Shift-Enter inserts a newline.
- Text paste remains text.
- Pasteboard images and dropped image files create attachment chips.
- Chips render a thumbnail/name and an `×` removal action above the editor.

Task detail, stage/cockpit task, dashboard-opened task, and needs-user free-text
answers all use this component. A visible terminal remains its direct terminal
surface; hiding it exposes this composer and its task draft.

### Capture convergence

Right-Option capture targeted at a focused task appends its rendered text and
captured images to that task draft instead of independently delivering a path
or a second message. The existing capture ordering is retained: speech and
captured inserts preserve their observed order. The explicit send action is the
only draft-drain path. Ordinary, untargeted dictation retains its current direct
cursor/task delivery behaviour.

### Provider delivery

`sendDraft(taskId)` snapshots the draft, delivers all attachments with text,
and clears only after success.

- Codex Desktop: attach each local image through Codex Desktop's attachment
  control, verify attachment presence, atomically insert draft text, then send.
- Codex CLI/app-server: submit local images through its structured local-image
  input where available, with the draft text as the same turn.
- Claude CLI/other terminal providers: use that provider's supported
  local-file reference in the same submitted turn. It is a delivery adapter,
  never a path displayed as an attachment preview.
- Unsupported provider/image combinations reject before submit and preserve the
  draft with an actionable error.

## Safety and lifecycle

- Drafts persist per task while the task exists, so switching expansion surfaces
  does not erase input.
- A failed attachment or send preserves text and attachments.
- No attachment is sent merely because it was pasted or captured.
- Existing direct text replies without attachments preserve their provider
  delivery path and behaviour.

## Tests

- Pure draft reducer: append text, add/remove attachment, snapshot/clear only
  after success, and preserve state after failure.
- Capture routing: focused Right-Option text and images append to its draft in
  order; untargeted capture retains current direct delivery.
- Native composer interaction coverage for multiline/send shortcuts and chip
  removal where practical; unit coverage for emitted IPC actions.
- Codex Desktop driver tests for attach-before-text-before-submit and failure
  preservation.
- Terminal adapter tests verifying a single submitted turn contains the text and
  supported image reference, rather than an unsubmitted path injection.
