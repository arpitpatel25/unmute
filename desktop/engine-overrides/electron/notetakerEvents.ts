export type NotesReadyEvent = { meetingId: string; title: string; notesPath: string }

const notesReadyListeners = new Set<(e: NotesReadyEvent) => void>()

export function onNotesReady(listener: (e: NotesReadyEvent) => void): () => void {
  notesReadyListeners.add(listener)
  return () => { notesReadyListeners.delete(listener) }
}

/** Listeners are isolated: one throwing never stops the rest, nor the notes pipeline. */
export function emitNotesReady(e: NotesReadyEvent, onError: (error: unknown) => void = () => {}): void {
  for (const listener of [...notesReadyListeners]) {
    try { listener(e) } catch (error) { onError(error) }
  }
}
