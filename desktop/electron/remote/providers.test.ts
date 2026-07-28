import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDERS, providerOf, type ProviderId } from './providers.ts'

// THE PROVIDER REGISTRY
//
// One table describing every backend. Before it, "which backends are desktop
// apps" was expressed in three places that had already drifted: isExternalAgent()
// in codex-executor.ts, `desktopBackends` in the Swift IPC layer (which listed a
// 'claude-code-desktop' that does not exist in AgentKind at all), and a handful
// of ad-hoc `!== 'codex-desktop'` checks in the renderer.
//
// These tests pin the two things the rest of the app now reads off the table:
// the ABSENT ⇒ Claude default, and the capability flags that used to be spelled
// as "is it Codex?".

test('every provider id has a registry entry', () => {
  // Record<ProviderId, Provider> makes this a compile error too, but a runtime
  // check is what catches an entry added to the type and forgotten in the table.
  const ids: ProviderId[] = ['claude', 'codex', 'codex-desktop']
  for (const id of ids) {
    assert.ok(PROVIDERS[id], `no registry entry for ${id}`)
    assert.equal(PROVIDERS[id].id, id, 'entry must be keyed by its own id')
  }
})

test('ABSENT agent resolves to Claude Code CLI — the whole legacy contract', () => {
  // PTY tasks are persisted with no `agent` key at all. Every read path depends
  // on undefined meaning Claude; anything else reintroduces the 2026-07-28 bug
  // where a resumed Claude task was rebuilt on whatever the picker said.
  assert.equal(providerOf(undefined).id, 'claude')
  assert.equal(providerOf('claude').id, 'claude')
})

test('transport says who owns the process', () => {
  // 'pty' = Unmute spawns and owns it. 'driver' = an app we drive; there is no
  // executor to build, which is what isExternalAgent() now reads.
  assert.equal(providerOf('claude').transport, 'pty')
  assert.equal(providerOf('codex').transport, 'pty')
  assert.equal(providerOf('codex-desktop').transport, 'driver')
})

test('capability flags reproduce the behaviour they replaced, exactly', () => {
  // hasTerminal replaces the Swift `desktopBackends` set (notch sizing: a live
  // terminal gets 80% of the screen, a conversation 60%).
  assert.equal(providerOf('claude').hasTerminal, true)
  assert.equal(providerOf('codex').hasTerminal, true)
  assert.equal(providerOf('codex-desktop').hasTerminal, false)

  // canResume replaces `task.agent !== 'codex-desktop'` in TaskRow/OverlayApp.
  // NOTE codex CLI is true purely because that is what ships today — the old
  // check was a negation of codex-desktop, so it showed Resume for codex CLI.
  // Changing that here would be a silent behaviour change, not a refactor.
  assert.equal(providerOf('claude').canResume, true)
  assert.equal(providerOf('codex').canResume, true)
  assert.equal(providerOf('codex-desktop').canResume, false)
})

test('vendor and surface are the two axes a provider list grows along', () => {
  // The same vendor can ship a CLI and a desktop app; both must be nameable
  // without string-matching the id.
  assert.equal(providerOf('codex').vendor, 'Codex')
  assert.equal(providerOf('codex-desktop').vendor, 'Codex')
  assert.equal(providerOf('codex').surface, 'cli')
  assert.equal(providerOf('codex-desktop').surface, 'desktop')
})

test('every provider carries a human label for the task card', () => {
  assert.equal(providerOf('claude').label, 'Claude Code CLI')
  assert.equal(providerOf('codex-desktop').label, 'Codex desktop')
  for (const p of Object.values(PROVIDERS)) {
    assert.ok(p.label.length > 0, `${p.id} needs a label — the card renders it`)
  }
})
