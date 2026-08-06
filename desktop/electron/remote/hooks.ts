// Unmute Remote — lifecycle hooks, installed WITHOUT touching the user's repo.
//
// WHAT CHANGED (2026-08-06) and why it matters:
//
// The previous version wrote `.claude/settings.json` and a `.unmute-hook.sh`
// INTO the session's working directory. That is why hooks were installed only
// for scratch spawns: writing them into a user's project would pollute it and
// could clobber the project's own settings. The consequence was backwards —
// project-bound sessions, the longest-lived and most valuable ones, ran with NO
// hooks at all, so they had no heartbeat, no submit confirmation, and
// `verifyDispatch` was disabled there entirely.
//
// `claude --settings <file-or-json>` loads ADDITIONAL settings from a path we
// own, and hooks from different settings levels MERGE rather than replace. So
// the file lives in Unmute's own directory and every session — scratch or
// project-bound — reports identically, with nothing written into the user's
// tree. That is the whole fix.
//
// The other change is what the hooks DO. The old Stop hook BLOCKED the end of
// every turn until the model wrote a status file — an interruption at the exact
// moment the model was concluding, twice per turn, forever. Every hook is now
// `async` and reports OUT: they tell Unmute what happened and never speak to
// the model. Nothing Unmute does can delay or redirect a turn.

import { promises as fs, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './log'
import { buildHookSettings } from './session-policy'

const log = createLogger('hooks')

/** Path of the shared hook-settings file (one per install, not per task —
 *  identity comes from the payload's own session_id, so nothing in it is
 *  task-specific). Lives under Unmute's baseDir, never in a user directory. */
export function hookSettingsPath(baseDir: string): string {
  return join(baseDir, 'session-hooks.json')
}

/**
 * Write (idempotently) the settings file handed to `claude --settings`.
 * Returns its path, or null on failure — a session with no hooks still runs and
 * still has its status file polled, so this must never block a dispatch.
 */
export async function installHookSettings(baseDir: string, port: number, token: string): Promise<string | null> {
  const target = hookSettingsPath(baseDir)
  try {
    await fs.mkdir(baseDir, { recursive: true })
    await fs.writeFile(target, JSON.stringify(buildHookSettings(port, token), null, 2), 'utf8')
    log.event('hook-settings-installed', { target, port })
    return target
  } catch (e) {
    log.warn('hook settings install failed — sessions will run without hooks', { error: (e as Error).message })
    return null
  }
}

/**
 * The same install, SYNCHRONOUSLY — used at startup.
 *
 * This must not be async, and the reason is a real cold-start race rather than
 * fussiness: a task dispatched before the promise resolves launches with no
 * `--settings`, so it gets no hooks, so the observer never hears from it and the
 * card sits at "processing" forever. The window is small and the trigger is
 * ordinary — launch the app, press the key, speak — which is exactly the case a
 * field test hits first.
 *
 * It writes ~600 bytes once per launch. Blocking on that is cheaper than the bug.
 */
export function installHookSettingsSync(baseDir: string, port: number, token: string): string | null {
  const target = hookSettingsPath(baseDir)
  try {
    mkdirSync(baseDir, { recursive: true })
    writeFileSync(target, JSON.stringify(buildHookSettings(port, token), null, 2), 'utf8')
    log.event('hook-settings-installed', { target, port, sync: true })
    return target
  } catch (e) {
    log.warn('hook settings install failed — sessions will run without hooks', { error: (e as Error).message })
    return null
  }
}
