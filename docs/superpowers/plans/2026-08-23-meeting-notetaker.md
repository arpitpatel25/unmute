# Meeting Notetaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot-free meeting notes — detect a meeting (native app or browser tab) and capture system audio (the other side of the call) alongside the existing mic capture, triggered by a dedicated hotkey, without disturbing any existing Unmute feature.

**Architecture:** A pure-logic detection layer (bundle-ID + browser-tab matching, debounced) drives an OS-notification prompt. A new native Core Audio Process Tap addon (macOS 14.2+, mirroring the existing `native-ax`/`native-fn-listener` in-process pattern) captures system audio on trigger, timestamped independently and merged with the existing mic stream at the session-orchestration layer — two channels, no diarization needed for 1:1 calls. The hotkey (new left-Control+left-Option chord) and its state (`notesActive`) sit outside the existing `dictationActive`/`remoteActive`/`agentActive` mutual-exclusion lock, so note-taking runs concurrently with every other Unmute feature, not instead of them.

**Tech Stack:** TypeScript (Electron main process, `node:test` for tests), Objective-C++ native addon (napi/node-addon-api, Core Audio), AppleScript (via `osascript`) for non-Chrome browser tab detection.

**Spec:** `docs/superpowers/specs/2026-08-23-meeting-notetaker-detection-capture.md`

## Global Constraints

- macOS 14.2+ required for `AudioHardwareCreateProcessTap` (spec §2, §8). No fallback for older macOS — capture is simply unavailable there; detection can still run.
- No calendar/Gmail/Slack integration, no screen capture, no diarization beyond the two-channel (mic vs. system) split (spec §1).
- Existing features (`dictationActive`/`remoteActive`/`agentActive` in `keyboard.ts`) must not be touched in a way that makes them depend on or block note-taker state (spec §5).
- Trigger: double-tap **left-Control + left-Option held together**, hardcoded for v1 (spec §6).
- Stop is a confirm, never a direct action (spec §6).
- Widget: small floating circle, bottom-left, live waveform, no timer (spec §7).
- Test runner is Node's built-in `node:test` via `tsx`, house style is `import test, { describe } from 'node:test'` + `import assert from 'node:assert/strict'` — see `desktop/engine-overrides/electron/mediaPause.test.ts` for the exact pattern. No vitest, no jest.
- All new/changed files live under the `desktop/` tree of this repo (`unmute-cloud`), following the engine-overrides model already used for `keyboard.ts`, `mediaPause.ts`, etc.

---

## Task 1: Meeting-app bundle-ID allowlist + matcher

**Files:**
- Create: `desktop/engine-overrides/electron/meetingApps.ts`
- Test: `desktop/engine-overrides/electron/meetingApps.test.ts`

**Interfaces:**
- Produces: `MEETING_APP_BUNDLE_IDS: readonly string[]`, `isMeetingAppBundleId(bundleId: string | undefined): boolean`, `MEETING_TAB_URL_PATTERNS: readonly RegExp[]`, `isMeetingTabUrl(url: string | undefined): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/meetingApps.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { isMeetingAppBundleId, isMeetingTabUrl } from './meetingApps'

describe('meeting-app bundle ID matching', () => {
  test('matches Zoom', () => {
    assert.equal(isMeetingAppBundleId('us.zoom.xos'), true)
  })
  test('matches Microsoft Teams', () => {
    assert.equal(isMeetingAppBundleId('com.microsoft.teams2'), true)
  })
  test('matches Webex', () => {
    assert.equal(isMeetingAppBundleId('Cisco-Systems.Spark'), true)
  })
  test('does not match an unrelated bundle id', () => {
    assert.equal(isMeetingAppBundleId('com.spotify.client'), false)
  })
  test('does not match undefined', () => {
    assert.equal(isMeetingAppBundleId(undefined), false)
  })
  test('browser bundle ids are never meeting apps by themselves', () => {
    assert.equal(isMeetingAppBundleId('com.google.Chrome'), false)
    assert.equal(isMeetingAppBundleId('com.apple.Safari'), false)
  })
})

describe('meeting tab URL matching', () => {
  test('matches a Google Meet call URL', () => {
    assert.equal(isMeetingTabUrl('https://meet.google.com/abc-defg-hij'), true)
  })
  test('matches a Zoom web-join URL', () => {
    assert.equal(isMeetingTabUrl('https://us05web.zoom.us/j/1234567890'), true)
  })
  test('matches a Teams web URL', () => {
    assert.equal(isMeetingTabUrl('https://teams.microsoft.com/l/meetup-join/abc'), true)
  })
  test('does not match the Meet marketing homepage query-less root', () => {
    assert.equal(isMeetingTabUrl('https://meet.google.com/'), false)
  })
  test('does not match an unrelated URL', () => {
    assert.equal(isMeetingTabUrl('https://www.youtube.com/watch?v=abc'), false)
  })
  test('does not match undefined', () => {
    assert.equal(isMeetingTabUrl(undefined), false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/meetingApps.test.ts`
Expected: FAIL — `Cannot find module './meetingApps'`

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/meetingApps.ts

/**
 * Native meeting-app bundle IDs, matched against readNowPlaying()'s
 * bundleIdentifier or native-ax's listApps()/frontmostApp(). Browser bundle
 * IDs (Chrome, Safari, etc.) are deliberately excluded here — a browser
 * running is not itself a meeting signal; see isMeetingTabUrl for that case.
 */
export const MEETING_APP_BUNDLE_IDS: readonly string[] = [
  'us.zoom.xos', // Zoom desktop
  'com.microsoft.teams2', // Teams (new)
  'com.microsoft.teams', // Teams (classic)
  'Cisco-Systems.Spark', // Webex
  'com.cisco.webexmeetingsapp', // Webex Meetings
  'com.google.meet', // Google Meet desktop wrapper (rare, but exists)
  'com.hnc.Discord', // Discord voice/video channel
  'com.electron.discord',
]

export function isMeetingAppBundleId(bundleId: string | undefined): boolean {
  if (!bundleId) return false
  return MEETING_APP_BUNDLE_IDS.includes(bundleId)
}

/**
 * Browser tab URL patterns for the browser-based meeting surfaces (spec §3).
 * Deliberately requires a path/query beyond the bare root — meet.google.com/
 * alone is the marketing page, not an active or joinable call.
 */
export const MEETING_TAB_URL_PATTERNS: readonly RegExp[] = [
  /^https:\/\/meet\.google\.com\/[a-z0-9-]{3,}/i,
  /^https:\/\/([a-z0-9-]+\.)?zoom\.us\/(j|wc)\//i,
  /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//i,
  /^https:\/\/([a-z0-9-]+\.)?webex\.com\/(meet|join)\//i,
]

export function isMeetingTabUrl(url: string | undefined): boolean {
  if (!url) return false
  return MEETING_TAB_URL_PATTERNS.some((pattern) => pattern.test(url))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/meetingApps.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/meetingApps.ts desktop/engine-overrides/electron/meetingApps.test.ts
git commit -m "notetaker: add meeting-app bundle ID and tab URL matchers"
```

---

## Task 2: Browser tab watcher (AppleScript, for Safari/Edge/Brave/Arc)

Chrome's tab URL is already reachable via the existing `unmute-in-chrome` extension bridge (out of scope here — Task 9 wires that channel in). This task covers the non-Chrome, AppleScript-scriptable browsers per spec §3.

**Files:**
- Create: `desktop/engine-overrides/electron/browserTabWatcher.ts`
- Test: `desktop/engine-overrides/electron/browserTabWatcher.test.ts`

**Interfaces:**
- Consumes: Node's `child_process.execFile` (injected for testability, see below)
- Produces: `type ExecFile = (cmd: string, args: string[]) => Promise<string>`, `AppleScriptBrowser` (`'Safari' | 'Microsoft Edge' | 'Brave Browser' | 'Arc'`), `getActiveTabUrl(browser: AppleScriptBrowser, execFile: ExecFile): Promise<string | undefined>`, `SUPPORTED_APPLESCRIPT_BROWSERS: readonly AppleScriptBrowser[]`

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/browserTabWatcher.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { getActiveTabUrl, SUPPORTED_APPLESCRIPT_BROWSERS } from './browserTabWatcher'

describe('AppleScript active-tab URL lookup', () => {
  test('returns the trimmed stdout as the URL on success', async () => {
    const url = await getActiveTabUrl('Safari', async () => 'https://meet.google.com/abc-defg-hij\n')
    assert.equal(url, 'https://meet.google.com/abc-defg-hij')
  })

  test('returns undefined when the browser is not running (osascript throws)', async () => {
    const url = await getActiveTabUrl('Safari', async () => {
      throw new Error('Application isn\'t running')
    })
    assert.equal(url, undefined)
  })

  test('returns undefined for empty stdout', async () => {
    const url = await getActiveTabUrl('Arc', async () => '')
    assert.equal(url, undefined)
  })

  test('builds the correct AppleScript for Safari (front document, no active-tab index needed)', async () => {
    let capturedArgs: string[] = []
    await getActiveTabUrl('Safari', async (_cmd, args) => {
      capturedArgs = args
      return 'https://example.com'
    })
    assert.ok(capturedArgs.some((a) => a.includes('tell application "Safari"')))
    assert.ok(capturedArgs.some((a) => a.includes('URL of current tab of front window')))
  })

  test('builds the correct AppleScript for Chromium-family browsers (active tab of front window)', async () => {
    let capturedArgs: string[] = []
    await getActiveTabUrl('Microsoft Edge', async (_cmd, args) => {
      capturedArgs = args
      return 'https://example.com'
    })
    assert.ok(capturedArgs.some((a) => a.includes('tell application "Microsoft Edge"')))
    assert.ok(capturedArgs.some((a) => a.includes('URL of active tab of front window')))
  })

  test('supported browser list matches spec §3', () => {
    assert.deepEqual(
      [...SUPPORTED_APPLESCRIPT_BROWSERS].sort(),
      ['Arc', 'Brave Browser', 'Microsoft Edge', 'Safari'].sort()
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/browserTabWatcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/browserTabWatcher.ts
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

export type AppleScriptBrowser = 'Safari' | 'Microsoft Edge' | 'Brave Browser' | 'Arc'

export const SUPPORTED_APPLESCRIPT_BROWSERS: readonly AppleScriptBrowser[] = [
  'Safari',
  'Microsoft Edge',
  'Brave Browser',
  'Arc',
]

export type ExecFile = (cmd: string, args: string[]) => Promise<string>

const defaultExecFile: ExecFile = promisify(execFileCb) as unknown as ExecFile

/**
 * Safari's AppleScript dictionary exposes "current tab of front window";
 * Chromium-family browsers (Edge, Brave, Arc — like Chrome) expose
 * "active tab of front window" instead. Firefox has no AppleScript tab-URL
 * support at all (dropped in Firefox 3.6, never restored) and is
 * deliberately not in SUPPORTED_APPLESCRIPT_BROWSERS — spec §3.
 */
function scriptFor(browser: AppleScriptBrowser): string {
  const tabExpr = browser === 'Safari' ? 'URL of current tab of front window' : 'URL of active tab of front window'
  return `tell application "${browser}" to get ${tabExpr}`
}

/**
 * Returns the active tab's URL for a running AppleScript-scriptable browser,
 * or undefined if the browser isn't running, has no windows, or the script
 * fails for any reason. Never throws — this is a best-effort polling signal,
 * not a hard dependency (spec §3, §9).
 */
export async function getActiveTabUrl(
  browser: AppleScriptBrowser,
  execFile: ExecFile = defaultExecFile
): Promise<string | undefined> {
  try {
    const stdout = await execFile('osascript', ['-e', scriptFor(browser)])
    const trimmed = stdout.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/browserTabWatcher.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/browserTabWatcher.ts desktop/engine-overrides/electron/browserTabWatcher.test.ts
git commit -m "notetaker: add AppleScript active-tab watcher for Safari/Edge/Brave/Arc"
```

---

## Task 3: Meeting detection orchestrator (debounced start/end signal)

Combines Task 1's matcher, Task 2's tab watcher, and the existing `readNowPlaying()` (`desktop/engine-overrides/electron/mediaController.ts:78`) into a single debounced "meeting likely active" boolean stream. Pure logic, fully unit-testable by injecting a fake clock and fake sample source — no real timers or real `readNowPlaying()` calls in the test.

**Files:**
- Create: `desktop/engine-overrides/electron/meetingWatcher.ts`
- Test: `desktop/engine-overrides/electron/meetingWatcher.test.ts`

**Interfaces:**
- Consumes: `isMeetingAppBundleId`, `isMeetingTabUrl` (Task 1); `NowPlaying` shape `{ playing: boolean; bundleIdentifier?: string }` (already defined in `mediaPause.ts:30-33`)
- Produces:
  ```ts
  export type MeetingSample = { nowPlaying: NowPlaying; activeTabUrl?: string }
  export type MeetingWatcherEvents = { onMeetingStarted: () => void; onMeetingEnded: () => void }
  export class MeetingWatcher {
    constructor(events: MeetingWatcherEvents, debounceMs?: number, now?: () => number)
    feed(sample: MeetingSample): void
    get isMeetingActive(): boolean
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/meetingWatcher.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { MeetingWatcher } from './meetingWatcher'

describe('MeetingWatcher debounced detection', () => {
  test('does not fire on a single sample below the debounce window', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 0)
    assert.equal(watcher.isMeetingActive, false)
  })

  test('fires onMeetingStarted once the signal holds for the debounce window', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 1)
    assert.equal(watcher.isMeetingActive, true)
  })

  test('does not re-fire onMeetingStarted while already active', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 3200
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 1)
  })

  test('fires onMeetingEnded once the signal drops and holds for the debounce window', () => {
    let started = 0
    let ended = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => ended++ }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1700
    watcher.feed({ nowPlaying: { playing: false, bundleIdentifier: 'us.zoom.xos' } })
    clock = 3300
    watcher.feed({ nowPlaying: { playing: false, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 1)
    assert.equal(ended, 1)
    assert.equal(watcher.isMeetingActive, false)
  })

  test('a matching browser tab URL counts as a meeting signal even for a non-meeting-specific bundle id', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'com.google.Chrome' }, activeTabUrl: 'https://meet.google.com/abc-defg-hij' })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'com.google.Chrome' }, activeTabUrl: 'https://meet.google.com/abc-defg-hij' })
    assert.equal(started, 1)
  })

  test('Chrome playing audio on a non-meeting tab is not a meeting signal', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'com.google.Chrome' }, activeTabUrl: 'https://www.youtube.com/watch?v=abc' })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'com.google.Chrome' }, activeTabUrl: 'https://www.youtube.com/watch?v=abc' })
    assert.equal(started, 0)
  })

  test('nowPlaying.playing=false with no tab url is not a meeting signal', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: false, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: false, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/meetingWatcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/meetingWatcher.ts
import { isMeetingAppBundleId, isMeetingTabUrl } from './meetingApps'

export type NowPlaying = { playing: boolean; bundleIdentifier?: string }
export type MeetingSample = { nowPlaying: NowPlaying; activeTabUrl?: string }
export type MeetingWatcherEvents = {
  onMeetingStarted: () => void
  onMeetingEnded: () => void
}

const DEFAULT_DEBOUNCE_MS = 1500

function sampleLooksLikeMeeting(sample: MeetingSample): boolean {
  if (!sample.nowPlaying.playing) return false
  if (isMeetingAppBundleId(sample.nowPlaying.bundleIdentifier)) return true
  if (isMeetingTabUrl(sample.activeTabUrl)) return true
  return false
}

/**
 * Debounced meeting-active signal (spec §2). Fed periodically with the
 * latest readNowPlaying()/tab-URL sample; fires onMeetingStarted/onMeetingEnded
 * only once the signal has held steady for `debounceMs`, so a momentarily
 * idle Zoom window or a single stray audio blip doesn't trigger a prompt.
 */
export class MeetingWatcher {
  private readonly events: MeetingWatcherEvents
  private readonly debounceMs: number
  private readonly now: () => number
  private active = false
  private pendingSince: number | null = null
  private pendingValue: boolean | null = null

  constructor(events: MeetingWatcherEvents, debounceMs: number = DEFAULT_DEBOUNCE_MS, now: () => number = Date.now) {
    this.events = events
    this.debounceMs = debounceMs
    this.now = now
  }

  get isMeetingActive(): boolean {
    return this.active
  }

  feed(sample: MeetingSample): void {
    const looksLikeMeeting = sampleLooksLikeMeeting(sample)
    if (looksLikeMeeting === this.active) {
      // Signal agrees with current state — nothing pending, reset any stale pending transition.
      this.pendingSince = null
      this.pendingValue = null
      return
    }

    const t = this.now()
    if (this.pendingValue !== looksLikeMeeting) {
      this.pendingValue = looksLikeMeeting
      this.pendingSince = t
      return
    }

    if (this.pendingSince !== null && t - this.pendingSince >= this.debounceMs) {
      this.active = looksLikeMeeting
      this.pendingSince = null
      this.pendingValue = null
      if (looksLikeMeeting) {
        this.events.onMeetingStarted()
      } else {
        this.events.onMeetingEnded()
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/meetingWatcher.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/meetingWatcher.ts desktop/engine-overrides/electron/meetingWatcher.test.ts
git commit -m "notetaker: add debounced meeting-active watcher"
```

---

## Task 4: Native audio-tap addon — scaffolding + Core Audio Process Tap capture

The heaviest task. New native Node addon mirroring `desktop/native-ax`'s exact structure (binding.gyp shape, package.json shape, index.js loader). Captures system audio from a target process (or process group, for browsers) via `AudioHardwareCreateProcessTap` + a private aggregate device, delivering timestamped Float32 PCM chunks to JS via a napi ThreadSafeFunction. API constants below were confirmed directly against the macOS 26.2 SDK headers (`CoreAudio.framework/Headers/{CATapDescription,AudioHardwareTapping,AudioHardware}.h`) during planning — not guessed.

**Files:**
- Create: `desktop/native-audio-tap/binding.gyp`
- Create: `desktop/native-audio-tap/package.json`
- Create: `desktop/native-audio-tap/index.js`
- Create: `desktop/native-audio-tap/src/audiotap.mm`
- Create: `desktop/native-audio-tap/src/stub.cc`
- Create: `desktop/native-audio-tap/smoke.js`
- Create: `desktop/native-audio-tap/README.md`

**Interfaces:**
- Produces (loaded via `require('unmute-native-audio-tap')`):
  ```ts
  pidForBundleId(bundleId: string): number | null // 0 or more PIDs matching a running app; returns the first
  startCapture(pid: number, onChunk: (chunk: { samples: Float32Array; sampleRate: number; timestampMs: number }) => void): void // throws on failure
  stopCapture(): void
  ```

- [ ] **Step 1: Write `binding.gyp`**

```python
{
  "targets": [
    {
      "target_name": "native_audio_tap",
      "conditions": [
        ['OS=="mac"', {
          "sources": ["src/audiotap.mm"],
          "xcode_settings": {
            "OTHER_LDFLAGS": [
              "-framework", "CoreAudio",
              "-framework", "AudioToolbox",
              "-framework", "Cocoa",
              "-framework", "Foundation"
            ],
            "MACOSX_DEPLOYMENT_TARGET": "14.2",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "OTHER_CFLAGS": ["-ObjC++"]
          }
        }],
        ['OS!="mac"', {
          "sources": ["src/stub.cc"]
        }]
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ]
    }
  ]
}
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "unmute-native-audio-tap",
  "version": "0.1.0",
  "private": true,
  "description": "Background macOS system-audio capture via Core Audio Process Taps (macOS 14.2+), loaded in-process from the main Electron process so it inherits the signed .app bundle's TCC System Audio Recording grant — same in-process lesson as unmute-native-paste and unmute-native-ax: child binaries get their own TCC identity and silently fail.",
  "main": "index.js",
  "scripts": {
    "install": "node-gyp rebuild --release",
    "rebuild": "node-gyp rebuild --release",
    "smoke": "node smoke.js"
  },
  "dependencies": {
    "node-addon-api": "^7.1.1"
  },
  "gypfile": true,
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 3: Write `index.js`**

```js
try {
  module.exports = require('./build/Release/native_audio_tap.node')
} catch (e) {
  const err = new Error(
    `[unmute-native-audio-tap] failed to load build/Release/native_audio_tap.node — ` +
    `${e instanceof Error ? e.message : String(e)}`
  )
  err.cause = e
  throw err
}
```

- [ ] **Step 4: Write `src/stub.cc`** (non-mac platforms — build must still succeed, capture is simply unavailable)

```cpp
#include <napi.h>

Napi::Value NotAvailable(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), "native-audio-tap is only available on macOS").ThrowAsJavaScriptException();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("pidForBundleId", Napi::Function::New(env, NotAvailable));
  exports.Set("startCapture", Napi::Function::New(env, NotAvailable));
  exports.Set("stopCapture", Napi::Function::New(env, NotAvailable));
  return exports;
}

NODE_API_MODULE(native_audio_tap, Init)
```

- [ ] **Step 5: Write `src/audiotap.mm`**

```objc
// unmute-native-audio-tap — background macOS system-audio capture via Core
// Audio Process Taps, in-process.
//
// Loaded in-process (not a spawned child) from Electron's main process for
// the same TCC-identity reason as native-ax and native-fn-listener: a
// spawned child binary gets its own bundle identity and the "System Audio
// Recording Only" TCC grant the user approves for the signed .app would not
// apply to it.
//
// API surface confirmed against the macOS 26.2 SDK (targets 14.2+):
//   CATapDescription            — CoreAudio.framework/Headers/CATapDescription.h
//   AudioHardwareCreateProcessTap — .../AudioHardwareTapping.h
//   kAudioAggregateDeviceTapListKey / kAudioSubTapUIDKey / kAudioSubTapDriftCompensationKey
//                                — .../AudioHardware.h
//   kAudioHardwarePropertyTranslatePIDToProcessObject
//                                — .../AudioHardware.h (pid_t -> AudioObjectID)

#include <napi.h>
#import <Cocoa/Cocoa.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <string>
#include <atomic>
#include <mutex>

namespace {

AudioObjectID gTapID = kAudioObjectUnknown;
AudioObjectID gAggregateDeviceID = kAudioObjectUnknown;
AudioDeviceIOProcID gIOProcID = nullptr;
Napi::ThreadSafeFunction gTSFN;
std::atomic<bool> gCapturing{false};

/** Resolves a pid_t to its Core Audio "process object" AudioObjectID. */
AudioObjectID ProcessObjectForPID(pid_t pid) {
  AudioObjectID processObjectID = kAudioObjectUnknown;
  UInt32 dataSize = sizeof(processObjectID);
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyTranslatePIDToProcessObject,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  OSStatus status = AudioObjectGetPropertyData(
    kAudioObjectSystemObject, &address, sizeof(pid), &pid, &dataSize, &processObjectID);
  if (status != noErr) return kAudioObjectUnknown;
  return processObjectID;
}

OSStatus TapIOProc(AudioObjectID inDevice,
                    const AudioTimeStamp* inNow,
                    const AudioBufferList* inInputData,
                    const AudioTimeStamp* inInputTime,
                    AudioBufferList* outOutputData,
                    const AudioTimeStamp* inOutputTime,
                    void* inClientData) {
  (void)inDevice; (void)inNow; (void)outOutputData;
  if (!gCapturing.load() || inInputData == nullptr || inInputData->mNumberBuffers == 0) return noErr;

  const AudioBuffer& buffer = inInputData->mBuffers[0];
  if (buffer.mData == nullptr || buffer.mDataByteSize == 0) return noErr;

  const size_t sampleCount = buffer.mDataByteSize / sizeof(float);
  auto* samplesCopy = new float[sampleCount];
  memcpy(samplesCopy, buffer.mData, buffer.mDataByteSize);

  // mHostTime is in mach absolute-time units; convert to wall-clock ms via
  // the host's timebase so JS gets an ordinary epoch-relative timestamp
  // comparable to the mic stream's Date.now()-based timestamps.
  static mach_timebase_info_data_t timebase = {0, 0};
  if (timebase.denom == 0) mach_timebase_info(&timebase);
  const double machNowNs = (double)inInputTime->mHostTime * timebase.numer / timebase.denom;
  const double machNowMs = machNowNs / 1e6;
  const double wallNowMs = (double)([[NSDate date] timeIntervalSince1970] * 1000.0);
  const double timestampMs = wallNowMs - ((double)mach_absolute_time() * timebase.numer / timebase.denom / 1e6 - machNowMs);

  struct ChunkData { float* samples; size_t count; double sampleRate; double timestampMs; };
  auto* chunk = new ChunkData{samplesCopy, sampleCount, buffer.mDataByteSize > 0 ? 48000.0 : 0.0, timestampMs};

  gTSFN.NonBlockingCall(chunk, [](Napi::Env env, Napi::Function jsCallback, ChunkData* data) {
    Napi::Float32Array samples = Napi::Float32Array::New(env, data->count);
    memcpy(samples.Data(), data->samples, data->count * sizeof(float));
    Napi::Object chunkObj = Napi::Object::New(env);
    chunkObj.Set("samples", samples);
    chunkObj.Set("sampleRate", Napi::Number::New(env, data->sampleRate));
    chunkObj.Set("timestampMs", Napi::Number::New(env, data->timestampMs));
    jsCallback.Call({chunkObj});
    delete[] data->samples;
    delete data;
  });

  return noErr;
}

void TeardownLocked() {
  if (gIOProcID != nullptr && gAggregateDeviceID != kAudioObjectUnknown) {
    AudioDeviceStop(gAggregateDeviceID, gIOProcID);
    AudioDeviceDestroyIOProcID(gAggregateDeviceID, gIOProcID);
    gIOProcID = nullptr;
  }
  if (gAggregateDeviceID != kAudioObjectUnknown) {
    AudioHardwareDestroyAggregateDevice(gAggregateDeviceID);
    gAggregateDeviceID = kAudioObjectUnknown;
  }
  if (gTapID != kAudioObjectUnknown) {
    AudioHardwareDestroyProcessTap(gTapID);
    gTapID = kAudioObjectUnknown;
  }
  gCapturing.store(false);
}

} // namespace

/** pidForBundleId(bundleId: string) -> number | null */
Napi::Value PidForBundleId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "pidForBundleId(bundleId: string)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string bundleId = info[0].As<Napi::String>().Utf8Value();
  NSArray<NSRunningApplication*>* apps = [[NSWorkspace sharedWorkspace] runningApplications];
  for (NSRunningApplication* app in apps) {
    if (app.bundleIdentifier != nil &&
        [app.bundleIdentifier isEqualToString:[NSString stringWithUTF8String:bundleId.c_str()]]) {
      return Napi::Number::New(env, (double)app.processIdentifier);
    }
  }
  return env.Null();
}

/** startCapture(pid: number, onChunk: (chunk) => void): void */
Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (gCapturing.load()) {
    Napi::Error::New(env, "capture already in progress — call stopCapture() first").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "startCapture(pid: number, onChunk: (chunk) => void)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  pid_t targetPID = (pid_t)info[0].As<Napi::Number>().Int32Value();
  AudioObjectID processObjectID = ProcessObjectForPID(targetPID);
  if (processObjectID == kAudioObjectUnknown) {
    Napi::Error::New(env, "no Core Audio process object for that PID (process may not be producing audio yet)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  CATapDescription* tapDescription =
      [[CATapDescription alloc] initStereoMixdownOfProcesses:@[ @(processObjectID) ]];
  tapDescription.name = @"UnmuteNotetakerTap";
  tapDescription.muteBehavior = CATapUnmuted; // spec §2: the user's other audio keeps playing normally
  tapDescription.privateTap = YES;

  OSStatus status = AudioHardwareCreateProcessTap(tapDescription, &gTapID);
  if (status != noErr) {
    Napi::Error::New(env, "AudioHardwareCreateProcessTap failed, OSStatus=" + std::to_string(status)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  NSDictionary* aggregateDescription = @{
    @(kAudioAggregateDeviceNameKey) : @"Unmute Notetaker Aggregate",
    @(kAudioAggregateDeviceUIDKey) : [[NSUUID UUID] UUIDString],
    @(kAudioAggregateDeviceIsPrivateKey) : @YES,
    @(kAudioAggregateDeviceTapAutoStartKey) : @YES,
    @(kAudioAggregateDeviceSubDeviceListKey) : @[],
    @(kAudioAggregateDeviceTapListKey) : @[ @{
      @(kAudioSubTapUIDKey) : tapDescription.UUID.UUIDString,
      @(kAudioSubTapDriftCompensationKey) : @YES,
    } ],
  };

  status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregateDescription, &gAggregateDeviceID);
  if (status != noErr) {
    AudioHardwareDestroyProcessTap(gTapID);
    gTapID = kAudioObjectUnknown;
    Napi::Error::New(env, "AudioHardwareCreateAggregateDevice failed, OSStatus=" + std::to_string(status)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  gTSFN = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "NotetakerAudioChunk", 0, 1);

  status = AudioDeviceCreateIOProcID(gAggregateDeviceID, TapIOProc, nullptr, &gIOProcID);
  if (status != noErr) {
    TeardownLocked();
    Napi::Error::New(env, "AudioDeviceCreateIOProcID failed, OSStatus=" + std::to_string(status)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // This is the call that actually triggers the "System Audio Recording
  // Only" TCC prompt on first use (spec §8) — there is no separate
  // requestAuthorization-style API.
  status = AudioDeviceStart(gAggregateDeviceID, gIOProcID);
  if (status != noErr) {
    TeardownLocked();
    Napi::Error::New(env, "AudioDeviceStart failed, OSStatus=" + std::to_string(status)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  gCapturing.store(true);
  return env.Undefined();
}

/** stopCapture(): void */
Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  TeardownLocked();
  if (gTSFN != nullptr) {
    gTSFN.Release();
  }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("pidForBundleId", Napi::Function::New(env, PidForBundleId));
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
  return exports;
}

NODE_API_MODULE(native_audio_tap, Init)
```

- [ ] **Step 6: Write `smoke.js`** (manual, on-device smoke test — not part of `node:test`, since it requires a real running meeting app and a real TCC grant)

```js
// Manual smoke test: run `node smoke.js <bundleId>` (e.g. `node smoke.js us.zoom.xos`)
// with that app open and producing audio. Prints chunk count + sample stats
// for 5 seconds, then stops. First run will trigger the macOS "System Audio
// Recording Only" permission prompt — approve it and re-run.
const native = require('./index.js')

const bundleId = process.argv[2]
if (!bundleId) {
  console.error('usage: node smoke.js <bundleId>')
  process.exit(1)
}

const pid = native.pidForBundleId(bundleId)
if (pid == null) {
  console.error(`no running app with bundle id ${bundleId}`)
  process.exit(1)
}

console.log(`found pid ${pid} for ${bundleId}, starting capture...`)
let chunks = 0
let totalSamples = 0
native.startCapture(pid, (chunk) => {
  chunks++
  totalSamples += chunk.samples.length
  if (chunks % 20 === 0) {
    console.log(`chunk #${chunks}, sampleRate=${chunk.sampleRate}, timestampMs=${chunk.timestampMs}`)
  }
})

setTimeout(() => {
  native.stopCapture()
  console.log(`done. ${chunks} chunks, ${totalSamples} total samples.`)
  process.exit(0)
}, 5000)
```

- [ ] **Step 7: Write `README.md`**

```markdown
# unmute-native-audio-tap

Background macOS system-audio capture via Core Audio Process Taps
(`AudioHardwareCreateProcessTap`, macOS 14.2+). Loaded in-process from
Electron's main process — same TCC-identity pattern as `native-ax` and
`native-fn-listener` (see their READMEs): a spawned child binary would get
its own TCC identity and the signed .app's "System Audio Recording Only"
grant would not apply to it.

## Build

```
npm install   # runs node-gyp rebuild --release via the install script
```

## Manual on-device smoke test

There is no automated test for the actual Core Audio capture path — it
requires a real running meeting app, a real signed build, and a real TCC
grant, none of which are available in CI or in a plain `npm test` run.

```
node smoke.js us.zoom.xos   # with Zoom open and in a call
```

First run triggers the "System Audio Recording Only" system prompt
(System Settings → Privacy & Security → Screen & System Audio Recording).
Approve it, then re-run.

## API

- `pidForBundleId(bundleId: string): number | null`
- `startCapture(pid: number, onChunk: (chunk: { samples: Float32Array, sampleRate: number, timestampMs: number }) => void): void`
- `stopCapture(): void`
```

- [ ] **Step 8: Build and verify it compiles**

Run:
```
cd desktop/native-audio-tap && npx --yes node-gyp rebuild --release
```
Expected: builds `build/Release/native_audio_tap.node` with no errors. This verifies the ObjC++ compiles and links against the real SDK on this machine — it does **not** verify actual runtime capture behavior (that needs `smoke.js` on a signed build with a real meeting app running and the TCC prompt approved, which is on-device work for the user, not something this task can complete standalone).

- [ ] **Step 9: Commit**

```bash
git add desktop/native-audio-tap
git commit -m "notetaker: add native-audio-tap addon (Core Audio Process Tap capture)"
```

---

## Task 5: Wire native-audio-tap into the build + add the new entitlement usage string

**Files:**
- Modify: `desktop/build/wire-into-engine.sh` (add a copy block mirroring the existing native-ax block, and a `package.json` dependency-injection block mirroring native-ax's)
- Modify: `desktop/engine-overrides/electron-builder.yml` (add an `extendInfo` block under `mac:` — this file does not currently have one; do not assume `NSMicrophoneUsageDescription` is inherited from the OSS engine's `package.json`, it is not merged in — see plan research notes)

**Interfaces:**
- Consumes: nothing new
- Produces: `unmute-native-audio-tap` present as a `file:` dependency in the wired engine's `package.json`, `NSSystemAudioCaptureUsageDescription` present in the packaged app's `Info.plist`

- [ ] **Step 1: Add the copy block to `wire-into-engine.sh`**

Locate the existing native-ax copy block (search for `"Copying native-ax addon"`). Immediately after that `if` block, add:

```bash
  # Copy the native-audio-tap addon (meeting notetaker system-audio capture).
  # Same in-process pattern as native-ax/native-fn-listener — see that
  # module's README for why.
  if [[ -d "$ROOT/native-audio-tap" ]]; then
    log "Copying native-audio-tap addon"
    mkdir -p "$engine/native-audio-tap"
    cp -R "$ROOT/native-audio-tap/." "$engine/native-audio-tap/"
  else
    log "WARN: $ROOT/native-audio-tap not found — meeting notetaker will be unavailable"
  fi
```

- [ ] **Step 2: Add the dependency-injection block**

Locate the existing native-ax dependency injection (search for `pkg.dependencies['unmute-native-ax']`). Immediately after it, add:

```js
    if (fs.existsSync('$engine/native-audio-tap/package.json')) {
      pkg.dependencies['unmute-native-audio-tap'] = 'file:./native-audio-tap'
    }
```

- [ ] **Step 3: Add the entitlement usage string**

In `desktop/engine-overrides/electron-builder.yml`, under the existing `mac:` key, add (create the key if it doesn't already exist under `mac:`):

```yaml
mac:
  extendInfo:
    NSMicrophoneUsageDescription: "unmute uses your microphone to transcribe what you say into text."
    NSAppleEventsUsageDescription: "unmute uses System Events to paste transcribed text at your cursor."
    NSSystemAudioCaptureUsageDescription: "unmute's meeting notetaker captures system audio to transcribe both sides of a call, entirely on your device."
```

Note: `NSMicrophoneUsageDescription` and `NSAppleEventsUsageDescription` are included here explicitly because — per plan research — the OSS engine's own copy of these strings lives in `desktop/work/oss-engine/package.json`'s `build.mac.extendInfo`, and `engine-overrides/electron-builder.yml` **replaces** (not merges with) the OSS `electron-builder.yml`. If `electron-builder.yml` is the config electron-builder actually reads for the Pro/wired build, these two existing strings need to be here too, not just the new one — verify against a real packaged build's `Info.plist` (`plutil -p` on the built `.app/Contents/Info.plist`) before assuming any of the three actually land in the output.

- [ ] **Step 4: Verify the wiring script's edits are syntactically valid**

Run: `bash -n desktop/build/wire-into-engine.sh`
Expected: no output (syntax OK)

Run: `cd desktop/engine-overrides && node -e "require('yaml').parse(require('fs').readFileSync('electron-builder.yml','utf8'))"` (or equivalent YAML parse check using whatever YAML lib is already a devDependency — check `desktop/package.json` first) to confirm the new `extendInfo:` block is valid YAML.

- [ ] **Step 5: Commit**

```bash
git add desktop/build/wire-into-engine.sh desktop/engine-overrides/electron-builder.yml
git commit -m "notetaker: wire native-audio-tap into build, add system-audio-capture usage string"
```

---

## Task 6: `native-fn-listener` — emit left-Control and left-Option chord events

**Files:**
- Modify: `desktop/native-fn-listener/src/listener.mm` (add event emission for the left-Control and left-Option modifier keys specifically — the existing file distinguishes right-Option from left-Option already since it emits `right-option-down/up` and not a generic `option-down/up`, so the modifier-flags decoding needed already exists for the right-hand key; extend the same decoding to also emit `left-control-down/up` and `left-option-down/up`)

**Interfaces:**
- Produces: two new native event strings, `left-control-down`, `left-control-up`, `left-option-down`, `left-option-up`, emitted through the same `emit_event(...)` mechanism the file already uses for `right-option-down/up` (confirmed at `listener.mm:83-84`)

- [ ] **Step 1: Locate the existing right-Option modifier decoding**

Read `desktop/native-fn-listener/src/listener.mm` around lines 74-90 (the `right-option`/`caps` emission block) to find the exact `NSEvent.flagsChanged` keyCode/flags check used to distinguish left vs. right modifier keys (macOS keyCode 58 = left Option, 61 = right Option; 59 = left Control, 62 = right Control — confirm these against whatever constant names the file already uses for the right-Option case rather than introducing a second naming convention).

- [ ] **Step 2: Add left-Control and left-Option emission**

Following the exact pattern found in Step 1 (same `flagsChanged` handler, same `emit_event` call shape), add cases for keyCode 59 (left Control) and keyCode 58 (left Option) that emit `left-control-down`/`left-control-up` and `left-option-down`/`left-option-up` respectively, mirroring how `right-option-down/up` is emitted for keyCode 61.

- [ ] **Step 3: Rebuild and verify it compiles**

Run: `cd desktop/native-fn-listener && npx --yes node-gyp rebuild --release`
Expected: builds with no errors.

- [ ] **Step 4: Manual on-device verification (not automatable)**

There is no automated test for real key events — `native-fn-listener`'s existing tests (if any; check `desktop/native-fn-listener` for a `*.test.ts` covering the JS-side wrapper) don't simulate real `NSEvent`s. Note in the PR/handoff that pressing left-Control and left-Option together needs to be manually verified on a signed dev build to confirm both `left-control-down` and `left-option-down` actually fire (see `unmute-test-build` skill for the correct build process — do not use `build:fast` for a testable install, per this repo's established build traps).

- [ ] **Step 5: Commit**

```bash
git add desktop/native-fn-listener/src/listener.mm
git commit -m "notetaker: emit left-control/left-option key events from native-fn-listener"
```

---

## Task 7: `keyboard.ts` — independent `notesActive` state + chord double-tap trigger

**Files:**
- Modify: `desktop/engine-overrides/electron/keyboard.ts`

**Interfaces:**
- Consumes: `left-control-down/up`, `left-option-down/up` events (Task 6); `DOUBLE_TAP_WINDOW_MS` from `./paywall/remote/capture/agentGesture.ts` (already imported at `keyboard.ts:4` for the Agent's own double-tap gesture — reuse the same constant and the same recognition primitive that file exposes, rather than writing new double-tap logic from scratch)
- Produces: new `KeyboardManager` events `'notes-start-requested'`, `'notes-stop-confirm-requested'`; new private field `notesActive: boolean` that is **not** read or written by any of the existing `dictationActive`/`instructionActive`/`agentActive`/`remoteActive` gates (spec §5) — grep every `if (this.dictationActive ||` / `if (this.remoteActive)` style guard in the file (lines 298, 368, 391, 583 per plan research) and confirm none of them are touched by this task

- [ ] **Step 1: Add the chord-hold tracking state**

Near the existing lock fields (around line 44-82), add:

```ts
private notesActive = false
private leftControlHeld = false
private leftOptionHeld = false
private notesChordLastTapAt = 0
```

- [ ] **Step 2: Track the chord's hold state from the two new key events**

In the existing `handleKey`/event switch (around lines 212-250, same place `fn-down`/`right-option-down` etc. are switched on), add cases:

```ts
case 'left-control-down':
  this.leftControlHeld = true
  this.maybeHandleNotesChordDown()
  break
case 'left-control-up':
  this.leftControlHeld = false
  break
case 'left-option-down':
  this.leftOptionHeld = true
  this.maybeHandleNotesChordDown()
  break
case 'left-option-up':
  this.leftOptionHeld = false
  break
```

- [ ] **Step 3: Implement the chord double-tap recognition, reusing the Agent's primitive**

```ts
private maybeHandleNotesChordDown(): void {
  if (!this.leftControlHeld || !this.leftOptionHeld) return // both must be down together
  const now = Date.now()
  const sinceLastTap = now - this.notesChordLastTapAt
  this.notesChordLastTapAt = now

  if (sinceLastTap > DOUBLE_TAP_WINDOW_MS) {
    return // first tap of a potential double-tap — just record it, wait for the second
  }

  // Second tap within the window: toggle. Chosen deliberately independent
  // of dictationActive/remoteActive/agentActive (spec §5) — note-taker never
  // blocks, and is never blocked by, those three.
  if (this.notesActive) {
    this.emit('notes-stop-confirm-requested') // spec §6: never stop directly
  } else {
    this.notesActive = true
    this.emit('notes-start-requested')
  }
}

/** Called by the owning module once the user has confirmed cancellation (spec §6). */
public confirmNotesStop(): void {
  this.notesActive = false
  this.emit('notes-stopped')
}
```

- [ ] **Step 4: Write a targeted test for the non-interference guarantee**

```ts
// desktop/engine-overrides/electron/keyboard.notetaker.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { KeyboardManager } from './keyboard'

describe('notes chord does not interact with existing mutual-exclusion locks', () => {
  test('double-tapping left-Control+left-Option starts notes while dictation is inert', () => {
    const km = new KeyboardManager()
    let startRequested = 0
    km.on('notes-start-requested', () => startRequested++)

    // simulate: both down, released, both down again within the window
    km.handleKey({ type: 'left-control-down' } as never)
    km.handleKey({ type: 'left-option-down' } as never)
    km.handleKey({ type: 'left-control-up' } as never)
    km.handleKey({ type: 'left-option-up' } as never)
    km.handleKey({ type: 'left-control-down' } as never)
    km.handleKey({ type: 'left-option-down' } as never)

    assert.equal(startRequested, 1)
  })

  test('a second chord double-tap while notes is active requests a confirm, not a direct stop', () => {
    const km = new KeyboardManager()
    let startRequested = 0
    let stopConfirmRequested = 0
    km.on('notes-start-requested', () => startRequested++)
    km.on('notes-stop-confirm-requested', () => stopConfirmRequested++)

    const doubleTap = () => {
      km.handleKey({ type: 'left-control-down' } as never)
      km.handleKey({ type: 'left-option-down' } as never)
      km.handleKey({ type: 'left-control-up' } as never)
      km.handleKey({ type: 'left-option-up' } as never)
      km.handleKey({ type: 'left-control-down' } as never)
      km.handleKey({ type: 'left-option-down' } as never)
      km.handleKey({ type: 'left-control-up' } as never)
      km.handleKey({ type: 'left-option-up' } as never)
    }
    doubleTap()
    doubleTap()

    assert.equal(startRequested, 1)
    assert.equal(stopConfirmRequested, 1)
  })
})
```

Adjust the exact `handleKey` call shape/`KeyEvent` type to match what `keyboard.ts` actually expects once Task 6/7's implementer has the real type in front of them — the important behavioral assertions (one start, one confirm-not-direct-stop, independence from the other locks) are what this test must preserve.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/keyboard.notetaker.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 6: Run the full existing keyboard test suite to confirm no regression**

Run: `cd desktop && node --import tsx --import ./electron/remote/test-setup.ts --test 'engine-overrides/electron/keyboard*.test.ts'`
Expected: PASS, all tests (existing + new)

- [ ] **Step 7: Commit**

```bash
git add desktop/engine-overrides/electron/keyboard.ts desktop/engine-overrides/electron/keyboard.notetaker.test.ts
git commit -m "notetaker: add independent notesActive state + chord double-tap trigger to keyboard.ts"
```

---

## Task 8: Notetaker capture session — mic + system-tap orchestration with timestamps

**Files:**
- Create: `desktop/engine-overrides/electron/notetakerSession.ts`
- Test: `desktop/engine-overrides/electron/notetakerSession.test.ts`

**Interfaces:**
- Consumes: `frontmostApp()`/`listApps()` (native-ax, `desktop/native-ax/src/ax.mm:364,381`, loaded per `desktop/electron/remote/ax/ax-bridge.ts`'s resolution pattern); `startCapture`/`stopCapture`/`pidForBundleId` (Task 4, injected as a `NativeAudioTap` interface for testability — never import `unmute-native-audio-tap` directly in this file's testable logic)
- Produces:
  ```ts
  export type TimestampedChunk = { source: 'mic' | 'system'; samples: Float32Array; sampleRate: number; timestampMs: number }
  export type NativeAudioTap = {
    startCapture: (pid: number, onChunk: (c: { samples: Float32Array; sampleRate: number; timestampMs: number }) => void) => void
    stopCapture: () => void
  }
  export class NotetakerSession {
    constructor(nativeAudioTap: NativeAudioTap, onChunk: (chunk: TimestampedChunk) => void)
    start(targetPid: number): void
    feedMicChunk(samples: Float32Array, sampleRate: number, timestampMs: number): void // called from the renderer's existing getUserMedia path via IPC
    stop(): void
    get isActive(): boolean
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetakerSession.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { NotetakerSession, type TimestampedChunk } from './notetakerSession'

function fakeNativeAudioTap() {
  let capturedOnChunk: ((c: { samples: Float32Array; sampleRate: number; timestampMs: number }) => void) | null = null
  let startCalls: number[] = []
  let stopCalls = 0
  return {
    tap: {
      startCapture: (pid: number, onChunk: typeof capturedOnChunk extends null ? never : NonNullable<typeof capturedOnChunk>) => {
        startCalls.push(pid)
        capturedOnChunk = onChunk
      },
      stopCapture: () => {
        stopCalls++
      },
    },
    emitSystemChunk: (samples: Float32Array, sampleRate: number, timestampMs: number) => {
      capturedOnChunk?.({ samples, sampleRate, timestampMs })
    },
    get startCalls() { return startCalls },
    get stopCalls() { return stopCalls },
  }
}

describe('NotetakerSession', () => {
  test('start() calls native startCapture with the target pid', () => {
    const fake = fakeNativeAudioTap()
    const session = new NotetakerSession(fake.tap, () => {})
    session.start(4242)
    assert.deepEqual(fake.startCalls, [4242])
    assert.equal(session.isActive, true)
  })

  test('system-audio chunks are tagged with source "system" and passed through', () => {
    const fake = fakeNativeAudioTap()
    const received: TimestampedChunk[] = []
    const session = new NotetakerSession(fake.tap, (c) => received.push(c))
    session.start(4242)
    fake.emitSystemChunk(new Float32Array([0.1, 0.2]), 48000, 1000)
    assert.equal(received.length, 1)
    assert.equal(received[0].source, 'system')
    assert.equal(received[0].timestampMs, 1000)
  })

  test('mic chunks fed in from the renderer are tagged with source "mic"', () => {
    const fake = fakeNativeAudioTap()
    const received: TimestampedChunk[] = []
    const session = new NotetakerSession(fake.tap, (c) => received.push(c))
    session.start(4242)
    session.feedMicChunk(new Float32Array([0.3]), 16000, 1005)
    assert.equal(received.length, 1)
    assert.equal(received[0].source, 'mic')
    assert.equal(received[0].timestampMs, 1005)
  })

  test('mic and system chunks interleave in arrival order, both timestamped', () => {
    const fake = fakeNativeAudioTap()
    const received: TimestampedChunk[] = []
    const session = new NotetakerSession(fake.tap, (c) => received.push(c))
    session.start(4242)
    fake.emitSystemChunk(new Float32Array([0.1]), 48000, 1000)
    session.feedMicChunk(new Float32Array([0.2]), 16000, 1010)
    fake.emitSystemChunk(new Float32Array([0.3]), 48000, 1020)
    assert.deepEqual(received.map((c) => c.source), ['system', 'mic', 'system'])
    assert.deepEqual(received.map((c) => c.timestampMs), [1000, 1010, 1020])
  })

  test('stop() calls native stopCapture and further chunks are ignored', () => {
    const fake = fakeNativeAudioTap()
    const received: TimestampedChunk[] = []
    const session = new NotetakerSession(fake.tap, (c) => received.push(c))
    session.start(4242)
    session.stop()
    assert.equal(fake.stopCalls, 1)
    assert.equal(session.isActive, false)
    session.feedMicChunk(new Float32Array([0.5]), 16000, 2000)
    assert.equal(received.length, 0)
  })

  test('start() throws if already active', () => {
    const fake = fakeNativeAudioTap()
    const session = new NotetakerSession(fake.tap, () => {})
    session.start(4242)
    assert.throws(() => session.start(4242))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetakerSession.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetakerSession.ts

export type TimestampedChunk = {
  source: 'mic' | 'system'
  samples: Float32Array
  sampleRate: number
  timestampMs: number
}

export type NativeAudioTap = {
  startCapture: (pid: number, onChunk: (c: { samples: Float32Array; sampleRate: number; timestampMs: number }) => void) => void
  stopCapture: () => void
}

/**
 * Orchestrates the two independently-captured, independently-timestamped
 * audio channels a meeting note session needs (spec §2, §4): the existing
 * mic path (fed in from the renderer's getUserMedia recorder via IPC — this
 * class does not touch getUserMedia itself, per spec §2's "mic capture is
 * unchanged") and the new native system-audio tap (Task 4). Channel identity
 * ("who said what") is a property of which method delivered the chunk, not
 * anything inferred from the audio — no diarization needed for a 1:1 call.
 */
export class NotetakerSession {
  private readonly nativeAudioTap: NativeAudioTap
  private readonly onChunk: (chunk: TimestampedChunk) => void
  private active = false

  constructor(nativeAudioTap: NativeAudioTap, onChunk: (chunk: TimestampedChunk) => void) {
    this.nativeAudioTap = nativeAudioTap
    this.onChunk = onChunk
  }

  get isActive(): boolean {
    return this.active
  }

  start(targetPid: number): void {
    if (this.active) {
      throw new Error('NotetakerSession already active — call stop() first')
    }
    this.active = true
    this.nativeAudioTap.startCapture(targetPid, (c) => {
      if (!this.active) return
      this.onChunk({ source: 'system', samples: c.samples, sampleRate: c.sampleRate, timestampMs: c.timestampMs })
    })
  }

  feedMicChunk(samples: Float32Array, sampleRate: number, timestampMs: number): void {
    if (!this.active) return
    this.onChunk({ source: 'mic', samples, sampleRate, timestampMs })
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.nativeAudioTap.stopCapture()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetakerSession.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add desktop/engine-overrides/electron/notetakerSession.ts desktop/engine-overrides/electron/notetakerSession.test.ts
git commit -m "notetaker: add NotetakerSession orchestrating timestamped mic+system channels"
```

---

## Task 9: Widget window — floating bottom-left circular waveform indicator

**Files:**
- Create: `desktop/electron/remote/notetakerWidget.ts` (modeled directly on `desktop/electron/remote/overlay.ts` — same `BrowserWindow` config shape, same all-Spaces/full-screen-following setup, same click-through pattern; only the position and content differ)
- Create: `desktop/engine-overrides/renderer/notetaker/NotetakerWidget.tsx` (React component: circular shape, live waveform from an `AnalyserNode`-driven amplitude array, a Cancel affordance on click matching spec §6/§7)

**Interfaces:**
- Consumes: `screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea` (same pattern as `overlay.ts:94-107`); IPC channel `notetaker:cancel-requested` sent from the renderer back to the main process when the user clicks the widget and confirms Cancel

- [ ] **Step 1: Write `notetakerWidget.ts`**, adapting `overlay.ts`'s `dockedBounds()`/`createOverlayWindow()` shape:

```ts
// desktop/electron/remote/notetakerWidget.ts
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

let widgetWindow: BrowserWindow | null = null

/** Small circular bottom-left indicator (spec §7) — mirrors overlay.ts's
 * dockedBounds() but anchored to the opposite corner. */
function bottomLeftBounds(): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const size = 56 // circular, small — spec §7: "not buried, more like a floating thing"
  const margin = 16
  return {
    width: size,
    height: size,
    x: wa.x + margin,
    y: wa.y + wa.height - size - margin,
  }
}

export function createNotetakerWidget(): BrowserWindow {
  if (widgetWindow && !widgetWindow.isDestroyed()) return widgetWindow
  const { x, y, width, height } = bottomLeftBounds()

  widgetWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    paintWhenInitiallyHidden: true,
    focusable: true,
    acceptFirstMouse: true,
    type: 'panel',
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  widgetWindow.setAlwaysOnTop(true, 'screen-saver')
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  widgetWindow.setFullScreenable(false)

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    widgetWindow.loadURL(`${devUrl}#/notetaker-widget`)
  } else {
    widgetWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/notetaker-widget' })
  }

  widgetWindow.on('closed', () => {
    widgetWindow = null
  })

  return widgetWindow
}

export function showNotetakerWidget(): void {
  const win = createNotetakerWidget()
  win.showInactive()
}

export function hideNotetakerWidget(): void {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.hide()
  }
}

export function destroyNotetakerWidget(): void {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close()
  }
  widgetWindow = null
}
```

Confirm the exact preload path and dev-vs-packaged `loadURL`/`loadFile` shape against `overlay.ts` in full (only the excerpted lines were available during planning) before finalizing — match it exactly rather than guessing at surrounding lines not shown in the plan's research.

- [ ] **Step 2: Write `NotetakerWidget.tsx`**

```tsx
// desktop/engine-overrides/renderer/notetaker/NotetakerWidget.tsx
import { useEffect, useRef, useState } from 'react'

const BAR_COUNT = 5

/**
 * Bottom-left floating circular widget (spec §7): live waveform, no timer.
 * Clicking surfaces a Cancel affordance (spec §6) — the widget never stops
 * the session on its own; it only requests confirmation, same as the
 * chord-double-tap-while-active path in keyboard.ts.
 */
export function NotetakerWidget({
  analyser,
  onCancelConfirmed,
}: {
  analyser: AnalyserNode | null
  onCancelConfirmed: () => void
}) {
  const [levels, setLevels] = useState<number[]>(new Array(BAR_COUNT).fill(0.1))
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const rafRef = useRef<number>()

  useEffect(() => {
    if (!analyser) return
    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      const chunkSize = Math.floor(data.length / BAR_COUNT)
      const next = new Array(BAR_COUNT).fill(0).map((_, i) => {
        let sum = 0
        for (let j = i * chunkSize; j < (i + 1) * chunkSize; j++) {
          sum += Math.abs(data[j] - 128)
        }
        return Math.min(1, (sum / chunkSize / 128) * 2)
      })
      setLevels(next)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [analyser])

  return (
    <div
      role="button"
      aria-label={confirmingCancel ? 'Cancel note-taking?' : 'Note-taking in progress'}
      onClick={() => setConfirmingCancel((v) => !v)}
      style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        background: 'rgba(20, 20, 22, 0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
      }}
    >
      {confirmingCancel ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onCancelConfirmed()
          }}
          style={{
            fontSize: 10,
            color: '#fff',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      ) : (
        levels.map((level, i) => (
          <div
            key={i}
            style={{
              width: 3,
              height: Math.max(4, level * 24),
              borderRadius: 2,
              background: '#fff',
              transition: 'height 60ms linear',
            }}
          />
        ))
      )}
    </div>
  )
}
```

- [ ] **Step 3: Wire the new route**

Locate wherever `overlay.ts`'s `#/route` hash is matched to a component in the renderer's route table (search the renderer entry point for the existing overlay route, likely near `WidgetApp.tsx` or a top-level router file per earlier research). Add a `notetaker-widget` route rendering `<NotetakerWidget />`, following that file's exact existing pattern rather than introducing a new routing convention.

- [ ] **Step 4: Manual on-device verification (not automatable in `node:test`)**

This is Electron/DOM-dependent UI, consistent with how `overlay.ts`/`orchestrate.ts` are already noted as untested in this codebase for the same reason (per plan research). Verify manually via a dev run: trigger the notes chord, confirm the widget appears bottom-left, shows a moving waveform when fed a live `AnalyserNode`, and shows Cancel on click.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/notetakerWidget.ts desktop/engine-overrides/renderer/notetaker/NotetakerWidget.tsx
git commit -m "notetaker: add bottom-left floating widget with waveform and cancel confirm"
```

---

## Task 10: Wire it all together — detection prompts, chord trigger, widget, session lifecycle

**Files:**
- Modify: `desktop/engine-overrides/electron/keyboard.ts` (or wherever `KeyboardManager` is instantiated and listened to in the main process — likely `desktop/electron/main.ts`; confirm exact wiring point before editing)
- Create: `desktop/engine-overrides/electron/notetakerController.ts` — the glue module owning one `MeetingWatcher` (Task 3), one `NotetakerSession` (Task 8), and the widget (Task 9); listens to `KeyboardManager`'s `notes-start-requested`/`notes-stop-confirm-requested` events and to `MeetingWatcher`'s `onMeetingStarted`/`onMeetingEnded`, and issues OS notifications for both the proactive detected-meeting prompt and the confirm-to-stop prompt (spec §6)
- Test: `desktop/engine-overrides/electron/notetakerController.test.ts`

**Interfaces:**
- Consumes: `MeetingWatcher` (Task 3), `NotetakerSession` (Task 8), `frontmostApp()` (native-ax), a `showNotification: (opts: { title: string; body: string; onClick?: () => void }) => void` and `confirm: (message: string) => Promise<boolean>` pair injected for testability (wrap Electron's `Notification`/dialog APIs behind these two functions in the real wiring, at the composition root only)

- [ ] **Step 1: Write the failing test**

```ts
// desktop/engine-overrides/electron/notetakerController.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { NotetakerController } from './notetakerController'
import { NotetakerSession } from './notetakerSession'

function fakeSession() {
  const startCalls: number[] = []
  const stopCalls: number[] = []
  const session = {
    start: (pid: number) => startCalls.push(pid),
    stop: () => stopCalls.push(1),
    isActive: false,
  } as unknown as NotetakerSession
  return { session, startCalls, stopCalls }
}

describe('NotetakerController', () => {
  test('a detected meeting start surfaces a notification, does not auto-start capture', () => {
    const { session, startCalls } = fakeSession()
    const notifications: string[] = []
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: (opts) => notifications.push(opts.title),
      confirm: async () => true,
    })
    controller.onMeetingDetected()
    assert.deepEqual(notifications, ["Looks like you're in a meeting"])
    assert.equal(startCalls.length, 0) // detection prompts, it never auto-starts
  })

  test('chord double-tap start requested calls session.start with the resolved target pid', () => {
    const { session, startCalls } = fakeSession()
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => true,
    })
    controller.onNotesStartRequested()
    assert.deepEqual(startCalls, [4242])
  })

  test('stop-confirm-requested calls confirm() and only stops if the user confirms', async () => {
    const { session, stopCalls } = fakeSession()
    let confirmCalls = 0
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => {
        confirmCalls++
        return true
      },
    })
    await controller.onNotesStopConfirmRequested()
    assert.equal(confirmCalls, 1)
    assert.deepEqual(stopCalls, [1])
  })

  test('declining the stop confirmation leaves the session running', async () => {
    const { session, stopCalls } = fakeSession()
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => false,
    })
    await controller.onNotesStopConfirmRequested()
    assert.equal(stopCalls.length, 0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetakerController.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// desktop/engine-overrides/electron/notetakerController.ts
import type { NotetakerSession } from './notetakerSession'

export type NotetakerControllerDeps = {
  session: NotetakerSession
  resolveTargetPid: () => number | null
  showNotification: (opts: { title: string; body?: string }) => void
  confirm: (message: string) => Promise<boolean>
}

/**
 * Composition-root glue: wires MeetingWatcher's detection events and
 * KeyboardManager's chord events to NotetakerSession, per spec §6.
 * Detection only ever prompts — it never auto-starts capture. Stopping is
 * always a confirm, whether triggered by the chord again or by a detected
 * meeting-ended signal.
 */
export class NotetakerController {
  private readonly deps: NotetakerControllerDeps

  constructor(deps: NotetakerControllerDeps) {
    this.deps = deps
  }

  onMeetingDetected(): void {
    this.deps.showNotification({
      title: "Looks like you're in a meeting",
      body: 'Double-tap Control+Option to start notes.',
    })
  }

  onMeetingEnded(): void {
    if (!this.deps.session.isActive) return
    void this.onNotesStopConfirmRequested()
  }

  onNotesStartRequested(): void {
    const pid = this.deps.resolveTargetPid()
    if (pid == null) {
      this.deps.showNotification({ title: 'Notetaker', body: 'Could not find a target app to capture.' })
      return
    }
    this.deps.session.start(pid)
  }

  async onNotesStopConfirmRequested(): Promise<void> {
    const confirmed = await this.deps.confirm('Stop note-taking?')
    if (confirmed) {
      this.deps.session.stop()
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test engine-overrides/electron/notetakerController.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Wire the composition root**

In `desktop/electron/main.ts` (confirm exact location first — do not guess a path that wasn't verified during planning), instantiate: `MeetingWatcher` fed by a `setInterval` polling `readNowPlaying()` (`mediaController.ts`) plus `getActiveTabUrl()` (Task 2) for whichever AppleScript-scriptable browser is currently frontmost (via `frontmostApp()`), plus the existing Chrome-extension tab-URL channel (locate its existing message handler and feed its value into the same `MeetingWatcher.feed()` call — do not build a second detection path for Chrome); `NotetakerSession` backed by the real `require('unmute-native-audio-tap')`; `NotetakerController` wired to real `Notification` and a real confirm dialog; `resolveTargetPid` implemented via `native-ax`'s `frontmostApp()` mapped through `pidForBundleId` (Task 4) or directly if `frontmostApp()` already returns a pid (confirm its actual return shape before assuming). Wire `KeyboardManager`'s `notes-start-requested`/`notes-stop-confirm-requested` events to `controller.onNotesStartRequested()`/`controller.onNotesStopConfirmRequested()`, and `MeetingWatcher`'s events to `controller.onMeetingDetected()`/`onMeetingEnded()`. Show/hide the widget (Task 9) from `NotetakerSession` start/stop, not from the controller, so the widget's visibility always matches actual capture state.

- [ ] **Step 6: Run the full test suite**

Run: `cd desktop && npm test`
Expected: PASS — all existing tests plus every test added in Tasks 1-3, 7, 8, 10.

- [ ] **Step 7: Commit**

```bash
git add desktop/engine-overrides/electron/notetakerController.ts desktop/engine-overrides/electron/notetakerController.test.ts desktop/electron/main.ts
git commit -m "notetaker: wire detection, chord trigger, session, and widget together"
```

---

## What this plan does not (and cannot) verify

Per `superpowers:verification-before-completion` — be explicit about this rather than implying full confidence:

- **Real TCC permission flow.** The "System Audio Recording Only" prompt only fires on a real signed build with a real user present to approve it (spec §8). Task 4's Step 8 verifies the native module *compiles*; it does not verify the prompt fires or capture actually works against a real meeting app.
- **Real hotkey firing.** Task 6's new `left-control-down`/`left-option-down` events need on-device confirmation that the correct macOS keyCodes were used — there is no automated NSEvent simulation in this codebase.
- **Dual mic consumption** (spec §5's open risk) — whether a concurrent regular-dictation `getUserMedia()` call and the note-taker's own mic feed can coexist cleanly, and whether `micWarm.ts` assumes a single consumer, is unverified by this plan and needs an on-device spike.
- **Per-process-group browser tapping** (spec §9) — Task 4 taps a single resolved PID; browsers that split audio across multiple helper processes may need `pidForBundleId` extended to resolve a *group* of PIDs feeding a multi-process `CATapDescription`, which this plan does not attempt.
- **Packaged Info.plist correctness** — Task 5 flags, but does not resolve, whether `extendInfo` in `engine-overrides/electron-builder.yml` actually reaches the packaged app's `Info.plist` today at all, for any of the three usage-description keys.

All of the above require a full signed dev build on the user's own Mac to verify — per this repo's own established build traps (do not use `build:fast` for a testable install).
