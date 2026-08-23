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
- `startCapture(pid: number, onChunk: (chunk: { samples: Float32Array, sampleRate: number, timestampMs: number }) => void): { mode: 'global-exclude-self', excludedOwnProcess: boolean, ownLookupStatus: number }`
  — captures the system's WHOLE audio output mix (`initStereoGlobalTapButExcludeProcesses:`),
  excluding only THIS process, not `pid`-scoped. `pid` is accepted for API
  continuity (callers may still use it for their own "is anything reasonable
  focused" gating/logging) but no longer determines what gets captured.
  This replaced an earlier per-process-pid approach (tap only the resolved
  target app, or that app's whole `.app`-bundle process family) after two
  real problems: a multi-process browser like Chrome never emits audio from
  its own main process (real output comes from a helper/renderer
  subprocess), and per-process pid resolution proved fragile even after
  fixing that. Validated against two of the most-starred open-source
  projects doing the same thing on macOS (Zackriya-Solutions/meetily,
  screenpipe/screenpipe) — both independently use this same global-tap
  pattern for exactly this reason. `excludedOwnProcess`/`ownLookupStatus`
  report whether this app's own pid resolved (should always be true — a
  `false` is a feedback-risk warning, not a capture failure).
- `stopCapture(): void`
