import type { PresenterCommand } from './types'

type Rectangle = { x: number; y: number; width: number; height: number }

export interface PresenterBrowserWindow {
  webContents: {
    send(channel: string, value: unknown): void
    once(event: string, callback: () => void): void
  }
  loadURL(url: string): Promise<unknown> | unknown
  showInactive(): void
  setFocusable?(focusable: boolean): void
  setBounds(bounds: Rectangle): void
  isDestroyed(): boolean
  destroy(): void
}

export interface PresenterWindowDeps {
  create(options: Record<string, unknown>): PresenterBrowserWindow
  routeUrl(): string
  displayWorkArea(): Rectangle
}

const PRESENTER_SIZE = { width: 432, height: 700 }

export function presenterBounds(workArea: Rectangle, size = PRESENTER_SIZE): Rectangle {
  const sideInset = 28
  const notchClearance = 76
  return {
    x: Math.max(workArea.x + sideInset, workArea.x + workArea.width - size.width - sideInset),
    y: workArea.y + notchClearance,
    width: Math.min(size.width, workArea.width - sideInset * 2),
    height: Math.min(size.height, workArea.height - notchClearance - sideInset),
  }
}

export class PresenterWindow {
  private window: PresenterBrowserWindow | undefined
  private ready = false
  private pending: PresenterCommand | undefined

  constructor(private readonly deps: PresenterWindowDeps) {}

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.setBounds(presenterBounds(this.deps.displayWorkArea()))
      this.window.showInactive()
      return
    }

    const bounds = presenterBounds(this.deps.displayWorkArea())
    this.ready = false
    this.window = this.deps.create({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
    })
    this.window.webContents.once('did-finish-load', () => {
      this.ready = true
      if (this.pending) this.deliver(this.pending)
      this.pending = undefined
      this.window?.showInactive()
    })
    void this.window.loadURL(this.deps.routeUrl())
  }

  send(command: PresenterCommand): void {
    if (!this.window || this.window.isDestroyed()) this.show()
    if (!this.ready) {
      this.pending = command
      return
    }
    this.deliver(command)
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = undefined
    this.ready = false
    this.pending = undefined
  }

  private deliver(command: PresenterCommand): void {
    const interactive = command.card?.kind === 'permission'
      || command.card?.kind === 'provider'
      || command.card?.kind === 'repair'
    this.window?.setFocusable?.(interactive)
    this.window?.webContents.send('onboarding:presenter-command', command)
  }
}
