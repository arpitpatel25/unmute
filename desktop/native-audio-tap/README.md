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
