import agentExplain from './clips/agent-explain-v1.mp4'
import agentNotes from './clips/agent-notes-v1.mp4'
import captureClipboard from './clips/capture-clipboard-v1.mp4'
import captureScreenshot from './clips/capture-screenshot-v1.mp4'
import dictationExplain from './clips/dictation-explain-v1.mp4'
import functionKeyReadiness from './clips/function-key-readiness-v1.mp4'
import notetakerExplain from './clips/notetaker-explain-v1.mp4'
import orchestratorExplain from './clips/orchestrator-explain-v1.mp4'
import orientation from './clips/orientation-v1.mp4'
import permissionAccessibility from './clips/permission-accessibility-v1.mp4'
import permissionMicrophone from './clips/permission-microphone-v1.mp4'
import permissionSystemAudio from './clips/permission-system-audio-v1.mp4'
import privacy from './clips/privacy-v1.mp4'
import providerReadiness from './clips/provider-readiness-v1.mp4'
import signIn from './clips/sign-in-v1.mp4'
import welcomeProduct from './clips/welcome-product-v1.mp4'

const CLIPS: Readonly<Record<string, string>> = {
  'welcome-product-v1': welcomeProduct,
  'privacy-v1': privacy,
  'permission-microphone-v1': permissionMicrophone,
  'permission-accessibility-v1': permissionAccessibility,
  'function-key-readiness-v1': functionKeyReadiness,
  'permission-system-audio-v1': permissionSystemAudio,
  'provider-readiness-v1': providerReadiness,
  'dictation-explain-v1': dictationExplain,
  'capture-clipboard-v1': captureClipboard,
  'capture-screenshot-v1': captureScreenshot,
  'orchestrator-explain-v1': orchestratorExplain,
  'agent-explain-v1': agentExplain,
  'notetaker-explain-v1': notetakerExplain,
  'agent-notes-v1': agentNotes,
  'orientation-v1': orientation,
  'sign-in-v1': signIn,
}

/** Static imports make Vite fingerprint and package every founder clip. */
export function clipUrl(clipId: string): string {
  return CLIPS[clipId] ?? ''
}
