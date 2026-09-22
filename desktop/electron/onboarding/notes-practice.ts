export const APPLE_NOTES_BUNDLE_ID = 'com.apple.Notes'

export interface NotesPracticeAdapters {
  launch(bundleId: string): Promise<void>
  frontmostBundleId(): Promise<string | null>
  sleep(ms: number): Promise<void>
}

export interface DeliveryReceipt {
  captureId: string
  mode: 'dictation' | 'instruction'
  targetBundleId: string | null
  delivered: boolean
  changedSelection?: boolean
}

export async function openNotesPractice(adapters: NotesPracticeAdapters, timeoutMs = 5_000): Promise<boolean> {
  await adapters.launch(APPLE_NOTES_BUNDLE_ID)
  const deadline = Date.now() + timeoutMs
  do {
    if (await adapters.frontmostBundleId() === APPLE_NOTES_BUNDLE_ID) return true
    await adapters.sleep(100)
  } while (Date.now() < deadline)
  return false
}

export function notesEventFromReceipt(receipt: DeliveryReceipt) {
  if (!receipt.delivered || receipt.mode !== 'dictation' || receipt.targetBundleId !== APPLE_NOTES_BUNDLE_ID) return null
  return { type: 'dictation-delivered' as const, captureId: receipt.captureId, target: receipt.targetBundleId }
}
