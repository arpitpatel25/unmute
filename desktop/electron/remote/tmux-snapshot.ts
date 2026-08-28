// THE SCREEN, ASKED FOR — instead of a reel of frames replayed blind.
//
// The live terminal used to seed itself from the raw PTY byte log. For a TUI
// that log is a PAINT STREAM: absolute cursor moves (\x1b[15;3H), scroll-region
// sets (\x1b[1;32r), scroll-ups (\x1b[4S). Every one of those coordinates is
// meaningless except against the exact grid it was computed for.
//
// And the grid moves. Opening the live terminal resizes the tmux window to the
// xterm's fit, while the attaching client is spawned at a hardcoded 120x40 —
// so after an app relaunch the buffer holds frames drawn at two or three
// different geometries. Replaying them in order lands text from one grid on
// top of another: words overwritten mid-line, fragments stranded at the right
// margin.
//
// Measured 29 Aug, and the correlation was exact: the two sessions whose tmux
// windows had been resized to 122x32 rendered corrupt, the six still at their
// spawn 120x40 were clean. Buffer size was irrelevant — one of the corrupt
// ones was 136KB, well under the truncation cap I first blamed.
//
// The user found the tell before I did: scrolling fixed it. Scrolling forwards
// input to tmux, tmux repaints the whole screen at the CURRENT geometry, and
// it comes out right. That proves the live path was never wrong — only the
// replayed history was. This module just asks tmux for that repaint up front
// instead of waiting for a human to scroll.
//
// `capture-pane -p -e` returns the rendered screen: plain lines plus SGR
// colour, and no cursor addressing anywhere. There is no grid for it to be
// wrong about, so it is safe to write into an xterm of any size.

import { TMUX_SOCKET } from './tmux'

/** Lines of scrollback to seed. Enough to scroll back through a few turns,
 *  bounded so a long-lived session cannot dump megabytes into xterm on every
 *  mount (this runs on every card switch). */
export const SNAPSHOT_LINES = 2000
const MAX_LINES = 10_000

/**
 * `tmux capture-pane` args for a task's session.
 *
 * -p  write to stdout
 * -e  KEEP SGR colour. Without it the seed arrives monochrome and the terminal
 *     visibly changes appearance the moment live output resumes.
 * -S  start line, negative = lines of scrollback above the visible screen.
 */
export function tmuxCapturePaneArgs(session: string, lines: number = SNAPSHOT_LINES): string[] {
  const n = Math.min(MAX_LINES, Math.max(0, Math.floor(lines) || 0))
  return ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-e', '-S', `-${n}`, '-t', session]
}

/**
 * Is this capture worth seeding with?
 *
 * tmux answers a dead or unknown session with nothing at all. Seeding an empty
 * string would blank a terminal that has content, so an unusable capture must
 * send the caller back to the raw buffer rather than be trusted.
 */
export function snapshotIsUsable(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim().length > 0
}
