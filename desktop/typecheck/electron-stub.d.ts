// Minimal ambient stub of the Electron surface our Remote main/preload code
// uses — enough to typecheck OUR logic without downloading the Electron binary.
// NOT used at build time (the real engine has real electron); typecheck-only.
declare module 'electron' {
  export interface WebContents {
    send(channel: string, ...args: unknown[]): void
    on(event: string, cb: (...a: unknown[]) => void): void
  }
  export interface Rectangle { x: number; y: number; width: number; height: number }
  export class BrowserWindow {
    constructor(opts?: Record<string, unknown>)
    static getAllWindows(): BrowserWindow[]
    isDestroyed(): boolean
    isVisible(): boolean
    webContents: WebContents
    setAlwaysOnTop(flag: boolean, level?: string): void
    setVisibleOnAllWorkspaces(flag: boolean, opts?: { visibleOnFullScreen?: boolean }): void
    setFullScreenable(flag: boolean): void
    setBounds(b: Rectangle): void
    showInactive(): void
    hide(): void
    loadURL(url: string): Promise<void>
    loadFile(path: string, opts?: { hash?: string }): Promise<void>
    on(event: string, cb: (...a: unknown[]) => void): void
  }
  export interface Display { workArea: Rectangle }
  export const screen: {
    getDisplayNearestPoint(point: { x: number; y: number }): Display
    getCursorScreenPoint(): { x: number; y: number }
  }
  export interface IpcMainInvokeEvent { sender: WebContents }
  export const ipcMain: {
    handle(channel: string, listener: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void
    on(channel: string, listener: (e: IpcMainInvokeEvent, ...args: any[]) => void): void
  }
  export const ipcRenderer: {
    invoke(channel: string, ...args: any[]): Promise<any>
    on(channel: string, listener: (e: unknown, ...args: any[]) => void): void
    removeListener(channel: string, listener: (e: unknown, ...args: any[]) => void): void
    send(channel: string, ...args: any[]): void
  }
  export const shell: {
    openExternal(url: string, options?: { activate?: boolean }): Promise<void>
    openPath(path: string): Promise<string>
  }
  export interface App { on(event: string, cb: (...a: unknown[]) => void): void }
  export const app: App
  export class Notification {
    constructor(opts: { title: string; body: string })
    show(): void
    static isSupported(): boolean
  }
}
