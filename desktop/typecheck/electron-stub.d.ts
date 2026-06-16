// Minimal ambient stub of the Electron surface our Remote main/preload code
// uses — enough to typecheck OUR logic without downloading the Electron binary.
// NOT used at build time (the real engine has real electron); typecheck-only.
declare module 'electron' {
  export interface WebContents { send(channel: string, ...args: unknown[]): void }
  export class BrowserWindow {
    static getAllWindows(): BrowserWindow[]
    isDestroyed(): boolean
    webContents: WebContents
  }
  export interface IpcMainInvokeEvent { sender: WebContents }
  export const ipcMain: {
    handle(channel: string, listener: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void
    on(channel: string, listener: (e: IpcMainInvokeEvent, ...args: any[]) => void): void
  }
  export const ipcRenderer: {
    invoke(channel: string, ...args: any[]): Promise<any>
    on(channel: string, listener: (e: unknown, ...args: any[]) => void): void
    send(channel: string, ...args: any[]): void
  }
  export interface App { on(event: string, cb: (...a: unknown[]) => void): void }
  export const app: App
  export class Notification {
    constructor(opts: { title: string; body: string })
    show(): void
    static isSupported(): boolean
  }
}
