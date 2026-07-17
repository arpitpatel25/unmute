// Unmute Remote — warm routing classifier (DECIDED architecture).
//
// One WARM, tool-less Claude Code REPL session on the user's subscription whose
// ONLY job is to decide, per utterance: is this a NEW task, or a follow-up to an
// existing one — and if so, which. It also cleans the raw transcript in the same
// turn (folds in intent-cleanup), so we don't pay a separate managed-LLM call.
//
// Why a session and not a one-off model call: classification needs intelligence
// (vague utterances, "apply it to the most recent one"), and the user's flat
// subscription is the only zero-incremental-cost place to get it. RESIDENT from
// app startup (warm()) so there's never a per-utterance cold start; kept lean by
// a post-decision /clear and recycled periodically; killed only on app shutdown.
//
// Topology (star, Unmute = hub): Unmute composes a fresh snapshot from its own
// task map and hands it here; the router writes a decision FILE (the REPL's TUI
// stream is too messy to parse from stdout — same reason executors use a status
// file); Unmute reads it. The router NEVER talks to task sessions directly.
//
// Safety: every failure path (no session, timeout, bad parse, unknown id) returns
// action:'new' with the raw transcript — routing can never block or mis-inject.

import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { createLogger } from './log'
import { SURFACES, normalizeSurface } from './surface'
import type { AgentExecutor, ExecutorFactory } from './executor'

const log = createLogger('router')

/** A task the router may route a follow-up into (Unmute supplies this snapshot). */
export interface RoutableTask {
  id: string
  intent: string
  /** short display name (what the user calls it) — a strong match signal. */
  name?: string | null
  state: string
  /** 'session' = persistent working session (multi-day, often project-bound) —
   *  the likelier target of "keep going / now do X" follow-ups. 'oneoff' =
   *  quick fire-and-forget errand. */
  kind?: 'oneoff' | 'session'
  /** project directory name for project-bound sessions ("unmute-cloud") — what
   *  people SAY when addressing them. */
  project?: string | null
  category?: string | null
  ageSec: number
  /** the task currently expanded/surfaced in the overlay — a strong prior. */
  surfaced?: boolean
  /** the task is BLOCKED on a question to the user (state needs-user). */
  awaiting?: boolean
  /** the pending question text, when awaiting — so the router can judge whether
   *  this utterance answers it. */
  question?: string | null
  /** workspace group ("what the work is about") — live groups only; the router
   *  joins/creates against exactly what it sees here. */
  group?: string | null
}

/** A known project a NEW session can be bound to (curated by projects.ts). */
export interface RoutableProject {
  name: string
  path: string
}

/** A single wall-curation operation (user-initiated, via voice — the router
 *  resolves references like "these two" against the snapshot it was given). */
export type CurateOp =
  | { op: 'set_group'; taskIds: string[]; group: string }
  | { op: 'rename_group'; from: string; to: string }

export interface RouteDecision {
  /** 'resume' = revive a recently-finished one-off (session dead, window-capped)
   *  and deliver this utterance inside it — the thread continues on its card.
   *  'speak' = the user asked to HEAR something (a blocked task's question, a
   *  task's state, overall status) — Unmute speaks it aloud; NOTHING is spawned
   *  or injected. Read-only by construction. */
  /** 'curate' = the command organizes the WALL itself (group/rename) — nothing
   *  is spawned or injected; the host applies validated ops directly. */
  /** 'skill_feedback' = the command is feedback ABOUT a listed skill's behavior
   *  (a complaint/correction/suggestion) — nothing is spawned; the host records
   *  it against the named skill. */
  action: 'new' | 'continue' | 'resume' | 'speak' | 'curate' | 'skill_feedback'
  targetTaskId?: string
  /** cleaned intent (router folds in transcript cleanup). */
  intent: string
  /** the app/tool surface this task operates on (e.g. gmail, google-sheets), or
   *  undefined when none applies — caller falls back to detectSurface. */
  surface?: string
  /** managed = short dictated task; raw = open-ended session where injected
   *  memory hints would pollute long reasoning. Default: managed. */
  mode?: 'managed' | 'raw'
  /** Species for a NEW task: 'session' (persistent working session — never
   *  idle-killed/purged) vs 'oneoff' (today's errand). Omitted → oneoff. */
  kind?: 'oneoff' | 'session'
  /** Project directory to bind a NEW session to — ONLY ever one of the known
   *  project paths offered in the prompt (validated at parse; anything else is
   *  dropped). The task then runs IN that directory. */
  dir?: string
  /** For action 'new' only: the open task the router NEARLY chose instead (a
   *  plausible continue-target that lost). Powers the declinable offer — "started
   *  new — or send to X?" — never a silent reroute. Validated against the
   *  snapshot ids at parse. */
  alternate?: string
  /** For action 'new': a 2-4 word display name for the task ("Twitter strategy
   *  summary"). Minted in the SAME routing turn — the warm session is the one
   *  intelligence we already have, so naming costs zero extra calls. */
  name?: string
  /** For action 'new': RECALL pointer — the command asks about what another/past
   *  task did or found ("what did the pricing session conclude?"). The new task
   *  gets that task's status + transcript paths appended so it reads the actual
   *  record instead of guessing (§6.6: own the pointer, not the plumbing). */
  contextTaskId?: string
  /** Workspace group for the task this decision creates or targets — applied
   *  by the host ONLY if that task has no group yet (assign-once). Aboutness,
   *  never activity type; user's words win; omitted = ungrouped. */
  group?: string
  /** For action 'curate': the validated operations to apply. */
  ops?: CurateOp[]
  /** Skill the user explicitly asked to use by name (validated against the
   *  offered list) — or, for skill_feedback, the skill the feedback is about.
   *  Unmute never chooses one unprompted. */
  skill?: string
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────

/** Humanize an age for the prompt — "260000s ago" is noise for a 3-day session. */
export function fmtAge(ageSec: number): string {
  if (ageSec < 90) return `${ageSec}s ago`
  if (ageSec < 90 * 60) return `${Math.round(ageSec / 60)}m ago`
  if (ageSec < 36 * 3600) return `${Math.round(ageSec / 3600)}h ago`
  return `${Math.round(ageSec / 86400)}d ago`
}

/** The instruction we type into the warm REPL each call. Self-contained: the
 *  router relies on THIS snapshot, not on accumulated memory (keeps it thin). */
export function buildRoutingPrompt(utterance: string, tasks: RoutableTask[], decisionPath: string, projects: RoutableProject[] = [], finished: RoutableTask[] = [], coldSessions: RoutableTask[] = [], wall: RoutableTask[] = [], skillNames: string[] = []): string {
  const lines = tasks.map((t) =>
    `  [${t.id}]${t.name ? ` "${t.name}" —` : ''} "${t.intent}" — ${t.state}` +
    `${t.kind === 'session' ? ' · PERSISTENT SESSION' : ''}${t.project ? ` · project: ${t.project}` : ''}` +
    `${t.group ? ` · group: ${t.group}` : ''}` +
    `${t.category ? ` · ${t.category}` : ''} · ${fmtAge(t.ageSec)}${t.surfaced ? ' · ON SCREEN' : ''}` +
    (t.awaiting ? ` · ⏳ BLOCKED — awaiting your answer to: "${t.question || ''}"` : ''),
  )
  const projectLines = projects.map((p) => `  ${p.name} → ${p.path}`)
  const finishedLines = finished.map((t) =>
    (t.state === 'done' || t.state === 'ready')
      ? `  [${t.id}]${t.name ? ` "${t.name}" —` : ''} "${t.intent}" — finished · ${fmtAge(t.ageSec)} · RESUMABLE`
      : `  ${t.name ? `"${t.name}" — ` : ''}"${t.intent}" — ${t.state} · ${fmtAge(t.ageSec)} (context only)`,
  )
  return [
    `[Unmute router] You route a spoken command to where it belongs. Reply ONLY by writing JSON to ${decisionPath} (atomically: write ${decisionPath}.tmp then rename). Do nothing else — no tools, no browser, no research.`,
    ``,
    `Spoken command: "${utterance}"`,
    ``,
    `FIRST classify the command's SPECIES, then apply that species' rules below:`,
    `  • WORK — does something: starts, continues, or resumes a task (actions "new"/"continue"/"resume").`,
    `  • META — asks to HEAR about the tasks (action "speak"). Nothing is spawned.`,
    `  • CURATION — organizes the wall itself: grouping or renaming what's already on it (action "curate"). Nothing is spawned.`,
    ``,
    `Open tasks you could continue — each is a SEPARATE live session that already`,
    `holds its own context (most recent first):`,
    ...(lines.length ? lines : ['  (none)']),
    ``,
    `Decide: does this command START a new task, or CONTINUE one of the open ones?`,
    `Reason about it genuinely — this is a judgement, not a default.`,
    ``,
    `A task marked "⏳ BLOCKED — awaiting your answer" stopped to ask the user`,
    `something and is waiting. If this command is plausibly the ANSWER to that`,
    `question (it supplies what was asked, even loosely), CONTINUE that task — the`,
    `answer is piped straight back into it. Only choose otherwise if the command`,
    `clearly ignores the question and starts something unrelated.`,
    ``,
    `Lean CONTINUE when the command DEPENDS on an existing task to make sense: it`,
    `refers back to it (a pronoun or a relative phrase), leaves the subject implied,`,
    `or reads as the natural next step of something already open. People speak`,
    `tersely to a task in progress and don't repeat context they just gave — so a`,
    `short or context-light command is frequently a follow-up, NOT a new request.`,
    `Topical continuity counts on its own: if the command digs deeper into, asks`,
    `more about, or builds on the SAME specific subject as a recent open task,`,
    `CONTINUE it even when the command is fully formed and never refers back`,
    `explicitly — people keep probing the same thread in complete sentences.`,
    `Match on the shared subject/entity and on recency; when the command is terse,`,
    `the ON SCREEN task is the most likely target. A brand-new session would NOT`,
    `know the missing context — so if the command only makes sense given an open`,
    `task, route it there. A task in state "ready" finished a step and is WAITING`,
    `for the user's next direction — it is the most natural continue target for a`,
    `command that advances its thread.`,
    ``,
    `Choose NEW when the command opens a DIFFERENT subject from every open task, or`,
    `when no open task plausibly relates to it. A command can be self-contained and`,
    `still be a continuation — so do not start a parallel session merely because the`,
    `sentence could stand alone; if it stays on the same specific thread, CONTINUE.`,
    `But guard the other way just as hard: sharing only a BROAD area (both about git,`,
    `both about email) is NOT the same task — the subject AND goal must match a`,
    `SPECIFIC open task, not just fall in the same general domain. When the command`,
    `pursues its own distinct goal, or relates only loosely or coincidentally to an`,
    `open task, choose NEW. Do NOT collapse every command onto an existing task —`,
    `when nothing clearly matches, NEW is correct. Equally, don't pick NEW out of`,
    `caution when there is a real dependency or a clear same-thread continuation.`,
    ``,
    `Weigh the task metadata: a task named like what the user SAID (its "name" or`,
    `project) is a strong continue-target. A PERSISTENT SESSION is a long-lived`,
    `working thread — the natural home of "keep going", "now do X there", and any`,
    `command about ITS project; prefer it over an old one-off errand on the same`,
    `topic. Recency matters most among one-offs (people rarely return to an errand`,
    `from hours ago) and least for persistent sessions (returning after hours or`,
    `days is normal for them).`,
    ...(projectLines.length ? [
      ``,
      `Known project directories (name → path). If the command asks to work in/on one`,
      `of THESE — start a session there, fix/build something in that repo — and no`,
      `open task already covers it, choose NEW with "dir" set to that EXACT path`,
      `(copy it verbatim; never invent or modify a path, never use one not listed):`,
      ...projectLines,
    ] : []),
    ...(coldSessions.length ? [
      ``,
      `The user's WORKING SESSIONS, currently untouched by them — you may NOT`,
      `route into these (never emit their ids as targetTaskId; the user speaks to`,
      `them by opening them). If the command clearly belongs to one of these`,
      `sessions, choose NEW and set "alternate" to that session's id — the user`,
      `gets a one-tap offer to redirect (their tap is the consent):`,
      ...coldSessions.map((t) =>
        `  [${t.id}]${t.name ? ` "${t.name}" —` : ''} "${t.intent}"${t.project ? ` · project: ${t.project}` : ''}${t.group ? ` · group: ${t.group}` : ''} · ${fmtAge(t.ageSec)}`),
    ] : []),
    ...(finishedLines.length ? [
      ``,
      `Recently FINISHED tasks (their sessions closed, but the thread is still`,
      `fresh). If the command is a FOLLOW-UP to one marked RESUMABLE — it builds`,
      `on, corrects, or asks more about what that task just did — choose action`,
      `"resume" with its id: Unmute revives that exact session with its full`,
      `prior context and delivers this command inside it. For '(context only)'`,
      `entries, or when the command merely references a finished task without`,
      `truly following it up, choose NEW with a fully SELF-CONTAINED intent that`,
      `carries whatever the finished task establishes:`,
      ...finishedLines,
    ] : []),
    ``,
    `Also clean the command into one natural line (fix transcription slips, keep the`,
    `exact meaning).`,
    ``,
    `META-COMMANDS (action "speak"): if the command asks to HEAR or KNOW something`,
    `about the tasks themselves — "read me the question", "what does it need",`,
    `"what's the status", "what's going on" — do NOT start any task: choose action`,
    `"speak" with targetTaskId of the task being asked about (the blocked one when`,
    `they say "the question"; omit targetTaskId for an overall status). Unmute`,
    `speaks the answer aloud.`,
    ``,
    `RECALL (contextTaskId): if the command asks what ANOTHER listed task did,`,
    `found, or concluded — "what did the pricing session conclude?", "summarize`,
    `what the runbook one found" — choose NEW, write the question as the intent,`,
    `and set "contextTaskId" to that task's id: the new task receives that task's`,
    `actual record (status + transcript) to read before answering.`,
    ``,
    ...((): string[] => {
      const members = new Map<string, string[]>()
      for (const t of [...tasks, ...coldSessions, ...wall]) {
        const g = (t.group ?? '').trim()
        if (!g) continue
        const label = (t.name || t.intent).slice(0, 40)
        const list = members.get(g) ?? []
        if (list.length < 2 && !list.includes(label)) list.push(label)
        members.set(g, list)
      }
      if (!members.size) return []
      return [
        ``,
        `LIVE GROUPS — the workspace streams currently on the user's wall. These are`,
        `the ONLY groups that exist right now: groups are creatures of the present`,
        `(they fade when their tasks end; new ones are minted only by you or the`,
        `user). Each is "what the work is about", shown with example members:`,
        ...[...members.entries()].map(([g, ms]) => `  • ${g} — e.g. ${ms.map((m) => `"${m}"`).join(', ')}`),
      ]
    })(),
    ``,
    `CURATION (action "curate"): if the command organizes the wall ITSELF — "group`,
    `these two as X", "put the video tasks together", "rename group A to B" — do`,
    `NOT start or continue anything: choose action "curate" with "ops". Ops:`,
    `{"op":"set_group","taskIds":["<id>",...],"group":"<name>"} assigns tasks to a`,
    `group (creating it if new); {"op":"rename_group","from":"<existing group>",`,
    `"to":"<new name>"} renames one. Resolve references like "these two" / "the`,
    `unmute ones" against the WALL list below (ids there are curation-only —`,
    `NEVER emit them as targetTaskId). The tell is REFERENCE MATCHING: when the`,
    `command's nouns match tasks actually on the wall, it is curation; when it`,
    `asks to BUILD/FIX/EDIT something, it is work even if it names the same`,
    `subject. Example: "group the unmute tasks" with three unmute-named tasks`,
    `on the wall → curate; "add grouping to the unmute repo" → work (new task).`,
    ...(wall.length ? [
      ``,
      `THE WALL (everything on screen — curation targets ONLY):`,
      ...wall.map((t) =>
        `  [${t.id}]${t.name ? ` "${t.name}"` : ` "${t.intent.slice(0, 60)}"`} — ${t.state}${t.group ? ` · group: ${t.group}` : ' · ungrouped'}`),
    ] : []),
    ...(skillNames.length ? [
      ``,
      `THE USER'S SKILLS (reference list — names only): ${skillNames.join(', ')}`,
      `If the command EXPLICITLY asks to use one of these by (fuzzy) name — "use my`,
      `PR review skill", "run the video load skill" — set "skill" to that EXACT`,
      `listed name on your normal WORK decision. Only when the user names one;`,
      `never volunteer a skill.`,
      `SKILL FEEDBACK: if the command is feedback ABOUT one of these skills — a`,
      `complaint, correction, or suggestion about how the skill itself behaves`,
      `("the pr-review skill keeps missing lockfiles") — choose action`,
      `"skill_feedback" with "skill" set to that name and intent = the feedback,`,
      `cleaned. Nothing is spawned.`,
    ] : []),
    ``,
    `Write exactly: {"action":"new"|"continue"|"resume"|"speak"|"curate"${skillNames.length ? '|"skill_feedback"' : ''},"targetTaskId":"<id when continue/resume/speak>","intent":"<cleaned one-line command>","name":"<2-4 word title for a new task>","surface":"<app/tool or omit>","mode":"managed"|"raw","kind":"oneoff"|"session","dir":"<known project path or omit>","alternate":"<task id or omit>","contextTaskId":"<task id whose record a NEW task should read, or omit>","group":"<workspace group or omit>","ops":[<curate ops, action "curate" only>]${skillNames.length ? ',"skill":"<listed skill name or omit>"' : ''}}`,
    `name (for action "new"): a 2-4 word title capturing the essence, for a session list in a UI — plain words, no quotes/punctuation (e.g. "Unmute pricing check", "WhatsApp message", "Gating feature work").`,
    `alternate (only with action "new", optional): if exactly one open task was a PLAUSIBLE alternative you seriously weighed before choosing NEW, give its id — the user gets a one-tap "or send it there?" offer. Omit it when nothing came close (most of the time).`,
    `surface: the app/tool the task operates on. Use EXACTLY one of these canonical labels (never invent a new one): ${SURFACES.join(', ')}. Omit if none applies. (e.g. a tweet/X task = "x"; a Mac app/system task = "macos"; streaming on Hotstar = "jiohotstar".)`,
    `mode: use "raw" for "open me a session to work in" / open-ended coding where injected memory hints would pollute long reasoning; use "managed" for short, surface-operating dictated tasks. If ambiguous, choose "raw".`,
    `kind (only for action "new"): "session" for a working session the user will keep coming back to — coding, a project (anything with "dir"), open-ended "work on X" — it stays alive until they end it. "oneoff" for a quick errand they fire and forget (open/check/find something). If ambiguous, "oneoff".`,
    `group: the workspace group for the task this command creates or continues — the answer to "what is this work ABOUT" (a project, artifact, or stream: a repo name, "launch video", "on-call"), NEVER an activity type ("coding", "research", "media"). Every PERSISTENT SESSION deserves a group — being a session already proves the stream is ongoing. Decide DELIBERATELY, in this order: (1) if the user names a group in the command, use exactly their words; (2) check the LIVE GROUPS list above — JOIN one when this task belongs to that same stream of work (not merely when it mentions the same product/word: a group that swallows everything is no group); (3) otherwise CREATE one — 2-3 words, the subject in the user's own words ("videos", "launch video", "on-call") — this is the NORMAL case for a new session, not an exception; (4) omit ONLY when the work is genuinely subject-less, or for a one-off errand. A group is the stream, not the deliverable: name what the user will still call this work next week.`,
  ].join('\n')
}

/** The default decision when the router gives us nothing usable (timeout, bad
 *  parse, unknown id). A follow-up is likelier than a coincidental brand-new
 *  request when exactly ONE recent task is open — BUT the failsafe must NEVER
 *  guess its way INTO A RUNNING TASK: injecting into a session that is mid-work
 *  derails it (proven live: a router timeout sent "rephrase a tweet" into a
 *  running growth-strategy session and hijacked it). A running task's heartbeat
 *  also keeps it perpetually "recent", so the age gate is meaningless for it.
 *  Continue only when the lone task is WAITING (needs-user — the utterance is
 *  plausibly the answer) or parked after finishing (a follow-up window). A
 *  wrong NEW task is visible and cheap; a wrong injection is destructive. */
export function failsafeDecision(tasks: RoutableTask[], intent: string, maxAgeSec = 180): RouteDecision {
  const clean = (intent || '').trim()
  if (tasks.length === 1 && tasks[0].ageSec <= maxAgeSec && tasks[0].state !== 'processing') {
    return { action: 'continue', targetTaskId: tasks[0].id, intent: clean, mode: 'managed' }
  }
  return { action: 'new', intent: clean, mode: 'managed' }
}

/** Parse the decision file. EXPLICIT router decisions (new, or continue→known id)
 *  are honored. Everything else — null/malformed/unknown-action/unknown-id —
 *  routes through failsafeDecision (continue-latest-if-single). */
export function parseDecision(raw: string | null, fallbackIntent: string, tasks: RoutableTask[], projects: RoutableProject[] = [], coldSessions: RoutableTask[] = [], finished: RoutableTask[] = [], wall: RoutableTask[] = [], skillNames: string[] = []): RouteDecision {
  // CONSENT ENFORCEMENT (layer 2): continue-targets are ONLY the targetable
  // tasks; a cold session id in targetTaskId is rejected here no matter what
  // the model wrote (falls through to a safe NEW). Cold ids ARE valid for
  // `alternate` — the declinable one-tap offer is the consent path.
  const validIds = new Set(tasks.map((t) => t.id))
  const alternateIds = new Set([...tasks, ...coldSessions].map((t) => t.id))
  // Resume targets: ONLY 'done' entries from the capped recently-finished pool
  // (a failed task resumes via its own nudge path, not here; cold sessions and
  // live tasks can never be 'resumed').
  const resumeIds = new Set(finished.filter((t) => t.state === 'done' || t.state === 'ready').map((t) => t.id))
  // Skills the user was actually offered — Unmute never chooses one unprompted,
  // and an off-list name (or a hallucinated one) is dropped at this boundary.
  const knownSkills = new Set(skillNames)
  if (!raw) return failsafeDecision(tasks, fallbackIntent)
  let obj: { action?: string; targetTaskId?: string; intent?: string; surface?: string; mode?: string; kind?: string; dir?: string; alternate?: string; name?: string; contextTaskId?: string; group?: string; ops?: unknown; skill?: string }
  try { obj = JSON.parse(raw) } catch { return failsafeDecision(tasks, fallbackIntent) }
  const intent = (obj.intent && obj.intent.trim()) || fallbackIntent
  const mode = obj.mode === 'raw' ? 'raw' : 'managed'
  // skill: trimmed, de-quoted, kept ONLY if it names a skill we offered — junk
  // and off-list names become undefined (the user must have named it explicitly).
  const rawSkill = (obj.skill ?? '').trim().replace(/^["'`]+|["'`.]+$/g, '').trim()
  const skill = knownSkills.has(rawSkill) ? rawSkill : undefined
  // Pin to the canonical vocabulary: an off-list / invented surface (the LM
  // emitted "jiohotstar", "x", etc. freely) becomes undefined, and the caller
  // falls back to the deterministic detectSurface — so the store can't fragment.
  const surface = normalizeSurface(obj.surface)
  // workspace group: trimmed, de-quoted, bounded — junk becomes undefined.
  // Grouping is metadata, never a gate: a bad group must never break routing.
  const rawGroup = (obj.group ?? '').trim().replace(/^["'`]+|["'`.]+$/g, '').trim()
  const group = rawGroup && rawGroup.length <= 32 ? rawGroup : undefined
  if (obj.action === 'continue' && obj.targetTaskId && validIds.has(obj.targetTaskId)) {
    return { action: 'continue', targetTaskId: obj.targetTaskId, intent, mode, surface, ...(group ? { group } : {}), ...(skill ? { skill } : {}) }
  }
  if (obj.action === 'resume' && obj.targetTaskId && resumeIds.has(obj.targetTaskId)) {
    return { action: 'resume', targetTaskId: obj.targetTaskId, intent, mode, surface, ...(group ? { group } : {}), ...(skill ? { skill } : {}) }
  }
  // SKILL FEEDBACK: feedback ABOUT a listed skill's behavior — nothing spawned,
  // nothing injected; the host records it against the named skill. We NEVER
  // invent a feedback target: an unknown/missing skill falls through to failsafe.
  if (obj.action === 'skill_feedback') {
    if (skill) return { action: 'skill_feedback', skill, intent }
    return failsafeDecision(tasks, intent)
  }
  // CURATE: wall organization only — nothing spawned, nothing injected. Ops are
  // validated hard: task ids must be ones we offered (live or cold — the user's
  // explicit command is the consent; group metadata is not injection), rename
  // sources must be groups that actually exist. Nothing valid → failsafe.
  if (obj.action === 'curate') {
    // Curation targets = the WALL (everything on screen), plus routable/cold
    // for completeness. Wall ids are curation-only: they are NOT added to
    // continue/resume/alternate validation — the consent guards stand.
    const curatableIds = new Set([...alternateIds, ...wall.map((t) => t.id)])
    const liveGroups = new Set([...tasks, ...coldSessions, ...wall].map((t) => t.group).filter((g): g is string => !!g))
    const sane = (v: unknown): string => typeof v === 'string' ? v.trim().replace(/^["'`]+|["'`.]+$/g, '').trim().slice(0, 32) : ''
    const ops: CurateOp[] = []
    for (const rawOp of Array.isArray(obj.ops) ? obj.ops : []) {
      const o = rawOp as { op?: string; taskIds?: unknown; group?: unknown; from?: unknown; to?: unknown }
      if (o?.op === 'set_group') {
        const g = sane(o.group)
        const ids = (Array.isArray(o.taskIds) ? o.taskIds : []).filter((i): i is string => typeof i === 'string' && curatableIds.has(i))
        if (g && ids.length) ops.push({ op: 'set_group', taskIds: ids, group: g })
      } else if (o?.op === 'rename_group') {
        const from = typeof o.from === 'string' ? o.from.trim() : ''
        const to = sane(o.to)
        if (from && to && liveGroups.has(from)) ops.push({ op: 'rename_group', from, to })
      }
    }
    if (ops.length) return { action: 'curate', intent, ops }
    return failsafeDecision(tasks, intent)
  }
  // speak: read-only by construction — any KNOWN id is fine (cold sessions too:
  // hearing about a session is not injecting into it); unknown id → overall.
  if (obj.action === 'speak') {
    const anyKnown = new Set([...tasks, ...coldSessions, ...finished].map((t) => t.id))
    const target = obj.targetTaskId && anyKnown.has(obj.targetTaskId) ? obj.targetTaskId : undefined
    return { action: 'speak', targetTaskId: target, intent }
  }
  if (obj.action === 'new') {
    // dir is honored ONLY when it's one of the paths we offered — an invented
    // or modified path must never become a spawn cwd (dispatch would fall back
    // to scratch anyway, but the guard belongs at the trust boundary).
    const dir = obj.dir && projects.some((p) => p.path === obj.dir) ? obj.dir : undefined
    // A project-bound task is inherently a working session, whatever the model
    // labeled it — dir implies kind.
    const kind = obj.kind === 'session' || dir ? 'session' as const : 'oneoff' as const
    // alternate must name a task we actually offered (targetable OR cold) — else dropped.
    const alternate = obj.alternate && alternateIds.has(obj.alternate) ? obj.alternate : undefined
    // recall pointer: any KNOWN task's record may be read (read-only) — else dropped.
    const anyKnown = new Set([...tasks, ...coldSessions, ...finished].map((t) => t.id))
    const contextTaskId = obj.contextTaskId && anyKnown.has(obj.contextTaskId) ? obj.contextTaskId : undefined
    // display name: trimmed, de-quoted, bounded — junk becomes undefined (the UI
    // falls back to a truncated intent, never breaks).
    const rawName = (obj.name ?? '').trim().replace(/^["'`]+|["'`.]+$/g, '').trim()
    const name = rawName && rawName.length <= 48 ? rawName : undefined
    return { action: 'new', intent, mode, surface, kind, dir, alternate, name, contextTaskId, ...(group ? { group } : {}), ...(skill ? { skill } : {}) }
  }
  return failsafeDecision(tasks, intent)
}

// ─── The warm session ─────────────────────────────────────────────

export interface RouterOpts {
  /** Builds the tool-less classifier session (a minimal claude REPL). */
  executorFactory: ExecutorFactory
  baseDir?: string
  /** Per-call wait for the decision file (default 60s — cloud inference + a
   *  tool-driven file write can be slow; we are diagnosing the true latency). */
  decisionTimeoutMs?: number
  /** ms to let the REPL boot before the first prompt. */
  readyGraceMs?: number
  /** ms to wait after typing the multi-line prompt before sending an explicit
   *  confirm Enter. Claude's TUI captures a multi-line write as a paste that
   *  lands one Enter short of submitting (same quirk the task dispatch path
   *  confirm-Enters for). Without this the prompt sits unsubmitted as a paste. */
  submitConfirmMs?: number
  pollMs?: number
  /** Recycle (full respawn) the resident session after this many decisions. */
  recycleEvery?: number
  /** Recycle the resident session once it is older than this (ms). */
  maxSessionMs?: number
  now?: () => number
}

export class Router {
  private ex: AgentExecutor | null = null
  private chain: Promise<unknown> = Promise.resolve() // single-flight serializer
  private decisionCount = 0
  private spawnedAt = 0
  private readonly dir: string
  private readonly decisionPath: string
  private readonly o: Required<Omit<RouterOpts, 'now'>> & Pick<RouterOpts, 'now'>

  constructor(opts: RouterOpts) {
    this.o = {
      executorFactory: opts.executorFactory,
      baseDir: opts.baseDir ?? join(homedir(), '.unmute', 'remote'),
      decisionTimeoutMs: opts.decisionTimeoutMs ?? 60000,
      readyGraceMs: opts.readyGraceMs ?? 1500,
      submitConfirmMs: opts.submitConfirmMs ?? 450,
      pollMs: opts.pollMs ?? 150,
      recycleEvery: opts.recycleEvery ?? 50,
      maxSessionMs: opts.maxSessionMs ?? 2 * 60 * 60_000,
      now: opts.now,
    }
    this.dir = join(this.o.baseDir, 'router')
    this.decisionPath = join(this.dir, 'decision.json')
  }

  /** Classify one utterance against the current task snapshot. Single-flighted;
   *  always resolves (fail-safe to a new task). */
  route(utterance: string, tasks: RoutableTask[], projects: RoutableProject[] = [], finished: RoutableTask[] = [], coldSessions: RoutableTask[] = [], wall: RoutableTask[] = [], skillNames: string[] = []): Promise<RouteDecision> {
    const run = this.chain.then(() => this.routeOnce(utterance, tasks, projects, finished, coldSessions, wall, skillNames))
    // After the decision resolves to the caller, keep the chain alive with
    // housekeeping (/clear + maybe-recycle) — off the hot path, but serialized
    // so it can never overlap the next route.
    this.chain = run.then(() => this.housekeep(), () => this.housekeep())
    return run
  }

  /** Bring the session up (or respawn it if it died) BEFORE it is needed, so a
   *  real utterance never pays cold-start. Idempotent and single-flighted: safe
   *  to call at app init and again on every Remote key-down. */
  warm(): Promise<void> {
    const run = this.chain.then(() => this.ensureSession())
    this.chain = run.catch(() => undefined)
    return run
  }

  private async routeOnce(utterance: string, tasks: RoutableTask[], projects: RoutableProject[] = [], finished: RoutableTask[] = [], coldSessions: RoutableTask[] = [], wall: RoutableTask[] = [], skillNames: string[] = []): Promise<RouteDecision> {
    const fallback = (utterance || '').trim()
    try {
      await this.ensureSession()
      await fs.mkdir(this.dir, { recursive: true })
      await fs.rm(this.decisionPath, { force: true }).catch(() => {})
      const prompt = buildRoutingPrompt(utterance, tasks, this.decisionPath, projects, finished, coldSessions, wall, skillNames)
      this.ex!.writeStdin(prompt)
      // The multi-line prompt is captured by Claude's TUI as a paste that lands
      // one Enter short of submitting — so it sits as "[Pasted text]" and the
      // model never runs. Mirror the task dispatch path: settle, then send an
      // explicit confirm Enter to actually submit it. (Proven on the task lane.)
      await this.sleep(this.o.submitConfirmMs)
      if (this.ex?.alive) { this.ex.write('\r'); log.event('router-submit-confirm', { afterMs: this.o.submitConfirmMs }) }
      const raw = await this.waitForDecision(prompt)
      const decision = parseDecision(raw, fallback, tasks, projects, coldSessions, finished, wall, skillNames)
      // TEMP(memory-debug)
      log.event('route-decision', { action: decision.action, targetTaskId: decision.targetTaskId ?? null, tasks: tasks.length, surface: decision.surface ?? null, mode: decision.mode ?? null, kind: decision.kind ?? null, dir: decision.dir ?? null, group: decision.group ?? null, ops: decision.ops?.length ?? 0, MEMORY_DEBUG: true })
      return decision
    } catch (e) {
      log.warn('route failed — using failsafe', { error: (e as Error).message })
      return failsafeDecision(tasks, fallback)
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ex?.alive) return
    log.event('router-spawn', {})
    this.ex = await this.spawnSession()
    this.spawnedAt = this.clock()
    this.decisionCount = 0
  }

  /** Spawn + ready a new executor (shared by ensureSession and recycle). */
  private async spawnSession(): Promise<AgentExecutor> {
    const ex = this.o.executorFactory()
    // DIAGNOSTIC: mirror the router REPL's own output into our logs. The router
    // executor (unlike task executors) was never subscribed, so we were blind to
    // what the model actually says/does with the routing prompt. Strip ANSI +
    // OSC sequences, collapse whitespace, and log any non-empty text so we can
    // SEE whether it writes the file, prints JSON to chat, stalls on a prompt, etc.
    ex.onData((chunk) => {
      // Log a compact view of whatever the router REPL emits. The logger
      // JSON-escapes control bytes, so ANSI shows as \u001b... — readable
      // enough to see if the model writes the file, prints JSON to chat, or
      // stalls. Skip pure cursor/redraw noise (chunks with no letters).
      const text = chunk.replace(/\s+/g, ' ').trim()
      if (/[A-Za-z0-9{}"]/.test(text)) log.event('router-output', { text: text.slice(0, 500) })
    })
    await ex.spawn({ cwd: this.dir, env: process.env, taskId: 'router' })
    await fs.mkdir(this.dir, { recursive: true }).catch(() => {})
    await ex.isReady()
    ex.writeStdin('') // accept any folder-trust prompt
    await this.sleep(this.o.readyGraceMs)
    return ex
  }

  /** Runs in the idle gap AFTER a decision (chained, never on the hot path):
   *  wipe the conversation context so the resident session stays lean (routing
   *  is stateless — the full snapshot is supplied every turn), and periodically
   *  recycle the whole process to cap long-run drift. */
  private async housekeep(): Promise<void> {
    this.decisionCount++
    if (this.ex?.alive) {
      try { this.ex.writeStdin('/clear') } catch { /* best-effort */ }
    }
    const aged = this.spawnedAt > 0 && this.clock() - this.spawnedAt > this.o.maxSessionMs
    if (this.decisionCount >= this.o.recycleEvery || aged) {
      await this.recycle().catch(() => {})
    }
  }

  /** Proactive full respawn: bring a fresh session up, then kill the old one and
   *  swap. Done in idle time so a real decision never pays cold-start. */
  private async recycle(): Promise<void> {
    log.event('router-recycle', { decisions: this.decisionCount })
    const fresh = await this.spawnSession()
    const old = this.ex
    this.ex = fresh
    this.spawnedAt = this.clock()
    this.decisionCount = 0
    if (old?.alive) { try { old.kill() } catch { /* best-effort */ } }
  }

  /** Test hook: await any trailing housekeeping queued on the chain. */
  settleHousekeeping(): Promise<void> { return this.chain.then(() => undefined, () => undefined) }

  private async waitForDecision(prompt?: string): Promise<string | null> {
    const start = this.clock()
    const deadline = start + this.o.decisionTimeoutMs
    let lastBeat = 0
    let reinjected = false
    while (this.clock() < deadline) {
      try {
        const raw = await fs.readFile(this.decisionPath, 'utf8')
        if (raw.trim()) {
          log.event('router-decision-file-read', { afterMs: this.clock() - start, raw: raw.slice(0, 500) })
          return raw
        }
      } catch { /* not written yet */ }
      const elapsed = this.clock() - start
      // SELF-HEAL (same disease the task lane cures with verifyDispatch): the
      // multi-line prompt occasionally lands unsubmitted in the REPL's input box
      // — the session then sits idle forever and the timeout fires (proven live:
      // a 60s stall sent the failsafe into a running session). If no decision
      // after 15s, clear the input line (Ctrl-U, NEVER Esc) and re-inject once.
      if (!reinjected && prompt && elapsed >= 15_000 && this.ex?.alive) {
        reinjected = true
        log.warn('router slow — clearing input and re-injecting prompt once', { elapsedMs: elapsed })
        this.ex.write('\x15')
        await this.sleep(200)
        this.ex.writeStdin(prompt)
        await this.sleep(this.o.submitConfirmMs)
        if (this.ex?.alive) this.ex.write('\r')
      }
      // DIAGNOSTIC heartbeat: prove we are still polling and show elapsed, so a
      // slow-but-eventual write is distinguishable from a never-write.
      if (elapsed - lastBeat >= 5000) { lastBeat = elapsed; log.event('router-waiting', { elapsedMs: elapsed, decisionPath: this.decisionPath }) }
      await this.sleep(this.o.pollMs)
    }
    log.warn('router decision timed out', { ms: this.o.decisionTimeoutMs })
    return null
  }

  /** Kill the resident session (app shutdown). */
  dispose(): void {
    if (this.ex?.alive) { try { this.ex.kill() } catch { /* best-effort */ } }
    this.ex = null
  }

  private clock(): number { return this.o.now ? this.o.now() : Date.now() }
  // NOT unref'd — these drive an in-flight route; unref'ing would let the loop
  // drain mid-route and stall the decision. (Only the idle timer is unref'd.)
  private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
}
