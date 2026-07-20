// Skill Curator — prompt builders and validating output parsers.
//
// Pure module: builds the exact one-shot prompts the distill and synthesize
// sessions receive, and parses/validates the JSON files they write back. No fs,
// no LLM, no side effects. The prompts implement Curator Operating Theory v2
// (spec §15, V1–V9): selection is driven by observed STRUGGLE (the free
// capability-gap proxy), skills are task/domain units grouped by domain, and
// cross-cutting disciplines / app-navigation are excluded.

import type { DistillProcedure, Candidate, Proposal, ProposalDraft } from './curator-store.ts'

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
    `Your job: find the reusable, recurring pieces of WORK a thoughtful person`,
    `would want to capture so they never have to figure it out again. For each`,
    `candidate report:`,
    `- title: the TASK or kind of work, named plainly the way the USER would say`,
    `  it (e.g. "editing a talking-head video", "setting up a vendor's MCP`,
    `  connector", "pulling and summarizing a standup"). Name the WORK, not an`,
    `  abstract principle.`,
    `- skeleton: what the work involves and HOW it was done well here — the`,
    `  concrete approach, order, standards, and any non-obvious trap discovered.`,
    `- count: how many separate times this kind of work occurred in THIS trace.`,
    `- struggle: TRUE if the agent visibly STRUGGLED — hit errors, backtracked,`,
    `  went down a wrong path, re-derived something, or the USER corrected its`,
    `  approach. This is the MOST IMPORTANT signal: struggle is evidence the model`,
    `  did not know how to do this well by default. Report it honestly.`,
    ``,
    `STRONGLY PREFER candidates with struggle — those are worth capturing. A task`,
    `the agent did smoothly first try, no errors, no correction, is probably NOT`,
    `worth a skill (the model already handles it) — omit it or mark struggle:false.`,
    ``,
    `Do NOT report app-navigation / UI click-paths / how-to-reach-a-state-in-an-app`,
    `(brittle, tool-locked — not our job); bare facts or preferences; raw`,
    `coordinates / pixels / tab-ids / one-off values.`,
    ``,
    `These curated skills already exist: ${curated}. If the trace`,
    `shows one being invoked, report what happened AROUND the invocation`,
    `(extra steps appended, corrections, failure) as usedCuratedSkill.`,
    `Reply ONLY by writing JSON to ${i.outPath} (write ${i.outPath}.tmp then rename).`,
    `In each entry, "skeleton" carries what the work involves and how it was done`,
    `well — the concrete approach, order, standards, and traps:`,
    `{"procedures":[{"title":"…","skeleton":"…","count":N,"struggle":true|false,`,
    `  "usedCuratedSkill":{"name":"…","friction":"…"}?}]}`,
    `Nothing worth capturing → {"procedures":[]}. Do nothing else — no other tools than Read and the file write.`,
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

/** Build the synthesize prompt: candidates + context → proposals. Judges on the
 *  v2 three tests (GAP/TASK/REUSE, spec §15 V5), groups by domain, excludes
 *  cross-cutting disciplines and app-navigation. */
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
    // (1) role
    `[Unmute curator — synthesize] Sweep ${i.sweepId}. From the candidates below,`,
    `propose a SMALL number of genuinely useful SKILLS for THIS specific user.`,
    `Proposals only — a human reviews.`,
    ``,
    // (2) what a skill is
    `── What a skill IS ──`,
    `A skill is a reusable capability for a RECURRING TASK the user does — named`,
    `the way the user would name that task (extract-invoice, edit-talking-head-`,
    `video, setup-mcp-connector). It can be small (a specific repeated fetch) or`,
    `large (a whole workflow). It is SELF-CONTAINED: it bakes in the specifics it`,
    `needs — which source/account/channel, how to reach it, the format the user`,
    `wants — because there is no separate profile or memory to lean on. The`,
    `reusable method/standards live INSIDE the task skill.`,
    ``,
    // (3) the one bar — three tests (V5)
    `── The one bar: would THIS user keep it and actually invoke it again? Three`,
    `tests, ALL must hold ──`,
    `(1) GAP: would the base model have STRUGGLED without this? A candidate marked`,
    `    struggle:y is your evidence (errors, backtracking, user correction). If`,
    `    the model already did it smoothly by default, there is NO gap → NOT a skill.`,
    `(2) TASK: is it a recognizable TASK a human would name and reach for — not an`,
    `    abstract principle?`,
    `(3) REUSE: would this specific user plausibly do it again?`,
    `Struggle (the GAP) is the PRIMARY signal. Repetition (seen Nx) only STRENGTHENS`,
    `a struggling candidate — it never qualifies a frictionless one alone.`,
    ``,
    // (4) what is NOT a skill (V4, V6 — negatives first)
    `── What is NOT a skill (pass-1 went wrong here — read carefully) ──`,
    `REJECT, do not propose:`,
    `• A cross-cutting DISCIPLINE that applies to ALL work, not one task — e.g.`,
    `  "always verify a change before saving", "read the schema before guessing",`,
    `  "prove which artifact is running". Good habits, but not tasks you invoke;`,
    `  they apply everywhere. DROP.`,
    `• APP-NAVIGATION / how-to-click-through-an-app / how-to-reach-a-state —`,
    `  brittle, tool-locked. DROP.`,
    `• A TRIVIAL task the model already nails. No gap → no skill.`,
    `• A one-off with NO struggle. DROP.`,
    `Contrastive examples (the DECISION, across professions — learn the boundary):`,
    `• "extract action items from a call transcript and file them" (recurred;`,
    `  model kept formatting wrong until corrected) → YES, task skill.`,
    `• "always double-check numbers before sending" → NO — a discipline, applies`,
    `  to everything.`,
    `• "click through Figma's export dialog" → NO — app-navigation.`,
    `• "summarize this article" (model nailed it first try) → NO — no gap.`,
    `• "pull my weekly sales figures from the dashboard and format them my way"`,
    `  (recurred; model kept fetching the wrong range) → YES, self-contained task`,
    `  skill.`,
    ``,
    // (5) group by domain (V3)
    `── GROUP BY DOMAIN — no slivers ──`,
    `Cluster candidates of the SAME kind of work into ONE skill, sub-methods as`,
    `sections of its body (three video-editing candidates → ONE video-editing`,
    `skill, not three). Separate only if genuinely unrelated. Prefer FEW`,
    `well-scoped skills over many thin ones.`,
    ``,
    // (6) naming (V7)
    `── Naming ──`,
    `Name each skill a concrete TASK/domain noun in kebab-case the way a human`,
    `would (extract-invoice, video-editing, mcp-connector-setup) — NEVER an`,
    `abstract coined phrase (not "verify-mutations-against-observed-state").`,
    `description = what it does AND when to use it, phrased to trigger on the`,
    `user's words.`,
    ``,
    // (7) candidates
    `── Candidates (accumulated across sessions; struggle:y = agent struggled) ──`,
    candidateLines,
    ``,
    // (8) existing curated index
    `── Existing curated skills (this curator's OWN library) ──`,
    curatedLines,
    `If a candidate OVERLAPS an existing skill, propose kind:"update" against that`,
    `skill (targetSkill + the FULL proposed new SKILL.md body) — NEVER a duplicate`,
    `skill, and NEVER a hand-written diff (the diff is computed deterministically`,
    `elsewhere from your body vs the file on disk).`,
    ``,
    // (9) rejections
    `── Previously rejected (never re-offer these or close variants) ──`,
    rejectionLines,
    ``,
    // (10) user feedback
    `── User feedback (first-class evidence for updates) ──`,
    feedbackLines,
    `Feedback on an existing skill is strong evidence to propose an update.`,
    ``,
    // (11) output contract
    `── Output contract ──`,
    `Write {"proposals":[…]} to ${i.outPath} atomically (write ${i.outPath}.tmp then rename).`,
    `Each proposal:`,
    `{"kind":"create"|"update",`,
    ` "draft":{"name":"kebab-case-task-noun","description":"what it does + when to use","body":"full SKILL.md body per template"},`,
    ` "changeSummary":["short plain-language bullet","…"],`,
    ` "evidence":{"occurrences":N,"sessions":[{"id":"…","intent":"…","at":"…","tracePointer":"…"}],`,
    `   "firstSeen":"…","lastSeen":"…","struggle":{"errors":N,"recoveries":N,"wallClockMin":N}},`,
    ` "rationale":"why this clears all three tests",`,
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
    // (12) SKILL.md body template (spec §5.1)
    `── SKILL.md body template (use these headings) ──`,
    `## Goal            — what the skill accomplishes`,
    `## When to use     — the trigger conditions`,
    `## Preconditions   — stable setup that must hold before starting`,
    `## Steps           — ordered steps by intent/label, no raw coordinates`,
    `## Verify          — how to know it worked (definition of done)`,
    `## Gotchas         — non-obvious traps discovered (optional)`,
    ``,
    // (13) closing posture
    `── Posture ──`,
    `FEW is the goal. Zero is a fine and common answer — write {"proposals":[]} if`,
    `nothing clears all three tests. A handful of skills a human would genuinely`,
    `keep beats a long list they'd wade through. When unsure, DON'T.`,
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

const VALID_KINDS = new Set<Proposal['kind']>(['create', 'narrow', 'split', 'merge', 'retire'])

/** Build this proposal's `draft` per its kind's rules, or return null to drop
 *  the row. `create` needs a fully-formed draft (valid name/description/body).
 *  `narrow`/`split`/`merge` write a full SKILL.md so need a non-empty body,
 *  but may omit name/description (defaulted from targetSkill / ''). `retire`
 *  carries no new body — a missing/empty `draft.body` is fine; a `draft`
 *  object is still returned (downstream code expects one) using targetSkill
 *  as a placeholder name. */
function buildDraft(kind: Proposal['kind'], e: Record<string, unknown>, targetSkill: string | undefined): ProposalDraft | null {
  const draftRaw = e.draft
  const d = (draftRaw && typeof draftRaw === 'object') ? draftRaw as Record<string, unknown> : null

  if (kind === 'create') {
    if (!d) return null
    if (typeof d.name !== 'string' || !NAME_RE.test(d.name)) return null
    if (!nonEmptyString(d.description)) return null
    if (!nonEmptyString(d.body)) return null
    return { name: d.name, description: d.description as string, body: d.body as string }
  }

  if (kind === 'narrow' || kind === 'split' || kind === 'merge') {
    if (!d) return null
    if (!nonEmptyString(d.body)) return null
    return {
      name: nonEmptyString(d.name) ? (d.name as string) : (targetSkill as string),
      description: nonEmptyString(d.description) ? (d.description as string) : '',
      body: d.body as string,
    }
  }

  // retire — draft.body is NOT required.
  return {
    name: (d && nonEmptyString(d.name)) ? (d.name as string) : (targetSkill as string),
    description: (d && nonEmptyString(d.description)) ? (d.description as string) : '',
    body: (d && nonEmptyString(d.body)) ? (d.body as string) : '',
  }
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

    // Only the 5 typed kinds are accepted from fresh model output. A raw
    // 'update' (or anything else unrecognized) is dropped here — the legacy
    // 'update'→'narrow' mapping is a curator-store.ts READ-boundary concern
    // for proposals already persisted to disk, not for the model's output.
    if (typeof e.kind !== 'string' || !VALID_KINDS.has(e.kind as Proposal['kind'])) continue
    const kind = e.kind as Proposal['kind']

    // narrow/split/merge/retire all rewrite or remove an EXISTING owned skill,
    // so all four require a targetSkill; create needs none (it has nothing to target).
    const targetSkill = nonEmptyString(e.targetSkill) ? (e.targetSkill as string) : undefined
    if (kind !== 'create' && !targetSkill) continue

    const draft = buildDraft(kind, e, targetSkill)
    if (!draft) continue

    const evidence = e.evidence
    if (!evidence || typeof evidence !== 'object') continue
    const ev = evidence as Record<string, unknown>
    if (typeof ev.occurrences !== 'number' || !Number.isFinite(ev.occurrences)) continue

    if (!nonEmptyString(e.rationale)) continue

    const index = out.length
    const prop: Proposal = {
      id: `prop_${ts}_${index}`,
      sweepId,
      proposedAt: new Date(ts).toISOString(),
      kind,
      draft,
      evidence: evidence as Proposal['evidence'],
      rationale: e.rationale as string,
      changeSummary: Array.isArray(e.changeSummary)
        ? e.changeSummary.filter(nonEmptyString)
        : [],
      resolution: null,
    }
    if (targetSkill) prop.targetSkill = targetSkill
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

// ── Match (Cadence A — semantic matcher) ────────────────────────────────────

/** A matcher's per-procedure verdict: which existing ledger entry (by `key`) a
 *  distilled procedure EXTENDS, or `null` for a new entry. */
export interface MatchDecision {
  procedureIndex: number
  matchedKey: string | null // null = a NEW ledger entry
  confidence: number // 0..1
  variedThisRun: string[] // per-run specifics to record as slots, not reasons to call it new
}

/** Build the matcher prompt: this sweep's distilled procedures + a per-procedure
 *  shortlist of candidate ledger entries → a match decision for each. Replaces
 *  brittle title-slug equality with an LLM judgment of "same repeatable core?" —
 *  this is what fuses the same pattern across differently-worded sessions. */
export function buildMatchPrompt(i: {
  procedures: DistillProcedure[]
  ledgerShortlist: Array<{ key: string; title: string; skeleton: string }>
  outPath: string
  devMode?: boolean
}): string {
  const procLines = i.procedures.length
    ? i.procedures
        .map((p, idx) => `[${idx}] "${p.title}"\n  skeleton: ${p.skeleton}`)
        .join('\n')
    : '(no procedures this sweep)'

  const shortlistLines = i.ledgerShortlist.length
    ? i.ledgerShortlist.map((s) => `- [${s.key}] "${s.title}"\n  skeleton: ${s.skeleton}`).join('\n')
    : '(ledger is empty — everything is new)'

  const lines = [
    `[Unmute curator — match] For EACH distilled procedure below, decide against`,
    `the SHORTLIST ONLY whether it EXTENDS an existing ledger entry (same`,
    `repeatable core) or is NEW.`,
    ``,
    `── Distilled procedures (this sweep) ──`,
    procLines,
    ``,
    `── Shortlist of existing ledger entries (candidates to match against) ──`,
    shortlistLines,
    ``,
    `── The match rule ──`,
    `Match on the REPEATABLE CORE — the underlying method/approach a procedure`,
    `captures. Treat differing PER-RUN SPECIFICS (a file path, a branch name, a`,
    `ticket id, an account, a date) as "variedThisRun" entries to RECORD, not as`,
    `reasons to call it a different pattern. Two procedures worded completely`,
    `differently are the SAME entry if they are the same repeatable core with`,
    `different specifics plugged in. If a procedure genuinely does not extend`,
    `anything on the shortlist, it is NEW: matchedKey:null.`,
    ``,
    `For each procedure, reference the shortlist entry it extends by its "key"`,
    `(never invent a key that isn't on the shortlist), or use null for new.`,
    ``,
    `── Output contract ──`,
    `Reply ONLY by writing JSON to ${i.outPath} atomically (write ${i.outPath}.tmp`,
    `then rename):`,
    `{"matches":[{"procedureIndex":N,"matchedKey":"<key>"|null,"confidence":0.0-1.0,"variedThisRun":["…"]}]}`,
    `Nothing to match → {"matches":[]}. Do nothing else — no other tools than the file write.`,
  ]
  if (i.devMode) {
    lines.push(
      ``,
      `[developer diagnostics] ALSO add a top-level "reasoning" string to that same`,
      `JSON object: explain your match/no-match call for each procedure. This`,
      `field is for a developer inspecting the run; it does not affect any decision.`,
      `Shape: {"matches":[…], "reasoning":"…"}.`,
    )
  }
  return lines.join('\n')
}

/** Parse the matcher output file. [] on null/malformed/`matches` not array. Per
 *  row: requires numeric procedureIndex; matchedKey must be a non-empty string OR
 *  null (else the row is dropped); confidence coerced to a finite number
 *  (default 0); variedThisRun defaults to [], keeping only string elements. */
export function parseMatchOutput(raw: string | null): MatchDecision[] {
  if (raw == null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const matches = (parsed as { matches?: unknown } | null)?.matches
  if (!Array.isArray(matches)) return []
  const out: MatchDecision[] = []
  for (const m of matches) {
    if (!m || typeof m !== 'object') continue
    const e = m as Record<string, unknown>
    if (typeof e.procedureIndex !== 'number' || !Number.isFinite(e.procedureIndex)) continue
    let matchedKey: string | null
    if (e.matchedKey === null) {
      matchedKey = null
    } else if (typeof e.matchedKey === 'string' && e.matchedKey.trim() !== '') {
      matchedKey = e.matchedKey
    } else {
      continue
    }
    const confidence = typeof e.confidence === 'number' && Number.isFinite(e.confidence) ? e.confidence : 0
    const variedThisRun = Array.isArray(e.variedThisRun) ? e.variedThisRun.filter((v): v is string => typeof v === 'string') : []
    out.push({ procedureIndex: e.procedureIndex, matchedKey, confidence, variedThisRun })
  }
  return out
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
