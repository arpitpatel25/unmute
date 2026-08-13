export interface HistoryPasteComposition {
  text: string
  images: readonly string[]
}

export interface ClipboardIdentity {
  /** macOS NSPasteboard.changeCount. Null means the native probe is absent. */
  changeCount: number | null
  text: string
}

interface PendingComposition {
  composition: { text: string; images: string[] }
  clipboard: ClipboardIdentity
}

/**
 * One-shot state for History's "Copy text + images" action.
 *
 * The system pasteboard cannot express a cross-application promise that says
 * "paste this text, then paste these images". History therefore leaves the
 * text on the real pasteboard and remembers only the follow-up images. When
 * the next physical Cmd+V is observed, this object returns those images iff
 * the pasteboard is still the exact write History made.
 */
export class HistoryPasteStage {
  private pending: PendingComposition | null = null

  set(composition: HistoryPasteComposition, clipboard: ClipboardIdentity): void {
    this.pending = {
      composition: { text: composition.text, images: [...composition.images] },
      clipboard: { ...clipboard },
    }
  }

  clear(): void { this.pending = null }

  take(current: ClipboardIdentity): { text: string; images: string[] } | null {
    const pending = this.pending
    // A paste attempt consumes the promise even when it is stale. That keeps a
    // later, unrelated paste from ever receiving old history images.
    this.pending = null
    if (!pending) return null

    const counterMatches = pending.clipboard.changeCount !== null && current.changeCount !== null
      ? pending.clipboard.changeCount === current.changeCount
      : pending.clipboard.text === current.text
    if (!counterMatches || pending.clipboard.text !== current.text) return null

    return {
      text: pending.composition.text,
      images: [...pending.composition.images],
    }
  }
}
