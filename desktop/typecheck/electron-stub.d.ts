// Minimal ambient stub of the Electron surface our Remote main/preload code
// uses — enough to typecheck OUR logic without downloading the Electron binary.
// NOT used at build time (the real engine has real electron); typecheck-only.
declare module 'electron' {
  export interface WebContents {
    send(channel: string, ...args: unknown[]): void
    on(event: string, cb: (...a: unknown[]) => void): void
    getURL(): string
  }
  export interface Rectangle { x: number; y: number; width: number; height: number }
  export class BrowserWindow {
    constructor(opts?: Record<string, unknown>)
    static getAllWindows(): BrowserWindow[]
    isDestroyed(): boolean
    isVisible(): boolean
    webContents: WebContents
    setAlwaysOnTop(flag: boolean, level?: string): void
    setVisibleOnAllWorkspaces(flag: boolean, opts?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): void
    setFullScreenable(flag: boolean): void
    setBounds(b: Rectangle): void
    show(): void
    showInactive(): void
    hide(): void
    focus(): void
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
  export const globalShortcut: {
    register(accelerator: string, cb: () => void): boolean
    unregister(accelerator: string): void
    isRegistered(accelerator: string): boolean
  }
  export const shell: {
    openExternal(url: string, options?: { activate?: boolean }): Promise<void>
    openPath(path: string): Promise<string>
  }
  export interface NativeImage {
    isEmpty(): boolean
    toPNG(): Buffer
    resize(opts: { width?: number; height?: number }): NativeImage
    toDataURL(): string
  }
  export const nativeImage: {
    createFromPath(path: string): NativeImage
  }
  export const clipboard: {
    readImage(): NativeImage
    readText(): string
    writeText(text: string): void
    write(data: { text?: string; image?: NativeImage }): void
    availableFormats(): string[]
    clear(): void
    /** Raw pasteboard flavours. Used to hand a file URL over as a real
     *  NSFilenamesPboardType-style payload rather than as text. */
    writeBuffer(format: string, buffer: Buffer): void
    readBuffer(format: string): Buffer
  }
  /** Seconds since the last SYSTEM-WIDE input event — the presence signal.
   *  System-wide is the point: it sees you working in any app. */
  export const powerMonitor: {
    getSystemIdleTime(): number
    on(event: string, cb: (...a: unknown[]) => void): void
  }
  export interface App {
    on(event: string, cb: (...a: unknown[]) => void): void
    getPath(name: string): string
    getAppPath(): string
    isPackaged: boolean
  }
  export const app: App
  export const safeStorage: {
    isEncryptionAvailable(): boolean
    encryptString(plainText: string): Buffer
    decryptString(encrypted: Buffer): string
  }
  export class Notification {
    constructor(opts: { title: string; body: string })
    show(): void
    /** 'click' / 'close' / 'show' — the notetaker attaches a click handler so
     *  its meeting-detected prompt can act on being tapped. */
    on(event: string, cb: (...a: unknown[]) => void): void
    static isSupported(): boolean
  }
  /** Native modal dialogs. Only showMessageBox is used (the notetaker's
   *  stop-confirmation, spec §6); `response` is the index of the button the
   *  user chose, within the `buttons` array. */
  export const dialog: {
    showMessageBox(opts: {
      type?: 'none' | 'info' | 'error' | 'question' | 'warning'
      buttons?: string[]
      defaultId?: number
      cancelId?: number
      title?: string
      message: string
      detail?: string
    }): Promise<{ response: number; checkboxChecked: boolean }>
    showErrorBox(title: string, content: string): void
  }
}

// Electron augments Node's process with resourcesPath (the packaged app's
// Contents/Resources dir). Typecheck-only mirror of that augmentation.
declare namespace NodeJS {
  interface Process { resourcesPath: string }
}
