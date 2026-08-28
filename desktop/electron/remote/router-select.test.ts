// WHICH ROUTER, AND WHICH TASKS IT MAY SEE.
//
// Both answers used to be written as `=== 'codex-desktop'`, inline, from when
// the desktop app was the only Codex surface. The CLI is a second one, and it
// carries agent 'codex' — so with the picker set to Codex CLI:
//
//   * routing went to the CLAUDE router (the condition did not match), and
//   * had it matched, the scoping filter would then have hidden every Codex
//     CLI task from it, because that also compared against 'codex-desktop'.
//
// Confirmed in the field 28 Aug: settings held agent='codex', and both routes
// that day still logged engine "claude-headless". The Codex router was
// effectively unreachable unless the user was on Codex desktop specifically.
//
// The split that MUST survive is by VENDOR, not by surface. A router may never
// be offered the other vendor's task — that is the cross-provider bleed which
// once sent a resume for a Codex thread into `claude --continue`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prefersCodexRouter, routerScopeMatches } from './router-select.ts'

test('either Codex surface selects the Codex router', () => {
  assert.equal(prefersCodexRouter('codex-desktop', { claude: true, codex: true }), true)
  assert.equal(prefersCodexRouter('codex', { claude: true, codex: true }), true)
})

test('Claude surfaces stay on the Claude router', () => {
  assert.equal(prefersCodexRouter('claude', { claude: true, codex: true }), false)
  assert.equal(prefersCodexRouter('claude-code-desktop', { claude: true, codex: true }), false)
})

test('with no Claude router, Codex takes the work rather than nothing happening', () => {
  assert.equal(prefersCodexRouter('claude', { claude: false, codex: true }), true)
})

test('a Codex preference with no Codex router falls back instead of failing', () => {
  assert.equal(prefersCodexRouter('codex', { claude: true, codex: false }), false)
  assert.equal(prefersCodexRouter('codex-desktop', { claude: true, codex: false }), false)
})

test('the Codex router sees BOTH Codex surfaces', () => {
  assert.equal(routerScopeMatches(true, 'codex'), true)
  assert.equal(routerScopeMatches(true, 'codex-desktop'), true)
})

test('the vendor split holds — neither router sees the other vendor', () => {
  // The whole reason this scoping exists.
  assert.equal(routerScopeMatches(true, 'claude'), false)
  assert.equal(routerScopeMatches(true, 'claude-code-desktop'), false)
  assert.equal(routerScopeMatches(false, 'codex'), false)
  assert.equal(routerScopeMatches(false, 'codex-desktop'), false)
})

test('the Claude router sees its own surfaces', () => {
  assert.equal(routerScopeMatches(false, 'claude'), true)
  assert.equal(routerScopeMatches(false, 'claude-code-desktop'), true)
})

test('a task with no named backend belongs to NEITHER router', () => {
  // NO DEFAULTING: absence of information is not evidence of Claude. An
  // agent-less task used to be asserted as Claude's and handed over.
  assert.equal(routerScopeMatches(false, undefined), false)
  assert.equal(routerScopeMatches(true, undefined), false)
})
