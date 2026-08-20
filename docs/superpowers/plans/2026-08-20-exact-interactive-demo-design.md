# Live Unmute Web Demo Design

## Objective

Replace the scripted product tour with a browser-native mini Unmute client. The demo requests microphone permission, records the visitor's real voice, sends that recording to a dedicated Unmute demo transcription route, and renders the returned words through faithful web ports of the native pill, scratchpad, and notch surfaces.

## Permission boundary

The page requests microphone permission only. It does not request screen-sharing, filesystem, raw-keyboard, or persistent clipboard permission. Images enter through the browser's ordinary `paste` event or drag-and-drop. The page never polls or monitors the clipboard.

## Source of truth

- Recording transport: `unmute-cloud/desktop/engine-overrides/renderer/widget/useAudioRecorder.ts` and `desktop/electron/managed-client.ts`.
- Native input surface: `PillView.swift`, `PillModel.swift`, `ScratchpadView.swift`, `ScratchpadModel.swift`, and `Waveform.swift`.
- Native task surface: `NotchView.swift`, `NotchModel.swift`, `PocketView.swift`, `TaskSurfaceView.swift`, and `Theme.swift`.
- Trigger behavior: `keyboard.ts` and `mode-router.ts`.

SwiftUI cannot execute in a webpage, so its geometry, colors, typography, icons, transitions, and state contracts are translated into semantic HTML and CSS. No Orchestrator window or dashboard is introduced.

## Architecture

`demo-recorder.js` owns `getUserMedia`, `MediaRecorder`, timing, and WebM blob assembly. `demo-transcription.js` owns the HTTP contract and the five-attempt client display. `demo-state.js` remains a pure reducer, but its scripted transcripts are replaced by events carrying actual transcript and pasted-image data. `demo.js` coordinates those boundaries and revokes image object URLs when a mode resets.

The production route is configured through a `data-stt-endpoint` attribute. It accepts multipart `file`, `duration_seconds`, and `flow_type`, and returns the existing Unmute `{ ok, data: { text } }` envelope plus demo-attempt metadata. Quota enforcement belongs on the server; local storage is used only to restore the visitor-facing counter.

## Interaction contracts

### Dictation

1. The visitor enables the demo and grants microphone access.
2. A visible key control or supported keyboard shortcut starts recording.
3. Stopping uploads the recorded WebM to Unmute.
4. The returned transcript appears at the Notes cursor.

### Scratchpad

1. Recording starts normally and the visitor arms Scratchpad.
2. Stopping transcribes and holds the returned segment instead of delivering it.
3. Recording can resume and append further real segments.
4. `Paste at cursor` delivers the accumulated segments to Notes.

### Capture

1. The visitor records speech into an armed Scratchpad.
2. While the page is focused, `Command-V` accepts an image from `ClipboardEvent.clipboardData` without a permission request. Drag-and-drop is the fallback.
3. The real image preview appears in the ordered Scratchpad.
4. Delivery inserts the transcript and image into Notes.

### Remote

Remote records and transcribes the visitor's real task request. The browser then demonstrates the authentic notch working/result states; it does not claim to run a local agent on the visitor's Mac.

## Error and privacy behavior

- Permission denial explains how to enable the microphone and offers Retry.
- Empty, unsupported, or failed recordings never substitute scripted text.
- Network, quota, and transcription errors remain recoverable.
- Pasted images remain in browser memory and are not uploaded by the transcription request.
- The UI states that audio is sent to Unmute for transcription and that the free demo is limited to five submissions.

## Accessibility and responsive behavior

- Every control is a real button with visible focus and accurate labels.
- Keyboard shortcuts are enhancements, never the sole interaction.
- Live status uses polite announcements; failures use alert semantics.
- Motion respects `prefers-reduced-motion`.
- The MacBook scales as one unit without horizontal page scrolling.

## Non-goals

- No global `Fn` listener, silent clipboard monitoring, screen-sharing prompt, or screenshot-folder access.
- No real Remote execution on the visitor's Mac.
- No redesign of unrelated landing-page sections.
