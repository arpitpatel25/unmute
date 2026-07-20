// Skill Curator — prompt builders and validating output parsers.
//
// Pure module: builds the exact one-shot prompts the distill and synthesize
// sessions receive, and parses/validates the JSON files they write back. No fs,
// no LLM, no side effects. The prompts implement Curator Operating Theory v2
// (spec §15, V1–V9): selection is driven by observed STRUGGLE (the free
// capability-gap proxy), skills are task/domain units grouped by domain, and
// cross-cutting disciplines / app-navigation are excluded.

import type { DistillProcedure, Candidate, Proposal, ProposalDraft } from './curator-store.ts'
import { entryStatus, distinctSessionCount } from './curator-store'

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

/** Render one ledger candidate as the evidence block the judge weighs: distinct-
 *  session count (the Door-2 floor input), lifecycle status, struggle, and — when
 *  present — variance (hardcode-vs-slot), the Door-1 priorScore/rationale, and the
 *  accumulated divergenceLog (what fires narrow/refine). Optional fields render
 *  only when set, keeping the prompt lean for the common bare candidate. */
function renderCandidate(c: Candidate): string {
  const sessions = distinctSessionCount(c)
  const head =
    `- [${c.key}] "${c.title}" — seen ${c.total}x across ${sessions} distinct session(s) (${c.firstSeen}→${c.lastSeen})` +
    `; struggle:${c.struggle ? 'y' : 'n'}; status:${entryStatus(c)}` +
    (typeof c.priorScore === 'number' ? `; priorScore:${c.priorScore}` : '')
  const parts = [head, `  skeleton: ${c.skeleton}`]
  if (c.priorRationale) parts.push(`  priorRationale: ${c.priorRationale}`)
  if (c.variance) {
    const constant = c.variance.constant.length ? c.variance.constant.join('; ') : '(none observed yet)'
    const varying = c.variance.varying.length ? c.variance.varying.join('; ') : '(none observed yet)'
    parts.push(`  variance — constant (bake into body): ${constant}`)
    parts.push(`  variance — changes run-to-run (slot candidates): ${varying}`)
  }
  if (c.divergenceLog && c.divergenceLog.length) {
    const summary = c.divergenceLog.map((d) => `${d.verdict}: ${d.note}`).join(' | ')
    parts.push(`  divergenceLog (${c.divergenceLog.length}): ${summary}`)
  }
  return parts.join('\n')
}

/** Build the Cadence-B judge prompt: the durable ledger + the existing skills →
 *  TYPED proposals (create for graduation; narrow/split/merge/retire for
 *  gardening). Encodes the two-door selection philosophy LITERALLY (spec §2/§6,
 *  Global Constraints 2–6) — those exact sentences are asserted by
 *  curator-prompts.test.ts as the guard against prompt drift. Kept named
 *  `buildSynthesizePrompt` (curator.ts imports it) with a backward-compatible
 *  input shape. */
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
    ? i.candidates.map(renderCandidate).join('\n')
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
    `[Unmute curator — judge] Sweep ${i.sweepId}. You are the periodic judge. You`,
    `read the durable pattern ledger below + the skills that already exist, and you`,
    `emit a SMALL number of TYPED proposals for THIS specific user. Proposals only`,
    `— a human reviews every one; nothing is applied automatically.`,
    ``,
    // (2) what a skill is (self-contained; hardcode-vs-slot; independence)
    `── What a skill IS ──`,
    `A skill is a reusable capability for a task the user does — named the way the`,
    `user would name it (extract-invoice, edit-talking-head-video,`,
    `setup-mcp-connector). It is SELF-CONTAINED: the reusable method lives INSIDE`,
    `it; there is no separate profile or memory to lean on.`,
    `Hardcode-vs-slot rule: bake the specifics that are STABLE for this user`,
    `(which source/account/channel, the format they want, the standing approach)`,
    `directly into the body; only values that CHANGE from run to run become slots.`,
    `Secrets are referenced from env/keychain, never baked into the body.`,
    `Skills are independent — no cross-skill facts store, no shared memory a skill`,
    `reads from. The ONLY cross-skill relation is parent→child composition (a skill`,
    `may invoke a smaller child skill).`,
    ``,
    // (3) TWO DOORS (Constraint 3 + 2)
    `── The two doors: how a candidate earns a proposal ──`,
    `A candidate becomes a skill through EITHER door — they are independent:`,
    ``,
    `DOOR 1 — strong prior. Propose a skill from even a SINGLE sighting if it`,
    `passes this test:`,
    `  "If this never happens again, would a human still be glad this skill exists?"`,
    `If yes (e.g. a rare-but-brutal task like filing quarterly taxes: frequency ≈ 1,`,
    `huge cost to re-derive, obviously worth keeping), that single sighting is`,
    `enough — graduate it via Door 1.`,
    ``,
    `DOOR 2 — observed recurrence. A repeatable CORE seen across sessions and`,
    `judged significant + stable. THE ≥2 RULE: a Door-2 (recurrence) skill requires`,
    `the pattern in at least 2 distinct sessions (read "distinct session(s)" on`,
    `each candidate). Door 1 may graduate on 1; Door 2 may NOT — recurrence means`,
    `two. If a candidate has <2 distinct sessions and does NOT pass Door 1, DON'T`,
    `propose it yet — leave it watched.`,
    ``,
    // (4) struggle is one input, not the gate (Constraint 4)
    `── What governs: expected future value, not frequency ──`,
    `Struggle is one input, not the gate. A struggle:y candidate is evidence the`,
    `base model had a capability GAP, but selection is governed by EXPECTED FUTURE`,
    `VALUE ≈ P(this kind of work recurs) × cost-of-re-deriving × stability-of-the-`,
    `path — NOT by frequency or struggle alone. A smooth, high-value, recurring`,
    `task can still be a skill; a struggle-heavy one-off with no future value is`,
    `not.`,
    ``,
    // (5) FEW is the goal; exclusions (Constraint 4/spec §2)
    `── FEW is the goal ──`,
    `FEW is the goal. A handful of skills a human would genuinely keep beats a long`,
    `list they'd wade through. Exclude:`,
    `• Cross-cutting DISCIPLINES that apply to ALL work, not one task — "always`,
    `  verify before saving", "read the schema before guessing". These are good`,
    `  habits, not tasks you invoke — there is no cross-cutting "skill". DROP.`,
    `• INCIDENTAL app-navigation — how-to-click-through-an-app / how-to-reach-a-`,
    `  state. Brittle, tool-locked. DROP.`,
    `BUT a recurring cross-app TASK is fine and IS a skill — e.g. "each morning`,
    `sweep my Gmail accounts → fetch X → drop into a Google Doc". The difference is`,
    `a named, repeatable task vs. incidental clicking.`,
    ``,
    // (6) naming
    `── Naming ──`,
    `Name each skill a concrete task/domain noun in kebab-case the way a human`,
    `would (extract-invoice, video-editing, mcp-connector-setup) — NEVER an`,
    `abstract coined phrase (not "verify-mutations-against-observed-state").`,
    `description = what it does AND when to use it, phrased to trigger on the`,
    `user's words.`,
    ``,
    // (7) the ledger candidates
    `── Pattern ledger (accumulated across sessions) ──`,
    `Each entry shows: distinct-session count (the Door-2 floor input), status,`,
    `struggle, and — when known — priorScore (a Door-1 judgment), variance`,
    `(constant vs run-to-run), and a divergenceLog (agree/diverge observations`,
    `against a skill this pattern already owns).`,
    candidateLines,
    ``,
    // (8) existing curated skills + gardening verbs
    `── Existing skills (this curator's OWN library) ──`,
    curatedLines,
    `When the ledger shows an existing skill needs tending, propose the right`,
    `GARDENING verb against it (targetSkill = its name) instead of a duplicate:`,
    `• narrow — the divergenceLog shows the user reliably does only a SUBSET of`,
    `  what the skill says; tighten it to that stable core. (Also use narrow to`,
    `  fold an accumulated correction / add a learning into the body.)`,
    `• split — one skill is really two distinct sub-patterns; break it in two.`,
    `• merge — two skills heavily overlap / co-occur; fold them into one.`,
    `• retire — a skill is dead: unused across enough time/observation to drop.`,
    `A SINGLE divergence never modifies a skill — act only on divergence that has`,
    `ACCUMULATED in the same direction across sessions (the divergenceLog carries`,
    `it). If nothing has accumulated, leave the skill alone.`,
    ``,
    // (9) rejections
    `── Previously rejected (never re-offer these or close variants) ──`,
    rejectionLines,
    ``,
    // (10) feedback
    `── User feedback (first-class evidence for gardening) ──`,
    feedbackLines,
    `Feedback on an existing skill is strong evidence to propose a narrow/refine.`,
    ``,
    // (11) typed output contract (Constraint 7)
    `── Output contract (TYPED proposals) ──`,
    `Write {"proposals":[…]} to ${i.outPath} atomically (write ${i.outPath}.tmp then rename).`,
    `"kind" is exactly one of: create, narrow, split, merge, retire.`,
    `• create → a full new skill. Carries draft{name,description,body}. No targetSkill.`,
    `• narrow / split / merge → rewrite an existing skill. Carries targetSkill AND`,
    `  the COMPLETE new SKILL.md body in draft.body (the full replacement text, NOT`,
    `  a diff). Never emit a "diff" field — the raw diff is computed`,
    `  deterministically from your body vs the file on disk.`,
    `• retire → remove an existing skill. Carries targetSkill + rationale, NO body.`,
    `Each proposal:`,
    `{"kind":"create"|"narrow"|"split"|"merge"|"retire",`,
    ` "draft":{"name":"kebab-case-task-noun","description":"what it does + when to use","body":"full SKILL.md body per template"},`,
    ` "changeSummary":["short plain-language bullet","…"],`,
    ` "evidence":{"occurrences":N,"sessions":[{"id":"…","intent":"…","at":"…","tracePointer":"…"}],`,
    `   "firstSeen":"…","lastSeen":"…","struggle":{"errors":N,"recoveries":N,"wallClockMin":N}},`,
    ` "rationale":"which door (or gardening reason) this clears, and why",`,
    ` "targetSkill":"…"?, "triggeringEvidence":["…"]?, "affectedSessions":[{"id":"…","invokedAt":"…"}]?}`,
    `targetSkill is REQUIRED for narrow/split/merge/retire and omitted for create.`,
    ``,
    `"changeSummary" is 2-5 short plain-language bullet strings for a HUMAN`,
    `reviewer (no markdown, plain sentences). For a create: what the skill does +`,
    `which door it cleared. For a gardening verb: what is changing and why`,
    `(e.g. ["Narrows pr-review to the lockfile-check the user always does",`,
    `"Retires stale-export — unused across the last N sweeps"]).`,
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
    `nothing clears a door and nothing needs gardening. Precision over recall: a`,
    `missed skill is cheaper than an annoying one. When unsure, DON'T.`,
  ]
  if (i.devMode) {
    lines.push(
      ``,
      `── Developer diagnostics (dev-only) ──`,
      `ALSO add a top-level "reasoning" string to the output JSON`,
      `({"proposals":[…], "reasoning":"…"}). In it, cover EVERY candidate you saw`,
      `and why you PROPOSED (which door) / GARDENED / NO-OP'd / REJECTED each. This`,
      `is for a developer inspecting the run; it never affects the decision.`,
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
