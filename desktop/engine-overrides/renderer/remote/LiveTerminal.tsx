// Unmute Orchestrator — the live terminal. A REAL terminal, done the way iTerm and
// VS Code do it, not a reconstruction.
//
// THE MODEL (why this finally behaves like a terminal). We OWN the PTY: the
// `claude` process runs inside tmux and our node-pty is a tmux CLIENT, so the
// PTY's raw output — escape sequences, cursor moves, colours, box-drawing — is
// already streaming to us byte-for-byte (task-manager buffers it; remoteGetOutput
// replays it, remoteOnOutput streams it live). We hand that RAW stream straight to
// xterm.js and let xterm own the grid, the scrollback, AND the reflow. That single
// decision is the whole fix:
//
//   • Scroll works because xterm's scrollback is built from the real byte stream,
//     so every line carries its true soft-vs-hard wrap flag (isWrapped).
//   • Resize works because xterm reflows that buffer itself, and we resize the PTY
//     to match (SIGWINCH) so the TUI repaints itself at the new width — same as
//     dragging any terminal window. Tiny or huge, it just re-lays-out.
//
// What we DELETED and must never bring back: the `tmux capture-pane` snapshot
// path, the drift-guard timer, the re-anchor event, the fixed-120 + horizontal-
// scroll hack. capture-pane returns FLATTENED TEXT — it has already thrown away
// the soft/hard wrap distinction — so pasting it as xterm scrollback corrupts the
// instant you scroll or resize. That lossy reconstruction was the entire bug class
// we chased for weeks. One authority (xterm), one raw stream, one negotiated size.

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { connectTerminalInputAfterReplay, type TerminalInputSession } from './terminal-replay-gate'

type API = {
  remoteGetOutput?: (taskId: string) => Promise<string>
  remoteOnOutput?: (cb: (d: { taskId: string; chunk: string }) => void) => () => void
  remoteTerminalInput?: (taskId: string, data: string) => void
  remoteTerminalResize?: (taskId: string, cols: number, rows: number) => void
  remoteOpenInTerminal?: (taskId: string) => Promise<boolean>
  remoteTmuxAvailable?: () => Promise<boolean>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

// `fill` is a LAYOUT choice only (edge-to-edge stage vs. a bordered panel). Both
// paths run the identical terminal engine below — fit to the container, resize the
// PTY, reflow natively. There is no second rendering model any more.
export function LiveTerminal({ taskId, onClose, fill = false }: { taskId: string; onClose: () => void; fill?: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let off: (() => void) | undefined
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let lastCols = 0
    let lastRows = 0
    let inputSession: TerminalInputSession | undefined

    // Fit xterm to its container, then tell the PTY the new size so the TUI
    // repaints at that width (SIGWINCH). Debounced: a window drag fires dozens of
    // ResizeObserver ticks; we only want the PTY resized once it settles. xterm's
    // own buffer reflow is synchronous inside fit() and needs no debounce.
    const syncSize = () => {
      if (!term || !fit || !host.clientHeight || !host.clientWidth) return
      try {
        fit.fit() // reflows xterm's buffer + scrollback to the new width
      } catch { return /* not laid out yet */ }
      if (term.cols === lastCols && term.rows === lastRows) return
      lastCols = term.cols
      lastRows = term.rows
      if (resizeTimer) clearTimeout(resizeTimer)
      const cols = term.cols
      const rows = term.rows
      resizeTimer = setTimeout(() => { if (!disposed) api().remoteTerminalResize?.(taskId, cols, rows) }, 120)
    }

    // LAZY open: only instantiate xterm once the host has real dimensions.
    // Opening into a 0×0 box (a collapsed/hidden row) makes xterm throw on
    // "dimensions". The ResizeObserver re-drives this once it's laid out.
    const open = () => {
      if (disposed || term || !host.clientHeight || !host.clientWidth) return
      term = new Terminal({
        cols: 80,
        rows: 24,
        // Real PTY stream already carries CRLF; don't rewrite newlines.
        convertEol: false,
        cursorBlink: true,
        fontSize: 11,
        lineHeight: 1.1,
        scrollback: 10000,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        theme: { background: 'rgba(0,0,0,0)', foreground: '#d4d4d4', cursor: '#d4d4d4' },
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      // Fit to the container BEFORE we replay, so history wraps to the width the
      // user is actually looking at (xterm sets isWrapped correctly as it writes).
      try { fit.fit() } catch { /* first layout not ready; ResizeObserver retries */ }
      // lastCols/lastRows are set below, once the size has actually been SENT.
      // Recording the fitted size here without sending it is what silenced the
      // first syncSize(): it compares against lastCols, saw no change, and the
      // PTY never learned the width it was being displayed at.

      // Shift+Enter → soft newline (no submit). xterm emits the SAME byte (\r)
      // for Enter and Shift+Enter, so the TUI can't tell them apart and submits
      // on both. Intercept ONLY the exact Shift+Enter keydown and inject ESC+CR
      // ('\x1b\r') — the sequence Claude Code and `/terminal-setup` treat as an
      // in-place newline (identical to what Option/Alt+Enter sends). Everything
      // else falls through untouched: plain Enter still sends \r and submits;
      // other keys, paste, and IME composition are handled by xterm as before.
      // Returning false suppresses xterm's own \r for THIS one event, so there is
      // exactly one write to stdin (no double-send).
      term.attachCustomKeyEventHandler((e) => {
        if (
          e.type === 'keydown' &&
          e.key === 'Enter' &&
          e.shiftKey &&
          !e.ctrlKey && !e.metaKey && !e.altKey &&
          !e.isComposing
        ) {
        inputSession?.forward('\x1b\r')
          return false
        }
        return true
      })
      // SIZE THE PTY BEFORE CAPTURING ITS SCREEN, not after.
      //
      // This resize used to run at the END of the block below, with the note
      // "so all FUTURE output is painted at this width" — and that was exactly
      // the bug. The replayed buffer is a capture of what tmux had ALREADY
      // painted, hard-wrapped at whatever width the pane was then (its spawn
      // 120x40, or 80 before the first fit). Re-wrapping cannot be done after
      // the fact: those line breaks are real characters in the buffer by the
      // time we read them.
      //
      // So on open, a session showed text broken mid-word with dead space to
      // the right of it, and toggling the terminal off and on "fixed" it —
      // because that re-captured tmux AFTER the resize had landed. The toggle
      // was never a redraw quirk; it was delivering the width first.
      //
      // Order now: fit → tell the PTY → let it repaint → capture → replay.
      const cols = term.cols
      const rows = term.rows
      api().remoteTerminalResize?.(taskId, cols, rows)
      lastCols = cols
      lastRows = rows

      // One frame for tmux to receive SIGWINCH and repaint at the new width.
      // Without the wait the capture races the repaint and we are back to
      // replaying the old wrapping. 140ms is the debounce above plus a beat;
      // it is not a correctness guarantee, and the ResizeObserver still
      // re-syncs if the layout settles differently.
      const REPAINT_MS = 140

      // Replay the buffered RAW output, THEN attach the live stream on top — in
      // that order so history never lands after a newer live chunk. Subscribing
      // inside the .then keeps the two ordered through one path.
      setTimeout(() => {
        if (disposed || !term) return
        void api().remoteGetOutput?.(taskId).then((buf) => {
          if (disposed || !term) return
          const replayTarget = term
          inputSession = connectTerminalInputAfterReplay(
            replayTarget,
            buf ?? '',
            (data) => api().remoteTerminalInput?.(taskId, data),
            () => {
              if (disposed) return
              off = api().remoteOnOutput?.((d) => {
                if (!disposed && d.taskId === taskId && term) term.write(d.chunk)
              })
              // Re-assert the size only if the layout moved while we waited.
              // Unconditionally re-sending here is what made the original
              // ordering look correct while doing nothing for the replay.
              if (replayTarget.cols !== lastCols || replayTarget.rows !== lastRows) {
                lastCols = replayTarget.cols
                lastRows = replayTarget.rows
                api().remoteTerminalResize?.(taskId, replayTarget.cols, replayTarget.rows)
              }
            },
          )
        })
      }, REPAINT_MS)
    }

    open()
    const ro = new ResizeObserver(() => { open(); syncSize() })
    ro.observe(host)

    void api().remoteTmuxAvailable?.().then((ok) => {
      if (!disposed && popRef.current) popRef.current.style.display = ok ? '' : 'none'
    })

    return () => {
      disposed = true
      inputSession?.dispose()
      if (resizeTimer) clearTimeout(resizeTimer)
      ro.disconnect()
      off?.()
      term?.dispose()
    }
  }, [taskId])

  const TitleBar = (
    <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.05] border-b border-white/15 flex-none">
      <span className="text-[10px] uppercase tracking-wider text-white/55">
        live terminal · type to take over
      </span>
      <div className="flex items-center gap-3">
        <button
          ref={popRef}
          className="text-[11px] text-white/60 hover:text-white"
          style={{ display: 'none' }}
          title="Open this exact session in your terminal app"
          onClick={() => void api().remoteOpenInTerminal?.(taskId)}
        >
          open in terminal ↗
        </button>
        <button className="text-[11px] text-white/60 hover:text-white" onClick={onClose}>close</button>
      </div>
    </div>
  )

  // Fill (the wall stage): edge-to-edge, fills the stage height. The host fills
  // both dimensions; FitAddon fits cols+rows to it → a real full terminal.
  if (fill) {
    return (
      <div className="h-full flex flex-col bg-black overflow-hidden">
        {TitleBar}
        <div className="flex-1 min-h-0 overflow-hidden">
          <div ref={hostRef} className="h-full w-full" />
        </div>
      </div>
    )
  }

  // Panel (in-app card / overlay): a bordered box with a clear edge on the dark
  // overlay. The host fills the panel body so FitAddon fits the terminal to it —
  // reflowed to whatever width the card is, exactly like a small terminal window.
  // xterm owns vertical scrollback natively (mouse wheel); no outer scroll.
  return (
    <div className="mt-2.5 rounded-lg border border-white/20 bg-black overflow-hidden shadow-[0_10px_30px_rgba(0,0,0,0.55)]">
      {TitleBar}
      <div className="h-72 overflow-hidden">
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  )
}
