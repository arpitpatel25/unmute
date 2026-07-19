// Skill Curator — prompt builders and validating output parsers.
//
// Pure module: builds the exact one-shot prompts the distill and synthesize
// sessions receive, and parses/validates the JSON files they write back. No fs,
// no LLM, no side effects. The synthesize prompt inherits the librarian's
// battle-tested filter language nearly verbatim (see librarian.ts:163-169).

import type { DistillProcedure, Candidate, Proposal } from './curator-store.ts'

// ── Distill ────────────────────────────────────────────────────────────────

/** Build the distill prompt: one work session's reduced trace → procedures.
 *  devMode (DEV-ONLY, default false) asks the model to ALSO emit a top-level
 *  `reasoning` string for developer diagnostics. Production (devMode false) pays
 *  zero extra tokens — the ask is simply not present. */
export function buildDistillPrompt(i: {
  taskId: string
  intent: string
  tracePath: string
  outPath: string
  curatedNames: string[]
  devMode?: boolean
}): string {
  const curated = i.curatedNames.length ? i.curatedNames.join(', ') : '(none)'
  const lines = [
    `[Unmute curator — distill] You are analyzing ONE work session's reduced trace.`,
    `Read the trace file at ${i.tracePath} (use the Read tool; read it fully, in chunks if large).`,
    `Session intent: "${i.intent}"`,
    ``,
    `Report every reusable METHOD / WORKFLOW / STANDARD the work demonstrates — a`,
    `body of domain know-how that makes the agent do a KIND OF WORK the way the`,
    `user wants it done. For each, report: what KIND OF WORK it accomplishes, the`,
    `approach / standards / judgment it encodes (the reusable method, not a UI`,
    `click-path), when it applies, how many separate times it occurred in THIS`,
    `trace, and whether it involved visible struggle (errors, backtracking,`,
    `re-derivation). A method qualifies only if it is transferable beyond one`,
    `app's mechanics, encodes judgment/standards (not just steps-to-a-state), and`,
    `is recognizable as "my way of doing X" worth deliberately invoking.`,
    ``,
    `Do NOT report app-navigation, tool-operation paths, UI click-sequences, or`,
    `"how to reach a state in an app" — those are transient, brittle, tool-locked,`,
    `and judgment-free; they are NOT skills (they are the librarian's domain).`,
    `NEVER report bare facts or preferences — they are not methods and are out of`,
    `scope. NEVER store raw coordinates, pixel positions, tab ids, or one-off`,
    `values.`,
    `These curated skills already exist: ${curated}. If the trace`,
    `shows one being invoked, report what happened AROUND the invocation`,
    `(extra steps appended, corrections, failure) as usedCuratedSkill.`,
    `Reply ONLY by writing JSON to ${i.outPath} (write ${i.outPath}.tmp then rename).`,
    `In each entry, "skeleton" carries the reusable method/approach (what it does,`,
    `the standards/judgment it encodes, when it applies) — NOT ordered UI steps:`,
    `{"procedures":[{"title":"…","skeleton":"…","count":N,"struggle":true|false,`,
    `  "usedCuratedSkill":{"name":"…","friction":"…"}?}]}`,
    `No methods found → {"procedures":[]}. Do nothing else — no other tools than Read and the file write.`,
  ]
  if (i.devMode) {
    lines.push(
      ``,
      `[developer diagnostics] ALSO add a top-level "reasoning" string to that same`,
      `JSON object: explain what you considered and, importantly, what you EXCLUDED`,
      `— especially WHY anything was app-navigation-and-not-a-method. This field is`,
      `for a developer inspecting the run; it does not affect any decision.`,
      `Shape: {"procedures":[…], "reasoning":"…"}.`,
    )
  }
  return lines.join('\n')
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

/** DEV-ONLY: capture the top-level `reasoning` string the devMode distill prompt
 *  asks for. Returns undefined on null/malformed/absent. Kept as a SEPARATE read
 *  (not folded into parseDistillOutput's return) so the decision path is byte-for-
 *  byte unchanged; the sweep only LOGS this — it never feeds a decision. */
export function parseDistillReasoning(raw: string | null): string | undefined {
  return topLevelReasoning(raw)
}

// ── Synthesize ───────────────────────────────────────────────────────────────

/** Build the synthesize prompt: candidates + context → proposals. Inherits the
 *  librarian filter language (librarian.ts:163-169) nearly verbatim. */
export function buildSynthesizePrompt(i: {
  sweepId: string
  candidates: Candidate[]
  // Each owned skill's body is carried too (the sweep diffs against it, D19); the
  // listing below stays name+description to keep the prompt lean.
  curatedIndex: Array<{ name: string; description: string; body: string }>
  rejections: Array<{ name: string; reason?: string }>
  feedback: Array<{ skill: string; note: string }>
  outPath: string
  // DEV-ONLY: ask the model to ALSO emit a top-level `reasoning` string for
  // developer diagnostics. Default false — production pays zero extra tokens.
  devMode?: boolean
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

  const lines = [
    // (1) role + inherited librarian filter block
    `[Unmute curator — synthesize] Sweep ${i.sweepId}. You decide whether the`,
    `accumulated candidates below justify CREATING new skills or UPDATING existing`,
    `ones. You produce PROPOSALS only — a human reviews and applies them.`,
    ``,
    `── The filter — what clears the bar to propose (create OR update) ──`,
    `A SKILL is a durable, transferable METHOD / WORKFLOW / STANDARD / body of`,
    `domain know-how that makes the agent do a KIND OF WORK the way the user wants`,
    `it done. Propose ONLY when the candidate is such a method AND it is worth`,
    `deliberately invoking: transferable beyond one app's mechanics; encodes`,
    `judgment/standards, not just steps-to-a-state; recognizable as "my way of`,
    `doing X".`,
    `Do NOT propose APP-NAVIGATION / tool-operation paths / UI click-sequences /`,
    `"how to reach a state in an app" — those are transient, brittle, tool-locked,`,
    `judgment-free, and are NOT skills (they are the librarian's domain). An`,
    `expensive NAVIGATION does not qualify; only an expensive METHOD does.`,
    `Everything else — facts, preferences, transient state, mere app-navigation —`,
    `DROP.`,
    `The default is NO change. A wrong or excess skill degrades the executor's own intelligence MORE`,
    `than a missing one; bloat is the enemy. When unsure, DON'T.`,
    ``,
    // (2) admission criteria (spec D3)
    `── Admission criteria ──`,
    `A candidate is admissible only if it is a genuine method (above) AND it clears`,
    `the bar by EITHER: REPETITION (≥2 total occurrences across sessions), OR a`,
    `VALUABLE ONE-OFF method that involved visible struggle (errors, backtracking,`,
    `re-derivation). A one-off that is mere app-navigation does NOT qualify, no`,
    `matter how expensive. A single frictionless occurrence is NOT admissible.`,
    ``,
    // (3) candidates
    `── Candidates (accumulated across sessions) ──`,
    candidateLines,
    ``,
    // (4) existing curated index
    `── Existing curated skills (this curator's OWN library) ──`,
    curatedLines,
    `If a candidate OVERLAPS an existing skill, propose kind:"update" against that`,
    `skill (targetSkill + the FULL proposed new SKILL.md body) — NEVER a duplicate`,
    `skill, and NEVER a hand-written diff (the diff is computed deterministically`,
    `elsewhere from your body vs the file on disk).`,
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
    ` "changeSummary":["short plain-language bullet","…"],`,
    ` "evidence":{"occurrences":N,"sessions":[{"id":"…","intent":"…","at":"…","tracePointer":"…"}],`,
    `   "firstSeen":"…","lastSeen":"…","struggle":{"errors":N,"recoveries":N,"wallClockMin":N}},`,
    ` "rationale":"why this clears the filter",`,
    ` "targetSkill":"…"?, "triggeringEvidence":["…"]?, "affectedSessions":[{"id":"…","invokedAt":"…"}]?}`,
    `kind:"update" MUST include targetSkill AND put the COMPLETE new SKILL.md body`,
    `in draft.body — the full replacement text, not a diff. Do NOT emit a "diff"`,
    `field; the raw diff is computed deterministically from your body vs the file.`,
    ``,
    `"changeSummary" is 2-5 short plain-language bullet strings for a HUMAN`,
    `reviewer (no markdown, plain sentences). For a create: what the skill does +`,
    `why you're suggesting it. For an update: what is changing and why`,
    `(e.g. ["Adds a lockfile check before merge","Tightens the description so it`,
    `triggers on 'review my PR'"]).`,
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
  ]
  if (i.devMode) {
    lines.push(
      ``,
      `── Developer diagnostics (dev-only) ──`,
      `ALSO add a top-level "reasoning" string to the output JSON`,
      `({"proposals":[…], "reasoning":"…"}). In it, cover EVERY candidate you saw`,
      `and why you PROPOSED / UPDATED / NO-OP'd / REJECTED each. This is for a`,
      `developer inspecting the run; it never affects the decision.`,
    )
  }
  return lines.join('\n')
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
      changeSummary: Array.isArray(e.changeSummary)
        ? e.changeSummary.filter(nonEmptyString)
        : [],
      resolution: null,
    }
    if (nonEmptyString(e.targetSkill)) prop.targetSkill = e.targetSkill as string
    // D19: the raw diff is deterministic-only — computed by the sweep from the real
    // on-disk body vs the proposed body, never taken from the synthesize LLM output.
    // Any `diff` field the LLM emits is deliberately IGNORED here (it could be fiction).
    if (Array.isArray(e.triggeringEvidence)) prop.triggeringEvidence = e.triggeringEvidence as string[]
    if (Array.isArray(e.affectedSessions)) prop.affectedSessions = e.affectedSessions as Proposal['affectedSessions']

    out.push(prop)
  }
  return out
}

/** DEV-ONLY: capture the top-level `reasoning` string the devMode synthesize
 *  prompt asks for. Returns undefined on null/malformed/absent. Separate read
 *  (not folded into parseSynthesizeOutput) so the decision path is unchanged; the
 *  sweep only LOGS this — it never feeds a decision. */
export function parseSynthesizeReasoning(raw: string | null): string | undefined {
  return topLevelReasoning(raw)
}

/** Shared: pull a non-empty top-level `reasoning` string out of a stage's raw
 *  JSON output. Tolerant — undefined on null / non-JSON / missing / non-string. */
function topLevelReasoning(raw: string | null): string | undefined {
  if (raw == null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const r = (parsed as { reasoning?: unknown } | null)?.reasoning
  return typeof r === 'string' && r.trim() !== '' ? r : undefined
}
