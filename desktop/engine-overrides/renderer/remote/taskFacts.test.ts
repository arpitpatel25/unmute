import { test, describe } from 'node:test'
import assert from 'node:assert'
import {
  agentAndModel, canKill, canResume, dirLabel, hasTerminal, isDesktopTask, openInLabel,
  providerLabel, vendorMark, UNKNOWN_VENDOR_MARK,
} from './taskFacts'
import type { RemoteTask } from './useRemoteTasks'

const PROVIDERS = {
  claude: { id: 'claude', vendor: 'Claude', surface: 'cli', label: 'Claude Code CLI', transport: 'structured', hasTerminal: false, canResume: true },
  codexDesktop: { id: 'codex-desktop', vendor: 'Codex', surface: 'desktop', label: 'Codex desktop', transport: 'driver', hasTerminal: false, canResume: false },
  claudeDesktop: { id: 'claude-code-desktop', vendor: 'Claude', surface: 'desktop', label: 'Claude desktop', transport: 'driver', hasTerminal: false, canResume: false },
} as const

const task = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  id: 't1', intent: 'do a thing', state: 'done',
  createdAt: 0, updatedAt: 0, result: null, error: null, question: null, mcpGap: null,
  ...over,
} as RemoteTask)

describe('capability questions ask the registry, never the id', () => {
  test('a driver backend offers no terminal and no resume', () => {
    const t = task({ provider: PROVIDERS.codexDesktop as RemoteTask['provider'], agent: 'codex-desktop' })
    assert.equal(hasTerminal(t), false)
    assert.equal(canResume(t), false)
    assert.equal(canKill(t), false)
  })

  test('an owned chat offers stop and resume but no terminal or external-app handoff', () => {
    const t = task({ provider: PROVIDERS.claude as RemoteTask['provider'], agent: 'claude' })
    assert.equal(hasTerminal(t), false)
    assert.equal(isDesktopTask(t), false)
    assert.equal(canResume(t), true)
    assert.equal(canKill(t), true)
  })

  test('the AGENT ID is never consulted — a Codex id with a PTY provider is resumable', () => {
    // The exact failure the registry replaced: four `agent !== "codex-desktop"`
    // checks. If any survived, this task would lose its buttons.
    const t = task({ provider: PROVIDERS.claude as RemoteTask['provider'], agent: 'codex-desktop' })
    assert.equal(canResume(t), true)
    assert.equal(hasTerminal(t), false)
  })

  test('a pre-registry payload (no provider) is treated as the PTY session it was', () => {
    const t = task({ agent: undefined })
    assert.equal(hasTerminal(t), false)
    assert.equal(canResume(t), true)
    assert.equal(canKill(t), true)
  })
})

describe('model is a historical fact, never invented (D6)', () => {
  test('present → agent · model', () => {
    const t = task({ provider: PROVIDERS.claude as RemoteTask['provider'], model: 'sonnet' })
    assert.equal(agentAndModel(t), 'Claude Code CLI · sonnet')
  })

  test('absent → the agent ALONE, with no separator and no default', () => {
    const t = task({ provider: PROVIDERS.claude as RemoteTask['provider'] })
    assert.equal(agentAndModel(t), 'Claude Code CLI')
    assert.ok(!agentAndModel(t).includes('·'))
    for (const invented of ['sonnet', 'opus', 'haiku', 'default', 'unknown', '—']) {
      assert.ok(!agentAndModel(t).toLowerCase().includes(invented), `invented "${invented}"`)
    }
  })

  test('an empty-string model is absence, not a model', () => {
    const t = task({ provider: PROVIDERS.claude as RemoteTask['provider'], model: '' })
    assert.equal(agentAndModel(t), 'Claude Code CLI')
  })
})

describe('label and mark come from one row and cannot disagree', () => {
  test('registry provider: mark follows vendor AND surface', () => {
    assert.equal(vendorMark(task({ provider: PROVIDERS.claude as RemoteTask['provider'] })), '#D97757')
    assert.equal(vendorMark(task({ provider: PROVIDERS.claudeDesktop as RemoteTask['provider'] })), '#d2a8ff')
    assert.equal(vendorMark(task({ provider: PROVIDERS.codexDesktop as RemoteTask['provider'] })), '#3fb950')
  })

  test('two Claude surfaces are told apart; two Codex surfaces share a vendor colour', () => {
    const cli = vendorMark(task({ provider: PROVIDERS.claude as RemoteTask['provider'] }))
    const desktop = vendorMark(task({ provider: PROVIDERS.claudeDesktop as RemoteTask['provider'] }))
    assert.notEqual(cli, desktop)
  })

  test('an unknown vendor gets neutral grey, never another vendor’s colour', () => {
    const t = task({ provider: { ...PROVIDERS.claude, vendor: 'Someone', surface: 'cli' } as RemoteTask['provider'] })
    assert.equal(vendorMark(t), UNKNOWN_VENDOR_MARK)
  })

  test('no provider: a Codex id gets the Codex NAME and the Codex COLOUR', () => {
    // The bug this pairing exists to prevent: "Codex desktop" in Claude terracotta.
    const t = task({ agent: 'codex-desktop' })
    assert.equal(providerLabel(t), 'Codex desktop')
    assert.equal(vendorMark(t), '#3fb950')
  })

  test('a Codex project disambiguates two threads on one wall', () => {
    const t = task({ provider: PROVIDERS.codexDesktop as RemoteTask['provider'], codexProject: 'unmute' })
    assert.equal(providerLabel(t), 'Codex desktop · unmute')
  })

  test('the door is named from the vendor, so a new backend names itself', () => {
    assert.equal(openInLabel(task({ provider: PROVIDERS.codexDesktop as RemoteTask['provider'] })), 'open in Codex')
    assert.equal(openInLabel(task({ provider: PROVIDERS.claudeDesktop as RemoteTask['provider'] })), 'open in Claude')
  })
})

describe('every ticket names its working directory', () => {
  test('home is compacted', () => {
    assert.equal(dirLabel(task({ cwd: '/Users/arpit/code/unmute' })), '~/code/unmute')
    assert.equal(dirLabel(task({ cwd: '/home/arpit/code/unmute' })), '~/code/unmute')
  })

  test('a scratch dir is SHORTENED, not hidden — it used to render as nothing', () => {
    const d = dirLabel(task({ cwd: '/Users/arpit/.unmute/tasks/3f2a1b9c-dead-beef' }))
    assert.equal(d, '~/.unmute/…/3f2a1b')
    assert.notEqual(d, '')
  })

  test('no cwd is the only empty answer', () => {
    assert.equal(dirLabel(task({})), '')
  })
})
