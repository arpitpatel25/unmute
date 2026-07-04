// Unmute Remote — the skill-usage ledger (deterministic trust fuel).
//
// The cockpit ranks skills by EARNED TRUST, but trust needs evidence. This
// module supplies the deterministic half: when Claude Code invokes a skill it
// leaves a structured `Skill` tool_use in the session transcript — counting
// those is arithmetic on facts, not judgment, so it needs no LLM and no
// librarian gate. The JUDGED half (runs_confirmed — "did it actually help?")
// remains the librarian's job and stays behind the calibration write gate.
//
// Ownership boundary (hard rule): we NEVER write into ~/.claude/skills — the
// user's own files are their territory. All usage stats live in an
// Unmute-owned sidecar ledger (~/.unmute/remote/skill-stats.json), and the
// rail merges: frontmatter counters for Unmute-owned skills, ledger counters
// for everything.
//
// Idempotency: a session can park `done` many times (each turn-over), and a
// resumed thread re-reaches done with the SAME transcript growing longer. We
// therefore remember, per task, how many Skill invocations have already been
// credited, and only credit the delta. One invocation is never counted twice;
// a task that uses a skill five times still counts as five USES but the rail
// ranks on runs (tasks), so we also track distinct task credit per skill.

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log'

const log = createLogger('skill-usage')

export interface SkillStat {
  /** Distinct TASKS in which this skill was invoked (the trust unit — one
   *  task = one run, no matter how many times the task invoked it). */
  runs: number
  /** ISO date (YYYY-MM-DD) of the most recent use. */
  lastUsed: string
}

export interface SkillStatsFile {
  version: 1
  skills: Record<string, SkillStat>
  /** Per-task idempotency cursor: how many Skill tool_use entries have already
   *  been credited from this task's transcript, and which skills this task
   *  already earned a `runs` credit for. */
  counted: Record<string, { uses: number; credited: string[] }>
}

export function defaultStatsPath(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), '.unmute', 'remote'), 'skill-stats.json')
}

const EMPTY: SkillStatsFile = { version: 1, skills: {}, counted: {} }

export async function readSkillStats(statsPath: string): Promise<SkillStatsFile> {
  try {
    const raw = JSON.parse(await fs.readFile(statsPath, 'utf8')) as SkillStatsFile
    if (raw && raw.version === 1 && raw.skills && raw.counted) return raw
    return { ...EMPTY, skills: {}, counted: {} }
  } catch {
    return { ...EMPTY, skills: {}, counted: {} }
  }
}

/** Normalize a Skill invocation name to the rail's vocabulary (file basename):
 *  plugin/dir-scoped names ("superpowers:brainstorming", "apps/web:deploy")
 *  reduce to their final segment. */
export function normalizeSkillName(name: string): string {
  const s = (name || '').trim()
  const afterColon = s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s
  return afterColon.replace(/\.md$/, '').trim()
}

/** Extract every Skill invocation from a Claude Code transcript (JSONL), in
 *  order. Malformed lines are skipped — transcripts can be mid-write. */
export function extractSkillUses(jsonl: string): string[] {
  const uses: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"tool_use"') || !line.includes('Skill')) continue // cheap pre-filter
    try {
      const entry = JSON.parse(line) as { message?: { content?: Array<{ type?: string; name?: string; input?: { skill?: string; command?: string } }> } }
      for (const block of entry.message?.content ?? []) {
        if (block?.type !== 'tool_use' || block.name !== 'Skill') continue
        const skill = normalizeSkillName(block.input?.skill ?? block.input?.command ?? '')
        if (skill) uses.push(skill)
      }
    } catch { /* partial/foreign line — skip */ }
  }
  return uses
}

// Single-writer chain: done-events can land close together; serialized
// read-modify-write keeps the ledger consistent (the meta.json lesson).
let writeChain: Promise<unknown> = Promise.resolve()

/**
 * Credit a task's transcript against the ledger. Idempotent per invocation
 * (only the delta beyond the stored cursor is credited) and per task-skill
 * (a task bumps a skill's `runs` at most once). Returns the skills newly
 * credited this call (for logging), or [] when nothing changed.
 */
export async function recordSkillUsage(opts: {
  taskId: string
  transcriptPath: string
  statsPath: string
  now?: () => number
}): Promise<string[]> {
  const run = async (): Promise<string[]> => {
    let jsonl: string
    try { jsonl = await fs.readFile(opts.transcriptPath, 'utf8') } catch { return [] }
    const uses = extractSkillUses(jsonl)
    if (!uses.length) return []

    const stats = await readSkillStats(opts.statsPath)
    const cursor = stats.counted[opts.taskId] ?? { uses: 0, credited: [] }
    if (uses.length <= cursor.uses) return [] // nothing new since last credit

    const fresh = uses.slice(cursor.uses)
    const today = new Date(opts.now ? opts.now() : Date.now()).toISOString().slice(0, 10)
    const newlyCredited: string[] = []
    for (const name of fresh) {
      const s = stats.skills[name] ?? { runs: 0, lastUsed: '' }
      if (!cursor.credited.includes(name)) {
        s.runs += 1 // trust unit: distinct task, not invocation count
        cursor.credited.push(name)
        newlyCredited.push(name)
      }
      if (today > s.lastUsed) s.lastUsed = today
      stats.skills[name] = s
    }
    cursor.uses = uses.length
    stats.counted[opts.taskId] = cursor

    // Bound the cursor map: keep the most recent ~200 tasks. Old cursors are
    // only needed while a task can still re-reach done; 200 is generous.
    const taskIds = Object.keys(stats.counted)
    if (taskIds.length > 200) {
      for (const id of taskIds.slice(0, taskIds.length - 200)) delete stats.counted[id]
    }

    await fs.mkdir(dirname(opts.statsPath), { recursive: true })
    const tmp = `${opts.statsPath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(stats, null, 2))
    await fs.rename(tmp, opts.statsPath) // atomic — a reader never sees a torn file
    if (newlyCredited.length) log.event('skill-usage-credited', { taskId: opts.taskId, skills: newlyCredited })
    return newlyCredited
  }
  const p = writeChain.then(run, run)
  writeChain = p.catch(() => { /* keep the chain alive */ })
  return p
}
