// Unmute Remote — render-on-demand live terminal (PRD §4.3, §13.4 #8).
//
// Summoned per task (never shown by default). Streams the task's owned-PTY
// output into a scrolling monospace view. Dependency-free: ANSI control codes
// are lightly stripped for readability rather than pulling in xterm.js — enough
// for the "rare peek" the PRD describes. (xterm.js can replace this verbatim
// behind the same IPC if richer rendering is wanted later.)

import { useEffect, useRef, useState } from 'react'

type API = {
  remoteGetOutput?: (taskId: string) => Promise<string>
  remoteOnOutput?: (cb: (d: { taskId: string; chunk: string }) => void) => void
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

// Strip the most common ANSI escape sequences + carriage returns so the raw
// TUI stream reads as plain text in a <pre>.
function clean(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\][^]*/g, '')
    .replace(/\r/g, '')
}

export function LiveTerminal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const boxRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    let alive = true
    void api().remoteGetOutput?.(taskId).then((buf) => { if (alive) setText(clean(buf || '')) })
    api().remoteOnOutput?.((d) => {
      if (alive && d.taskId === taskId) setText((prev) => (prev + clean(d.chunk)).slice(-200_000))
    })
    return () => { alive = false }
  }, [taskId])

  useEffect(() => {
    // auto-scroll to bottom on new output
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [text])

  return (
    <div className="mt-2 rounded-md border border-black/15 bg-[#0a0a0a]">
      <div className="flex items-center justify-between px-2 py-1 border-b border-white/10">
        <span className="text-[10px] uppercase tracking-wider text-white/50">live terminal</span>
        <button className="text-[11px] text-white/60 hover:text-white" onClick={onClose}>close</button>
      </div>
      <pre
        ref={boxRef}
        className="m-0 p-2 text-[10px] leading-snug text-[#d4d4d4] font-mono max-h-56 overflow-auto whitespace-pre-wrap break-all"
      >
        {text || '(no output yet)'}
      </pre>
    </div>
  )
}
