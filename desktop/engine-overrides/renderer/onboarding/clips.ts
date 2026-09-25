import agentExplain from './clips/agent-explain-v2.mp4'
import captureClipboard from './clips/capture-clipboard-v2.mp4'
import captureScreenshot from './clips/capture-screenshot-v2.mp4'
import dictationExplain from './clips/dictation-explain-v2.mp4'
import functionKeyReadiness from './clips/function-key-readiness-v2.mp4'
import notetakerExplain from './clips/notetaker-explain-v2.mp4'
import orchestratorExplain from './clips/orchestrator-explain-v2.mp4'
import orientation from './clips/orientation-v2.mp4'
import permissionAccessibility from './clips/permission-accessibility-v2.mp4'
import permissionMicrophone from './clips/permission-microphone-v2.mp4'
import permissionSystemAudio from './clips/permission-system-audio-v2.mp4'
import privacy from './clips/privacy-v2.mp4'
import providerReadiness from './clips/provider-readiness-v2.mp4'
import welcomeProduct from './clips/welcome-product-v2.mp4'

const CLIPS: Readonly<Record<string, string>> = {
  'welcome-product-v2': welcomeProduct,
  'privacy-v2': privacy,
  'permission-microphone-v2': permissionMicrophone,
  'permission-accessibility-v2': permissionAccessibility,
  'function-key-readiness-v2': functionKeyReadiness,
  'permission-system-audio-v2': permissionSystemAudio,
  'provider-readiness-v2': providerReadiness,
  'dictation-explain-v2': dictationExplain,
  'capture-clipboard-v2': captureClipboard,
  'capture-screenshot-v2': captureScreenshot,
  'orchestrator-explain-v2': orchestratorExplain,
  'agent-explain-v2': agentExplain,
  'notetaker-explain-v2': notetakerExplain,
  'orientation-v2': orientation,
}

/** Static imports make Vite fingerprint and package every founder clip. */
export function clipUrl(clipId: string): string {
  return CLIPS[clipId] ?? ''
}
