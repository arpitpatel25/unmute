// Apple Events lane — drives scriptable native macOS apps via `osascript`.
//
// WHY THIS LANE EXISTS: some apps expose a proper AppleScript/JXA dictionary
// that's far more reliable than AX-tree clicking or CDP eval (Notes, Mail,
// Finder, System Events UI scripting fallbacks, etc). This lane shells out to
// `osascript -e <script>` with the script as a single arg — no shell
// interpolation, no screen/cursor/focus interaction of any kind.
import { execFile } from 'node:child_process'

export type ExecResult = { stdout: string; stderr: string; code: number }
export type Exec = (args: string[]) => Promise<ExecResult>

function defaultExec(args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('osascript', args, (error, stdout, stderr) => {
      // execFile's error.code is the process exit code for a non-zero exit;
      // for a spawn failure (e.g. osascript missing) it's a string errno
      // like 'ENOENT' instead — fall back to 1 in that case.
      const code = !error ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ stdout, stderr, code })
    })
  })
}

/** Runs `script` via `osascript -e <script>` (single `-e`, script as one arg)
 *  and returns its trimmed stdout. Throws `applescript error: <stderr>` on
 *  non-zero exit. */
export async function runAppleScript(script: string, exec: Exec = defaultExec): Promise<string> {
  const { stdout, stderr, code } = await exec(['-e', script])
  if (code !== 0) throw new Error(`applescript error: ${stderr}`)
  return stdout.trim()
}
