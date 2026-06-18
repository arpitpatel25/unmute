// Unmute Remote — render-on-demand live terminal (PRD §4.3, §13.4 #8).
//
// Summoned per task (never shown by default). A REAL terminal: xterm.js renders
// the owned-PTY stream faithfully (colours, cursor, the TUI box-drawing). It is
// also TYPEABLE: focus it and keystrokes flow straight to the session's stdin.
//
// Rendering model (the fix for the wrapped/garbled output): Claude Code's TUI is
// a full-screen, cursor-addressed app — it paints with absolute coordinates and
// HATES being reflowed into a narrow box. So we DON'T reflow. We pin the xterm to
// the SAME fixed width the PTY runs at (FIXED_COLS) and let the pane SCROLL to
// reveal it — exactly what a real terminal does (one width, no shrink). Match the
// widths and there's nothing to wrap.

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// Must match the PTY spawn width (pty-session.ts cols). One width = no wrap.
const FIXED_COLS = 120

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

export function LiveTerminal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    const term = new Terminal({
      cols: FIXED_COLS,
      rows: 24,
      convertEol: true,
      cursorBlink: true,
      fontSize: 11,
      lineHeight: 1.1,
      scrollback: 8000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0a0a0a', foreground: '#d4d4d4', cursor: '#d4d4d4' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    // Fit the ROWS to the pane height, but FORCE the width back to FIXED_COLS so
    // the TUI is never squeezed into a narrow box. The pane scrolls horizontally
    // to show the full width. PTY is told the same fixed width → no mismatch.
    const sync = () => {
      try {
        fit.fit() // sets cols+rows from the visible pane
        if (term.cols !== FIXED_COLS) term.resize(FIXED_COLS, term.rows) // override width back
        api().remoteTerminalResize?.(taskId, FIXED_COLS, term.rows)
      } catch { /* not laid out yet */ }
    }
    sync()

    // Keystrokes → the session's PTY stdin (raw, verbatim). PRD §4.3.
    term.onData((data) => api().remoteTerminalInput?.(taskId, data))

    // Backfill history (now clean — same width), then stream live.
    void api().remoteGetOutput?.(taskId).then((buf) => { if (!disposed && buf) term.write(buf) })
    const off = api().remoteOnOutput?.((d) => {
      if (!disposed && d.taskId === taskId) term.write(d.chunk)
    })

    // Reflow rows on pane resize (width stays fixed).
    const ro = new ResizeObserver(() => sync())
    ro.observe(host)

    // Show the pop-out button only when tmux is available to attach to.
    void api().remoteTmuxAvailable?.().then((ok) => {
      if (!disposed && popRef.current) popRef.current.style.display = ok ? '' : 'none'
    })

    return () => {
      disposed = true
      ro.disconnect()
      off?.()
      term.dispose()
    }
  }, [taskId])

  return (
    <div className="mt-2 rounded-md border border-black/15 bg-[#0a0a0a] overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 border-b border-white/10">
        <span className="text-[10px] uppercase tracking-wider text-white/50">
          live terminal · type to take over · scroll to see full width
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
      {/* Scroll container: horizontal reveals the fixed-width TUI; xterm owns vertical. */}
      <div className="h-72 overflow-auto">
        <div ref={hostRef} className="p-1 w-max" />
      </div>
    </div>
  )
}
