/**
 * Dependency-inverted image paste for a driven desktop composer.
 *
 * Remote owns provider routing; the Electron engine owns the macOS pasteboard
 * and synthetic Command-V. Registration keeps that dependency one-way.
 */
export type DesktopTaskImagePaste = (
  text: string,
  paths: readonly string[],
) => Promise<boolean>

let effect: DesktopTaskImagePaste | null = null

export function registerDesktopTaskImagePaste(fn: DesktopTaskImagePaste): void {
  effect = fn
}

export async function pasteDesktopTaskImages(text: string, paths: readonly string[]): Promise<boolean> {
  if (!paths.length) return true
  return effect ? effect(text, paths) : false
}
