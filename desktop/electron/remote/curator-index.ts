// Curator "existing skills" index — GLOBAL (~/.claude/skills) UNION
// PROJECT-SCOPED (<project>/.claude/skills) skills, deduped by name.
//
// This is the judge's "does this already exist?" context (curator-prompts,
// buildDistillPrompt/buildSynthesizePrompt) AND the deterministic dedup
// backstop in curator.ts's create-suppression. Before this module existed,
// curatedIndex only ever looked at GLOBAL ~/.claude/skills — so the curator
// was blind to skills a user keeps in a repo's own .claude/skills/ and kept
// re-proposing duplicates of them (e.g. proposing `unmute-local-build-install`
// when a project-scoped `unmute-test-build` already covered the same ground).
//
// Reading is best-effort everywhere: a missing/unreadable dir (no skills
// there yet, or — the common case — a project with no .claude/skills folder
// at all) is normal and must never throw or abort a sweep.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface CuratedSkill { name: string; description: string; body: string }

/** Strip the YAML frontmatter (everything up to and including the closing
 *  `---`) to recover the SKILL.md body. A body with no frontmatter is
 *  returned whole. */
export function stripFrontmatter(md: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(md)
  return (m ? md.slice(m[0].length) : md).replace(/^\n/, '')
}

/** List every skill under `dir` — one subdirectory per skill, each holding a
 *  SKILL.md (dir name = skill name). Defensive: a missing dir, or an entry
 *  with no valid SKILL.md, is silently skipped — never throws. */
export async function readSkillsFrom(dir: string): Promise<CuratedSkill[]> {
  const out: CuratedSkill[] = []
  let entries: string[]
  try { entries = await fs.readdir(dir) } catch { return out } // no such dir — normal, not an error
  for (const name of entries) {
    try {
      const md = await fs.readFile(join(dir, name, 'SKILL.md'), 'utf8')
      const description = (/^description:\s*(.+)$/m.exec(md.slice(0, 4096))?.[1] ?? '').trim().slice(0, 600)
      out.push({ name, description, body: stripFrontmatter(md) })
    } catch { /* not a skill dir (no SKILL.md, or unreadable) — skip */ }
  }
  return out
}

/** Global skills ∪ project-scoped skills, deduped by name (a name present in
 *  both keeps the GLOBAL copy — it's the canonical one). `ownedNames` are
 *  guaranteed present in the result even when their SKILL.md is missing on
 *  disk (empty description/body) — the ownership record is the authority,
 *  matching the prior curatedIndex contract the D19 diff relies on. */
export async function buildCuratedIndexFrom(
  ownedNames: Iterable<string>,
  globalSkillsDir: string,
  projectRoots: string[],
): Promise<CuratedSkill[]> {
  const byName = new Map<string, CuratedSkill>()
  for (const s of await readSkillsFrom(globalSkillsDir)) byName.set(s.name, s)
  for (const name of ownedNames) {
    if (!byName.has(name)) byName.set(name, { name, description: '', body: '' })
  }
  for (const root of projectRoots) {
    for (const s of await readSkillsFrom(join(root, '.claude', 'skills'))) {
      if (!byName.has(s.name)) byName.set(s.name, s)
    }
  }
  return Array.from(byName.values())
}
