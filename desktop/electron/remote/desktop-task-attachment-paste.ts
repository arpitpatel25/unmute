/**
 * Dependency-inverted image paste for a driven desktop composer.
 *
 * Remote owns provider routing; the Electron engine owns the macOS pasteboard
 * and synthetic Command-V. Registration keeps that dependency one-way.
 */
/**
 * `paste` lets the CALLER decide how the staged pasteboard image is consumed.
 * The engine still owns the macOS pasteboard, but a driver that can reach its
 * target's renderer supplies its own paste — the Codex lane does, which is what
 * lets a screenshot reply land without bringing Codex to the front. Omitted, the
 * engine falls back to a native Command-V, which requires the target to be
 * frontmost.
 */
export type DesktopTaskImagePaste = (
  text: string,
  paths: readonly string[],
  observe?: (stage: string, fields: Record<string, unknown>) => void,
  paste?: () => Promise<boolean>,
) => Promise<boolean>

let effect: DesktopTaskImagePaste | null = null

export function registerDesktopTaskImagePaste(fn: DesktopTaskImagePaste): void {
  effect = fn
}

export async function pasteDesktopTaskImages(
  text: string,
  paths: readonly string[],
  observe?: (stage: string, fields: Record<string, unknown>) => void,
  paste?: () => Promise<boolean>,
): Promise<boolean> {
  if (!paths.length) return true
  return effect ? effect(text, paths, observe, paste) : false
}
