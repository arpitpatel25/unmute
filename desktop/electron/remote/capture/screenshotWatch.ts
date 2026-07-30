// Catch the screenshots that never reach the pasteboard.
//
// changeCount only sees the pasteboard, which covers Ctrl-Shift-3/4. But the
// macOS DEFAULT is Cmd-Shift-3/4, which writes a file and never touches the
// clipboard — so a clipboard-only design would silently drop the way most
// people actually take a screenshot.
//
// EVENT-DRIVEN, NOT POLLED. This replaces a 900ms readdir sweep: fs.watch costs
// nothing while idle, fires on the actual write rather than up to 900ms later,
// and that fire time IS the insert's position. It is armed only while the mic
// is hot, so the filesystem is never observed outside a consented window.

import type { InsertKind } from './types'

const IMAGE_RE = /\.(png|jpe?g)$/i
const SCREENSHOT_NAME_RE = /^screen ?shot/i

/** Inside a dedicated Screenshots folder any image counts; elsewhere only
 *  Screenshot-named files, so an unrelated Desktop png is never swept in. */
export function isScreenshotFile(name: string, inDedicatedFolder: boolean): boolean {
  // macOS writes a `.sb-…` temp file before renaming into place; acting on it
  // would attach a path that is about to stop existing.
  if (name.startsWith('.')) return false
  if (!IMAGE_RE.test(name)) return false
  return inDedicatedFolder || SCREENSHOT_NAME_RE.test(name)
}

export interface ScreenshotWatchDeps {
  /** Directories to watch, each flagged as dedicated or not. */
  dirs: () => { dir: string; dedicated: boolean }[]
  watch: (dir: string, cb: (filename: string) => void) => { close: () => void }
  now: () => number
  /** False when another detector already claimed this user action. */
  claim: (hash: string, atMs: number) => boolean
  onInsert: (i: { kind: InsertKind; content: string; atMs: number }) => void
}

export function createScreenshotWatch(deps: ScreenshotWatchDeps) {
  let handles: { close: () => void }[] = []

  function disarm(): void {
    for (const h of handles) { try { h.close() } catch { /* already gone */ } }
    handles = []
  }

  return {
    arm(): void {
      // Self-disarm first. A caller is expected to disarm() before re-arming,
      // but this module cannot enforce that discipline, and the cost of not
      // enforcing it is not just a leaked file descriptor: a stale watcher
      // left running keeps calling onInsert, which means the filesystem
      // stays observed after the capture window is believed closed — the
      // exact thing this module's header promises never happens.
      disarm()
      handles = deps.dirs().map(({ dir, dedicated }) =>
        deps.watch(dir, (filename) => {
          // fs.watch invokes this callback directly — there is no promise
          // chain here for a `void` caller to discard a rejection from, so a
          // throw would propagate straight out of the event handler. `claim`
          // or `onInsert` throwing is reachable, not theoretical: `onInsert`
          // will later broadcast to every BrowserWindow, and a window
          // destroyed between an isDestroyed() guard and the send throws.
          // Logged, not silent — a dep throwing here is a real bug someone
          // needs to be able to find.
          try {
            if (!filename || !isScreenshotFile(filename, dedicated)) return
            const path = `${dir}/${filename}`
            const atMs = deps.now()
            // Dedup by path: a tool set to write a file AND copy fires both
            // detectors for one action.
            if (!deps.claim(path, atMs)) return
            deps.onInsert({ kind: 'image', content: path, atMs })
          } catch (err) {
            console.warn('[capture] screenshotWatch callback failed:', err)
          }
        }),
      )
    },
    disarm,
  }
}
