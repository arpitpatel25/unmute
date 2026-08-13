/**
 * Dependency-inverted pasteboard effect for an owned PTY. The Electron engine
 * registers the real macOS clipboard implementation; Remote owns only the
 * provider-neutral request and the exact PTY callback it must target.
 */
export type TaskImagePaste = (
  text: string,
  paths: readonly string[],
  paste: () => Promise<boolean>,
) => Promise<boolean>

let effect: TaskImagePaste | null = null

export function registerTaskImagePaste(fn: TaskImagePaste): void { effect = fn }

export async function pasteTaskImages(
  text: string,
  paths: readonly string[],
  paste: () => Promise<boolean>,
): Promise<boolean> {
  return effect ? effect(text, paths, paste) : false
}
