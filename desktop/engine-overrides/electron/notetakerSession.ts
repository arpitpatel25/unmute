// desktop/engine-overrides/electron/notetakerSession.ts

export type TimestampedChunk = {
  source: 'mic' | 'system'
  samples: Float32Array
  sampleRate: number
  /** How many audio channels `samples` carries. The system tap is created as
   *  a STEREO mixdown (initStereoMixdownOfProcesses), so its chunks are
   *  normally 2-channel interleaved — a consumer that assumes mono would play
   *  them back at roughly double speed. The mic side, fed from the renderer's
   *  getUserMedia recorder, is mono. Carried honestly here so no downstream
   *  consumer has to guess; nothing reads it yet. */
  channels: number
  timestampMs: number
}

/** One chunk as the native addon delivers it (see
 *  desktop/native-audio-tap/src/audiotap.mm — `sampleRate` is the aggregate
 *  device's real queried rate, `channels` is the buffer's own
 *  mNumberChannels). */
export type NativeAudioChunk = {
  samples: Float32Array
  sampleRate: number
  channels: number
  timestampMs: number
}

/** Diagnostics returned by a successful startCapture() — see
 *  desktop/native-audio-tap/src/audiotap.mm's StartCapture. The native tap
 *  captures the system's WHOLE audio output mix (initStereoGlobalTapButExcludeProcesses),
 *  excluding only this app's own process — not a specific target app's pid.
 *  (An earlier version resolved a target pid, or that pid's whole .app-bundle
 *  process family, and tapped only those; a multi-process browser like
 *  Chrome never emits audio from its own main process, so that approach
 *  proved fragile — see the native file's header comment for the full
 *  history and the two open-source projects this global-tap approach was
 *  validated against.) */
export type AudioTapStartResult = {
  mode: 'global-exclude-self'
  /** Whether this app's own process was successfully excluded from the tap
   *  (should always be true — false means a feedback risk if this app ever
   *  plays audio itself, which it doesn't today, so not fatal). */
  excludedOwnProcess: boolean
  /** Raw OSStatus from resolving this app's own pid to a Core Audio process
   *  object. 0 (noErr) when excludedOwnProcess is true. */
  ownLookupStatus: number
}

export type NativeAudioTap = {
  startCapture: (pid: number, onChunk: (c: NativeAudioChunk) => void) => AudioTapStartResult | void
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

  /** Returns the native tap's diagnostics (which pids actually got tapped),
   *  or undefined if the underlying tap doesn't report any (e.g. a test
   *  fake). Callers that want to log this should read the return value —
   *  it is NOT stored on the session, to keep this class's own state
   *  minimal. */
  start(targetPid: number): AudioTapStartResult | undefined {
    if (this.active) {
      throw new Error('NotetakerSession already active — call stop() first')
    }
    try {
      const result = this.nativeAudioTap.startCapture(targetPid, (c) => {
        if (!this.active) return
        this.onChunk({
          source: 'system',
          samples: c.samples,
          sampleRate: c.sampleRate,
          channels: c.channels,
          timestampMs: c.timestampMs,
        })
      })
      this.active = true
      return result || undefined
    } catch (err) {
      this.active = false
      throw err
    }
  }

  /** Signature deliberately unchanged. `channels: 1` is not a guess: the mic
   *  path is the renderer's existing getUserMedia recorder, which is mono
   *  (widget/useAudioRecorder.ts). Stated explicitly so the mic side of a
   *  TimestampedChunk is as honest about its shape as the system side. */
  feedMicChunk(samples: Float32Array, sampleRate: number, timestampMs: number): void {
    if (!this.active) return
    this.onChunk({ source: 'mic', samples, sampleRate, channels: 1, timestampMs })
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.nativeAudioTap.stopCapture()
  }
}
