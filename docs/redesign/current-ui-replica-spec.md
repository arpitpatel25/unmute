# Current Unmute UI Replica Specification

## Objective

Build a standalone browser atlas that ports every renderable state of the current Unmute pill and native-notch UI from `/Users/zodpatel/tools/unmute/unmute-cloud` at source revision `20dfd8fe5135371b7c4b5178a4124225a2e15662`. The atlas is the component source for the later guided landing-page experience; it is not itself marketing content.

## Source of truth

1. Complete Swift and TypeScript render conditions define state coverage and behavior.
2. Deterministic renders of the native helper define visual truth.
3. Constants, custom paths, embedded marks, exact text, and transition values come directly from source.
4. Browser code must cite its source file and symbol in the machine-readable manifest.
5. Existing `replica/`, `replica-v2/`, and `experience/` output is historical only and must not be copied as visual truth.

## Fidelity contract

- No placeholder icons, Unicode approximations, invented copy, invented states, or guessed dimensions.
- Custom product marks are ported from `UnMarkArt.swift` and `ProviderMarkArt.swift`.
- SF Symbols are rendered from the native system into frozen local transparent assets at required configurations; browser text substitutes are forbidden.
- SF Pro uses the macOS system stack with explicit source sizes, weights, line limits, tracking, and truncation.
- Geometry, padding, opacity, gradients, material fallbacks, z-order, clipping, and animation timing are transcribed exactly.
- Native Liquid Glass cannot share pixels with CSS compositing; acceptance is screenshot similarity against deterministic native renders on this Mac, with differences documented where the rendering engines make literal identity impossible.
- Every interactive control must expose every source-defined resting, hover, pressed, selected, disabled, open, closed, loading, success, and failure state.
- Reduced Motion receives a deterministic alternate state and no continuous animation.

## Coverage groups

1. Foundations: system colors, tones, material modes, typography, motion, shapes, buttons, badges, status dots, marks, waveform, and icon assets.
2. Pill: all `PillPhase`, `PillKind`, offline reasons, coaching, microphone states, raw/scratchpad, Agent/backend/model menus, Codex axes, unavailable providers, timer thresholds, hover cancel, Agent lane, and output/error variants.
3. Bar/notch: dormant, idle, active, attention, routing, toast, Agent activity, notched/non-notched geometry, hover detail, badges, truncation/drop rules, and each task status.
4. Pocket: faces, shoulder actions, slot rail, focused card, Agent card, task statuses, waiting questions, counts, scrolling, swipe, expanded/collapsed heights, and empty content.
5. Task/Agent conversation: header, stage states, questions/options, plans, work/tool calls, sources, file changes, user/assistant messages, links, terminal, unavailable sessions, usage, jump-to-latest, composer, attachments/staging, tools, dictation, configuration menus, and failures.
6. Cockpit/Orchestrator: wall, rail, groups, projects, one-offs, queues, skills, suggestions, proposals, imports, empty/loading/error states, selection, resizing, and navigation.
7. Scratchpad and meeting-note surfaces: every source-defined entry, capture, destination, pending, saved, failure, menu, and action state.
8. New conversation: provider, permissions, managed workspace, recent projects, search, preview, pending, effective access, validation, and error states.

## Deliverable architecture

- `replica-current/index.html`: neutral review shell and semantic mount points.
- `replica-current/src/`: focused ES modules grouped by foundations, pill, notch, pocket, conversation, cockpit, scratchpad, and note taker.
- `replica-current/styles/`: source-mapped tokens and component CSS.
- `replica-current/fixtures/manifest.json`: every state, source condition, fixture input, expected controls, and native baseline path.
- `replica-current/assets/`: only source-derived product art, SF Symbol renders, and deterministic fixture media.
- `replica-current/native/`: scripts and JSONL fixtures for driving the real native helper without modifying `unmute-cloud`.
- `replica-current/tests/`: manifest completeness, DOM geometry, interaction, accessibility, and screenshot comparison checks.

## Acceptance

- The manifest contains every branch identified by static source audit, with no uncited specimen.
- All manifest states render directly by URL and remain interactive in the atlas.
- Exact-value tests cover source constants and conditional visibility.
- Visual baselines exist for every top-level state and every materially different control state.
- Browser screenshots are compared with native baselines at matched dimensions and desktop backdrop.
- Existing landing pages and guided experience remain untouched until the atlas is approved.
