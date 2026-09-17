# Unmute Help Guide — Design

**Date:** 2026-09-17  
**Status:** Approved direction; implementation specification

## Purpose

New users cannot currently form a simple mental model of Unmute. They do not know which key talks to the app under the cursor, which key talks to a coding session, which key talks to Unmute itself, how the pocket relates to sessions, or how to start meeting notes. Existing explanations are split across Settings and feature-specific pages, and several descriptions disagree with the behavior implemented by the keyboard state machine.

This feature adds a permanent, human-sounding guide that a person can revisit at any time. It is part of the core app, not onboarding. The Electron app, native notch, and Unmute Agent must all answer from the same guide content.

## Product principles

1. **Plain words first.** Copy sounds like one person helping another. Prefer “Talk to this session” over “route a capture to the task lane.”
2. **Useful in a glance.** The first screen teaches the product in roughly twenty seconds. Deeper details exist, but are not placed in the way of the basic explanation.
3. **Action, key, example.** Each explanation says what the action is for, how to invoke it, and gives one short example.
4. **The current product is the authority.** The guide reflects the actual keyboard and notch state machines. Existing stale help copy is corrected as part of this work; this project does not silently change gestures.
5. **One source of truth.** The same catalog drives Electron, the notch, and Agent answers. No surface keeps an independent prose copy of shortcuts.
6. **Configured keys are shown as configured.** The guide never presents “Fn or Right Option.” It reads Settings and names only the key and activation the person actually uses. Session work uses the complementary key, and that exact key is shown too.
7. **Permanent, not interruptive.** Help is always available but is not another onboarding tour, modal sequence, or first-run gate.

## The mental model

The overview teaches four ideas:

- **Dictation** puts the words you say into the app under your cursor.
- **A session** is one ongoing piece of work. Speak directly to it with the session key.
- **The Unmute Agent** is the session manager. It finds, compares, resumes, creates, and routes between sessions using what it knows from sessions, meetings, and remembered information. It is not the coding session doing the work.
- **Notetaker** records a meeting and prepares its transcript and notes.

The load-bearing distinction is:

> A session does the work. The Unmute Agent helps you find and manage sessions.

## Information architecture

### Electron app

Add **How to use Unmute** as a top-level sidebar destination. It appears first in the main navigation, above Dictation, matching the placement requested in the supplied sidebar reference. It is not nested under Settings, Agent, or Orchestrator.

The page has a short introduction followed by four compact sections:

1. **Dictation** — what it does; the exact configured key and activation; Capture; ordinary screenshots; copied text, links, paths, and images; output behavior; and Scratchpad.
2. **Sessions and the Unmute Agent** — what a session is; using the exact session key to create or talk directly to one; why the Unmute Agent is the session manager; when to ask it to find, compare, resume, create, or route work; and what it knows from sessions, Notetaker, and memory.
3. **Notetaker** — starting/stopping it, what is recorded, where notes appear, meeting screenshots, and asking the Unmute Agent about a recorded meeting.
4. **Every shortcut** — the complete verified reference, grouped by Dictation, Sessions and pocket, Unmute Agent, Meetings and screenshots, and Inside the notch.

The first section is fully visible and glanceable. Later sections use compact cards or disclosure rows; they are not long articles. Existing detailed Help pages remain available for specialist details, but the new guide becomes the primary explanation and links to those pages only where useful.

### Native notch

Add a small Help button to the expanded dashboard/session chrome and an entry on the notch’s empty/dashboard state. It opens a temporary Help sheet over the notch surface; Help is not represented as a session or pocket card.

The notch sheet exposes four compact destinations:

- **Dictation**
- **Sessions and Agent**
- **Pocket and navigation**
- **Notetaker**

It uses the same guide entries as Electron, but shows only their short form. Its footer says, in plain language, that the person can ask the Unmute Agent any “How do I…?” question.

The sheet obeys existing surface behavior: Escape closes Help first, without closing the underlying session. Opening Help does not start, stop, route, or focus a capture.

### Unmute Agent

Add a read-only Help capability backed by the same catalog. It supports an index request and a natural-language query. Results return the best matching entries, their resolved shortcut text, conditions, and examples.

The Agent constitution gains one compact rule: when a person asks how to use Unmute, consult the Help capability and answer from it. The full guide is not inserted into every system prompt. This avoids permanent prompt cost and keeps answers synchronized with the product.

Example questions the capability must answer:

- “What does Right Option do?”
- “How do I get back to a session?”
- “What is the Unmute Agent for?”
- “How do I start meeting notes?”
- “How do I take a screenshot during a meeting?”
- “Why did Escape close the pocket?”

## Shared guide catalog

The canonical content is structured data rather than free-standing UI copy. Each entry contains:

- stable id
- section
- short title
- plain-language summary
- optional steps
- optional shortcut gesture
- optional repeat/next action
- conditions or availability
- one short example
- search keywords
- source references to the behavior-owning code

The catalog supports tokens for configured values such as the current dictation key and the complementary session key. Resolution happens before content is rendered or returned to the Agent.

The resolved guide contains one dictation key and one session key. It never renders both possibilities or says “depending on Settings.” Activation copy is resolved the same way: a tap-toggle user sees tap instructions, a push-to-talk user sees hold/release instructions, and a dual-mode user sees the dual gesture.

A Markdown reference is generated from or kept as a checked representation of this catalog for product review. Markdown is not independently edited by each UI surface.

Catalog validation fails tests for duplicate ids, missing summaries, unresolved tokens, unknown section ids, or shortcuts without a behavior source.

## Shortcut inventory

The implementation starts from this code-backed inventory and extends it only when another product-specific shortcut is found during implementation.

### Voice

- **Dictation key:** show only the exact key selected in Settings.
- **Dictation activation:** show only the exact activation selected in Settings: tap to start/tap to stop, hold/release, or dual mode.
- **Session key:** the key not assigned to Dictation; the current state machine taps once to start and taps again to submit.
- **Right Command:** the current state machine double-taps to start the Unmute Agent and single-taps to submit.
- **Escape during a voice capture:** cancel the current utterance; do not discard held Scratchpad work.

### Sessions and pocket

- **Hold Right Command first, then tap Right Option:** open the pocket on its first card.
- **Repeat that chord while the pocket is open:** expand the selected card.
- **Repeat while already expanded:** no action.
- **Left/Right Arrow in an open, focused pocket:** select the previous/next card.
- **Return or Enter in the pocket:** expand the selected card.
- **Escape:** close the command menu first when present; otherwise step the visible Help/pocket/session surface down according to the existing surface ladder.
- **Left/Right Arrow in the expanded task/dashboard surface:** move through sessions when a text field is not active.

### Meetings and screenshots

- **Double-tap Left Control:** start Notetaker; double-tap again to stop.
- **Double-tap Left Command during an active meeting:** save a full-screen meeting reference.
- **Hold Left Command for about 600 ms during an active meeting:** interactively select a region to save as a meeting reference.
- Meeting screenshot gestures are ignored when Notetaker is not active or another ordinary voice capture owns the capture lane.

### Capture while speaking

When Capture is enabled and an ordinary voice capture is live:

- Copying text, a link, a path, or an image attaches it at that point in the spoken request.
- macOS full-screen and region screenshots (`Command-Shift-3` and `Command-Shift-4`) are added at that point in the request.
- **Scratchpad** holds dictation and captured material instead of delivering it when the mic stops, so the person can build something across several captures and send it when ready.

### Notch composer

- A leading `/` opens the current session’s command menu when commands are available.
- Up/Down moves through command matches.
- Tab or Return accepts the highlighted command.
- Escape closes the command menu before it closes the underlying surface.
- Standard macOS editing shortcuts continue to work in notch text fields; they are listed quietly, separate from Unmute-specific shortcuts.

## Copy corrections

Several existing descriptions conflict with the implementation. This feature corrects the descriptions to the current behavior rather than preserving contradictions:

- Agent help currently says to hold Right Command, while the keyboard state machine uses double-tap to start and single-tap to submit.
- Settings currently describes the session trigger as hold/release, while the keyboard state machine uses tap-toggle.
- A native listener comment describes a single-tap Notetaker stop, while the keyboard state machine uses double-tap for both start and stop.

If any of those gestures are meant to change, that is a separate behavior decision and must change the state machine and its tests before this guide describes it.

## Writing style

- Sentences are short and spoken, not technical.
- Headings answer human questions: “Where did my session go?” rather than “Session lifecycle.”
- Avoid “orchestrate,” “route,” “lane,” “principal,” “capability,” and provider implementation terms in user copy.
- Prefer one concrete example to another explanatory paragraph.
- Never claim a gesture works everywhere when it is conditional.
- Use familiar key names: “Right Command,” “Right Option,” “Left Control.”
- Details are revealed on demand. The overview never becomes a manual.

Example copy:

> **Talk to this session**
>
> Tap your session key, say what you want, then tap it again.
>
> “Now add keyboard navigation.”

> **Can’t remember which session?**
>
> Ask the Unmute Agent. It can find the work and bring it back.
>
> “Find the session where we changed Google login.”

## Data flow

1. Main owns the canonical guide catalog and resolves the current Dictation key, Dictation activation, and complementary session key.
2. The Electron renderer requests or imports the resolved guide and renders the full page.
3. Main sends the resolved short-form guide to the native notch through its existing JSON IPC command stream.
4. The Agent Help capability searches the same resolved catalog and returns matching entries.
5. Settings changes invalidate the resolved view and refresh open guide surfaces.

The guide remains usable if the notch is unavailable. The notch remains usable if guide data cannot be decoded: it omits Help content and logs the schema error rather than affecting sessions or captures. The Agent capability returns a plain unavailable result if the catalog fails validation; it never invents shortcut behavior.

## Testing

### Shared content

- Catalog schema and unique-id validation.
- Dynamic dictation/session key resolution in both configurations.
- Dynamic activation copy for tap-toggle, push-to-talk, and dual mode.
- No resolved entry contains the unused Dictation key or “depending on Settings.”
- Query matching for common natural-language questions and key names.
- Markdown/reference generation has no unresolved tokens.

### Electron

- The new destination is the first top-level sidebar item.
- Selecting it renders the overview and complete shortcut sections.
- Switching trigger settings updates displayed key names.
- Existing navigation destinations still render unchanged.

### Native notch

- Help opens from the dashboard/session entry points.
- Escape closes Help before changing the underlying session surface.
- Help receives and displays the resolved keys.
- Help never changes pocket position, capture route, or session state.

### Agent

- The Help tools are available only to the Unmute Agent principal.
- Queries return the expected guide entries and current configured keys.
- The Agent constitution directs product-usage questions to Help without embedding the entire guide.
- Existing capability-policy and constitution-coverage tests continue to pass.

### Regression

- Keyboard lane, Notetaker gesture, pocket chord, notch controller, and session-manager tests remain unchanged and pass.
- TypeScript typechecks and native notch tests pass.

## Scope boundaries

- No new onboarding step or forced tour.
- No Instruct explanation or shortcut; that feature is being removed.
- No keyboard behavior changes unless separately approved.
- No analytics or remote documentation service.
- No web-hosted help center.
- No duplication of the entire existing detailed Help library in the notch.
- No autonomous Agent action from a help question; Help is read-only.
