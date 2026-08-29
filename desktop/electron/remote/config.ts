// Unmute Remote — central config for model choices + static LLM prompts.
//
// WHY this file exists
// --------------------
// The Claude Code model choices and the two static LLM prompts used by the
// Remote orchestration layer used to live inline, scattered across init.ts
// (the doer default appeared as `|| 'sonnet'` in ~6 places, plus the pinned
// router/librarian models) and intent-cleanup.ts. Centralizing them here makes
// "which model do we use for X" and "what does the cleanup prompt say"
// answerable — and changeable — in ONE place.
//
// SCOPE (deliberate — what belongs here vs what does NOT)
// ------------------------------------------------------
// IN: values that are genuinely STATIC and config-like — the model aliases and
//     the self-contained prompt strings below.
//
// OUT (left with their logic on purpose):
//   • The dynamically-assembled prompt TEMPLATES — buildRoutingPrompt
//     (router.ts), buildLibrarianPrompt (librarian.ts) and buildDispatch /
//     buildResumeNudge (dispatch-prompt.ts). These interpolate live runtime
//     state and branch on it, so they are code, not config; forcing them into
//     a data file would only obscure them.
//   • The executor operating contract — already its own dedicated module at
//     contract/contract-text.ts (CONTRACT_TEXT).
//
// OUT (already centralized in their own runtime's single source of truth —
// these run in different deploy units that cannot import this Electron file):
//   • Backend Groq STT/LLM model ids + endpoints → backend/cloudflare/shared/
//     groq.ts (STT_MODEL, LLM_MODEL, GROQ_STT_URL, GROQ_CHAT_URL) — the
//     server-side "change here to roll out to all users" file.
//   • On-device STT model → desktop/engine-overrides/electron/parakeet.ts
//     (MODEL_ARCHIVE_DIR).

// ─── Models (Claude Code CLI aliases, passed to executors as `--model`) ──────

/** One selectable model: the `--model` value + how it reads in the UI. */
export interface ModelChoice {
  /** The value the backend is given. Claude takes it as `--model <id>`; Codex
   *  takes it as `-c model="<id>"`, which is a TOML override and NOT a flag —
   *  see codexArgs. The catalog stores the bare id and each adapter spells it. */
  id: string
  /** Short UI label. */
  label: string
  /** One-line helper shown under the selector. */
  description?: string
  /** Which backend this model belongs to. Absent ⇒ Claude, because every entry
   *  predates a second CLI and the persisted `model` setting has no provider
   *  key — so absent must keep meaning Claude rather than "any". */
  provider?: 'claude' | 'codex'
}

/** The DEFAULT model catalog — the Claude Code `/model` aliases, which
 *  auto-track the latest underlying version (so 'opus' is always the newest
 *  Opus). This is the COMPILED FLOOR: the runtime config can replace/extend it
 *  (e.g. add pinned full-name versions like 'claude-opus-4-8') WITHOUT an app
 *  build — see runtime-config.ts (models.available). Order is fast → capable. */
export const MODEL_CATALOG: ModelChoice[] = [
  { id: 'default',  label: 'Default',   description: 'Your Claude Code default — recommended.' },
  { id: 'haiku',    label: 'Haiku',     description: 'Fastest — best for simple, quick tasks.' },
  { id: 'sonnet',   label: 'Sonnet',    description: 'Balanced speed and capability. Great default.' },
  { id: 'opus',     label: 'Opus',      description: 'Most capable — best for hard, multi-step tasks.' },
  { id: 'opusplan', label: 'Opus Plan', description: 'Plans with Opus, executes with Sonnet.' },
  // NO CODEX ENTRIES, DELIBERATELY, AND THIS IS THE SECOND ANSWER TO THE SAME
  // QUESTION. Four were written here — 'gpt-5.1-codex-max', 'gpt-5.1-codex',
  // 'gpt-5.1-codex-mini', 'default' — and they were invented, never checked
  // against a running Codex. The real codex-cli 0.147 offers six models under
  // entirely different names, each with its own reasoning efforts.
  //
  // The fix is not better constants. Codex's line-up is Codex's to change and
  // it turned over completely between two point releases, so ANY value written
  // here is a claim about someone else's product with no way to notice it going
  // stale: a wrong id does not fail at the picker, because `-c model="…"` is a
  // valid TOML override for any string. The task starts and fails at the API.
  //
  // Codex CLI's models are ASKED FOR at read time (codex/cli-models.ts, via the
  // app-server `model/list` the desktop backend already uses). This catalogue is
  // for backends whose vocabulary Unmute genuinely owns — the Claude Code
  // aliases, which are stable and which config can extend without a build. See
  // `modelSource` in providers.ts for which backend is which.
]

/** Which backend an entry belongs to, with the absent-means-Claude rule applied.
 *
 *  ONE definition, because the rule is now read in three places — the picker
 *  (modelsFor), the config merge, and the selectable-id guard — and the way
 *  this breaks is not a crash. Spelled twice and drifted, a backend's models
 *  quietly land in another backend's menu. */
export function providerOfModel(m: ModelChoice): string {
  return m.provider ?? 'claude'
}

/** The models selectable for a given backend.
 *
 *  Absent `provider` means Claude — the catalog predates a second CLI and the
 *  persisted `model` setting carries no provider key, so an untagged entry must
 *  keep meaning what it always did. */
export function modelsFor(provider: string | undefined, catalog: readonly ModelChoice[] = MODEL_CATALOG): ModelChoice[] {
  const want = provider || 'claude'
  return catalog.filter((m) => providerOfModel(m) === want)
}

/** The compiled default set of selectable model ids (catalog ids). Kept for
 *  backward-compat; the EFFECTIVE selectable set is runtime/config-driven
 *  (getModelCatalog() in runtime-config.ts). */
export const DOER_MODELS: string[] = modelsFor('claude').map((m) => m.id)
/** A selectable model id. Relaxed to `string`: the set is now runtime-driven,
 *  so it can no longer be a fixed compile-time union. */
export type DoerModel = string

/** Narrowing guard against the COMPILED catalog (the floor). For the EFFECTIVE
 *  (config-extended) catalog use isSelectableModel() in runtime-config.ts. */
export function isDoerModel(m: unknown): m is DoerModel {
  return typeof m === 'string' && DOER_MODELS.includes(m)
}

export const MODELS = {
  /** Default doer model. DECIDED: Sonnet — fast AND capable for agentic remote
   *  tasks. Users switch to Haiku (faster) or Opus (most capable) from the
   *  Remote settings or the capture-widget model selector. */
  doerDefault: 'sonnet',

  /** Router classifier — PINNED light/fast, independent of the user's doer
   *  choice. Classification is thin and must answer in ~1-2s, and we must NOT
   *  inherit the CLI default (the user can set it to Opus, heavy/slow for a
   *  one-line judgement). */
  router: 'sonnet',

  /** Librarian curator — PINNED strong, independent of the user's doer choice:
   *  curation is background (latency-insensitive) and benefits from strong
   *  reasoning, so picking Haiku for speed on tasks shouldn't degrade
   *  long-term memory. */
  librarian: 'opus',
} as const satisfies Record<string, DoerModel>

// ─── Static prompts (self-contained system prompts for direct chat calls) ────

export const PROMPTS = {
  /** Intent cleanup (PRD §13.7): raw voice transcript → one clean command.
   *  Errs LIGHT — fix disfluencies + obvious self-corrections, keep intent. */
  intentCleanup: [
    'You clean up a voice transcript into a single clear command for a computer assistant.',
    'Rules: remove filler ("uh", "um", "like"), resolve self-corrections (keep the final intent),',
    'fix obvious speech-to-text errors, and output ONE concise imperative sentence.',
    'Do NOT add steps, do NOT answer or perform the task, do NOT ask questions.',
    'Output only the cleaned command, nothing else.',
  ].join(' '),

  /**
   * Task naming: an intent string → a short 2-5 word UI title for the row.
   *
   * SUBJECT-LED, not action-led. The old wording asked for "the essence" and
   * then showed "Open Dodo women's page" — an imperative verb phrase — so that
   * is what it produced. It reads fine for one card and fails completely on a
   * wall, where several tasks share a subject and every title is a different
   * verb applied to the same invisible noun. The name's job is to say WHICH
   * THING this is about; the intent underneath already says what is being done.
   *
   * Examples are the real specification here — the model copies their shape far
   * more reliably than it follows the prose, which is why all of them now lead
   * with the subject.
   */
  taskName: [
    'You name a task with a SHORT title for a session list in a UI.',
    'Reply with ONLY a 2-5 word title in plain text — no quotes, no punctuation, no trailing period.',
    'Lead with the SUBJECT — the thing the work is about — and never with the action being taken on it.',
    'The user will have several tasks about the same subject, so the title must identify which subject it is,',
    'adding a distinguishing detail only after the subject is clear.',
    'e.g. "Dodo checkout page", "Twitter strategy folder", "Notch freeze on wake", "Unmute pricing model".',
  ].join(' '),
} as const
