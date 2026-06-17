// Unmute Remote — render-on-demand live terminal (PRD §4.3, §13.4 #8).
//
// Summoned per task (never shown by default). A REAL terminal: xterm.js renders
// the owned-PTY stream faithfully (colours, cursor, the TUI box-drawing) instead
// of the old ANSI-stripped <pre> that turned Claude's TUI into garbled text —
// that mangling is exactly what the owner flagged. It is also TYPEABLE: focus
// the terminal and keystrokes flow straight to the session's stdin, so a peek
// can become hands-on control (answer a prompt, nudge the agent, run a command)
// without leaving Unmute. Voice remains the primary path; this is the rare peek.

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type API = {
  remoteGetOutput?: (taskId: string) => Promise<string>
  remoteOnOutput?: (cb: (d: { taskId: string; chunk: string }) => void) => () => void
  remoteTerminalInput?: (taskId: string, data: string) => void
  remoteTerminalResize?: (taskId: string, cols: number, rows: number) => void
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

export function LiveTerminal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 11,
      lineHeight: 1.1,
      scrollback: 5000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0a0a0a', foreground: '#d4d4d4', cursor: '#d4d4d4' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    const refit = () => {
      try {
        fit.fit()
        api().remoteTerminalResize?.(taskId, term.cols, term.rows)
      } catch { /* host not laid out yet */ }
    }
    refit()

    // Keystrokes → the session's PTY stdin (raw, verbatim). PRD §4.3.
    term.onData((data) => api().remoteTerminalInput?.(taskId, data))

    // Backfill the buffered history, then stream live chunks for THIS task.
    void api().remoteGetOutput?.(taskId).then((buf) => { if (!disposed && buf) term.write(buf) })
    const off = api().remoteOnOutput?.((d) => {
      if (!disposed && d.taskId === taskId) term.write(d.chunk)
    })

    // Reflow when the panel resizes.
    const ro = new ResizeObserver(() => refit())
    ro.observe(host)

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
          live terminal · type to take over
        </span>
        <button className="text-[11px] text-white/60 hover:text-white" onClick={onClose}>close</button>
      </div>
      <div ref={hostRef} className="h-56 p-1" />
    </div>
  )
}
