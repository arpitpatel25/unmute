# Live Unmute Web Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current scripted MacBook tour into a real microphone-powered Unmute web demo with pasted-image Scratchpad context and a five-use server contract.

**Architecture:** Pure state transitions remain isolated from browser APIs. Focused adapters own microphone recording and transcription transport; the DOM controller coordinates them and passes only real transcripts and pasted images into the reducer.

**Tech Stack:** HTML5, CSS, ES modules, MediaRecorder, ClipboardEvent, Node.js `node:test`; no runtime dependencies.

**Spec:** `docs/superpowers/plans/2026-08-20-exact-interactive-demo-design.md`

## Global Constraints

- Request microphone permission only.
- Never substitute scripted transcript text after a failed or empty recording.
- Accept screenshots only through explicit paste or drag-and-drop.
- Keep native pill, Scratchpad, and notch surface ownership; remove invented Orchestrator UI.
- Display a five-attempt limit from server response metadata.
- Use no third-party JavaScript dependencies.

---

### Task 1: Real-data reducer

**Files:** `tests/demo-state.test.js`, `demo-state.js`

**Interfaces:** Consume `TRANSCRIPTION_SUCCEEDED`, `TRANSCRIPTION_FAILED`, and `IMAGE_PASTED`; produce recording, processing, error, held-segment, delivered-note, and quota state.

- [ ] Write failing tests proving actual event text is delivered, scratchpad segments accumulate, pasted images remain ordered, errors recover, and attempt five disables recording.
- [ ] Run `npm test` and observe the intended failures.
- [ ] Replace scripted transcript transitions with payload-driven transitions.
- [ ] Run `npm test` and commit the reducer cycle.

### Task 2: Microphone and transcription adapters

**Files:** `tests/demo-recorder.test.js`, `tests/demo-transcription.test.js`, `demo-recorder.js`, `demo-transcription.js`

**Interfaces:** `createRecorder(...)` returns `requestPermission()`, `start()`, and `stop()`; `createTranscriptionClient(...)` returns `transcribe(...)`.

- [ ] Write failing tests for recording/blob assembly, unsupported APIs, multipart fields, response normalization, quota metadata, and errors.
- [ ] Run the focused tests and observe missing-module failures.
- [ ] Implement the smallest adapters satisfying the contracts.
- [ ] Run the full suite and commit the adapter cycle.

### Task 3: Live controller and explicit paste flow

**Files:** `tests/demo-view.test.js`, `demo.js`, `demo-view.js`, `index.html`

**Interfaces:** Coordinate recorder, transcription client, reducer, paste, and drop events; render enable, recording, real note text/image, retry, and attempt states.

- [ ] Write failing contracts for Enable microphone, privacy copy, Paste screenshot, attempts, processing/errors, and removal of scripted trigger claims.
- [ ] Run tests and observe the intended failures.
- [ ] Wire permission and recording lifecycles to the Unmute surfaces.
- [ ] Convert pasted/dropped images into object URLs and dispatch ordered image events.
- [ ] Run the suite and commit the controller cycle.

### Task 4: Visual fidelity and browser verification

**Files:** `demo.css`, and `demo-view.js` only for anatomy defects.

- [ ] Match current SwiftUI metrics and remove invented surfaces.
- [ ] Exercise Dictation, Scratchpad, Capture paste/drop, Remote transcript, quota, denial, and network failure.
- [ ] Run `npm test`, `git diff --check`, and a fresh browser console inspection.
- [ ] Commit verified polish.

## Self-review

- Spec coverage: microphone-only permission, real STT payloads, Scratchpad accumulation, explicit image paste/drop, quota display, errors, native surfaces, and honest Remote each map to a task.
- Placeholder scan: no client behavior is deferred; deployment of the secured demo endpoint is outside this landing-repository plan.
- Type consistency: reducer events and adapter shapes are identical across tasks.
