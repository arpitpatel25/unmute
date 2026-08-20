# Exact Interactive MacBook Demo Design

## Objective

Replace the invented landing-page prototype with one focused, interactive MacBook demo that faithfully translates the current Unmute product surfaces from `unmute-cloud/origin/main` into browser-native HTML, CSS, and JavaScript.

## Source of truth

- Native input surface: `PillView.swift`, `PillModel.swift`, `ScratchpadView.swift`, `ScratchpadModel.swift`, `Waveform.swift`.
- Native task surface: `NotchView.swift`, `NotchModel.swift`, `PocketView.swift`, `TaskSurfaceView.swift`, `Theme.swift`.
- Trigger behavior: `keyboard.ts` and `mode-router.ts`.
- Capture behavior: `help/Capture.tsx` and the capture store types.

The landing demo translates those files rather than inventing adjacent UI. SwiftUI material is represented by deterministic CSS using the native fixed-glass colors because browser HTML cannot instantiate macOS Liquid Glass or SF Symbols.

## Demo structure

The page keeps the existing light, restrained landing-page character. A compact mode selector above a single MacBook switches among four scripted demonstrations: Dictation, Scratchpad, Capture, and Unmute Remote. Only the MacBook demo is redesigned in this change.

Inside the MacBook, Apple Notes supplies the destination and makes delivery visible. The top-center notch and bottom-center input cluster remain distinct, matching the product architecture:

- Dictation, model selection, capture progress, and scratchpad controls live in the bottom pill cluster.
- Remote tasks, questions, progress, and results live in the notch.
- The scratchpad is an off-white paper surface beside the bottom pill, never a centered app modal.

## Interaction contracts

### Dictation

1. The visitor clicks or presses `Fn`.
2. The bottom pill enters `recording`, showing the record dot, live waveform, and stop control without a “Listening” label.
3. A second `Fn` tap enters `processing`, then `output`.
4. The scripted transcript is inserted at the Notes cursor and the pill gives a silent green-check acknowledgement.

### Scratchpad

1. `Fn` begins a normal dictation.
2. The visitor arms the pencil-tip Scratchpad chip.
3. Stopping holds the segment and leaves the pill in the amber `Paused` state.
4. `Fn` resumes the same pad. Further speech becomes a second ordered segment.
5. The paper pad offers the native destinations. `Paste at cursor` delivers the accumulated text into Notes.

### Capture

1. A normal dictation begins and the Scratchpad is armed.
2. Guided controls simulate copying a URL and taking a screenshot with `⌘⇧4` while the mic is hot.
3. The paper pad renders URL and image inserts among transcript segments in timestamp order.
4. `Paste at cursor` delivers text, link, and screenshot preview into Notes.

### Unmute Remote

1. The visitor taps `Right Option` to start. Remote is always tap-toggle: key-up is ignored.
2. The bottom cluster displays the joined agent/model control and Remote glyph.
3. The scripted task is submitted with a second `Right Option` tap.
4. The notch shows task creation and working state. Clicking it expands the task surface.
5. The scripted task resolves to a clear result (“Email sent successfully”), visible in the notch task surface. The demo can be replayed.

## Accessibility and responsive behavior

- All rendered keycaps are real buttons and expose their shortcuts and current action to assistive technology.
- Physical `Fn` cannot be captured reliably by browsers, so `F` is the keyboard fallback while the rendered `Fn` key remains the primary control. `Alt` is accepted for the Remote simulation where browser behavior allows it.
- Motion respects `prefers-reduced-motion`.
- On narrow screens the MacBook scales as one unit and the guide remains usable without horizontal page scrolling.

## Non-goals

- No redesign of the remaining landing-page copy, pricing, footer, or secondary pages.
- No microphone permission or real speech recognition.
- No real screenshot-folder or clipboard access.
- No separate Orchestrator window or dashboard inside the MacBook.
