import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain, screen, shell, systemPreferences } from 'electron'

import { AllowanceGrantStore, OnboardingAllowanceSession, InstallationIdentityStore, setOnboardingAllowanceSession } from './paywall/onboarding/allowance'
import { OnboardingCoordinator } from './paywall/onboarding/coordinator'
import { ActionEntry } from './paywall/onboarding/action-entry'
import { hasExistingPaywallSession, getPaywallUser } from './paywall/paywall-glue'
import { escapeEventFor, skipEventFor } from './paywall/onboarding/chapters'
import { openNotesPractice, notesEventFromReceipt } from './paywall/onboarding/notes-practice'
import { prepareOnboardingWorkspace, verifyHelloTask } from './paywall/onboarding/orchestrator-exercise'
import { PresenterWindow } from './paywall/onboarding/presenter-window'
import { defaultProviderProbeDeps, probeProvider, probeProviders, type ProviderProbeResult } from './paywall/onboarding/provider-probe'
import { installProvider, launchProviderLogin } from './paywall/onboarding/provider-setup'
import { ProgressStore } from './paywall/onboarding/progress-store'
import { OnboardingRuntime } from './paywall/onboarding/register'
import { acceptsAgentTaskLink, onOnboardingReceipt } from './paywall/onboarding/receipts'
import type { ActionId, OnboardingEvent, PresenterCommand, ProviderId, ProviderUiStatus } from './paywall/onboarding/types'
import { keyboardManager } from './keyboard'
import { preflightNotetakerSystemAudio } from './notetakerInit'
import { openOnboardingAgent, openOnboardingTask, setOnboardingTaskWorkspace } from './paywall/remote/init'

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
  // Address Notes itself. Never inject global Cmd+N into whatever application
  // happens to be focused when an asynchronous onboarding callback completes.
  await execFileAsync('/usr/bin/osascript', ['-e',
    'tell application "Notes"\nactivate\nset practiceNote to make new note at default account with properties {name:"Unmute practice", body:""}\nshow practiceNote\nend tell',
  ], { timeout: 10_000 }).catch(async error => {
    console.warn('[onboarding] could not create practice note; open Notes manually:', error.message)
    await execFileAsync('/usr/bin/open', ['-b', NOTES_ID])
  })
}

function satisfiedPermissions(progressCompleted: readonly ActionId[]): ActionId[] {
  const result: ActionId[] = []
  if (progressCompleted.includes('welcome')) result.push('welcome')
  if (progressCompleted.includes('privacy')) result.push('privacy')
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') result.push('microphone')
  if (systemPreferences.isTrustedAccessibilityClient(false)) result.push('accessibility')
  if (progressCompleted.includes('function-key')) result.push('function-key')
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
  const prepareInput = (): void => {
    keyboardManager.setDictationKey('fn')
    keyboardManager.setActivationMode('tap-toggle')
  }
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
  const receiptSource = (listener: (event: OnboardingEvent) => Promise<PresenterCommand>) => onOnboardingReceipt(event => {
    if (event.type === 'task-created' && event.cwd !== workspace) return
    if (event.type === 'task-created' && event.source === 'agent') ownedAgentTasks.add(event.taskId)
    if (event.type === 'task-created' && event.source === 'orchestrator'
      && coordinator.snapshot().action === 'orchestrator-task') {
      // The receipt precedes TaskManager's normal created listeners. Let those
      // populate the notch before opening the exact new task.
      setImmediate(() => {
        if (activeRuntime === runtime && runtime.snapshot().action === 'orchestrator-task') {
          openOnboardingTask(event.taskId)
        }
      })
    }
    if (event.type === 'agent-task-linked' && !acceptsAgentTaskLink(event, workspace, ownedAgentTasks)) return
    void Promise.resolve(listener(event)).then(() => afterReceipt?.()).catch(error => console.warn('[onboarding] receipt failed:', error))
  })

  const runtime = new OnboardingRuntime({
    coordinator,
    presenter,
    allowance,
    onReceipt: receiptSource,
    verifyOrchestratorTask: async (_taskId, notBeforeMs) => verifyHelloTask(workspace, [app.getPath('desktop')], notBeforeMs),
    onNavigate: navigate,
  })
  activeRuntime = runtime
  const initial = await runtime.boot({ signedIn: hasExistingPaywallSession() })
  if (initial.action !== 'complete') prepareInput()
  if (initial.action !== 'complete' && !allowance.snapshotGrant() && await allowance.acquire(__PIPELINE_URL__).catch(() => false)) {
    const grant = allowance.snapshotGrant()
    if (grant) await grantStore.save(grant)
  }
  await runtime.accept({ type: 'boot-revalidated', satisfied: satisfiedPermissions(coordinator.currentProgress().completed) })

  let providers: Record<ProviderId, ProviderProbeResult> | null = null
  const installingProviders = new Set<ProviderId>()
  const ensureProviders = async (): Promise<Record<ProviderId, ProviderProbeResult>> => {
    if (!providers) providers = await probeProviders()
    return providers
  }

  const presentProviderChoice = (): void => {
    const command = runtime.snapshot()
    if (command.action !== 'provider-choice') return
    const status = (provider: ProviderId): ProviderUiStatus => {
      if (installingProviders.has(provider)) return { state: 'installing' }
      const result = providers?.[provider]
      return result ? { state: result.state, ...('detail' in result ? { detail: result.detail } : {}) } : { state: 'checking' }
    }
    const bothMissing = providers?.claude.state === 'missing' && providers.codex.state === 'missing'
    const actionableDetail = (['claude', 'codex'] as const)
      .map(provider => providers?.[provider])
      .find(result => result?.state === 'failed' || result?.state === 'timed-out' || result?.state === 'auth-required')
    presenter.send({
      ...command,
      card: {
        kind: 'provider',
        title: bothMissing ? 'Set up an agent' : 'Connect your agent',
        detail: actionableDetail && 'detail' in actionableDetail ? actionableDetail.detail : bothMissing
          ? 'We could not find Claude Code or Codex. Set up either one below—Unmute needs one of them to run agent tasks.'
          : 'Choose a ready agent, or let Unmute set up one that is missing.',
        providers: { claude: status('claude'), codex: status('codex') },
      },
    })
  }

  const actionEntry = new ActionEntry()
  const configureAction = async (command: PresenterCommand): Promise<void> => {
    if (command.action !== runtime.snapshot().action) return
    if (command.action === 'sign-in' && getPaywallUser()) {
      command = await runtime.finishAfterSignIn(true)
    }
    keyboardManager.setFunctionReadinessProbe(command.action === 'function-key'
      ? () => { void runtime.accept({ type: 'function-key-observed' }).then(configureAction) }
      : null)
    const usesWorkspace = command.action === 'orchestrator-task' || command.action === 'agent-task-link'
    setOnboardingTaskWorkspace(usesWorkspace ? workspace : null)
    await actionEntry.run(command.action, async () => {
      if (command.action === 'notes-dictation') {
        await openNotesPractice({ launch: async () => launchFreshNotesNote(), frontmostBundleId, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) })
      }
      if (command.action === 'agent-task-link' || command.action === 'agent-notes') openOnboardingAgent()
    })
    if (command.action === 'provider-choice') presentProviderChoice()
  }
  afterReceipt = () => configureAction(runtime.snapshot())
  keyboardManager.on('keyboard', event => {
    const mapped = event.type === 'session-start' && event.mode === 'dictation'
      ? { type: 'shortcut-started', lane: 'dictation' } as const
      : event.type === 'session-stop' && event.mode === 'dictation'
        ? { type: 'shortcut-stopped', lane: 'dictation' } as const
        : event.type === 'remote-start'
          ? { type: 'shortcut-started', lane: 'orchestrator' } as const
          : event.type === 'remote-stop'
            ? { type: 'shortcut-stopped', lane: 'orchestrator' } as const
            : event.type === 'agent-start'
              ? { type: 'shortcut-started', lane: 'agent' } as const
              : event.type === 'agent-stop'
                ? { type: 'shortcut-stopped', lane: 'agent' } as const
                : null
    if (mapped) void runtime.accept(mapped).then(configureAction)
  })
  await configureAction(runtime.snapshot())
  void probeProviders().then(value => {
    if (!providers) providers = value
    presentProviderChoice()
  }).catch(() => undefined)

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
    if (action === 'welcome' || action === 'privacy' || action === 'agent-notes') granted = true
    if (action === 'microphone') granted = await systemPreferences.askForMediaAccess('microphone')
    if (action === 'accessibility') granted = systemPreferences.isTrustedAccessibilityClient(true)
    if (action === 'system-audio') granted = await preflightNotetakerSystemAudio() === 'granted'
    if (granted) await runtime.accept({ type: 'capability-satisfied', action })
    await configureAction(runtime.snapshot())
  }

  ipcMain.removeHandler('onboarding:snapshot')
  ipcMain.removeHandler('onboarding:reset')
  ipcMain.removeHandler('onboarding:orientation-complete')
  ipcMain.removeHandler('onboarding:finish-after-sign-in')
  ipcMain.handle('onboarding:snapshot', () => runtime.snapshot())
  ipcMain.handle('onboarding:reset', async () => { prepareInput(); const result = await runtime.reset(); await configureAction(result); return result })
  ipcMain.handle('onboarding:orientation-complete', async () => { const result = await runtime.completeOrientation(); await configureAction(result); return result })
  ipcMain.handle('onboarding:finish-after-sign-in', async (_event, signedIn: boolean) => {
    const before = runtime.snapshot().action
    const result = await runtime.finishAfterSignIn(signedIn === true)
    if (result.action === 'complete') await grantStore.reset()
    if (result.action !== before) await configureAction(result)
    return result
  })
  ipcMain.removeAllListeners('onboarding:presenter-action')
  ipcMain.removeAllListeners('onboarding:presenter-move')
  ipcMain.on('onboarding:presenter-move', (_event, value: unknown) => {
    const delta = value as { deltaX?: unknown; deltaY?: unknown }
    if (typeof delta?.deltaX !== 'number' || typeof delta?.deltaY !== 'number') return
    presenter.moveBy(delta.deltaX, delta.deltaY)
  })
  ipcMain.on('onboarding:presenter-action', async (_event, value: unknown) => {
    const action = value as { type?: string; provider?: ProviderId }
    if (action.type === 'continue') {
      await advancePermission()
    }
    if (action.type === 'skip-section') {
      const skip = skipEventFor(runtime.snapshot())
      if (skip) {
        const result = await runtime.accept(skip)
        if (result.action === 'complete') await grantStore.reset()
        await configureAction(result)
      }
    }
    if (action.type === 'dismiss') {
      const result = await runtime.dismiss()
      await configureAction(result)
      await grantStore.reset()
    }
    if (action.type === 'continue-anyway') {
      const escape = escapeEventFor(runtime.snapshot())
      if (escape) {
        const result = await runtime.accept(escape)
        await configureAction(result)
      }
    }
    if (action.type === 'retry') {
      const result = await runtime.accept({ type: 'retry-requested' })
      await configureAction(result)
    }
    if (action.type === 'open-settings' && runtime.snapshot().action === 'function-key') {
      await shell.openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension')
    }
    if (action.type === 'complete-orientation' && runtime.snapshot().action === 'product-orientation') {
      const result = await runtime.completeOrientation()
      await configureAction(result)
    }
    if (action.type === 'open-sign-in' && runtime.snapshot().action === 'sign-in') navigate('account')
    if (action.type === 'choose-provider' && (action.provider === 'claude' || action.provider === 'codex')) {
      const currentProviders = await ensureProviders()
      const result = currentProviders[action.provider]
      if (result.state === 'ready') await runtime.accept({ type: 'provider-selected', provider: action.provider })
      else presentProviderChoice()
      await configureAction(runtime.snapshot())
    }
    if (action.type === 'install-provider' && (action.provider === 'claude' || action.provider === 'codex') && runtime.snapshot().action === 'provider-choice') {
      if (installingProviders.has(action.provider)) return
      installingProviders.add(action.provider)
      presentProviderChoice()
      const installed = await installProvider(action.provider)
      installingProviders.delete(action.provider)
      const currentProviders = await ensureProviders()
      currentProviders[action.provider] = installed.state === 'installed'
        ? await probeProvider(action.provider)
        : { provider: action.provider, state: 'failed', detail: installed.detail }
      presentProviderChoice()
    }
    if (action.type === 'authenticate-provider' && (action.provider === 'claude' || action.provider === 'codex') && runtime.snapshot().action === 'provider-choice') {
      const binary = await defaultProviderProbeDeps.resolveBinary(action.provider)
      const currentProviders = await ensureProviders()
      if (!binary) {
        currentProviders[action.provider] = { provider: action.provider, state: 'missing', detail: 'The CLI could not be found. Set it up and try again.' }
      } else {
        launchProviderLogin(action.provider, binary)
        currentProviders[action.provider] = { provider: action.provider, state: 'failed', detail: 'Finish signing in with the provider, then check again.' }
      }
      presentProviderChoice()
    }
    if (action.type === 'retry-provider' && (action.provider === 'claude' || action.provider === 'codex') && runtime.snapshot().action === 'provider-choice') {
      const currentProviders = await ensureProviders()
      currentProviders[action.provider] = await probeProvider(action.provider)
      presentProviderChoice()
    }
  })
  return runtime
}
