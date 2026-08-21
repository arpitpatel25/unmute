export interface TerminalInputGate {
  forward(data: string): void
  enable(): void
  disable(): void
}

export function createTerminalInputGate(send: (data: string) => void): TerminalInputGate {
  let enabled = false
  return {
    forward(data) { if (enabled) send(data) },
    enable() { enabled = true },
    disable() { enabled = false },
  }
}

interface ReplayTarget {
  write(data: string, callback?: () => void): void
}

/**
 * Paint buffered PTY bytes before opening the input path.
 *
 * xterm may answer control-sequence queries while parsing history. Those
 * answers arrive through onData just like keystrokes, but they belong to the
 * historical terminal exchange and must never be written into the live PTY.
 */
export function replayTerminalHistory(
  terminal: ReplayTarget,
  history: string,
  gate: TerminalInputGate,
  onReady: () => void,
): void {
  const finish = () => {
    gate.enable()
    onReady()
  }
  if (history) terminal.write(history, finish)
  else finish()
}
