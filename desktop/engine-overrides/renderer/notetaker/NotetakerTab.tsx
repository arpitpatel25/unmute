// Notetaker tab — top-level navigation between the meetings list and the
// Notetaker settings sub-view. Mirrors OrchestratorTab's shape in
// engine-overrides/renderer/app/App.tsx (SegmentedControl + a two-way page
// switch), the closest existing analog to a sidebar tab with sub-pages.

import { useEffect, useState } from 'react'
import { SegmentedControl } from '../app/_shared'
import { MeetingsList } from './MeetingsList'
import { NotetakerSettings } from './NotetakerSettings'

type NotetakerPage = 'meetings' | 'settings'

export function NotetakerTab({
  pendingMeetingId,
  onConsumedPendingMeetingId,
}: {
  /** Set by App.tsx when the Agent's notetaker_open tool fires. */
  pendingMeetingId?: string | null
  onConsumedPendingMeetingId?: () => void
} = {}) {
  const [page, setPage] = useState<NotetakerPage>('meetings')

  // A meeting opened from outside (the Agent) always means "show me the
  // meetings list with this one selected" — force off Settings if that's
  // where the user happened to be.
  useEffect(() => {
    if (pendingMeetingId) setPage('meetings')
  }, [pendingMeetingId])

  return (
    <>
      <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
        <h2 className="font-display text-[22px] font-bold text-ink tracking-tight">Notetaker</h2>
        <SegmentedControl
          options={[
            { value: 'meetings', label: 'Meetings' },
            { value: 'settings', label: 'Settings' },
          ]}
          value={page}
          onChange={(value) => setPage(value as NotetakerPage)}
        />
      </div>

      {page === 'meetings' && (
        <MeetingsList
          pendingMeetingId={pendingMeetingId}
          onConsumedPendingMeetingId={onConsumedPendingMeetingId}
        />
      )}
      {page === 'settings' && <NotetakerSettings />}
    </>
  )
}
