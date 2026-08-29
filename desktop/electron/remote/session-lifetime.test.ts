// KIND DECIDES LIFETIME. CATEGORY DECIDES SUBJECT.
//
// When a turn ends, task-manager chose between two teardown paths purely on
// CATEGORY: `consume` and `watch` were fire-and-forget (quit the REPL, kill the
// tmux session 1500ms later), everything else parked warm. The check never
// consulted `kind`, so a persistent SESSION whose subject happened to be video
// was torn down as though the user had walked away from a clip.
//
// Observed 2026-08-29, task 254ba44a — 51 minutes of work that produced an
// artifact and a file on disk:
//
//     observed         {"event":"turn-ended","state":"done","category":"watch"}
//     stdin-written    "/exit"
//     graceful-detach  {"graceMs":1500}
//     tmux-kill-session
//
// and earlier in the same task's life, from the other mechanism:
//
//     parked-warm      {"warmMs":null,"persistent":true}
//
// Two rules disagreeing about the same task, with the one that knows least
// about lifetime winning. `kind: session` means "hours can pass between done
// and the next spoken follow-up"; nothing about the subject should overrule it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** The decision under test, extracted exactly as task-manager applies it. */
function teardownFor(task: { kind?: string; category?: string }): 'detachAndKill' | 'parkWarm' {
  const fireAndForget = task.category === 'consume' || task.category === 'watch'
  // A persistent session outranks its subject.
  return fireAndForget && task.kind !== 'session' ? 'detachAndKill' : 'parkWarm'
}

test('a one-off that consumed media is torn down — the tab must be released', () => {
  assert.equal(teardownFor({ kind: 'oneoff', category: 'watch' }), 'detachAndKill')
  assert.equal(teardownFor({ kind: 'oneoff', category: 'consume' }), 'detachAndKill')
})

test('a SESSION survives its turn ending, whatever it was about', () => {
  // The 254ba44a case: kind session, category watch, 51 minutes of work.
  assert.equal(teardownFor({ kind: 'session', category: 'watch' }), 'parkWarm')
  assert.equal(teardownFor({ kind: 'session', category: 'consume' }), 'parkWarm')
})

test('the other categories are unchanged, both kinds', () => {
  for (const kind of ['oneoff', 'session']) {
    for (const category of ['navigate', 'info', 'act', undefined]) {
      assert.equal(teardownFor({ kind, category }), 'parkWarm',
        `${kind}/${category} should still park warm`)
    }
  }
})

test('an untyped task is treated as a one-off, not promoted by accident', () => {
  // kind is optional on the record; absent must not read as "session".
  assert.equal(teardownFor({ category: 'watch' }), 'detachAndKill')
})
