export interface ScreenCaptureVisibilityCommand {
  type: 'screenCaptureVisibility'
  show: boolean
}

/** Default-visible policy shared by launch restoration, Settings IPC and tests. */
export function screenCaptureVisibility(value: boolean | undefined): {
  show: boolean
  command: ScreenCaptureVisibilityCommand
} {
  const show = value !== false
  return { show, command: { type: 'screenCaptureVisibility', show } }
}
