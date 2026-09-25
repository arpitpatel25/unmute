# Onboarding recordings v2 — edit and integration record

Source folder: `/Users/zodpatel/Downloads/Unmute onboarding part 2`

Branch: `arpit/onboarding-recordings-v2`, based on main `57863d0d` (identical to `origin/main` after fetching on Sep 25).

## Inspection status

Inventoried all 17 MP4s (all 3840×2160), read the matching exported SRTs, compared the existing lesson actions, checked audio transcription where wording was unclear, and inspected representative raw and captioned frames. Fourteen complete new takes are selected for onboarding, with corrected caption sidecars. The source recordings in Downloads remain untouched.

## Source-to-lesson plan

Owner direction (Sep 25): preserve every spoken line of each selected new recording. The later requested polish removes only the silent recording-stop tail and holds the last camera-facing frame briefly so the downward glance is not shown. No take is split or shortened within speech.

| New source | Duration | Proposed use |
| --- | ---: | --- |
| Introduce Unmute for Mac | 32.42s | Selected complete welcome |
| Privacy and Dictation Notice | 14.23s | Selected complete new privacy recording |
| Meet Unmute_ Ears for your MacBook | 35.23s | Alternate welcome, not selected |
| Enabling Microphone Access for Unmute | 7.71s | Microphone permission |
| Enabling Accessibility for Unmute | 10.43s | Accessibility permission |
| Configuring Mac OS Keyboard Settings for Dictation | 18.92s | Function-key setup; match the spoken “we've opened” wording to actual UI behavior |
| Enabling System Audio for Unmute | 11.75s | System Audio permission |
| Using Unmute with Your Copilot Plan | 14.63s | Provider readiness; transcript names Claude/Codex, not Copilot support |
| Using Dictation in Apple Notes | 14.79s | Alternate dictation take, not selected |
| Using Dictation in Apple Notes (1) | 17.70s | Selected complete dictation take |
| Dictating with Copied Text and Links | 39.94s | Clipboard lesson; provide actual selectable example text, not only a phrase to dictate |
| Streamline Your Workflow with Voice Dictation and Screenshots | 63.88s | Screenshot lesson; retain complete recording |
| Trigger AI Tasks Anywhere on Mac | 72.52s | Task exercise; retain complete recording |
| Introduction to Unmute Agent | 136.44s | Agent explanation + exercise; retain complete recording |
| Introducing the Unmute Note Taker | 10.38s | Unfinished take, ends mid-sentence; not selected |
| Unmute AI Note Taker & Agent | 68.62s | Selected complete Notetaker and Agent/notes explanation |
| Introduction to Unmute | 23.75s | Selected complete closing philosophy; not a spoken dashboard tour or sign-in instruction |

## Decisions before replacement

- Privacy: the user added `Privacy and Dictation Notice.mp4` to the new folder on Sep 25. It is a separate 14.234s, 3840×2160, 60fps recording with no burned-in text at the inspected frame. Its exported SRT had “clot code”; the v2 caption render corrects it to “Claude Code”. The older archived take and packaged v1 clip are no longer used.
- Notetaker: the complete recording never explains the start/save shortcut. The live card now provides double-tap Left Control → speak → Save, while retaining real recording/save event gates.
- Clipboard: the new recording tells viewers to copy sample text shown below. The live card now supplies selectable sample text, and the presenter becomes focusable for this step so Command+C works.
- Function key: the recording says Keyboard Settings has opened. Entering that step now opens the macOS pane; the card also keeps an Open Keyboard Settings fallback button.
- Dashboard and sign-in: no matching new walkthroughs exist. Agent/notes and sign-in are text-only action cards; the complete new closing take plays at product orientation. The old recordings for these sections are no longer imported.
- Long exercises: completion queues the next chapter until narration ends. A message tells the viewer when the task finished, while Skip and Close remain available. Text-only chapters advance without a nonexistent-video wait.
- Close: the presenter is destroyed immediately, before waiting on the progress-file write. Queued receipts are prevented from sending a new presenter command during dismissal, so they cannot reopen it.
- Notch: the real created task is automatically expanded after its creation receipt; the Agent chat opens on the Agent exercise and again for the Agent/notes explanation. The real Notetaker pill remains user-triggered.

## Picture and captions

- The presenter preserves a 16:9 landscape composition with `object-fit: contain`. The media is reframed before captions are burned in: a 2844×1600 source crop centered on the founder for 13 takes, while the already-close Notetaker take retains its original frame.
- Keep the existing dark-glass visual language and controls. No return of the old colored bars or oversized logo.
- No spoken audio is trimmed or sped up. Each clip ends about 0.1 seconds after its final caption; the unused 1–2-second recording-stop tail is removed. The final camera-facing frame is held for roughly half a second (about 1.15 seconds in the Keyboard Settings take, whose glance starts earlier). Source files remain intact.
- Caption treatment: Avenir Next Demi Bold at 44px in a 1280×720 master, sentence case, white with a restrained dark outline and safe bottom margin. The first render incorrectly used huge centered captions; it was discarded. Current welcome, Agent, Notetaker, and screenshot frames were visually checked, including at the 400px widget width.
- Recognition corrections include Claude Code, Codex, Unmute, macOS, Globe key, Apple Notes, Command+C, Right Option, Right Command, PR, “agentic loop” (confirmed independently by transcription), and “sending state”. Every caption ends before its output MP4, and every output has matching audio/video durations within 0.002 seconds.
- Corrected SRTs are kept alongside each v2 MP4 for future revisions. The reproducible render script is `desktop/scripts/prepare-onboarding-clips-v2.mjs`.

## Verification scope

Run only focused presenter/state and onboarding-window tests after the final wiring, check every source mapping and caption timeline, and inspect rendered caption samples. The owner separately requested a notarized dev build and installation; broad desktop suites remain out of scope.
