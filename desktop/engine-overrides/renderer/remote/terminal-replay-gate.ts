export interface TerminalInputSession {
  forward(data: string): void
  dispose(): void
}

interface TerminalReplayTarget {
  write(data: string, callback?: () => void): void
  onData(listener: (data: string) => void): { dispose(): void }
}

/**
 * Paint buffered PTY bytes while input is disconnected. xterm can emit device
 * replies while parsing history; waiting one microtask after write completes
 * ensures those replies can never be forwarded into the live tmux client.
 */
export function connectTerminalInputAfterReplay(
  terminal: TerminalReplayTarget,
  history: string,
  send: (data: string) => void,
  onReady: () => void,
  schedule: (callback: () => void) => void = queueMicrotask,
): TerminalInputSession {
  let live = false
  let disposed = false
  let inputSubscription: { dispose(): void } | undefined

  const activate = () => schedule(() => {
    if (disposed || live || inputSubscription) return
    inputSubscription = terminal.onData(send)
    live = true
    onReady()
  })

  if (history) terminal.write(history, activate)
  else activate()

  return {
    forward(data) {
      if (live && !disposed) send(data)
    },
    dispose() {
      disposed = true
      live = false
      inputSubscription?.dispose()
      inputSubscription = undefined
    },
  }
}
