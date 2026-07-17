// Skill Curator — prompt builders and validating output parsers.
//
// Pure module: builds the exact one-shot prompts the distill and synthesize
// sessions receive, and parses/validates the JSON files they write back. No fs,
// no LLM, no side effects. The synthesize prompt inherits the librarian's
// battle-tested filter language nearly verbatim (see librarian.ts:163-169).

import type { DistillProcedure, Candidate, Proposal } from './curator-store.ts'

// ── Distill ────────────────────────────────────────────────────────────────

/** Build the distill prompt: one work session's reduced trace → procedures. */
export function buildDistillPrompt(i: {
  taskId: string
  intent: string
  tracePath: string
  outPath: string
  curatedNames: string[]
}): string {
  const curated = i.curatedNames.length ? i.curatedNames.join(', ') : '(none)'
  return [
    `[Unmute curator — distill] You are analyzing ONE work session's reduced trace.`,
    `Read the trace file at ${i.tracePath} (use the Read tool; read it fully, in chunks if large).`,
    `Session intent: "${i.intent}"`,
    ``,
    `Report every MULTI-STEP PROCEDURE that occurred — a reusable method someone`,
    `would follow again: what it accomplishes, its semantic skeleton`,
    `(preconditions → ordered steps by intent → definition of done → gotchas`,
    `discovered), how many separate times it occurred in THIS trace, and whether`,
    `it involved visible struggle (errors, backtracking, re-derivation).`,
    `NEVER report bare facts or preferences — they are not procedures and are out`,
    `of scope. NEVER store raw coordinates, pixel positions, tab ids, or one-off`,
    `values — distill to the durable skeleton.`,
    `These curated skills already exist: ${curated}. If the trace`,
    `shows one being invoked, report what happened AROUND the invocation`,
    `(extra steps appended, corrections, failure) as usedCuratedSkill.`,
    `Reply ONLY by writing JSON to ${i.outPath} (write ${i.outPath}.tmp then rename):`,
    `{"procedures":[{"title":"…","skeleton":"…","count":N,"struggle":true|false,`,
    `  "usedCuratedSkill":{"name":"…","friction":"…"}?}]}`,
    `No procedures found → {"procedures":[]}. Do nothing else — no other tools than Read and the file write.`,
  ].join('\n')
}

/** Parse the distill output file. [] on null/malformed; drops entries missing title/skeleton. */
export function parseDistillOutput(raw: string | null): DistillProcedure[] {
  if (raw == null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const procs = (parsed as { procedures?: unknown } | null)?.procedures
  if (!Array.isArray(procs)) return []
  const out: DistillProcedure[] = []
  for (const p of procs) {
    if (!p || typeof p !== 'object') continue
    const e = p as Record<string, unknown>
    if (typeof e.title !== 'string' || e.title.trim() === '') continue
    if (typeof e.skeleton !== 'string' || e.skeleton.trim() === '') continue
    const proc: DistillProcedure = {
      title: e.title,
      skeleton: e.skeleton,
      count: typeof e.count === 'number' && Number.isFinite(e.count) ? e.count : 1,
      struggle: e.struggle === true,
    }
    const used = e.usedCuratedSkill
    if (used && typeof used === 'object') {
      const u = used as Record<string, unknown>
      if (typeof u.name === 'string' && typeof u.friction === 'string') {
        proc.usedCuratedSkill = { name: u.name, friction: u.friction }
      }
    }
    out.push(proc)
  }
  return out
}

// ── Synthesize ───────────────────────────────────────────────────────────────

/** Build the synthesize prompt: candidates + context → proposals. Inherits the
 *  librarian filter language (librarian.ts:163-169) nearly verbatim. */
export function buildSynthesizePrompt(i: {
  sweepId: string
  candidates: Candidate[]
  curatedIndex: Array<{ name: string; description: string }>
  rejections: Array<{ name: string; reason?: string }>
  feedback: Array<{ skill: string; note: string }>
  outPath: string
}): string {
  const candidateLines = i.candidates.length
    ? i.candidates
        .map(
          (c) =>
            `- [${c.key}] "${c.title}" — seen ${c.total}x (${c.firstSeen}→${c.lastSeen}), struggle:${c.struggle ? 'y' : 'n'}\n  skeleton: ${c.skeleton}`,
        )
        .join('\n')
    : '(no candidates this sweep)'

  const curatedLines = i.curatedIndex.length
    ? i.curatedIndex.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    : '(none)'

  const rejectionLines = i.rejections.length
    ? i.rejections.map((r) => `- ${r.name}${r.reason ? ` — ${r.reason}` : ''}`).join('\n')
    : '(none)'

  const feedbackLines = i.feedback.length
    ? i.feedback.map((f) => `- ${f.skill}: ${f.note}`).join('\n')
    : '(none)'

  return [
    // (1) role + inherited librarian filter block
    `[Unmute curator — synthesize] Sweep ${i.sweepId}. You decide whether the`,
    `accumulated candidates below justify CREATING new skills or UPDATING existing`,
    `ones. You produce PROPOSALS only — a human reviews and applies them.`,
    ``,
    `── The filter — what clears the bar to propose (create OR update) ──`,
    `Propose ONLY when ALL THREE hold: (1) CONSEQUENTIAL — getting it wrong causes a real wrong or`,
    `hard-to-reverse outcome, not merely a slower path; (2) NON-OBVIOUS / SILENT — a capable model`,
    `could miss it because nothing errors; (3) DURABLE — a stable property that recurs.`,
    `Everything else — obvious steps, things that merely worked, transient state, one-offs — DROP.`,
    `The default is NO change. A wrong or excess skill degrades the executor's own intelligence MORE`,
    `than a missing one; bloat is the enemy. When unsure, DON'T.`,
    ``,
    // (2) admission criteria (spec D3)
    `── Admission criteria ──`,
    `A candidate is admissible only if it ALSO clears the numeric bar: either`,
    `REPETITION (≥2 total occurrences across sessions), OR an EXPENSIVE ONE-OFF`,
    `that involved visible struggle (errors, backtracking, re-derivation).`,
    `A single frictionless occurrence is NOT admissible.`,
    ``,
    // (3) candidates
    `── Candidates (accumulated across sessions) ──`,
    candidateLines,
    ``,
    // (4) existing curated index
    `── Existing curated skills (this curator's OWN library) ──`,
    curatedLines,
    `If a candidate OVERLAPS an existing skill, propose kind:"update" against that`,
    `skill (targetSkill + a unified diff of the body) — NEVER a duplicate skill.`,
    ``,
    // (5) rejections
    `── Previously rejected (never re-offer these or close variants) ──`,
    rejectionLines,
    ``,
    // (6) user feedback
    `── User feedback (first-class evidence for updates) ──`,
    feedbackLines,
    `Feedback on an existing skill is strong evidence to propose an update.`,
    ``,
    // (7) output contract
    `── Output contract ──`,
    `Write {"proposals":[…]} to ${i.outPath} atomically (write ${i.outPath}.tmp then rename).`,
    `Each proposal:`,
    `{"kind":"create"|"update",`,
    ` "draft":{"name":"kebab-case-2-to-4-words","description":"trigger phrasing","body":"full SKILL.md body per template"},`,
    ` "evidence":{"occurrences":N,"sessions":[{"id":"…","intent":"…","at":"…","tracePointer":"…"}],`,
    `   "firstSeen":"…","lastSeen":"…","struggle":{"errors":N,"recoveries":N,"wallClockMin":N}},`,
    ` "rationale":"why this clears the filter",`,
    ` "targetSkill":"…"?, "diff":"…"?, "triggeringEvidence":["…"]?, "affectedSessions":[{"id":"…","invokedAt":"…"}]?}`,
    `kind:"update" MUST include targetSkill.`,
    ``,
    // (8) SKILL.md body template (spec §5.1)
    `── SKILL.md body template (use these headings) ──`,
    `## Goal            — what the skill accomplishes`,
    `## When to use     — the trigger conditions`,
    `## Preconditions   — stable setup that must hold before starting`,
    `## Steps           — ordered steps by intent/label, no raw coordinates`,
    `## Verify          — how to know it worked (definition of done)`,
    `## Gotchas         — non-obvious traps discovered (optional)`,
    ``,
    // (9) closing posture
    `── Posture ──`,
    `Zero proposals is the expected common case. Write {"proposals":[]} and finish`,
    `whenever nothing clears the filter and the admission criteria.`,
  ].join('\n')
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/** Parse the synthesize output file. Validates each proposal's shape and drops
 *  invalid entries; stamps id / sweepId / proposedAt / resolution on survivors. */
export function parseSynthesizeOutput(raw: string | null, sweepId: string, now: () => number): Proposal[] {
  if (raw == null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = (parsed as { proposals?: unknown } | null)?.proposals
  if (!Array.isArray(list)) return []

  const ts = now()
  const out: Proposal[] = []
  for (const raw2 of list) {
    if (!raw2 || typeof raw2 !== 'object') continue
    const e = raw2 as Record<string, unknown>

    if (e.kind !== 'create' && e.kind !== 'update') continue

    const draft = e.draft
    if (!draft || typeof draft !== 'object') continue
    const d = draft as Record<string, unknown>
    if (typeof d.name !== 'string' || !NAME_RE.test(d.name)) continue
    if (!nonEmptyString(d.description)) continue
    if (!nonEmptyString(d.body)) continue

    const evidence = e.evidence
    if (!evidence || typeof evidence !== 'object') continue
    const ev = evidence as Record<string, unknown>
    if (typeof ev.occurrences !== 'number' || !Number.isFinite(ev.occurrences)) continue

    if (!nonEmptyString(e.rationale)) continue

    if (e.kind === 'update' && !nonEmptyString(e.targetSkill)) continue

    const index = out.length
    const prop: Proposal = {
      id: `prop_${ts}_${index}`,
      sweepId,
      proposedAt: new Date(ts).toISOString(),
      kind: e.kind,
      draft: {
        name: d.name,
        description: d.description as string,
        body: d.body as string,
      },
      evidence: evidence as Proposal['evidence'],
      rationale: e.rationale as string,
      resolution: null,
    }
    if (nonEmptyString(e.targetSkill)) prop.targetSkill = e.targetSkill as string
    if (nonEmptyString(e.diff)) prop.diff = e.diff as string
    if (Array.isArray(e.triggeringEvidence)) prop.triggeringEvidence = e.triggeringEvidence as string[]
    if (Array.isArray(e.affectedSessions)) prop.affectedSessions = e.affectedSessions as Proposal['affectedSessions']

    out.push(prop)
  }
  return out
}
