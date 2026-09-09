import * as fs from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export const HELLO_TASK_PHRASE = 'Create a file called hello-unmute.txt and write "My first Unmute task" inside it.'
export const HELLO_TASK_CONTENT = 'My first Unmute task'

export async function prepareOnboardingWorkspace(root: string): Promise<void> { await fs.mkdir(root, { recursive: true, mode: 0o700 }) }
export async function verifyHelloTask(root: string): Promise<boolean> {
  try { return (await fs.readFile(join(root, 'hello-unmute.txt'), 'utf8')).trim() === HELLO_TASK_CONTENT } catch { return false }
}
export function isOwnedOnboardingTask(task: { id: string; cwd: string }, armedTaskId: string, root: string): boolean {
  const normalizedRoot = resolve(root)
  const cwd = resolve(task.cwd)
  return task.id === armedTaskId && (cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}${sep}`))
}
