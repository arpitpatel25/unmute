// PillController — the bridge between the capture renderer and the native
// input surface.
//
// ARCHITECTURE, AND WHY IT IS THIS SHAPE.
//
// The pill's visuals moved to Swift; its BEHAVIOUR did not. Audio capture, VAD,
// mic-source resolution, the staged-image ledger and the model/agent catalogs
// all stay in the renderer and in main exactly where they already work. This
// class only:
//
//   renderer state  →  `pill` command   →  the helper draws it
//   helper gesture  →  `pill*` event    →  the SAME handlers the DOM pill called
//
// Nothing here touches the capture path. That is deliberate and load-bearing:
// heavy main-process work while recording corrupts audio, so the only traffic
// this adds during a capture is one small JSON line PER SECOND for the timer.
// Everything else is pushed on change.
//
// Pure orchestration over injected deps — unit-testable without a window, a
// child process or an audio device.
import { createLogger } from '../log'

const log = createLogger('pill-controller')

export type PillPhase =
  | 'hidden' | 'recording' | 'processing' | 'output' | 'output-fallback' | 'too-short' | 'cancelled' | 'error'
export type PillKind = 'dictation' | 'remote'
export type PillOfflineReason =
  | 'not_signed_in' | 'no_subscription' | 'payment_failed'
  | 'cloud_unreachable' | 'chose_on_device'

export interface PillOptionP {
  id: string
  label: string
  detail?: string
  available?: boolean
}

export interface PillCoachingP {
  condition: string
  remedy?: string
  level?: 'warn' | 'good'
}

/** Everything the surface draws. Every field optional — the helper decodes
 *  partial payloads, so a level-only update is one tiny line. */
export interface PillStateP {
  phase?: PillPhase
  kind?: PillKind
  level?: number
  elapsed?: number
  maxSeconds?: number
  message?: string
  /** Each state keeps its OWN copy — funnelling these through one `message`
   *  is how "Didn't catch that" turned into "something went wrong". */
  fallbackMessage?: string
  outputPreview?: string
  mutedText?: string
  draftOffer?: boolean
  engineNotice?: boolean
  showDiscardHint?: boolean
  model?: string
  modelOptions?: PillOptionP[]
  agent?: string
  agentOptions?: PillOptionP[]
  stagedCount?: number
  raw?: boolean
  micOptions?: PillOptionP[]
  mic?: string
  coaching?: PillCoachingP | null
  offline?: PillOfflineReason | null
  canUndo?: boolean
}

/** Gestures the surface sends back. Each maps 1:1 onto an existing handler. */
export interface PillControllerDeps {
  /** Finish the current capture now (the pill's stop button). */
  stop(): void
  /** Discard it. */
  cancel(): void
  /** Undo the last paste. */
  undo(): void
  /** Insert the offered draft. */
  acceptDraft(): void
  /** Switch the doer model for the NEXT task. */
  pickModel(id: string): void
  /** Switch the backend the next task runs on. */
  pickAgent(id: string): void
  /** Switch capture source. */
  pickMic(id: string): void
  /** Session-scoped raw override. */
  toggleRaw(on: boolean): void
  /** Drop every staged image. */
  clearStaged(): void
  /** Open the Dodo customer portal (payment-failed recovery). */
  openBillingPortal(): void
  /** Dismiss the offline-awareness card for this app session. */
  dismissOffline(): void
}

export interface PillClientLike {
  send(cmd: { type: string; [k: string]: unknown }): void
  on(event: string, cb: (e: { type: string; [k: string]: unknown }) => void): unknown
}

export class PillController {
  private last: PillStateP = {}

  constructor(
    private readonly client: PillClientLike,
    private readonly deps: PillControllerDeps,
  ) {
    this.client.on('event', (e) => this.onEvent(e))
  }

  /** Push a full or partial state. Unchanged payloads are dropped so a renderer
   *  that re-renders on every tick cannot flood the helper. */
  push(state: PillStateP): void {
    const merged = { ...this.last, ...state }
    if (shallowEqual(merged, this.last)) return
    this.last = merged
    this.client.send({ type: 'pill', state: merged })
  }

  /** The recording timer — one tick per second while a capture is running.
   *
   *  Deliberately NOT routed through push(): it skips the merge/compare, so a
   *  tick is a shallow write rather than a diff over the whole state object.
   *  Identical consecutive values must still send, or a paused clock would look
   *  like a stalled capture. */
  level(level: number, elapsed?: number): void {
    if (this.last.phase !== 'recording') return
    this.last.level = level
    if (elapsed !== undefined) this.last.elapsed = elapsed
    this.client.send({
      type: 'pill',
      state: { ...this.last, level, ...(elapsed !== undefined ? { elapsed } : {}) },
    })
  }

  /** Tear the surface down. */
  hide(): void {
    this.last = { phase: 'hidden' }
    this.client.send({ type: 'pill', state: this.last })
  }

  private onEvent(e: { type: string; [k: string]: unknown }): void {
    const value = typeof e.value === 'string' ? e.value : ''
    switch (e.type) {
      case 'pillStop':        this.deps.stop(); break
      case 'pillCancel':      this.deps.cancel(); break
      case 'pillUndo':        this.deps.undo(); break
      case 'pillAcceptDraft': this.deps.acceptDraft(); break
      case 'pillPickModel':   if (value) this.deps.pickModel(value); break
      case 'pillPickAgent':   if (value) this.deps.pickAgent(value); break
      case 'pillPickMic':     if (value) this.deps.pickMic(value); break
      case 'pillToggleRaw':   this.deps.toggleRaw(e.value === true); break
      case 'pillClearStaged': this.deps.clearStaged(); break
      case 'pillOpenBillingPortal': this.deps.openBillingPortal(); break
      case 'pillDismissOffline':    this.deps.dismissOffline(); break
      default: return // not ours — the notch controller handles the rest
    }
    log.event('pill-event', { type: e.type })
  }
}

/** One level deep; arrays compared by JSON. Enough for a flat state object and
 *  far cheaper than a deep walk on every renderer tick. */
function shallowEqual(a: PillStateP, b: PillStateP): boolean {
  const ka = Object.keys(a) as Array<keyof PillStateP>
  const kb = Object.keys(b) as Array<keyof PillStateP>
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    const va = a[k]
    const vb = b[k]
    if (va === vb) continue
    if (typeof va === 'object' && typeof vb === 'object' && va && vb) {
      if (JSON.stringify(va) === JSON.stringify(vb)) continue
    }
    return false
  }
  return true
}
