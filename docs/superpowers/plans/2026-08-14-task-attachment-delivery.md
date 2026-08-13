# Task Attachment Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver captured and manually pasted images as genuine attachments to the exact selected CLI or desktop task, without ever converting them to prompt paths.

**Architecture:** Keep capture and task drafts provider-neutral (`text` plus ordered file attachments). Route that draft through provider-specific transports: clipboard image plus direct Ctrl-V PTY input for CLI agents, and verified composer file-input injection for desktop agents. A transport returns success only after attachment acceptance and submission, so the task draft remains retryable on failure.

**Tech Stack:** Electron, TypeScript, node-pty, Chrome DevTools Protocol, macOS NSPasteboard native integration, Node test runner.

**Spec:** Approved in the task discussion on 2026-08-14.

## Global Constraints

- Normal cursor dictation behavior must remain unchanged.
- Never place an image path in user-visible prompt text.
- Preserve text-first, image-after ordering and restore the user's clipboard text.
- Never clear a task draft unless its provider accepts the complete delivery.
- Delivery must target the task captured at Right Option key-down, regardless of foreground changes.

---

### Task 1: Provider-neutral attachment submission

**Files:**
- Modify: `desktop/electron/remote/init.ts`
- Modify: `desktop/electron/remote/task-manager.ts`
- Test: `desktop/electron/remote/addressed-capture.test.ts`
- Test: `desktop/electron/remote/task-manager-attachments.test.ts`

**Interfaces:**
- Consumes: task draft `{ text, attachments }`.
- Produces: `TaskManager.deliverDraft(id, text, attachments)` with no path serialization.

- [x] Add a failing test proving CLI attachment paths never enter prompt text.
- [x] Run the focused test and confirm it fails on `[image: /path]`.
- [x] Remove `draftDeliveryText` path serialization and pass structured attachments only.
- [x] Run focused tests and confirm they pass.

### Task 2: Genuine CLI image delivery

**Files:**
- Modify: `desktop/electron/remote/pty-session.ts`
- Modify: `desktop/electron/remote/task-manager.ts`
- Modify: `desktop/engine-overrides/electron/clipboard.ts`
- Test: `desktop/electron/remote/pty-session.test.ts`
- Test: `desktop/electron/remote/task-manager-attachments.test.ts`
- Test: `desktop/engine-overrides/electron/pasteboardHandoff.test.ts`

**Interfaces:**
- Consumes: `text` and ordered image paths plus an injected clipboard handoff effect.
- Produces: a PTY submission that writes text, stages each real clipboard image, sends `\x16` (Ctrl-V) to that exact PTY, submits once, and restores text.

- [x] Add failing ordering, multiple-image, failure, and clipboard-restoration tests.
- [x] Run the focused tests and confirm expected failures.
- [x] Add an injectable clipboard image handoff that targets a PTY callback rather than the foreground app.
- [x] Make PTY delivery await image ingestion before submitting.
- [x] Run focused tests and confirm they pass.

### Task 3: Reliable desktop composer attachments

**Files:**
- Modify: `desktop/electron/remote/codex/cdp.ts`
- Modify: `desktop/electron/remote/codex/driver.ts`
- Modify: `desktop/electron/remote/task-manager.ts`
- Test: `desktop/electron/remote/codex/cdp-attachments.test.ts`

**Interfaces:**
- Consumes: ordered local files.
- Produces: verified Codex composer attachment previews without requiring `Page.fileChooserOpened` as the only path.

- [x] Add a failing test for direct `input[type=file]` injection and chooser fallback.
- [x] Run it and confirm the current chooser-only implementation fails.
- [x] Inject through the DOM file input when available, retain intercepted chooser as fallback, and verify previews before submission.
- [x] Preserve the task draft and expose a delivery error when verification fails.
- [x] Run focused tests and confirm they pass.

### Task 4: Regression verification and commit

**Files:**
- Verify all modified production and test files.

- [x] Run attachment, addressed-capture, clipboard-handoff, PTY, Codex driver, and task-manager tests.
- [x] Run TypeScript checking and relevant package tests.
- [x] Review the diff for path leakage, clipboard loss, and accidental focus operations.
- [ ] Commit once with a scoped attachment-delivery message.
