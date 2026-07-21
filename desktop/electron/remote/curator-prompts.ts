// Skill Curator — prompt builders and validating output parsers.
//
// Pure module: builds the exact one-shot prompts the distill and synthesize
// sessions receive, and parses/validates the JSON files they write back. No fs,
// no LLM, no side effects. The distill prompt implements the USER-SIDE selection
// model (spec §0 A/B/D/G): the user's turns are the index, a finding is an
// actionable intent + the reusable context the user supplied for it, and the
// struggle signal is the user's corrections — never the model's errors.

import type { DistillProcedure, Candidate, Proposal, ProposalDraft, ProposalEvidence, AuditResult } from './curator-store.ts'
import { entryStatus, distinctSessionCount } from './curator-store'

// ── Distill ────────────────────────────────────────────────────────────────

/** Build the distill prompt: one work session's reduced trace → USER-SIDE
 *  findings. The user's turns are the index (spec §0 A/B/D/G); each finding is an
 *  actionable intent + the reusable context the user supplied for it, with the
 *  user's corrections as the (bonus) struggle signal. devMode (DEV-ONLY, default
 *  false) asks the model to ALSO emit a top-level `reasoning` string for developer
 *  diagnostics. Production (devMode false) pays zero extra tokens. */
export function buildDistillPrompt(i: {
  taskId: string
  intent: string
  tracePath: string
  outPath: string
  curatedSkills: Array<{ name: string; description: string }>
  devMode?: boolean
}): string {
  const curated = i.curatedSkills.length
    ? i.curatedSkills.map((s) => `- ${s.name} — ${s.description}`).join('\n')
    : '(none)'
  const lines = [
    `[Unmute curator — distill] You are analyzing ONE work session's reduced trace`,
    `to find work the USER will predictably ask for again.`,
    `Read the trace file at ${i.tracePath} (use the Read tool; read it fully, in chunks if large).`,
    `Session intent: "${i.intent}"`,
    ``,
    `── How to read the session ──`,
    `Read the USER's turns as the INDEX. A skill lives on the USER's side of the`,
    `conversation — it is a thing the user keeps asking for. So work from the`,
    `user's messages: read the model's transcript ONLY where a user message points`,
    `to it (the intent it served, or the action a correction refers to). NEVER`,
    `open-scan the model's output for interesting things it did — that is the wrong`,
    `anchor and the main source of noise.`,
    ``,
    `── What to extract, per finding ──`,
    `For each actionable INTENT the user expressed, capture the REUSABLE CONTEXT the`,
    `user supplied to get it done — where to look, what to fetch, which tool, which`,
    `account/location, how they like it: the stuff they would otherwise have to`,
    `re-type next time. That supplied context IS the skill's value.`,
    `- intent: the actionable task the user asked for, in the user's own words.`,
    `- contextSupplied: the reusable context/preferences the user gave, as an array`,
    `  of short strings. This is the payload a future skill would bake in.`,
    `- correction: if the user had to CORRECT the model — "no, do it this way", "why`,
    `  did you use the desktop app" — capture that correction. It reveals HOW the`,
    `  user wants it and the gap a skill should close. The struggle signal is the`,
    `  USER's corrections, NOT the model's errors or backtracks. Omit when none.`,
    `- bodySketch: a short sketch of how it was actually done, drawn ONLY from the`,
    `  part of the model transcript the user pointed at.`,
    ``,
    `── The entry test (apply it strictly) ──`,
    `Emit a finding ONLY when BOTH hold, judged from the user's messages: (1) there`,
    `is an actionable INTENT (a task, not discussion) AND (2) the user supplied`,
    `REUSABLE CONTEXT for it. If either is missing, emit nothing for it. A`,
    `discussion-only session — questions, opinions, no task with supplied context —`,
    `emits NOTHING. That empty result is the NORMAL case, not a failure.`,
    ``,
    `── Personal, not general ──`,
    `Capture THIS user's specifics — their locations, tools, accounts, preferences.`,
    `Do NOT genericize the context away; the whole value is context-elimination for`,
    `this user.`,
    ``,
    `Do NOT report app-navigation / UI click-paths / how-to-reach-a-state-in-an-app`,
    `(brittle, tool-locked); raw coordinates / pixels / tab-ids / one-off values.`,
    ``,
    `The user's skills already in their library (name — description):`,
    curated,
    `If the trace shows one being INVOKED, report what happened AROUND the`,
    `invocation (extra steps appended, corrections, failure) as usedCuratedSkill.`,
    ``,
    `Reply ONLY by writing JSON to ${i.outPath} (write ${i.outPath}.tmp then rename):`,
    `{"findings":[{"intent":"…","contextSupplied":["…"],"correction":"…"?,"bodySketch":"…",`,
    `  "usedCuratedSkill":{"name":"…","friction":"…"}?}]}`,
    `No actionable intent with supplied context → {"findings":[]}. Do nothing else — no other tools than Read and the file write.`,
  ]
  if (i.devMode) {
    lines.push(
      ``,
      `[developer diagnostics] ALSO add a top-level "reasoning" string to that same`,
      `JSON object: explain what you considered and, importantly, what you EXCLUDED`,
      `— especially WHY a discussion or a contextless intent produced no finding.`,
      `This field is for a developer inspecting the run; it does not affect any`,
      `decision. Shape: {"findings":[…], "reasoning":"…"}.`,
    )
  }
  return lines.join('\n')
}

/** Parse the distill output file. [] on null/malformed. Maps each `findings`
 *  entry to a DistillProcedure, populating the primary user-side fields (intent,
 *  contextSupplied, correction, bodySketch) AND the compat fields (title=intent,
 *  skeleton=bodySketch, struggle=!!correction). Enforces the entry test: a finding
 *  lacking an actionable intent, or with no reusable context supplied, is DROPPED. */
export function parseDistillOutput(raw: string | null): DistillProcedure[] {
  if (raw == null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const findings = (parsed as { findings?: unknown } | null)?.findings
  if (!Array.isArray(findings)) return []
  const out: DistillProcedure[] = []
  for (const p of findings) {
    if (!p || typeof p !== 'object') continue
    const e = p as Record<string, unknown>
    // Entry test (spec §0 B): actionable intent AND ≥1 reusable context item.
    if (typeof e.intent !== 'string' || e.intent.trim() === '') continue
    const contextSupplied = Array.isArray(e.contextSupplied)
      ? e.contextSupplied.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      : []
    if (contextSupplied.length === 0) continue
    const bodySketch = typeof e.bodySketch === 'string' ? e.bodySketch : ''
    // Struggle relocated to the user side (spec §0 D): a correction, never model errors.
    const correction = typeof e.correction === 'string' && e.correction.trim() !== '' ? e.correction : undefined
    const proc: DistillProcedure = {
      intent: e.intent,
      contextSupplied,
      bodySketch,
      // Compat fields for downstream consumers (later tasks re-aim them).
      title: e.intent,
      skeleton: bodySketch,
      count: typeof e.count === 'number' && Number.isFinite(e.count) ? e.count : 1,
      struggle: correction !== undefined,
    }
    if (correction !== undefined) proc.correction = correction
    const used = e.usedCuratedSkill
    if (used && typeof used === 'object') {
      const u = used as Record<string, unknown>
      if (typeof u.name === 'string' && typeof u.friction === 'string') {
        proc.usedCuratedSkill = { name: u.name, friction: u.friction }
      }
    }
    // (The agree/diverge modification signal is produced by the focused
    //  skill-usage-audit pass — see buildAuditPrompt / parseAuditOutput and spec
    //  §0 E — not here. Distill only extracts new-work findings.)
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

// ── Audit (Cadence A — skill-usage audit, spec §0 E) ─────────────────────────

/** Build the skill-usage audit prompt (spec §0 E, Cadence A mode 2). Runs ONLY
 *  when a skill was actually invoked in the session (detected deterministically
 *  via skill-usage.extractSkillUses). For each invoked skill it asks a single
 *  focused question: reading the trace AROUND the invocation, did the skill
 *  FINISH the user's job, or leave the user at some stage so they hand-drove the
 *  rest? The verdict is ok/extend/wrong. This is the agree/diverge modification
 *  signal, RELOCATED out of distill into its own pass. devMode (DEV-ONLY, default
 *  false) additionally asks for a top-level `reasoning` string (Task 1 convention;
 *  dev-logged only, never fed into a decision). */
export function buildAuditPrompt(i: {
  skillsInvoked: string[]
  tracePath: string
  outPath: string
  devMode?: boolean
}): string {
  const invoked = i.skillsInvoked.length
    ? i.skillsInvoked.map((s) => `- ${s}`).join('\n')
    : '(none)'
  const lines = [
    `[Unmute curator — skill-usage audit] One or more of the user's OWN skills was`,
    `INVOKED in this session. For EACH invoked skill below, judge whether it did`,
    `the user's job or fell short.`,
    `Read the trace file at ${i.tracePath} (use the Read tool; read it fully, in chunks if large).`,
    ``,
    `── Skills invoked this session ──`,
    invoked,
    ``,
    `── The audit question (per invoked skill) ──`,
    `Read the trace AROUND the invocation — what the user asked for, what the skill`,
    `did, and what happened after. Then decide: did the skill FINISH THE JOB, or did`,
    `it leave the user at some STAGE X so they had to HAND-DRIVE THE REST (add steps,`,
    `correct it, or the outcome wasn't what they wanted)?`,
    ``,
    `── Verdicts (choose exactly one per skill) ──`,
    `- "ok"     — the skill DID THE JOB: it completed the user's goal, no material`,
    `             hand-driving afterward.`,
    `- "extend" — it got the user only PARTWAY: it fell SHORT of the goal and the`,
    `             user had to add MORE steps to finish. The skill needs extending.`,
    `- "wrong"  — it did the WRONG THING or the user REJECTED / reverted its output.`,
    `In "note", say concretely what happened — for extend, the STAGE it stopped at`,
    `and what the user did next; for wrong, what was wrong or how the user rejected it.`,
    ``,
    `Only audit skills that were actually invoked (listed above). Skip a skill you`,
    `cannot find evidence for rather than guessing.`,
    ``,
    `Reply ONLY by writing JSON to ${i.outPath} (write ${i.outPath}.tmp then rename):`,
    `{"audits":[{"skill":"<invoked skill name>","verdict":"ok"|"extend"|"wrong","note":"…"}]}`,
    `Nothing to report → {"audits":[]}. Do nothing else — no other tools than Read and the file write.`,
  ]
  if (i.devMode) {
    lines.push(
      ``,
      `[developer diagnostics] ALSO add a top-level "reasoning" string to that same`,
      `JSON object: explain, per skill, WHY you landed on ok/extend/wrong. This field`,
      `is for a developer inspecting the run; it does not affect any decision.`,
      `Shape: {"audits":[…], "reasoning":"…"}.`,
    )
  }
  return lines.join('\n')
}

const AUDIT_VERDICTS = new Set<AuditResult['verdict']>(['ok', 'extend', 'wrong'])

/** Parse the audit output file. [] on null/malformed/`audits` not array. Per row:
 *  requires a non-empty `skill`, a verdict in {ok,extend,wrong}, and a string
 *  `note`; any row failing these is DROPPED (defensive, like the other parsers).
 *  Only the three contract fields are copied through — a stray `reasoning`/`reason`
 *  the model may attach to a row can never leak onto an AuditResult. */
export function parseAuditOutput(raw: string | null): AuditResult[] {
  if (raw == null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const audits = (parsed as { audits?: unknown } | null)?.audits
  if (!Array.isArray(audits)) return []
  const out: AuditResult[] = []
  for (const a of audits) {
    if (!a || typeof a !== 'object') continue
    const e = a as Record<string, unknown>
    if (typeof e.skill !== 'string' || e.skill.trim() === '') continue
    if (typeof e.verdict !== 'string' || !AUDIT_VERDICTS.has(e.verdict as AuditResult['verdict'])) continue
    if (typeof e.note !== 'string') continue
    out.push({ skill: e.skill, verdict: e.verdict as AuditResult['verdict'], note: e.note })
  }
  return out
}

/** DEV-ONLY: capture the top-level `reasoning` string the devMode audit prompt
 *  asks for. Returns undefined on null/malformed/absent. Separate read (not folded
 *  into parseAuditOutput) so the decision path is unchanged; the sweep only LOGS
 *  this — it never feeds a decision. Same convention as the other three stages. */
export function parseAuditReasoning(raw: string | null): string | undefined {
  return topLevelReasoning(raw)
}

// ── Synthesize ───────────────────────────────────────────────────────────────

/** Render one ledger SUSPICION as the user-side evidence block the judge weighs
 *  (spec §0 A/B/D): the user's actionable intent, the reusable context they
 *  supplied, the distinct-session count (the Door-2 recurrence input), lifecycle
 *  status, and — when present — the user correction (shapes HOW the skill reads,
 *  never a graduation reason), variance (hardcode-vs-slot), priorRationale, and
 *  the accumulated divergenceLog (what, with the audit signals, fires
 *  narrow/refine). Intent falls back to the legacy title only when a suspicion
 *  predates the user-side fields. Optional fields render only when set. */
function renderCandidate(c: Candidate): string {
  const sessions = distinctSessionCount(c)
  const intent = c.intent && c.intent.trim() !== '' ? c.intent : c.title
  const head =
    `- [${c.key}] intent: "${intent}" — recurred in ${sessions} distinct session(s)` +
    ` (${c.total} total sighting(s), ${c.firstSeen}→${c.lastSeen}); status:${entryStatus(c)}` +
    (typeof c.priorScore === 'number' ? `; priorScore:${c.priorScore}` : '')
  const ctx = c.contextSupplied && c.contextSupplied.length
    ? c.contextSupplied.join('; ')
    : '(none captured yet)'
  const parts = [head, `  reusable context the user supplied (the skill's payload): ${ctx}`]
  if (c.correction) parts.push(`  user correction (shapes HOW they want it — NOT a graduation reason): ${c.correction}`)
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

/** Build the Cadence-B UNIFIED JUDGE prompt (spec §0 C/E/G): the accumulated
 *  ledger of suspicions + the skill-usage audit signals + the existing skill set
 *  → TYPED proposals (create for graduation; narrow/split/merge/retire for
 *  gardening). Graduation is on VALUE judged from the USER's side — recurrence
 *  (≥2 distinct sessions) OR a predictable-recurrence prior — and EXPLICITLY not
 *  difficulty/struggle. Audit `extend` → narrow/refine, `wrong` → flag,
 *  dead → retire. These exact sentences are asserted by curator-prompts.test.ts
 *  as the guard against prompt drift. Kept named `buildSynthesizePrompt`
 *  (curator.ts imports it). `auditSignals` defaults to [] (Task 7 populates it). */
export function buildSynthesizePrompt(i: {
  sweepId: string
  candidates: Candidate[]
  // Each owned skill's body is carried too (the sweep diffs against it, D19); the
  // listing below stays name+description to keep the prompt lean.
  curatedIndex: Array<{ name: string; description: string; body: string }>
  // Cadence-A skill-usage audit output for this sweep (spec §0 E). Default [] —
  // most sweeps invoked no skill; Task 7 wires the populated value in.
  auditSignals?: AuditResult[]
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

  const auditSignals = i.auditSignals ?? []
  const auditLines = auditSignals.length
    ? auditSignals.map((a) => `- ${a.skill}: ${a.verdict} — ${a.note}`).join('\n')
    : '(no skill-usage audit signals this sweep)'

  const rejectionLines = i.rejections.length
    ? i.rejections.map((r) => `- ${r.name}${r.reason ? ` — ${r.reason}` : ''}`).join('\n')
    : '(none)'

  const feedbackLines = i.feedback.length
    ? i.feedback.map((f) => `- ${f.skill}: ${f.note}`).join('\n')
    : '(none)'

  const lines = [
    // (1) role
    `[Unmute curator — judge] Sweep ${i.sweepId}. You are the periodic UNIFIED`,
    `judge. You read the durable ledger of SUSPICIONS below + the skill-usage audit`,
    `signals + the skills that already exist, and you emit a SMALL number of TYPED`,
    `proposals for THIS specific user. Proposals only — a human reviews every one;`,
    `nothing is applied automatically.`,
    ``,
    // (2) what a skill is — value = context-elimination; personal, not general.
    `── What a skill IS, and where its value comes from ──`,
    `A skill is a reusable capability for a job THIS user keeps asking for — named`,
    `the way the user would name it (extract-invoice, edit-talking-head-video,`,
    `sweep-gmail-into-doc). Its whole value is CONTEXT-ELIMINATION for this user: it`,
    `bakes in WHERE to look and HOW they like it — their sources, accounts, tools,`,
    `format, standing preferences — phrased as the user's own recurring intent, so`,
    `they never have to re-supply that context. These skills are PERSONAL, not`,
    `general: do NOT genericize the user's specifics away; the specifics ARE the`,
    `value.`,
    `It is SELF-CONTAINED: the reusable method lives INSIDE it; there is no separate`,
    `profile or memory to lean on. Hardcode-vs-slot: bake the specifics that are`,
    `STABLE for this user directly into the body; only values that CHANGE from run`,
    `to run become slots. Secrets are referenced from env/keychain, never baked in.`,
    `Skills are independent — no cross-skill facts store, no shared memory. The only`,
    `cross-skill relation is parent→child composition (a skill may invoke a smaller`,
    `child skill).`,
    ``,
    // (3) TWO DOORS — value from the user's side, never difficulty (spec §0 C).
    `── When a suspicion GRADUATES to a "create" — VALUE, from the user's side ──`,
    `Graduation is judged ONLY on value to THIS user: will they keep asking for`,
    `this? A suspicion earns a create through EITHER door — they are independent:`,
    ``,
    `DOOR 2 — it RECURRED. The SAME intent + the SAME supplied context has now been`,
    `seen in at least 2 distinct sessions (read the distinct-session count on each`,
    `suspicion below). Recurrence means two distinct sessions — a single sighting`,
    `is not recurrence.`,
    ``,
    `DOOR 1 — a PREDICTABLE-RECURRENCE PRIOR. Even from a single sighting, this is`,
    `plainly a job the user will keep asking for: it has a recurring-workflow shape`,
    `— a weekly / on-call / seasonal / every-release / every-morning routine. When`,
    `the intent is obviously periodic like that, graduate it via Door 1 without`,
    `waiting for the second sighting.`,
    ``,
    // (4) difficulty is EXPLICITLY not a graduation reason (spec §0 C/D).
    `── Difficulty is NOT a door ──`,
    `Difficulty is not the test. "Was it hard", "did the model struggle", how long`,
    `it took, or whether the work was fiddly are NOT reasons to graduate and never`,
    `were. A brutal one-off the user will never repeat is NOT a skill; a trivially`,
    `easy chore they do every morning IS. Judge value from the USER's side (will`,
    `they ask for this again), never from how hard the work was to do. A recorded`,
    `user correction only shapes HOW the skill should read — it never graduates`,
    `anything by itself.`,
    ``,
    // (5) FEW is the goal; exclusions (spec §2).
    `── FEW is the goal ──`,
    `FEW is the goal. A handful of skills the user would genuinely keep beats a long`,
    `list they'd wade through. Exclude:`,
    `• Cross-cutting DISCIPLINES that apply to ALL work, not one job — "always`,
    `  verify before saving", "read the schema before guessing". Good habits, not`,
    `  things you invoke. DROP.`,
    `• INCIDENTAL app-navigation — how-to-click-through-an-app / how-to-reach-a-`,
    `  state. Brittle, tool-locked. DROP.`,
    `BUT a recurring cross-app job IS a skill — e.g. "each morning sweep my Gmail`,
    `accounts → fetch X → drop into a Google Doc". The difference is a named,`,
    `repeatable job vs. incidental clicking.`,
    ``,
    // (6) naming + attaching meaning (when-to-use).
    `── Naming + attaching meaning ──`,
    `Name each skill a concrete job/domain noun in kebab-case the way a human would`,
    `(extract-invoice, video-editing, sweep-gmail-into-doc) — NEVER an abstract`,
    `coined phrase (not "verify-mutations-against-observed-state"). Write`,
    `description = what it does AND WHEN TO USE it, phrased in the user's own words`,
    `so THEY recognize when to invoke it. Every proposal must attach this meaning:`,
    `the when-to-use is how the user finds the skill later.`,
    ``,
    // (7) the ledger suspicions (rendered user-side).
    `── Pattern ledger — SUSPICIONS accumulated across sessions ──`,
    `Each suspicion shows: the user's actionable intent, the reusable context they`,
    `supplied, the distinct-session count (the Door-2 recurrence input), status,`,
    `and — when present — a user correction (shapes HOW the skill reads, never a`,
    `graduation reason), variance (constant vs run-to-run), and a divergenceLog.`,
    candidateLines,
    ``,
    // (8) audit signals drive modification (spec §0 E).
    `── Skill-usage audit signals (sessions where the user invoked one of their`,
    `   OWN skills this sweep) ──`,
    auditLines,
    `Turn these into gardening proposals against the named skill (targetSkill = it):`,
    `• "extend" — the skill got the user only PARTWAY and they hand-drove the rest.`,
    `  Propose a narrow/refine that tightens or extends that skill toward what`,
    `  ACTUALLY finished the job.`,
    `• "wrong"  — the skill did the wrong thing / the user rejected its output.`,
    `  FLAG it: a narrow/refine that corrects it, or a retire if it is beyond saving.`,
    `• "ok"     — it did the job; leave it alone.`,
    `Also retire any skill that has gone dead — unused across enough time/observation.`,
    ``,
    // (9) existing skills — DEDUP + gardening verbs.
    `── Existing skills — DEDUP against these (the user's global library + project`,
    `   skills) ──`,
    curatedLines,
    `Before proposing any create, DEDUP against every skill above. If one already`,
    `covers this intent, do NOT propose a duplicate — instead propose the right`,
    `GARDENING verb against it (targetSkill = its name), or nothing:`,
    `• narrow — the divergenceLog / audit shows the user reliably does only a`,
    `  SUBSET of what the skill says; tighten it to that stable core. (Also use`,
    `  narrow to fold an accumulated correction / add a learning into the body.)`,
    `• split — one skill is really two distinct sub-patterns; break it in two.`,
    `• merge — two skills heavily overlap / co-occur; fold them into one.`,
    `• retire — a skill is dead: unused across enough time/observation to drop.`,
    `A SINGLE divergence never modifies a skill — act only on divergence that has`,
    `ACCUMULATED in the same direction across sessions (the divergenceLog and the`,
    `audit signals carry it). If nothing has accumulated, leave the skill alone.`,
    `Concretely: a "narrow" requires the user to have done it differently`,
    `REPEATEDLY — at least twice — in the SAME way. A single divergence is NOT`,
    `enough: it may be legitimate per-run variation, not a durable change.`,
    ``,
    // (10) rejections
    `── Previously rejected (never re-offer these or close variants) ──`,
    rejectionLines,
    ``,
    // (11) feedback
    `── User feedback (first-class evidence for gardening) ──`,
    feedbackLines,
    `Feedback on an existing skill is strong evidence to propose a narrow/refine.`,
    ``,
    // (12) typed output contract
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
    ` "sourceKeys":["<ledger key>","…"],`,
    ` "targetSkill":"…"?, "triggeringEvidence":["…"]?, "affectedSessions":[{"id":"…","invokedAt":"…"}]?}`,
    `targetSkill is REQUIRED for narrow/split/merge/retire and omitted for create.`,
    `"sourceKeys" lists the ledger candidate keys this proposal drew from — copy the`,
    `[key] shown in square brackets on each Pattern-ledger entry above. This links`,
    `the proposal back to the pattern(s) it graduates so their lifecycle advances.`,
    ``,
    `"changeSummary" is 2-5 short plain-language bullet strings for a HUMAN`,
    `reviewer (no markdown, plain sentences). For a create: what the skill does +`,
    `which door it cleared. For a gardening verb: what is changing and why`,
    `(e.g. ["Narrows pr-review to the lockfile-check the user always does",`,
    `"Retires stale-export — unused across the last N sweeps"]).`,
    ``,
    // (13) SKILL.md body template (spec §5.1)
    `── SKILL.md body template (use these headings) ──`,
    `## Goal            — what the skill accomplishes`,
    `## When to use     — the trigger conditions`,
    `## Preconditions   — stable setup that must hold before starting`,
    `## Steps           — ordered steps by intent/label, no raw coordinates`,
    `## Verify          — how to know it worked (definition of done)`,
    `## Gotchas         — non-obvious traps discovered (optional)`,
    ``,
    // (14) closing posture
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

    // NORMALIZE the evidence strip before it reaches the sweep's backfill (which
    // reads struggle.errors / sessions.length unconditionally) and the popup.
    // The judge validates only `occurrences`; `struggle` and `sessions` may be
    // absent or malformed. Default sessions to [] (keeping only well-formed
    // entries) and struggle to a fully-zeroed object (coercing each numeric,
    // defaulting absent to 0) so no downstream consumer can throw on them.
    const coerceNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const strugRaw = ev.struggle && typeof ev.struggle === 'object' ? (ev.struggle as Record<string, unknown>) : {}
    const sessionsRaw = Array.isArray(ev.sessions) ? ev.sessions : []
    const sessions = sessionsRaw.filter(
      (s): s is ProposalEvidence['sessions'][number] =>
        !!s && typeof s === 'object' &&
        typeof (s as Record<string, unknown>).id === 'string' &&
        typeof (s as Record<string, unknown>).intent === 'string' &&
        typeof (s as Record<string, unknown>).at === 'string' &&
        typeof (s as Record<string, unknown>).tracePointer === 'string',
    )
    const normalizedEvidence: ProposalEvidence = {
      occurrences: ev.occurrences,
      sessions,
      firstSeen: typeof ev.firstSeen === 'string' ? ev.firstSeen : '',
      lastSeen: typeof ev.lastSeen === 'string' ? ev.lastSeen : '',
      struggle: {
        errors: coerceNum(strugRaw.errors),
        recoveries: coerceNum(strugRaw.recoveries),
        wallClockMin: coerceNum(strugRaw.wallClockMin),
      },
    }

    const index = out.length
    const prop: Proposal = {
      id: `prop_${ts}_${index}`,
      sweepId,
      proposedAt: new Date(ts).toISOString(),
      kind,
      draft,
      evidence: normalizedEvidence,
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
    // sourceKeys link the proposal back to the ledger candidates it drew from
    // (their lifecycle then advances to 'surfaced'). Best-effort: keep only
    // non-empty strings; a malformed/absent value is simply omitted — it must
    // NEVER drop the proposal.
    if (Array.isArray(e.sourceKeys)) {
      const keys = e.sourceKeys.filter(nonEmptyString)
      if (keys.length) prop.sourceKeys = keys
    }

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
 *  shortlist of candidate ledger entries → a match decision for each. This is the
 *  single STRICT confirmation gate (spec §0 C): a finding may fuse into an
 *  existing suspicion ONLY when it is the SAME user intent carried out with
 *  OVERLAPPING supplied context — never on loose "close enough"/topical
 *  similarity. Loose confirmation is exactly what manufactures junk skills, so the
 *  default is NEW, not match. Judges on the user-side fields (intent +
 *  contextSupplied) where a procedure carries them. */
export function buildMatchPrompt(i: {
  procedures: DistillProcedure[]
  ledgerShortlist: Array<{ key: string; title: string; skeleton: string; intent?: string; contextSupplied?: string[] }>
  outPath: string
  devMode?: boolean
}): string {
  const procLines = i.procedures.length
    ? i.procedures
        .map((p, idx) => {
          const intent = p.intent && p.intent.trim() !== '' ? p.intent : p.title
          const ctx = Array.isArray(p.contextSupplied) && p.contextSupplied.length
            ? `\n  contextSupplied: ${p.contextSupplied.join('; ')}`
            : ''
          return `[${idx}] intent: "${intent}"${ctx}\n  skeleton: ${p.skeleton}`
        })
        .join('\n')
    : '(no procedures this sweep)'

  const shortlistLines = i.ledgerShortlist.length
    ? i.ledgerShortlist
        .map((s) => {
          // Render the ledger side symmetric to the procedure side (spec §0 A/B):
          // its user INTENT (falling back to the legacy title) + the reusable
          // CONTEXT it accumulated, so the matcher compares intent+context on BOTH
          // sides rather than title-similarity alone.
          const intent = s.intent && s.intent.trim() !== '' ? s.intent : s.title
          const ctx = Array.isArray(s.contextSupplied) && s.contextSupplied.length
            ? `\n  contextSupplied: ${s.contextSupplied.join('; ')}`
            : ''
          return `- [${s.key}] intent: "${intent}"${ctx}\n  skeleton: ${s.skeleton}`
        })
        .join('\n')
    : '(ledger is empty — everything is new)'

  const lines = [
    `[Unmute curator — match] For EACH distilled procedure below, decide against`,
    `the SHORTLIST ONLY whether it CONFIRMS an existing ledger entry (the SAME`,
    `repeatable core) or is NEW. This is a STRICT confirmation — bias toward NEW.`,
    ``,
    `── Distilled procedures (this sweep) ──`,
    procLines,
    ``,
    `── Shortlist of existing ledger entries (candidates to match against) ──`,
    shortlistLines,
    ``,
    `── The match rule (STRICT confirmation) ──`,
    `A procedure CONFIRMS a shortlist entry ONLY when it is the SAME user INTENT`,
    `carried out with OVERLAPPING supplied CONTEXT — the same repeatable core, NOT`,
    `merely a topically similar, same-domain, or same-tool task. A DIFFERING`,
    `intent, or only surface-level / keyword similarity, is NEW — never a match.`,
    `Treat differing PER-RUN SPECIFICS (a file path, a branch name, a ticket id,`,
    `an account, a date) as "variedThisRun" entries to RECORD; they are slots to`,
    `note, never a reason to split a genuine same-intent+context confirmation.`,
    `This is a DELIBERATE bias AGAINST fusing: loose "close enough" confirmation`,
    `manufactures junk skills, so recall is not the goal here. WHEN UNCERTAIN,`,
    `treat it as NEW (matchedKey: null) — never force a match.`,
    ``,
    `For each procedure, reference the shortlist entry it confirms by its "key"`,
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

/** DEV-ONLY: capture the top-level `reasoning` string the devMode match prompt
 *  asks for. Returns undefined on null/malformed/absent. Separate read (not
 *  folded into parseMatchOutput) so the decision path is unchanged; the sweep
 *  only LOGS this — it never feeds a decision. Completes the same convention as
 *  parseDistillReasoning/parseSynthesizeReasoning for the third (match) stage,
 *  so Task 7 can call devlogReason('match', …) exactly like the other two. */
export function parseMatchReasoning(raw: string | null): string | undefined {
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
