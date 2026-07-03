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
  remoteTerminalRefresh?: (taskId: string) => void
  remoteOpenInTerminal?: (taskId: string) => Promise<boolean>
  remoteTmuxAvailable?: () => Promise<boolean>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

// `fill` (the wall stage): instead of pinning to FIXED_COLS and scrolling, fit BOTH
// cols and rows to the container and resize the PTY to match — Claude Code reflows
// to fill the screen, a TRUE full terminal. The overlay keeps the fixed-120 model.
// Single-owner (see remote:orchestrate-owner) guarantees only ONE LiveTerminal
// drives a given PTY's size at a time, so the two width models never fight.
//
// `replay` (default true): paint the buffered history on mount. Set FALSE for a
// LIVE session in fill mode — replaying frames painted at the OLD width into a
// resized grid is exactly what garbled the stage (interleaved stale rows). A live
// TUI repaints itself completely on SIGWINCH, so we resize and let it paint fresh;
// the buffer replay is only for sessions that can no longer speak for themselves.
export function LiveTerminal({ taskId, onClose, fill = false, replay = true }: { taskId: string; onClose: () => void; fill?: boolean; replay?: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let off: (() => void) | undefined

    // Horizontal scroll, the RELIABLE way. The host width must come from ONE
    // authority that NEVER reads back from xterm — otherwise we get a circular
    // "measure xterm → size host → xterm measures the host" loop that always
    // collapses to the container width (so nothing overflows and there is no
    // scrollbar; that was the long-standing regression). So we compute the grid
    // width DETERMINISTICALLY from font metrics: measure one monospace cell in the
    // REAL font, multiply by FIXED_COLS, pin the host to that. xterm then renders
    // its 120 cols INTO that width and the outer pane scrolls left/right to reveal
    // it. The vertical story is untouched (h-full + overflow-y-hidden + rows-fit).
    const measureCellWidth = (): number => {
      try {
        const ctx = document.createElement('canvas').getContext('2d')
        if (!ctx) return 7
        // Same font as the Terminal below (fontSize 11 + this family). Measure a
        // long run so sub-pixel rounding averages out to a true per-cell width.
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
        const w = ctx.measureText('0'.repeat(100)).width / 100
        return w > 0 ? w : 7
      } catch { return 7 }
    }
    // Pin the host to the full grid width. Bias slightly WIDE (+cushion): a few
    // extra px is harmless (a hair of scroll slack), whereas too narrow would clip
    // the last column. Font-metric derived ⇒ it can never feed back from xterm.
    const pinHostWidth = () => {
      // Fill mode: the host spans the container; FitAddon derives cols from it.
      if (fill) { if (host.style.width !== '100%') host.style.width = '100%'; return }
      const w = Math.ceil(measureCellWidth() * FIXED_COLS) + 16
      if (host.style.width !== `${w}px`) host.style.width = `${w}px`
    }

    // Fixed mode: fit ROWS to the pane height, FORCE width to FIXED_COLS (pane scrolls).
    // Fill mode: fit BOTH cols and rows to the container and resize the PTY to match,
    // so the TUI reflows to fill the stage — no fixed grid, no gap, no scroll.
    const sync = () => {
      if (!term || !fit || !host.clientHeight) return
      try {
        // proposeDimensions is a pure read (no reflow flash); it can be undefined
        // before first layout. Resize explicitly rather than fit.fit().
        const dims = fit.proposeDimensions()
        if (fill) {
          const cols = dims?.cols ?? term.cols
          const rows = dims?.rows ?? term.rows
          if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)
          api().remoteTerminalResize?.(taskId, term.cols, term.rows)
          pinHostWidth()
          return
        }
        const rows = dims?.rows ?? term.rows
        if (term.cols !== FIXED_COLS || term.rows !== rows) term.resize(FIXED_COLS, rows)
        api().remoteTerminalResize?.(taskId, FIXED_COLS, term.rows)
        pinHostWidth()
      } catch { /* not laid out yet */ }
    }

    // LAZY open: only instantiate xterm once the host actually has dimensions.
    // Opening into a 0×0 container (e.g. inside a collapsed/hidden overlay row)
    // makes xterm throw "Cannot read properties of undefined (reading
    // 'dimensions')". The ResizeObserver below kicks this once it's laid out.
    const open = () => {
      // Gate on HEIGHT only. Height (h-full of the fixed h-72) is laid out
      // immediately and is the dimension FitAddon needs to compute rows — gating
      // on it also prevents the 0-height "Cannot read 'dimensions'" throw. We do
      // NOT gate on width: it's pinned deterministically (pinHostWidth), not
      // derived from xterm, so there's nothing to wait for.
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
      // Pin the host to the deterministic grid width BEFORE xterm paints, so it
      // renders straight into a correctly-sized (scrollable) box. No onRender
      // re-pin — the width is font-derived and constant, so there is no loop.
      pinHostWidth()
      term.open(host)
      sync()
      term.onData((data) => api().remoteTerminalInput?.(taskId, data))
      let sawOutput = false
      if (replay) {
        void api().remoteGetOutput?.(taskId).then((buf) => { if (!disposed && buf && term) term.write(buf) })
      } else {
        // Live no-replay path: sync() above resized the PTY; after the geometry
        // settles, ask tmux for a FULL clean redraw (refresh-client). This
        // replaces the old rows±1 "nudge" — three SIGWINCHes in <100ms raced the
        // TUI's repaint pipeline and left mispainted residue (fused spinner
        // fragments, scattered stale rows) that dirty-region repaints never
        // cleared. One refresh = deterministic full paint, zero geometry games.
        setTimeout(() => {
          if (disposed || !term) return
          term.clear()
          api().remoteTerminalRefresh?.(taskId)
        }, 350)
        // BACKSTOP: a nominally-alive session can still be unable to repaint —
        // e.g. a watch/consume one-off mid-graceful-detach (/exit sent, alive flag
        // not yet flipped). If NOTHING arrives shortly after the refresh, fall
        // back to the buffered record: an imperfect replay beats a black void.
        setTimeout(() => {
          if (disposed || sawOutput || !term) return
          void api().remoteGetOutput?.(taskId).then((buf) => {
            if (!disposed && !sawOutput && buf && term) term.write(buf)
          })
        }, 1000)
      }
      off = api().remoteOnOutput?.((d) => {
        if (!disposed && d.taskId === taskId && term) { sawOutput = true; term.write(d.chunk) }
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

  const TitleBar = (
    <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.05] border-b border-white/15 flex-none">
      <span className="text-[10px] uppercase tracking-wider text-white/55">
        live terminal · type to take over{fill ? '' : ' · scroll to see full width'}
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

  // Fill (the wall stage): edge-to-edge, fills the stage height; the host fills BOTH
  // dimensions and FitAddon fits cols+rows to it → a real full terminal.
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

  return (
    // Light border + a slightly-lighter title bar + a drop shadow so the panel
    // has a CLEAR edge on the dark overlay (where a black border vanished) while
    // staying fine on the light in-app card (the black body provides contrast there).
    <div className="mt-2.5 rounded-lg border border-white/20 bg-black overflow-hidden shadow-[0_10px_30px_rgba(0,0,0,0.55)]">
      {TitleBar}
      {/* Horizontal scroll reveals the fixed-width (120-col) TUI; xterm owns VERTICAL
          via its own scrollback. NO outer vertical scroll (overflow-y-hidden) — that
          double-scroll was what hid the last line below an outer fold. The host fills
          the pane HEIGHT (h-full of the fixed h-72) so FitAddon measures the REAL
          viewport and fits rows to it; width is pinned in JS to the font-derived
          grid width so the wide TUI scrolls left/right. No padding on the measured
          host (it threw the row math off by a fraction and clipped the bottom line). */}
      <div className="h-72 overflow-x-auto overflow-y-hidden">
        {/* Width is pinned in JS to the font-derived grid width (FIXED_COLS×cell),
            so the host is reliably WIDER than this pane → it scrolls left/right.
            No w-max (that depended on xterm's own width, which fed the old loop). */}
        <div ref={hostRef} className="h-full" />
      </div>
    </div>
  )
}
