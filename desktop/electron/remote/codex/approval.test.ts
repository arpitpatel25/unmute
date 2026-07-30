import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  choosePolicy,
  levelsFromProfiles,
  levelsFromMenu,
  levelFromLabel,
  LEVEL_LABEL,
} from './approval'

// THE RULE THESE PIN DOWN
//
//   "We are giving the max possible approval that is possible on this particular
//    device."  — the user, 2026-07-25, on why a hardcoded maximum is wrong.
//
// A company/managed Codex plan simply does not offer "Full access". Asking for
// it there is not a graceful degradation, it is a request for something that
// does not exist. So every level we request must come from what the device
// reported, capped again by what the user themselves asked for.

describe('device ceiling discovery', () => {
  it('reads the profile list measured on a live unmanaged account', () => {
    // Verbatim from permissionProfile/list, 2026-07-25.
    const live = { data: [
      { id: ':read-only', description: null, allowed: true },
      { id: ':workspace', description: null, allowed: true },
      { id: ':danger-full-access', description: null, allowed: true },
    ] }
    assert.deepEqual(levelsFromProfiles(live), ['ask', 'approve-for-me', 'full-access'])
  })

  it('drops a level the account is NOT allowed — the managed-plan case', () => {
    const managed = { data: [
      { id: ':read-only', allowed: true },
      { id: ':workspace', allowed: true },
      { id: ':danger-full-access', allowed: false },
    ] }
    assert.deepEqual(levelsFromProfiles(managed), ['ask', 'approve-for-me'])
  })

  it('returns nothing when discovery fails, rather than assuming', () => {
    // An empty answer must never be read as "everything is allowed".
    assert.deepEqual(levelsFromProfiles(null), [])
    assert.deepEqual(levelsFromProfiles({}), [])
  })

  it('reads the composer menu, which is the authority the API is not', () => {
    // Verbatim menu text captured over CDP, 2026-07-25.
    const menu = [
      'Ask for approval | Always ask to edit external files and use the internet',
      'Approve for me | Only ask for actions detected as potentially unsafe',
      'Full access | Unrestricted access to the internet and any file on your computer',
    ]
    assert.deepEqual(levelsFromMenu(menu), ['ask', 'approve-for-me', 'full-access'])
    // A managed device renders only the first two.
    assert.deepEqual(levelsFromMenu(menu.slice(0, 2)), ['ask', 'approve-for-me'])
  })

  it('reads the current level off the button label', () => {
    assert.equal(levelFromLabel('Ask for approval'), 'ask')
    assert.equal(levelFromLabel('Full access'), 'full-access')
    assert.equal(levelFromLabel(''), null)
    assert.equal(levelFromLabel(null), null)
  })
})

describe('policy choice', () => {
  const ALL = ['ask', 'approve-for-me', 'full-access'] as const
  const MANAGED = ['ask', 'approve-for-me'] as const

  it('gives an auto-approve user the MOST the device offers', () => {
    // auto-approve means what it says, and the same unmute setting already
    // gives Claude Code --dangerously-skip-permissions. Capping Codex one level
    // lower made one switch mean two different things.
    //
    // Safe to raise because the level is per-thread: it is recorded in each
    // thread's own rollout (turn_context.approval_policy) and there is no
    // approval key in ~/.codex/config.toml, so a task we create does not
    // reconfigure the user's manual chats. They can also lower it by hand.
    assert.equal(choosePolicy([...ALL], 'auto-approve').level, 'full-access')
  })

  it('NEVER requests a level the device did not offer', () => {
    // The whole point. On a managed plan the ceiling is approve-for-me.
    assert.equal(choosePolicy([...MANAGED], 'auto-approve').level, 'approve-for-me')
  })

  it('respects a user who wants to approve everything, even on an open device', () => {
    assert.equal(choosePolicy([...ALL], 'ask').level, 'ask')
  })

  it('refuses full access while sandboxed, mirroring the Claude adapter', () => {
    // executorFactory withholds --dangerously-skip-permissions when sandbox
    // roots are configured; the two backends must not disagree about that.
    assert.equal(choosePolicy([...ALL], 'auto-approve', true).level, 'approve-for-me')
  })

  it('falls back to the most conservative level when discovery returned nothing', () => {
    const p = choosePolicy([], 'auto-approve')
    assert.equal(p.level, 'ask')
    assert.equal(p.approvalPolicy, 'untrusted')
  })

  it('reports whether the chosen level can still block — the hooks trigger', () => {
    // If this were ever wrong we would stop shipping the approval channel for
    // users who need it most.
    // On an OPEN device full access no longer blocks on tool approvals — that
    // is the point of asking for it. On a MANAGED device the ceiling is still
    // approve-for-me, which does block, so the hook channel stays load-bearing
    // for exactly the users who cannot escalate.
    //
    // Note this says nothing about Computer Use consents: those are a separate
    // system, ungoverned by approval level, and they block regardless.
    assert.equal(choosePolicy([...ALL], 'auto-approve').canBlock, false)
    assert.equal(choosePolicy([...MANAGED], 'auto-approve').canBlock, true)
    assert.equal(choosePolicy([...ALL], 'ask').canBlock, true)
  })

  it('maps each level to the Codex approval + sandbox pair', () => {
    assert.equal(choosePolicy([...ALL], 'auto-approve').sandbox, 'danger-full-access')
    assert.equal(choosePolicy([...MANAGED], 'auto-approve').approvalPolicy, 'on-request')
    assert.equal(choosePolicy([...ALL], 'ask').sandbox, 'read-only')
  })

  it('labels every level exactly as the composer menu does', () => {
    // These strings are clicked, so a typo silently means "level never applied".
    assert.equal(LEVEL_LABEL.ask, 'Ask for approval')
    assert.equal(LEVEL_LABEL['approve-for-me'], 'Approve for me')
    assert.equal(LEVEL_LABEL['full-access'], 'Full access')
  })
})
