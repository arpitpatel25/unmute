import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import { AGENT_PRINCIPLES } from './constitution'

/**
 * unmute-agent.md — the Agent's persona, on disk and editable.
 *
 * The prompt used to exist only as a string constant. That was right while it
 * was a constitution nobody but us could reasonably change; it is wrong now
 * that the Agent is a persistent chat the user talks to all day, because how it
 * talks back is theirs to set.
 *
 * IT LIVES IN THE USER'S DIRECTORY, NOT IN THE BUNDLE. A file shipped inside
 * the app is read-only in practice — signed, replaced on every update, and gone
 * if the user edits it. Seeding ~/.unmute/remote/agent/unmute-agent.md from the
 * built-in default gives the opposite properties: edits survive updates, the
 * file is findable, and deleting it restores the default rather than breaking
 * the Agent.
 *
 * The constant stays the SOURCE OF THE DEFAULT and is what the eval harness
 * exercises, so evals still run against real text rather than whatever happens
 * to be on one machine.
 *
 * NEVER MERGED, NEVER MIGRATED. If the file exists, it is the prompt, verbatim.
 * Quietly appending our newer paragraphs to a file the user has edited would
 * make their copy drift into something neither of us wrote.
 */

export const PERSONA_FILENAME = 'unmute-agent.md'

/** The header written above the default, so someone opening it knows what it is. */
const PERSONA_HEADER = `<!--
  The Unmute Agent's persona and instructions.

  This file IS the prompt. It is read when a conversation starts, so an edit
  takes effect on the next FRESH conversation — after the idle purge, or after
  a relaunch. Delete the file and Unmute writes the default back.

  What belongs here is judgement: how the Agent should think, what it should
  prefer, how it should sound. What must ALWAYS hold lives in the tool schemas
  instead, where it is enforced rather than requested.
-->
`

export function personaPath(agentDir: string): string {
  return join(agentDir, PERSONA_FILENAME)
}

/**
 * Read the persona, writing the default first if there is nothing there.
 *
 * FALLS BACK TO THE CONSTANT RATHER THAN FAILING. A read error here — a
 * permission problem, a directory that will not create — must not be the reason
 * the Agent cannot answer. The user gets the default behaviour and one log
 * line, not a broken assistant.
 */
export async function loadPersona(
  agentDir: string,
  io: {
    readFile?: (p: string) => Promise<string>
    writeFile?: (p: string, data: string) => Promise<void>
    mkdir?: (p: string) => Promise<void>
  } = {},
): Promise<{ text: string; source: 'file' | 'seeded' | 'default' }> {
  const readFile = io.readFile ?? ((p) => fs.readFile(p, 'utf8'))
  const writeFile = io.writeFile ?? ((p, data) => fs.writeFile(p, data, { mode: 0o600 }))
  const mkdir = io.mkdir ?? (async (p) => { await fs.mkdir(p, { recursive: true, mode: 0o700 }) })
  const path = personaPath(agentDir)

  try {
    const existing = await readFile(path)
    if (existing.trim()) return { text: stripHeader(existing), source: 'file' }
  } catch { /* not there yet, or unreadable — seed below */ }

  try {
    await mkdir(dirname(path))
    await writeFile(path, `${PERSONA_HEADER}\n${AGENT_PRINCIPLES}\n`)
    return { text: AGENT_PRINCIPLES, source: 'seeded' }
  } catch {
    return { text: AGENT_PRINCIPLES, source: 'default' }
  }
}

/** The HTML comment is for whoever opens the file, not for the model. */
function stripHeader(text: string): string {
  return text.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim()
}
