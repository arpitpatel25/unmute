import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain, screen, systemPreferences } from 'electron'

import { AllowanceGrantStore, OnboardingAllowanceSession, InstallationIdentityStore, setOnboardingAllowanceSession } from './paywall/onboarding/allowance'
import { OnboardingCoordinator } from './paywall/onboarding/coordinator'
import { openNotesPractice, notesEventFromReceipt } from './paywall/onboarding/notes-practice'
import { prepareOnboardingWorkspace, verifyHelloTask } from './paywall/onboarding/orchestrator-exercise'
import { PresenterWindow } from './paywall/onboarding/presenter-window'
import { probeProviders, type ProviderProbeResult } from './paywall/onboarding/provider-probe'
import { ProgressStore } from './paywall/onboarding/progress-store'
import { OnboardingRuntime } from './paywall/onboarding/register'
import { onOnboardingReceipt } from './paywall/onboarding/receipts'
import type { ActionId, OnboardingEvent, PresenterCommand, ProviderId } from './paywall/onboarding/types'
import { isGlobalKeyMonitoringReady, requestGlobalKeyMonitoring } from './keyListener'
import { preflightNotetakerSystemAudio } from './notetakerInit'
import { setOnboardingTaskWorkspace } from './paywall/remote/init'

declare const __PIPELINE_URL__: string
const execFileAsync = promisify(execFile)
const NOTES_ID = 'com.apple.Notes'

type SessionManagerForOnboarding = {
  onOnboardingDelivery: ((receipt: { captureId: string; mode: 'dictation' | 'instruction'; changedSelection: boolean; includedItemIds: string[] }) => void | Promise<void>) | null
}

function routeUrl(): string {
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? `${dev}#/onboarding-presenter`
    : `${pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()}#/onboarding-presenter`
}

async function frontmostBundleId(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'])
    return String(stdout).trim() || null
  } catch { return null }
}

async function launchFreshNotesNote(): Promise<void> {
  await execFileAsync('/usr/bin/open', ['-b', NOTES_ID])
  await new Promise(resolve => setTimeout(resolve, 350))
  await execFileAsync('/usr/bin/osascript', ['-e', 'tell application "System Events" to keystroke "n" using command down']).catch(() => undefined)
}

function satisfiedPermissions(progressCompleted: readonly ActionId[]): ActionId[] {
  const result: ActionId[] = []
  if (progressCompleted.includes('privacy')) result.push('privacy')
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') result.push('microphone')
  if (systemPreferences.isTrustedAccessibilityClient(false)) result.push('accessibility')
  if (isGlobalKeyMonitoringReady()) result.push('input-monitoring')
  // macOS exposes no non-prompting ScreenCaptureKit audio probe. Once the real
  // tap succeeded, preserve that checkpoint; the Notetaker start remains the
  // authoritative runtime check if the permission is later revoked.
  if (progressCompleted.includes('system-audio')) result.push('system-audio')
  return result
}

let activeRuntime: OnboardingRuntime | null = null

export async function initOnboarding(
  sessionManager: SessionManagerForOnboarding,
  navigate: (destination: 'orchestrator' | 'notetaker' | 'account') => void,
): Promise<OnboardingRuntime> {
  activeRuntime?.dispose()
  const root = path.join(app.getPath('userData'), 'onboarding')
  const workspace = path.join(root, 'workspace')
  await prepareOnboardingWorkspace(workspace)

  const coordinator = new OnboardingCoordinator(new ProgressStore(path.join(root, 'progress-v1.json')))
  const installationId = await new InstallationIdentityStore(path.join(root, 'installation-id')).getOrCreate()
  const allowance = new OnboardingAllowanceSession(installationId)
  const grantStore = new AllowanceGrantStore(path.join(root, 'allowance-grant.json'))
  const retainedGrant = await grantStore.load()
  if (retainedGrant) allowance.acceptGrant(retainedGrant)
  setOnboardingAllowanceSession(allowance)

  const presenter = new PresenterWindow({
    create: options => new BrowserWindow({
      ...options,
      webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false },
    }) as never,
    routeUrl,
    displayWorkArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
  })

  const ownedAgentTasks = new Set<string>()
  let afterReceipt: (() => Promise<void>) | null = null
  const receiptSource = (listener: (event: OnboardingEvent) => void) => onOnboardingReceipt(event => {
    if (event.type === 'task-created' && event.cwd !== workspace) return
    if (event.type === 'task-created' && event.source === 'agent') ownedAgentTasks.add(event.taskId)
    if (event.type === 'agent-task-linked' && event.cwd !== workspace && !ownedAgentTasks.has(event.taskId)) return
    void Promise.resolve(listener(event)).then(() => afterReceipt?.()).catch(error => console.warn('[onboarding] receipt failed:', error))
  })

  const runtime = new OnboardingRuntime({
    coordinator,
    presenter,
    allowance,
    onReceipt: receiptSource,
    verifyOrchestratorTask: async () => verifyHelloTask(workspace),
    onNavigate: navigate,
  })
  activeRuntime = runtime
  const initial = await runtime.boot()
  if (initial.action !== 'complete' && !allowance.snapshotGrant() && await allowance.acquire(__PIPELINE_URL__).catch(() => false)) {
    const grant = allowance.snapshotGrant()
    if (grant) await grantStore.save(grant)
  }
  await runtime.accept({ type: 'boot-revalidated', satisfied: satisfiedPermissions(coordinator.currentProgress().completed) })

  let providers: Record<ProviderId, ProviderProbeResult> | null = null
  void probeProviders().then(value => { providers = value }).catch(() => undefined)

  const configureAction = async (command: PresenterCommand): Promise<void> => {
    const usesWorkspace = command.action === 'orchestrator-task' || command.action === 'agent-task-link'
    setOnboardingTaskWorkspace(usesWorkspace ? workspace : null)
    if (command.action === 'notes-dictation') {
      await openNotesPractice({ launch: async () => launchFreshNotesNote(), frontmostBundleId, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) })
    }
  }
  afterReceipt = () => configureAction(runtime.snapshot())
  await configureAction(runtime.snapshot())

  sessionManager.onOnboardingDelivery = async receipt => {
    const target = await frontmostBundleId()
    const notes = notesEventFromReceipt({ ...receipt, targetBundleId: target, delivered: true })
    if (notes) await runtime.accept(notes)
    if (receipt.includedItemIds.length) {
      await runtime.accept({ type: 'capture-delivered', captureId: receipt.captureId, includedItemIds: receipt.includedItemIds })
    }
    await configureAction(runtime.snapshot())
  }

  const advancePermission = async (): Promise<void> => {
    const action = runtime.snapshot().action
    let granted = false
    if (action === 'privacy') granted = true
    if (action === 'microphone') granted = await systemPreferences.askForMediaAccess('microphone')
    if (action === 'accessibility') granted = systemPreferences.isTrustedAccessibilityClient(true)
    if (action === 'input-monitoring') { requestGlobalKeyMonitoring(); granted = isGlobalKeyMonitoringReady() }
    if (action === 'system-audio') granted = await preflightNotetakerSystemAudio() === 'granted'
    if (granted) await runtime.accept({ type: 'capability-satisfied', action })
    await configureAction(runtime.snapshot())
  }

  ipcMain.removeHandler('onboarding:snapshot')
  ipcMain.removeHandler('onboarding:reset')
  ipcMain.removeHandler('onboarding:orientation-complete')
  ipcMain.removeHandler('onboarding:finish-after-sign-in')
  ipcMain.handle('onboarding:snapshot', () => runtime.snapshot())
  ipcMain.handle('onboarding:reset', async () => { const result = await runtime.reset(); await configureAction(result); return result })
  ipcMain.handle('onboarding:orientation-complete', async () => { const result = await runtime.completeOrientation(); await configureAction(result); return result })
  ipcMain.handle('onboarding:finish-after-sign-in', async (_event, signedIn: boolean) => {
    const result = await runtime.finishAfterSignIn(signedIn === true)
    if (result.action === 'complete') await grantStore.reset()
    await configureAction(result)
    return result
  })
  ipcMain.removeAllListeners('onboarding:presenter-action')
  ipcMain.on('onboarding:presenter-action', async (_event, value: unknown) => {
    const action = value as { type?: string; provider?: ProviderId }
    if (action.type === 'continue' || action.type === 'retry') await advancePermission()
    if (action.type === 'complete-orientation' && runtime.snapshot().action === 'product-orientation') {
      const result = await runtime.completeOrientation()
      await configureAction(result)
    }
    if (action.type === 'open-sign-in' && runtime.snapshot().action === 'sign-in') navigate('account')
    if (action.type === 'choose-provider' && (action.provider === 'claude' || action.provider === 'codex')) {
      providers ??= await probeProviders()
      const result = providers[action.provider]
      if (result.state === 'ready') await runtime.accept({ type: 'provider-selected', provider: action.provider })
      else presenter.send({ ...runtime.snapshot(), card: { kind: 'repair', title: `${action.provider === 'claude' ? 'Claude Code' : 'Codex'} needs setup`, detail: result.detail } })
      await configureAction(runtime.snapshot())
    }
  })
  return runtime
}
