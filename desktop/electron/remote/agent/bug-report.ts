/** A report leaves the device. Only a direct request in this turn can authorize it. */
export function isExplicitBugReportRequest(transcript: string): boolean {
  const text = transcript.trim().toLowerCase()
  if (/\b(?:do not|don't|never|without)\s+(?:\w+\s+){0,3}(?:report|send|file|submit|tell)\b/u.test(text)) return false
  if (/\b(?:how|where|what|should i)\b.{0,60}\b(?:report|send|file|submit)\b/u.test(text)) return false
  return /\b(?:report|send|file|submit|tell)\b/u.test(text)
    && /\b(?:bug|issue|problem)\b/u.test(text)
    && /\b(?:unmute|unmute team)\b/u.test(text)
}
