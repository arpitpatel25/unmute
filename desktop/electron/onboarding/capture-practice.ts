export type PracticeCaptureKind = 'clipboard-text' | 'screenshot'
export interface CompositionReceipt { captureId: string; observed: Array<{ id: string; kind: PracticeCaptureKind }>; deliveredItemIds: string[]; targetBundleId: string | null }

export function captureEvents(receipt: CompositionReceipt) {
  return [
    ...receipt.observed.map(item => ({ type: 'capture-observed' as const, captureId: receipt.captureId, kind: item.kind, itemId: item.id })),
    { type: 'capture-delivered' as const, captureId: receipt.captureId, includedItemIds: receipt.deliveredItemIds },
  ]
}
