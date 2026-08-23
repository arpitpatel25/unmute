// Notetaker tab — top-level navigation between the meetings list and the
// Notetaker settings sub-view. Mirrors OrchestratorTab's shape in
// engine-overrides/renderer/app/App.tsx (SegmentedControl + a two-way page
// switch), the closest existing analog to a sidebar tab with sub-pages.

import { useState } from 'react'
import { SegmentedControl } from '../app/_shared'
import { MeetingsList } from './MeetingsList'
import { NotetakerSettings } from './NotetakerSettings'

type NotetakerPage = 'meetings' | 'settings'

export function NotetakerTab() {
  const [page, setPage] = useState<NotetakerPage>('meetings')

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

      {page === 'meetings' && <MeetingsList />}
      {page === 'settings' && <NotetakerSettings />}
    </>
  )
}
