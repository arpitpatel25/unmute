# Expanded Reply Reliability Design

## Goal

Make every expanded task surface accept the same text-and-image draft, deliver that draft reliably to Codex Desktop, and morph from the pocket without blocking the native notch process.

## Confirmed failures

1. `StageComposer` allows an empty editor to consume up to 76 points and the direct task surface does not pass `TaskDetail.draft` into `CodexComposer`. The result is an oversized empty field and missing staged text or images on one expanded surface.
2. Codex attachment delivery clicks **Attach files or folders**, which opens a native file panel, and only then asks CDP to populate an HTML file input. The native modal blocks that automation boundary; the delivery never reaches text insertion or submission.
3. `NotchWindow.applyFrame` calls AppKit's synchronous animated `setFrame`. Expanding from roughly 348×146 to 1296×810 also mounts the transcript or terminal hierarchy, so intermediate redraws block the native main thread. Production logs show a nominal 240 ms transition taking 0.4–3+ seconds.

## Design

### Shared adaptive composer

All task, dashboard-stage, and cockpit-stage composers consume the task-scoped `TaskDraftP`. The editor reports its intrinsic text height and begins at one line, growing with wrapped content to a fixed multiline cap. Attachment thumbnails remain outside the text editor but inside the same composer shell. Enter submits, Shift-Enter inserts a newline, and captured or pasted images remain visible until confirmed delivery.

### Confirmed Codex attachment delivery

Codex CDP enables file-chooser interception before clicking the attach command. It consumes the resulting chooser event with `Page.handleFileChooser`, waits for the composer to render the expected attachment count, then inserts text and submits. Every CDP operation is bounded. Delivery returns success only after the composer clears or the rollout confirms a new user turn; on timeout or mismatch it returns a typed failure and leaves the task draft intact for retry.

The implementation must not drive the native macOS file picker and must not type filesystem paths into the conversation.

### Non-blocking pocket morph

Window geometry is driven by one display-linked animator owned by `NotchWindow`. A request records the latest destination and returns immediately. Duplicate targets do nothing; a changed target begins from the current presentation frame. The pocket shell remains the outgoing visual during the initial resize, while the task hierarchy is mounted once the window has enough area and cross-fades in during the same transition. Reduce Motion applies the destination immediately with the existing short content fade.

The transition may never wait on transcript parsing, terminal attachment, task polling, or provider operations.

## Failure handling

- A failed Codex attach or submit keeps both text and attachments in the task draft and presents the existing delivery error.
- A task disappearing during delivery returns failure without redirecting the draft.
- A transition interrupted by another state change retargets from its current frame; it never collapses through an intermediate bar unless the requested destination is actually collapsed.

## Verification

- Native tests cover transition coalescing, retargeting, progress, and non-blocking request behavior.
- Composer tests cover one-line sizing, multiline growth/cap, and draft propagation across task and stage surfaces.
- Codex tests cover chooser interception, attachment confirmation, submit confirmation, timeout, and draft preservation.
- Existing TypeScript, Swift, and type-check suites remain green.
