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
    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let off: (() => void) | undefined

    // Fit the ROWS to the pane height, but FORCE the width to FIXED_COLS so the
    // TUI is never squeezed into a narrow box; the pane scrolls horizontally.
    const sync = () => {
      if (!term || !fit || !host.clientHeight) return
      try {
        // Fit ROWS to the pane height; PIN cols to FIXED_COLS (the PTY width) so the
        // TUI never reflows. Use proposeDimensions (a pure read) + an explicit resize
        // rather than fit.fit(), so we never momentarily resize to a wrong width and
        // flash a reflow. proposeDimensions can return undefined before layout.
        const dims = fit.proposeDimensions()
        const rows = dims?.rows ?? term.rows
        if (term.cols !== FIXED_COLS || term.rows !== rows) term.resize(FIXED_COLS, rows)
        api().remoteTerminalResize?.(taskId, FIXED_COLS, term.rows)
      } catch { /* not laid out yet */ }
    }

    // LAZY open: only instantiate xterm once the host actually has dimensions.
    // Opening into a 0×0 container (e.g. inside a collapsed/hidden overlay row)
    // makes xterm throw "Cannot read properties of undefined (reading
    // 'dimensions')". The ResizeObserver below kicks this once it's laid out.
    const open = () => {
      // Gate on HEIGHT only: width is content-driven (w-max) and is 0 until xterm
      // renders its 120 cols, so requiring clientWidth here would deadlock (xterm
      // never opens). Height (h-full of the fixed h-72) is laid out immediately, and
      // it's the dimension FitAddon needs to compute rows — so it also prevents the
      // 0-height "Cannot read 'dimensions'" throw.
      if (disposed || term || !host.clientHeight) return
      term = new Terminal({
        cols: FIXED_COLS,
        rows: 24,
        convertEol: true,
        cursorBlink: true,
        fontSize: 11,
        lineHeight: 1.1,
        scrollback: 8000,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        theme: { background: 'rgba(0,0,0,0)', foreground: '#d4d4d4', cursor: '#d4d4d4' },
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      sync()
      term.onData((data) => api().remoteTerminalInput?.(taskId, data))
      void api().remoteGetOutput?.(taskId).then((buf) => { if (!disposed && buf && term) term.write(buf) })
      off = api().remoteOnOutput?.((d) => {
        if (!disposed && d.taskId === taskId && term) term.write(d.chunk)
      })
    }

    open()
    const ro = new ResizeObserver(() => { open(); sync() })
    ro.observe(host)

    void api().remoteTmuxAvailable?.().then((ok) => {
      if (!disposed && popRef.current) popRef.current.style.display = ok ? '' : 'none'
    })

    return () => {
      disposed = true
      ro.disconnect()
      off?.()
      term?.dispose()
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
      {/* Horizontal scroll reveals the fixed-width (120-col) TUI; xterm owns VERTICAL
          via its own scrollback. NO outer vertical scroll (overflow-y-hidden) — that
          double-scroll was what hid the last line below an outer fold. The host fills
          the pane HEIGHT (h-full of the fixed h-72) so FitAddon measures the REAL
          viewport and fits rows to it; width stays content-sized (w-max) so the wide
          TUI scrolls left/right. No padding on the measured host (it threw the row
          math off by a fraction and clipped the bottom line). */}
      <div className="h-72 overflow-x-auto overflow-y-hidden">
        <div ref={hostRef} className="h-full w-max" />
      </div>
    </div>
  )
}
