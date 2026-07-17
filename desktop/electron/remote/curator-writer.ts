// Unmute Remote — the Skill Curator's writer: the ONLY code in the system that
// touches ~/.claude/skills. Everything that materializes a curated skill on
// disk flows through here, and here alone, so the D7–D10 invariants can be
// enforced mechanically in one place:
//
//   D8  — every rendered skill carries `disable-model-invocation: true`,
//         always, unconditionally. A curated skill is invoked by the user
//         (explicit /name), never auto-injected into the model's context.
//   D10 — never write a name we did not author. `create` refuses if the name is
//         already ours (ledger) OR a directory already sits on disk; `update`
//         refuses anything not already in our ledger — we only edit what we own.
//   Ledger-FIRST — appendLedger runs BEFORE the file is written, so a crash
//         between the two leaves a recorded intent (which drift detection
//         reconciles) rather than an unrecorded file on disk. The ledger is the
//         authority; the filesystem is downstream of it.
//
// Writes are atomic (tmp + rename) and land only at
// <skillsRoot>/<name>/SKILL.md. `skillsRoot` defaults to ~/.claude/skills but
// is injectable so tests never touch the real one.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { readLedger, appendLedger, appendLedgerCore, curatedSkillNames, serialized } from './curator-store'
import type { CuratorPaths, ProposalDraft, LedgerEntry } from './curator-store'

export function defaultSkillsRoot(): string {
  return join(homedir(), '.claude', 'skills')
}

/** Strict slug rule for a skill name: lowercase alphanumeric + hyphens, 1-60
 *  chars, must start alphanumeric. This single gate closes BOTH the path-
 *  traversal hole (no '/', no '.', no '..' can survive) and the frontmatter-
 *  injection hole (no newline, no ':' can survive) — a name that passes this
 *  can neither escape <skillsRoot>/<name> nor break out of the YAML block. */
const NAME_SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/
export function isValidSkillName(name: string): boolean {
  return NAME_SLUG.test(name)
}

/** sha256 hex of the given string. */
export function contentHash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** A description must be a single frontmatter line: collapse whitespace/newlines
 *  and strip surrounding quotes so it never breaks the YAML block. */
function sanitizeDescription(desc: string): string {
  return desc.replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '')
}

/** Render a SKILL.md: a YAML frontmatter block (name, description,
 *  disable-model-invocation: true always, origin: unmute when stamped) followed
 *  by a blank line and the body. */
export function renderSkillMd(d: ProposalDraft, opts?: { originStamp?: boolean }): string {
  // Defensive: a pure/synchronous invariant — renderSkillMd must NEVER emit a
  // frontmatter block for an unsafe name (a newline/':' would inject arbitrary
  // frontmatter and could push `disable-model-invocation: true` out of the
  // block, defeating D8). writeSkill's top guard makes this unreachable in the
  // normal flow; the throw closes the module-level invariant regardless.
  if (!isValidSkillName(d.name)) {
    throw new Error(`renderSkillMd: unsafe skill name: ${JSON.stringify(d.name)}`)
  }
  const lines = [
    '---',
    `name: ${d.name}`,
    `description: ${sanitizeDescription(d.description)}`,
    'disable-model-invocation: true', // D8 — unconditional
  ]
  if (opts?.originStamp) lines.push('origin: unmute')
  lines.push('---', '')
  return `${lines.join('\n')}\n${d.body}`
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

export interface WriteResult { ok: boolean; error?: 'collision' | 'io' | 'invalid-name'; detail?: string }

/** Materialize (or update) a curated skill on disk, collision-guarded and
 *  ledger-first. See the module header for the invariants this enforces. */
export async function writeSkill(o: {
  draft: ProposalDraft; kind: 'create' | 'update'; userEdited: boolean
  proposalId: string; paths: CuratorPaths; skillsRoot?: string
  originStamp: boolean; diff?: string
}): Promise<WriteResult> {
  const skillsRoot = o.skillsRoot ?? defaultSkillsRoot()
  const name = o.draft.name

  // 0. Name guard (C1 path-traversal + C2 frontmatter-injection) — BEFORE the
  //    collision guard, any ledger append, or any FS op. A name that fails the
  //    slug rule can neither escape <skillsRoot>/<name> via '../' nor inject
  //    frontmatter via a newline. Reject with nothing written, nothing logged.
  if (!isValidSkillName(name)) {
    return { ok: false, error: 'invalid-name', detail: `not a valid skill name: ${JSON.stringify(name)}` }
  }

  const skillDir = join(skillsRoot, name)
  const rendered = renderSkillMd(o.draft, { originStamp: o.originStamp })
  const hash = contentHash(rendered)

  // The collision guard (read) → ledger-first append → file write run inside a
  // SINGLE serialized critical section on the store's write-chain, so two
  // concurrent creates for the same name can't both pass the guard (TOCTOU).
  return serialized(async () => {
    // 1. Collision guard (D10) — decided against the ledger + disk BEFORE any write.
    const ledger = await readLedger(o.paths)
    const owned = curatedSkillNames(ledger)
    if (o.kind === 'create') {
      if (owned.has(name)) {
        return { ok: false, error: 'collision', detail: `already curated: ${name}` }
      }
      if (await dirExists(skillDir)) {
        return { ok: false, error: 'collision', detail: `directory exists on disk: ${name}` }
      }
    } else {
      // update — we only ever edit a name we authored.
      if (!owned.has(name)) {
        return { ok: false, error: 'collision', detail: `not ours to update: ${name}` }
      }
    }

    // 2. Ledger FIRST — record the intent before touching disk. A crash between
    //    this append and the write leaves a recorded intent, never an orphan file.
    //    appendLedgerCore (not appendLedger) because we already hold the lock.
    const action: LedgerEntry['action'] =
      o.kind === 'create' ? 'created' : o.userEdited ? 'user-edited-accept' : 'updated'
    const entry: LedgerEntry = {
      at: new Date().toISOString(),
      skill: name,
      action,
      proposalId: o.proposalId,
      contentHash: hash,
    }
    if (o.diff !== undefined) entry.diff = o.diff
    await appendLedgerCore(o.paths, entry)

    // 3. Write the file atomically: tmp + rename, under skillsRoot/name only.
    const dest = join(skillDir, 'SKILL.md')
    const tmp = `${dest}.tmp`
    try {
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(tmp, rendered)
      await fs.rename(tmp, dest) // atomic — a reader never sees a torn file
    } catch (err) {
      // The intent is recorded in the ledger; drift detection reconciles later.
      // Best-effort: sweep the orphan tmp so a failed write leaves no litter.
      await fs.unlink(tmp).catch(() => { /* nothing to clean up */ })
      return { ok: false, error: 'io', detail: err instanceof Error ? err.message : String(err) }
    }

    return { ok: true }
  })
}

/** Detect skills we own whose on-disk content diverged from what we last wrote.
 *  For each owned name, compare the current SKILL.md hash against the LAST
 *  ledger entry for that skill that carries a contentHash. A mismatch that is
 *  not already flagged at the current hash appends a 'user-modified-detected'
 *  entry and is returned. Idempotent: a second call at the same hash re-reads
 *  that fresh flag and does not re-flag. */
export async function detectDrift(paths: CuratorPaths, skillsRoot?: string): Promise<string[]> {
  const root = skillsRoot ?? defaultSkillsRoot()
  const ledger = await readLedger(paths)
  const owned = curatedSkillNames(ledger)
  const drifted: string[] = []

  for (const name of owned) {
    let onDisk: string
    try {
      onDisk = await fs.readFile(join(root, name, 'SKILL.md'), 'utf8')
    } catch {
      continue // gone from disk — not a content-drift case; out of scope here.
    }
    const currentHash = contentHash(onDisk)

    // The LAST ledger entry for this skill that carries a contentHash.
    let last: LedgerEntry | undefined
    for (const e of ledger.entries) {
      if (e.skill === name && e.contentHash !== undefined) last = e
    }
    if (!last) continue // nothing to compare against.

    // Matches what we last recorded (incl. the case where our LAST entry is
    // itself a user-modified-detected flag at THIS hash — idempotency: a second
    // call at the same on-disk hash re-reads that fresh flag and stays quiet).
    if (last.contentHash === currentHash) continue

    await appendLedger(paths, {
      at: new Date().toISOString(),
      skill: name,
      action: 'user-modified-detected',
      contentHash: currentHash,
    })
    drifted.push(name)
  }

  return drifted
}
