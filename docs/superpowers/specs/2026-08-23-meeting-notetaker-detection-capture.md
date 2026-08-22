# Meeting notetaker — detection + capture

**Status:** design-complete, not yet built.
**Date:** 2026-08-23
**Branch:** `arpit/notetaker`

Bot-free meeting notes: detect that a meeting is happening and capture the
other participant(s)' audio alongside the user's own mic, without joining
Zoom/Meet/Teams as a bot or participant. Proven feasible — Granola and
Wispr Flow's notetaker both ship this today on the same OS APIs.

## 1. Scope

**In scope (v1):**
- Detect that a meeting is in progress, in a native meeting app or a browser
  tab, and prompt the user to start/stop.
- Manual start/stop via a dedicated hotkey gesture (see §5), independent of
  detection.
- Capture system audio (the other side of the call) alongside the existing
  mic capture, as two separate streams.

**Explicitly out of scope for v1** (raised and deliberately dropped in
discussion, not just deferred silently):
- Calendar/Gmail/Slack integration for speaker names or scheduled-meeting
  awareness. Detection is purely "is a meeting app producing audio right now."
- Screen capture.
- Speaker diarization *within* a stream (see §4 — not needed for 1:1 calls;
  genuinely unsolved for group calls with 3+ remote participants, since Groq's
  Whisper has no diarization support and none is being added in v1).
- Tab-level audio isolation. Core Audio taps operate at process/process-group
  granularity; there is no OS API to isolate one browser tab's audio from
  another tab in the same browser, in any browser, including Chrome.

## 2. Two decoupled capabilities

Detection and capture do not depend on each other. Capture works with zero
detection support (pure manual trigger); detection is a proactive layer on
top. Build capture first — it's the universal baseline.

**Detection** — "a meeting seems to be happening, prompt the user."
Signal: `readNowPlaying()` (`desktop/engine-overrides/electron/mediaController.ts:78`,
already shells out to the vendored `mediaremote-adapter` and returns bundle ID
+ playing state) matched against a small hardcoded meeting-app list, plus
browser tab URL where available (see §3). Require the audio-active signal to
hold for a short debounce window before prompting, to avoid false positives
from an idle Zoom window sitting in the background.

**Capture** — "grab the audio, right now, from whatever the user just
triggered on."
Mechanism: macOS Core Audio Process Tap (`AudioHardwareCreateProcessTap`,
macOS 14.2+), scoped to the PID (or process group, for browsers) of the
frontmost/target app. Target app resolved via the existing `frontmostApp`/
`listApps` native calls (`desktop/native-ax/src/ax.mm:364,381`). This is new
native code — nothing in the repo does system-audio capture today; the
closest existing piece, `mediaPause.ts`, does the opposite (pauses other
apps' audio during dictation) and will need to coexist with this feature
rather than fight it.

Mic capture (the user's own voice) is unchanged — existing
`useAudioRecorder.ts` `getUserMedia()` path. The two streams (mic + system tap)
stay separate rather than being mixed down, so "which side said what" is a
channel property, not something inferred — sufficient to label the two
parties in a 1:1 call with no diarization step at all.

## 3. Coverage by surface

| Surface | Detection | Capture | Notes |
|---|---|---|---|
| Native app (Zoom.app, Teams.app, Webex.app) | Yes — bundle ID via `readNowPlaying()`/`listApps` | Yes — tap that PID | Cleanest case, no browser involved |
| Browser: Chrome | Yes — `unmute-in-chrome` extension reads active tab URL | Yes — tap Chrome's process group | Extension already exists (built for Codex parity) |
| Browser: Safari/Edge/Brave/Arc | Yes — AppleScript `URL of active tab of window 1` polling, one-time Automation-permission prompt | Yes — tap that browser's process group | New, small: a poll loop, no extension needed |
| Browser: Firefox | **No** — Firefox has no AppleScript tab-URL support (dropped in v3.6, never restored) | Yes — manual trigger still taps Firefox's process group | Detection gap is permanent absent a Firefox extension; capture is unaffected |
| Anything unrecognized | No | Yes — manual trigger taps whatever app is frontmost | Universal fallback, always available |

Manual trigger capture works identically across every row — it never needs
to know it's looking at a "meeting," only which app is currently frontmost.

## 4. Timestamps

Note-taker's two streams (mic + system tap) must carry synchronized
timestamps, since merging "who said what, in what order" across two
independently-captured streams requires time alignment — this is what
substitutes for diarization in a 1:1 call (§2). This timestamp requirement is
**specific to note-taker**; the existing dictation/agent transcript paths are
unchanged and stay untimestamped.

## 5. Coexistence with existing Unmute features

Note-taker running does **not** suspend or compete with anything else in the
app. While a meeting is being recorded, regular dictation, screenshot capture,
the Unmute Agent, and any other existing hotkey-driven feature must continue
to work exactly as they do today — mic-only audio, same triggers, same
behavior. Note-taker is additive, not a mode the rest of the app defers to.

Concretely: the existing mutual-exclusion lock set
(`dictationActive`/`remoteActive`/`agentActive` in
`desktop/engine-overrides/electron/keyboard.ts`) stays as-is and untouched.
Note-taker gets its own independent state (`notesActive`) that sits outside
that lock group — it does not block, and is not blocked by, any of the
existing three.

**Open risk, not yet verified:** whether the mic can be consumed by two
independent capture sessions at once (note-taker's mic stream + a concurrent
regular-dictation `getUserMedia()` call), and whether the existing warm-mic
keep-alive logic (`desktop/engine-overrides/renderer/widget/micWarm.ts`)
assumes a single consumer. Needs a spike before implementation, not assumed
solved by this spec.

## 6. Trigger & UX

**Start:** double-tap **left-Control + left-Option held together** (the
chord itself, double-tapped — not two separate keys in sequence). Chosen
because it doesn't collide with anything currently wired: fn is regular
dictation, right-Option and right-Command are already used by other gestures
(`desktop/engine-overrides/electron/keyboard.ts`,
`paywall/remote/capture/agentGesture.ts`). Hardcoded for v1; configurable
later, not now.

**Stop is a confirm, not a direct action** — pressing the trigger again while
note-taker is active does not stop it immediately. It surfaces a confirm
prompt ("Stop note-taking?"). The user resolves it one of two ways:
- Respond to the prompt directly, or
- Click the floating widget (see §7) and choose Cancel from it.

Detected-meeting-ended (§2, for surfaces where detection is available) drives
the same confirm prompt symmetrically, rather than auto-stopping.

## 7. Widget UI

A small floating circular widget, positioned **bottom-left of the screen** —
visible at a glance, not buried in a menu or settings panel. Shows a live
waveform (no timer needed — the waveform itself communicates "recording").
Clicking it (mouse) surfaces the cancel option described in §6.

## 8. Permissions

Capture requires a new TCC grant distinct from anything Unmute currently
requests: **Screen & System Audio Recording → System Audio Recording Only**,
gated by `com.apple.security.device.audio-input` entitlement and an
`NSSystemAudioCaptureUsageDescription` plist string. There is no
`requestAuthorization`-style API — the prompt only fires when IO actually
starts on the tap-backed aggregate device, so the first real capture attempt
is also the permission request. Needs its own onboarding copy, separate from
the existing mic-permission flow.

AppleScript tab polling (Safari/Edge/Brave/Arc path) needs one Automation
(Apple Events) permission grant per target browser, prompted on first query.

## 9. Known risks / open questions

- Browser audio is split across multiple processes (main, renderer, GPU,
  audio helper) — tapping "the browser" may mean tapping a process *group*,
  not a single PID. Needs prototyping per browser before assuming uniform
  behavior.
- Bluetooth headset caveat, unrelated to this feature but shares the mic
  path: macOS forces the BT link to HFP/mSBC (lower quality) the moment the
  headset's mic is active, for the duration of the call. Not fixable at the
  app level — worth setting user expectations, not a bug to chase.
- Whole-app audio capture picks up anything else that app is playing (e.g. a
  second Chrome tab with music) — no per-tab filtering exists to guard
  against this, in any browser.
- Dual mic consumption (note-taker + a concurrent regular dictation session)
  is unverified — see §5.
