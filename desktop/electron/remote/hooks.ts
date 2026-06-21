// Unmute Remote — deterministic lifecycle hooks (DECIDED: the timing layer).
//
// Claude is PROBABILISTIC about writing the status file; hooks are DETERMINISTIC.
// We install per-task Claude Code hooks that do two things, and ONLY these:
//
//   1. HEARTBEAT — emit a marker on real progress (PostToolUse) and on turn
//      boundaries (UserPromptSubmit / Stop), so Unmute's liveness no longer
//      depends on the model remembering to write `step`. This fixes false-stuck
//      (incl. while the user works manually in the terminal). It keys off REAL
//      tool execution, not TUI redraw noise, so a genuinely hung task (no tool
//      calls) still goes stuck — the backstop is preserved.
//
//   2. ENFORCE — a Stop hook BLOCKS the turn from ending until status.json was
//      written THIS turn. "Usually writes it" becomes "can't finish without it",
//      and it works for manual terminal turns too (which bypass the dispatch
//      contract). Bounded to 2 nudges so it can never loop.
//
// Hooks NEVER author content — the model still writes the semantic status. And
// EVERYTHING is FAIL-OPEN: if a hook never fires, or the enforcer misjudges, the
// worst case is "no hook signal", which falls straight back to today's behaviour
// (status-file polling). So this layer cannot regress the existing flow.
//
// Zero token cost: silent `command` hooks touching local marker files, surfacing
// nothing to the model — except the Stop enforcer's short reason on the rare
// forgot-path (bounded). No `prompt` hooks, no `claude -p`. Uses POSIX file
// mtimes only (no `date`/`python` dependency) so it can't break on a thin PATH.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('hooks')

// Marker files written INTO the task cwd (cleaned up with the dir):
//   .unmute-activity    — appended on every hook event; its MTIME is the
//                         deterministic heartbeat Unmute reads.
//   .unmute-turn-start  — truncated on UserPromptSubmit; its mtime marks the
//                         start of the current turn (for the Stop enforcer).
//   .unmute-stop-count  — per-turn nudge counter (bounds the enforcer).
export const ACTIVITY_MARKER = '.unmute-activity'

// POSIX sh. No external deps — comparisons use the shell's `-nt` (newer-than)
// file test, so there's no `date`/`python` requirement. $1 = event name.
const HOOK_SCRIPT = `#!/bin/sh
# Unmute Remote lifecycle hook — deterministic, fail-open, zero-token.
DIR="\${CLAUDE_PROJECT_DIR:-$PWD}"
ACT="$DIR/.unmute-activity"
TS="$DIR/.unmute-turn-start"
case "$1" in
  prompt)
    touch "$TS"                        # mtime = turn start (touch reliably bumps mtime)
    rm -f "$DIR/.unmute-stop-count"    # reset the per-turn nudge counter
    touch "$ACT" ;;
  tool)
    touch "$ACT" ;;                    # heartbeat on real progress
  stop)
    touch "$ACT"
    STATUS="$DIR/status.json"
    # Status written THIS turn (newer than turn start) -> let the turn finish.
    if [ -f "$STATUS" ] && [ "$STATUS" -nt "$TS" ]; then exit 0; fi
    C="$DIR/.unmute-stop-count"
    N=\`[ -f "$C" ] && cat "$C" 2>/dev/null || echo 0\`
    case "$N" in ''|*[!0-9]*) N=0 ;; esac
    [ "$N" -ge 2 ] && exit 0           # bounded: give up after 2 nudges (fail-open)
    echo \$((N + 1)) > "$C"
    printf '{"decision":"block","reason":"Update your Unmute status file before finishing. Write %s atomically (status.json.tmp then rename) reflecting the current state (done | failed | needs-user) with a one-line result.summary."}\\n' "$STATUS"
    exit 0 ;;
esac
exit 0
`

/** The Claude Code project settings wiring the three lifecycle events to the
 *  script. Installed at <cwd>/.claude/settings.json (project scope — affects
 *  only this task's session). */
function settingsJson(scriptPath: string): string {
  const cmd = (ev: string) => `sh '${scriptPath}' ${ev}`
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt') }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('tool') }] }],
        Stop: [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
      },
    },
    null,
    2,
  )
}

/** Install the per-task hook script + Claude Code settings into `cwd`. Idempotent
 *  (overwrites). Best-effort: a failure here must NOT block dispatch — without
 *  hooks the task simply runs on the status-file path (today's behaviour). */
export async function installHooks(cwd: string): Promise<void> {
  const scriptPath = join(cwd, '.unmute-hook.sh')
  await fs.writeFile(scriptPath, HOOK_SCRIPT, { mode: 0o755 })
  await fs.chmod(scriptPath, 0o755).catch(() => {})
  const claudeDir = join(cwd, '.claude')
  await fs.mkdir(claudeDir, { recursive: true })
  await fs.writeFile(join(claudeDir, 'settings.json'), settingsJson(scriptPath))
  log.event('hooks-installed', { cwd })
}

/** mtime (ms) of the deterministic hook activity marker, or null if no hook has
 *  fired yet (or hooks aren't active at all). Null => caller falls back to the
 *  status-file heartbeat, i.e. exactly today's behaviour. */
export async function hookActivityMs(cwd: string): Promise<number | null> {
  try {
    const st = await fs.stat(join(cwd, ACTIVITY_MARKER))
    return st.mtimeMs
  } catch {
    return null
  }
}
