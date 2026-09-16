import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import { createHash } from 'node:crypto'

import { AGENT_PRINCIPLES } from './constitution'
import { LEGACY_DEFAULT_FINGERPRINTS } from './persona-defaults'

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

  Left untouched, it follows each new build of Unmute. Once you edit it, it is
  yours and is never changed again.

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
  legacyDefaults: ReadonlySet<string> = LEGACY_DEFAULT_FINGERPRINTS,
): Promise<{ text: string; source: 'file' | 'seeded' | 'refreshed' | 'default' }> {
  const readFile = io.readFile ?? ((p) => fs.readFile(p, 'utf8'))
  const writeFile = io.writeFile ?? ((p, data) => fs.writeFile(p, data, { mode: 0o600 }))
  const mkdir = io.mkdir ?? (async (p) => { await fs.mkdir(p, { recursive: true, mode: 0o700 }) })
  const path = personaPath(agentDir)

  let existing: string | undefined
  try { existing = await readFile(path) } catch { /* not there yet, or unreadable — seed below */ }
  if (existing?.trim()) {
    const body = stripHeader(existing)
    // AN UNTOUCHED COPY FOLLOWS THE BUILD. Never merged and never migrated
    // still holds for a file a person edited — but a copy nobody touched is
    // just an old default, and leaving it froze one machine on 8 September's
    // rules for eight days, through a whole new tool's instructions
    // (2026-09-16). "Untouched" is a fact, not a guess: the body matches the
    // fingerprint recorded when it was seeded, or one of every rulebook that
    // shipped before seeds recorded one.
    const seededFrom = existing.match(/<!-- unmute-default: ([0-9a-f]{16}) -->/)?.[1]
    const untouched = seededFrom ? fingerprint(body) === seededFrom : legacyDefaults.has(fingerprint(body))
    if (!untouched || fingerprint(body) === fingerprint(AGENT_PRINCIPLES)) return { text: body, source: 'file' }
    try { await writeFile(path, seed()) } catch { /* today's rules still apply; the next start retries */ }
    return { text: AGENT_PRINCIPLES, source: 'refreshed' }
  }

  try {
    await mkdir(dirname(path))
    await writeFile(path, seed())
    return { text: AGENT_PRINCIPLES, source: 'seeded' }
  } catch {
    return { text: AGENT_PRINCIPLES, source: 'default' }
  }
}

/** The HTML comments are for whoever opens the file, not for the model. */
function stripHeader(text: string): string {
  return text.replace(/^(\s*<!--[\s\S]*?-->\s*)+/, '').trim()
}

/**
 * One line that says which rules an Agent is running, for its log.
 *
 * `current` is the question that mattered on 2026-09-16, answerable from a
 * user's logs instead of their files: is this the rulebook the installed build
 * ships? `source` says why — seeded fresh, refreshed from an old copy, kept
 * because a person edited it, or the built-in fallback.
 */
export function describeRules(persona: { text: string; source: string }): { source: string; loaded: string; shipped: string; current: boolean; chars: number } {
  const loaded = fingerprint(persona.text), shipped = fingerprint(AGENT_PRINCIPLES)
  return { source: persona.source, loaded, shipped, current: loaded === shipped, chars: persona.text.length }
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

/** What a fresh copy holds: the header, what it was seeded from, the rules. */
function seed(): string {
  return `${PERSONA_HEADER}<!-- unmute-default: ${fingerprint(AGENT_PRINCIPLES)} -->\n\n${AGENT_PRINCIPLES}\n`
}
