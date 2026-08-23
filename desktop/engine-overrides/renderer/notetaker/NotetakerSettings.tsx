// Notetaker settings — v1 is deliberately minimal: a reference display of the
// trigger hotkey. The meeting-detection-prompt toggle mentioned in the spec is
// a nice-to-have; this codebase's settings persistence (Settings.tsx /
// SETTINGS_SECTIONS) lives in Pack B's ownership and has no existing key for
// this specific setting, so wiring real persistence here would mean either
// reaching into a file this task doesn't own or inventing a new ad hoc
// storage mechanism under time pressure. Per the task brief, that's an
// explicit follow-up rather than a half-wired toggle — see the report.

export function NotetakerSettings() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-[13px] font-semibold text-ink mb-1">Trigger</h3>
        <p className="text-[12px] text-ink-60 leading-relaxed">
          Double-tap Control + Option (left side) to start or stop recording a meeting.
          Manual capture always works, whether or not a call is detected.
        </p>
      </div>
    </div>
  )
}
