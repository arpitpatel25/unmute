# Video-led immersive onboarding — design

**Date:** 2026-09-10  
**Repository:** `unmute-cloud`  
**Status:** Approved design, awaiting implementation plan

## 1. Purpose

Replace the current page-based onboarding with a founder-led, event-driven first
run. The founder explains one capability, asks the user to perform it, and waits
for the real product to prove that it worked before continuing.

The experience begins on first launch, before sign-in. It is not a slideshow, a
settings wizard, or a simulated product tour. Apple Notes, the native notch and
pill, Dictation, Orchestrator, the Unmute Agent, and Notetaker are the
real shipping systems throughout.

The interaction model is inspired by MiniMe's founder-video onboarding, but its
presentation is Unmute's own: a notch-originated, background-reactive glass
surface with contextual companion cards. It must not recreate MiniMe's
right-side information panel, structure, or visual identity.

## 2. Product principles

### 2.1 Explain, perform, prove

Every instructional chapter follows one rhythm:

1. The founder briefly explains the capability and why it exists.
2. A contextual glass card shows the exact action or phrase.
3. The founder stops speaking before a voice capture begins.
4. The user performs the action in the real product.
5. A real product event or observable outcome proves completion.
6. The card confirms success and the founder continues.

Timers, Next buttons, and animation completion never stand in for product
success.

### 2.2 No dummy product

There is no onboarding notch, fake pill, fake task, simulated transcript, or
internal practice editor. The native notch and pill start normally with the app.
The onboarding coordinator observes them; it does not replace them.

Apple Notes is the real destination for Dictation, clipboard capture,
and screenshot capture. Orchestrator and the Unmute Agent create real tasks
through the user's detected CLI. Notetaker creates a real saved recording.

### 2.3 Founder footage comes last

Development uses placeholder clips carrying stable chapter IDs. The final
founder footage is recorded only after the actions, recovery branches, timing,
and copy are stable. Replacing a clip must not require changing product logic.

### 2.4 Before sign-in, within a strict allowance

The user experiences the product before being asked to sign in. A narrow,
installation-scoped onboarding allowance covers only the managed transcription
needed by the prescribed exercises. It has fixed audio and request limits and
cannot be used as a general anonymous product entitlement.

Claude Code and Codex execution continues to use the user's own installed CLI,
account, credentials, limits, and provider connection. Unmute never receives or
proxies those credentials.

## 3. Visual and spatial system

### 3.1 The presenter

The persistent guide is a small founder-video glass surface. It occupies less
than a screen quadrant and remains approximately the same size throughout the
experience; it does not begin full-screen and shrink for practice.

Its material follows the native notch's current language:

- live background-reactive glass;
- a dark legibility scrim rather than bare blur;
- subtle specular edge definition;
- denser inner planes where text requires stable contrast;
- the blue-purple-pink Unmute Agent identity only where that identity is
  meaningful.

The closed native notch remains opaque black so it continues the physical
camera cutout. Existing expanded notch and pill material behavior is unchanged.

### 3.2 Context cards

Only the current instruction accompanies the video. A permission, phrase,
status, choice, or repair card unfolds beside or below the presenter and
dissolves after completion. It is not a persistent details rail.

Cards can contain:

- one permission and its current macOS status;
- the exact sentence the user is asked to speak;
- provider readiness and the one-time default choice;
- a retry or repair action;
- a compact success receipt.

### 3.3 Real destination surfaces

During practice, the presenter remains visible while Unmute opens the real
destination:

- Apple Notes for voice and capture exercises;
- the native notch/pill for recording, task, and save interactions;
- the Electron app for the closing Orchestrator and Notetaker orientation.

The presenter must yield focus to macOS permission dialogs and destination apps.
It must never block the cursor, the physical notch, the target text field, or a
system prompt.

## 4. First-run choreography

### 4.1 Launch and privacy

On first launch, the native notch starts normally and the presenter appears
before sign-in. The founder welcomes the user and gives the shortest accurate
privacy explanation:

- voice captures that use managed transcription send audio to Unmute's
  transcription service;
- the audio is discarded after transcription;
- Claude Code and Codex execute locally through the user's own CLI and
  communicate with their providers directly, not through Unmute's servers;
- local and provider traffic must not be described as "never hitting the
  internet"—the correct promise is that agent execution does not pass through
  Unmute's service.

The final recorded copy must be checked against the shipping data paths before
release.

### 4.2 Permissions

A glass permission card evolves through the required grants. The founder video
pauses for every macOS prompt and resumes only after the app rechecks the real
permission state.

The required first-run permission surface is:

1. **Microphone** for voice capture.
2. **Accessibility** for reading selection state and delivering text into other
   applications.
3. **System Audio Recording** for Notetaker.

Immediately after Accessibility, onboarding performs a separate **Function-key
readiness** check. Dictation has one supported activation contract: tap
Function once to start, then tap Function again to submit. Holding Function and
releasing it is never taught or accepted as the onboarding path.

macOS commonly assigns the Globe/Function key to the emoji and symbol picker.
The readiness card checks the current keyboard preference where macOS exposes
it, opens the Keyboard Settings route when repair is required, and instructs
the user to set **“Press 🌐 key to” → “Do Nothing.”** A preference read is only
diagnostic; the authoritative proof is a real Function-key event observed by
Unmute's shipping listener. The user cannot continue until that event arrives.

System Audio has no standalone request API. During the permission chapter,
Unmute starts and immediately stops a controlled native system-audio tap so
macOS presents the real consent prompt. If macOS requires relaunch after a
grant, onboarding persists its checkpoint, relaunches, revalidates the grant,
and resumes with a short continuation clip.

Ordinary user-created screenshots do not require Screen Recording. Computer-use
window capture does, but computer use is outside this first-run curriculum.
Desktop-folder consent is requested contextually when the screenshot exercise
first watches the user's Desktop; the founder warns the user immediately before
that macOS prompt. Automation consent is likewise preflighted only if the
shipping paste path actually requires it in the signed build.

### 4.3 Agent readiness begins immediately

Provider readiness starts in the background at onboarding launch rather than
waiting for a provider chapter.

Unmute checks the **Claude Code CLI** (`claude`) and **Codex CLI** (`codex`)
independently. A desktop application is not treated as proof that its CLI is
available. Each provider resolves to one of:

- not installed;
- installed but authentication or first-run setup is required;
- ready.

For onboarding only, readiness is proven with a real disposable session in an
empty temporary directory. The probe uses a harmless no-write request, has a
strict timeout, terminates after one valid response, and removes all Unmute
cards and temporary files it created. The UI states that the provider may retain
the test conversation in its own history.

If one CLI is ready, it becomes the default automatically. If both are ready,
the presenter asks which should be the default. If neither is ready, the card
shows the exact official installation and login instructions and can rerun one
provider's test without rerunning onboarding.

### 4.4 Dictation in Apple Notes

Unmute opens Apple Notes without creating a fake in-app editor. The presenter
does not resize; it remains beside Notes.

The user places the cursor in Notes and follows a displayed phrase. They tap
Function once. The card changes from **Tap Function to start** to **Listening**
only after the shipping keyboard path emits a Dictation-start receipt. The user
speaks without holding any key, then taps Function again. The card changes to
**Processing** only after the Dictation-stop receipt.

Completion requires this ordered chain from one capture: start receipt, stop
receipt, and actual delivery into Apple Notes. A video ending, a timeout, a
transcription response, or delivery into another application cannot advance the
chapter. If no first tap is observed, the card remains on the start instruction.
If start is observed but no second tap arrives, it remains Listening.

### 4.5 Clipboard and screenshot capture

Two further Notes exercises teach composition during a live dictation:

1. copy a displayed link or text while speaking and see it inserted in the
   correct position;
2. take a screenshot while speaking and see the real attachment included with
   the delivered result.

Each exercise uses the shipping capture pipeline. The coordinator verifies the
capture event and final delivery independently so a captured-but-lost attachment
cannot be counted as success.

Both exercises use the same ordered tap-toggle contract: Function start,
expected clipboard or screenshot receipt while the capture is live, Function
submit, and verified final delivery containing that exact captured item. The UI
reflects the currently missing event rather than giving a generic retry.

### 4.6 Orchestrator

The founder first explains why Orchestrator exists. Starting a new Claude Code
or Codex session, finding the relevant existing session, and moving selected
context into it creates friction between having a thought and acting on it.
Orchestrator removes that session-management work. A user can be reading a
tweet, article, or document, select useful context, tap Right Option, speak the
question that occurred to them, and continue what they were doing. Unmute
creates or continues the appropriate task and keeps it available in the app.

A compact phrase card then asks the user to tap Right Option once to begin and
again to submit:

> Create a file called `hello-unmute.txt` and write "My first Unmute task"
> inside it.

The task runs through the real Orchestrator in its isolated onboarding
workspace. Onboarding requires the ordered Right Option start and stop receipts,
successful task creation, task completion, and the expected file content. The
task is safe, deterministic, and does not request access to the user's Desktop
or Downloads.

### 4.7 Unmute Agent

The founder explains the distinction: Orchestrator sends work to a coding
agent; the Unmute Agent understands Unmute history, meetings, and tasks and can
create or resume work on the user's behalf.

The user double-taps Right Command to invoke the Unmute Agent, asks it to create
a follow-up task that adds today's date to `hello-unmute.txt`, and taps Right
Command once to submit. Onboarding observes the real Agent-start and Agent-stop
receipts. The Agent must create a real task and return its real clickable task
link. Onboarding advances only after the gesture receipts, structured task
receipt, and link exist. Opening the link demonstrates that it leads to the
actual task.

### 4.8 Notetaker

The founder explains that Notetaker uses the user's existing Claude Code or
Codex CLI for note generation, allowing the user to benefit from the models and
provider account they already use.

The user double-taps **Left Control** to start a real Notetaker recording.
Onboarding waits for the real start receipt before showing that recording is
active. The native pill appears. The founder explains Save and Discard, and the
user saves the short onboarding recording with the real control. Saving the
same recording is the chapter's completion event; merely performing the key
gesture or stopping without Save does not advance.

Summary generation remains asynchronous and does not block onboarding. The
founder points to the Notetaker section, explains that the note and summary will
appear there, and explains that the Unmute Agent can later search or answer
questions about saved notes. The onboarding does not immediately require a
notes query because the summary may still be running.

### 4.9 Product orientation and sign-in

The Electron app opens for a short orientation using real state. The presenter
points out:

- today's tasks in Orchestrator;
- automatically created workspaces/groups;
- the task created directly through Orchestrator;
- the linked task created by the Unmute Agent;
- the Notetaker section and its asynchronous saved recording.

Only after the user has experienced the product does onboarding ask them to
sign in and select the appropriate plan. Completion contracts the presenter
away and leaves the real notch and application running normally.

## 5. Architecture

### 5.1 Onboarding coordinator

An `OnboardingCoordinator` in Electron main owns the journey. Renderer-local
React state cannot own it because permission grants and System Audio can require
window changes or a process relaunch.

The coordinator is responsible for:

- chapter and action state;
- prerequisite evaluation;
- starting background agent probes;
- arming each real exercise;
- consuming authoritative product events;
- retry and recovery decisions;
- durable progress and resume;
- presenter-window commands;
- final completion and replay reset.

The state machine is pure and table-tested. Electron, filesystem, macOS, native
notch, and renderer integrations are adapters around it.

### 5.2 Declarative chapter manifest

Each chapter is data, not a chain of component conditionals:

```ts
interface OnboardingChapter {
  id: ChapterId
  clips: ClipCue[]
  prerequisites: Requirement[]
  arm(context: OnboardingContext): Promise<void>
  completedBy: CompletionPredicate
  timeout: TimeoutPolicy
  recovery: RecoveryPolicy
}
```

A clip cue identifies placeholder/final media, captions, and the action card it
introduces. Product events—not clip timestamps—advance the state machine.

### 5.3 Event adapters

The coordinator consumes normalized events from existing systems, including:

- permission status changed;
- CLI probe started, succeeded, failed, or timed out;
- provider default selected;
- Function-key preference inspected, repair requested, and real Function event
  observed;
- Dictation start and stop receipts carrying the same capture ID;
- capture route and phase changed;
- Dictation delivered at the target;
- clipboard or screenshot captured and included in delivery;
- Orchestrator start, stop, task-created, completed, or failed;
- Unmute Agent start, stop, task receipt, and task link created;
- Notetaker started, stopped, saved, or failed;
- notch/pill opened or acted upon;
- sign-in and subscription changed.

Adapters may expose missing lifecycle signals, but they must not implement a
parallel onboarding-only action path.

### 5.4 Presenter window

The presenter is a small transparent Electron/native-compatible surface using
the current glass vocabulary. It renders:

- modular local video;
- captions and a silent fallback;
- one contextual companion card;
- repair/retry controls when necessary;
- accessibility controls for pause, replay, captioning, and keyboard use.

It yields focus by default. It may become interactive for a card action but must
return focus to the destination before asking the user to press a trigger.

### 5.5 Durable progress

Progress is stored as completed capabilities and current action, not a numeric
page index. On every launch, the coordinator revalidates permissions, provider
readiness, and external outcomes before deciding where to resume.

Replay clears instructional progress but never revokes permissions, signs a
provider out, deletes user work, or spends another provider probe when current
readiness can be safely revalidated.

## 6. Recovery behavior

- **Permission denied:** keep the founder paused; show the exact System Settings
  route and recheck automatically.
- **Relaunch required:** persist the exact action, relaunch, revalidate, and play
  a short continuation clip.
- **Provider missing or signed out:** identify the specific provider and show
  official installation/login instructions; retry only that provider.
- **Provider timeout:** terminate the disposable process, report timeout rather
  than absence, and allow retry.
- **Function key opens emoji or is not observed:** remain at Function readiness,
  open Keyboard Settings, show the exact “Press 🌐 key to → Do Nothing” repair,
  and retry the live-key check.
- **Start gesture missing:** remain on the start instruction; never begin an
  onboarding-only recording.
- **Stop gesture missing:** keep the live recording state visible and wait for
  the real submit gesture or explicit cancellation.
- **Dictation failure:** preserve Notes content and retry only the
  failed action.
- **Spoken phrase differs:** accept safe variation and verify the resulting
  action. Exact transcription matching is not required.
- **Clipboard or screenshot failure:** distinguish capture failure from final
  delivery failure and retry the failed portion.
- **Orchestrator failure:** show the real error and rerun the predefined safe
  task without duplicating successful tasks.
- **Notetaker summary pending:** never block completion; saving is sufficient.
- **Video unavailable:** show the same script as captions and keep every action
  usable.
- **Quit or crash:** resume at the first incomplete action; never repeat a
  completed external mutation automatically.

## 7. Verification

### 7.1 Pure tests

Table-test every chapter transition and branch:

- fresh install;
- permissions already granted;
- one or both providers ready;
- neither provider ready;
- provider timeout, authentication failure, and retry;
- permission denial and relaunch;
- Function-key preference conflict, repair, and live-key verification;
- missing, duplicated, and out-of-order start/stop gestures for every exercise;
- each exercise's failure and retry;
- quit/resume at every mutation boundary;
- replay after completion;
- missing video and caption fallback.

### 7.2 Integration tests

Prove that only the authoritative event advances each chapter. In particular:

- transcription without target delivery does not complete Dictation;
- Dictation delivery without the matching Function start and stop receipts does
  not complete Dictation;
- screenshot capture without final attachment delivery does not complete the
  screenshot exercise;
- Orchestrator task completion without matching Right Option start and stop
  receipts does not complete Orchestrator;
- Agent prose without a real task link does not complete the Agent exercise;
- Agent output without matching Right Command lifecycle receipts does not
  complete the Agent exercise;
- Notetaker start without Save does not complete Notetaker.

### 7.3 Visual verification

Capture the presenter and companion cards over bright pages, dark pages,
photographs, and saturated wallpapers. Verify readable video controls, captions,
card text, glass edges, and Unmute Agent tint. Verify that no arrangement blocks
the physical notch, Notes cursor, permission dialog, or Electron destination.

### 7.4 Signed clean-account run

The release gate is a signed/notarized build on a clean macOS account. Complete
one uninterrupted run:

1. install and launch;
2. grant every real TCC permission;
3. survive any required relaunch;
4. repair the Globe/Function setting if needed and prove a real Function event;
5. detect and test Claude Code and/or Codex CLI;
6. complete tap-toggle Dictation, clipboard, and screenshot exercises in Notes;
7. create and verify the Orchestrator task through the real Right Option cycle;
8. create and open the Unmute Agent's linked task through the real gesture;
9. start and save a Notetaker recording;
10. inspect the real Orchestrator and Notetaker destinations;
11. sign in, choose a plan, and land in the functioning app.

The run fails if any success is simulated, inferred only from elapsed time, or
displayed by an onboarding-only copy of a shipping surface.

## 8. Explicit non-goals

- Recreating MiniMe's visual layout.
- Retaining the current twelve-page onboarding underneath the video.
- Producing final founder footage before the experience is stable.
- Teaching every setting or advanced computer-use capability.
- Waiting for Notetaker summary generation before completion.
- Installing or authenticating a provider without the user's knowledge.
- Collecting Claude Code or Codex credentials in Unmute.

## 9. Implementation boundary

This document approves the experience and architecture, not implementation.
The next artifact is a task-level implementation plan that maps the coordinator,
manifest, event adapters, presenter, allowance, tests, and signed-build gates to
the current main-branch files. No legacy coached-onboarding implementation is to
be revived without re-evaluating it against this design and the current native
glass notch.
