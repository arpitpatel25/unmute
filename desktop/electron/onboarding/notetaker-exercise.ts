export type NotetakerExerciseEvent =
  | { type: 'notetaker-started'; meetingId: string }
  | { type: 'notetaker-stopped'; meetingId: string }
  | { type: 'notetaker-saved'; meetingId: string }
  | { type: 'notetaker-failed'; meetingId?: string; reason: string }

export function notetakerEvent(type: NotetakerExerciseEvent['type'], meetingId: string, reason?: string): NotetakerExerciseEvent {
  return type === 'notetaker-failed' ? { type, meetingId: meetingId || undefined, reason: reason ?? 'Capture failed' } : { type, meetingId }
}
