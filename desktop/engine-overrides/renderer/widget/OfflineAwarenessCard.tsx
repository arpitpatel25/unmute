// Awareness card that appears below the pill when the on-device engine is
// active. Tells the user *why* (not signed in, no balance, cloud unreachable,
// or chosen). Dismissible per app session (no persistence). Mounting this
// component triggers an HUD window resize via paywallSetHUDHeight; the
// effect cleanup restores the compact height on unmount.

import { useEffect } from 'react'

export type OfflineReason =
  | 'not_signed_in'
  | 'no_balance'
  | 'cloud_unreachable'
  | 'chose_on_device'

const REASON_TEXT: Record<OfflineReason, string> = {
  not_signed_in: 'Sign in for faster cloud transcription',
  no_balance: 'Out of credits — top up for cloud transcription',
  cloud_unreachable: 'Cloud unreachable — using on-device model',
  chose_on_device: 'On-device mode is selected in Settings',
}

const EXPANDED_HEIGHT = 142
const COMPACT_HEIGHT = 72

interface Props {
  reason: OfflineReason
  onDismiss: () => void
}

export default function OfflineAwarenessCard({ reason, onDismiss }: Props) {
  // Grow the HUD window while the card is visible so it doesn't get clipped
  // by the compact pill canvas. Restore on unmount/dismiss.
  useEffect(() => {
    window.electronAPI.paywallSetHUDHeight?.(EXPANDED_HEIGHT).catch(() => {})
    return () => {
      window.electronAPI.paywallSetHUDHeight?.(COMPACT_HEIGHT).catch(() => {})
    }
  }, [])

  return (
    <div
      className="awareness-card"
      style={{
        marginTop: 8,
        width: 360,
        background: '#FAF6F1',
        border: '1px solid rgba(0,0,0,0.08)',
        borderRadius: 12,
        boxShadow: '0 6px 18px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.06)',
        padding: '10px 12px 10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: 'system-ui, -apple-system, "Helvetica Neue", sans-serif',
        pointerEvents: 'auto',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: '#1a1612',
            letterSpacing: '-0.01em',
            lineHeight: 1.2,
            marginBottom: 2,
          }}
        >
          Offline model
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'rgba(26,22,18,0.6)',
            lineHeight: 1.3,
          }}
        >
          {REASON_TEXT[reason]}
        </div>
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          border: 'none',
          background: 'rgba(0,0,0,0.04)',
          color: 'rgba(26,22,18,0.55)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  )
}
