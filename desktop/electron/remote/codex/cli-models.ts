/**
 * CODEX CLI — the models it actually has.
 *
 * ASKED, NOT WRITTEN DOWN. Codex's model line-up is Codex's to change, and it
 * changes often: between codex-cli 0.142 and 0.147 the entire list turned over.
 * Anything hardcoded here is a claim about someone else's product that goes
 * stale without anyone noticing, because a wrong model id does not fail at the
 * picker — Codex takes `-c model="…"` as a TOML override for any string, so the
 * task starts, runs, and fails at the API, or quietly runs on something else.
 *
 * THIS FILE EXISTS BECAUSE THE LIST WAS INVENTED ONCE. The Codex CLI picker
 * shipped with four entries — 'gpt-5.1-codex-max', 'gpt-5.1-codex',
 * 'gpt-5.1-codex-mini', 'default' — that were assumed, never verified against a
 * running Codex. The real 0.147 line-up is six models, none of them by those
 * names, each with its own set of reasoning efforts. A hardcoded catalogue was
 * the wrong shape for this, not merely the wrong contents.
 *
 * THE SOURCE IS THE SAME ONE THE DESKTOP BACKEND ALREADY USES: `model/list`
 * over the app-server protocol (codex/appserver.ts), which answers in about a
 * millisecond, headless, with each model's supported efforts and its default.
 * The only difference here is WHICH BINARY is asked — the `codex` on the user's
 * PATH, which is the one their tasks will actually run, rather than the copy
 * bundled inside the desktop app. Those can be different versions with
 * different line-ups, and offering the list from one while spawning the other
 * is the same lie in a subtler form.
 *
 * EFFORT IS PART OF THE CHOICE, not a separate advanced setting. Codex's own
 * header reads `model: gpt-5.6-terra xhigh` and its picker is titled "Select
 * Model and Effort". Efforts belong to a model — Sol and Terra offer six, Luna
 * five, the 5.4/5.5 family four — so they cannot be a flat second list; they
 * follow whichever model is selected.
 *
 * CACHED, because the pill reads this on the capture path. Spawning a process
 * per keystroke-adjacent repaint is exactly the kind of main-process work that
 * corrupts audio. A stale-by-minutes model list is harmless; a stutter is not.
 */

import { execFile } from 'node:child_process'
import { listCodexModels, type CodexModel, listCodexSkills, type CodexSkill } from './appserver'
import { resolveCodexCli } from './driver'
import { createLogger } from '../log'

const log = createLogger('codex-cli-models')

/** How long a read stays good. Long enough that a burst of pill repaints costs
 *  one spawn; short enough that `codex update` shows up within a session. */
const TTL_MS = 10 * 60_000

let cache: { at: number; models: CodexModel[] } | null = null
let inflight: Promise<CodexModel[]> | null = null

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [bin], { env: process.env }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null)
    })
  })
}

/**
 * Codex CLI's model catalogue, or [] if Codex could not be asked.
 *
 * EMPTY IS A REAL ANSWER and must stay one: it means "we do not know what this
 * Codex offers", and the surfaces draw nothing selectable. The tempting
 * fallback — a remembered list, or Claude's — is what this module exists to
 * delete. A picker that shows models the target does not have is worse than a
 * picker that shows none, because only one of them can silently run your task
 * on the wrong thing.
 */
export async function listCodexCliModels(opts: { force?: boolean; now?: () => number } = {}): Promise<CodexModel[]> {
  const now = opts.now ?? Date.now
  if (!opts.force && cache && now() - cache.at < TTL_MS) return cache.models
  // Coalesce: the pill can ask several times in the same frame, and each of
  // those would otherwise be its own `codex app-server`.
  if (inflight) return inflight
  inflight = (async () => {
    const bin = await resolveCodexCli(which)
    if (!bin) { log.warn('codex-cli-models-no-binary', {}); return [] }
    const models = await listCodexModels({ bin }).catch(() => [] as CodexModel[])
    // A FAILED READ DOES NOT OVERWRITE A GOOD ONE. Codex being momentarily busy
    // should not empty a picker the user is looking at.
    if (!models.length && cache?.models.length) {
      log.warn('codex-cli-models-empty — keeping the last good list', { kept: cache.models.length })
      return cache.models
    }
    cache = { at: now(), models }
    log.event('codex-cli-models-read', { bin, count: models.length, ids: models.map((m) => m.id) })
    return models
  })().finally(() => { inflight = null })
  return inflight
}

/**
 * The skills the user's Codex can see from `cwd`, or [] if it could not be
 * asked. Resolved through the SAME binary the models list uses, so the menu can
 * never describe a Codex other than the one that will run the turn.
 */
export async function listCodexCliSkills(cwd: string, extraRoots: string[] = []): Promise<CodexSkill[]> {
  const bin = await resolveCodexCli(which)
  if (!bin) { log.warn('codex-cli-skills-no-binary', {}); return [] }
  return await listCodexSkills(cwd, { bin, extraRoots }).catch(() => [] as CodexSkill[])
}

/** Drop the cache — after a `codex update`, or when a read must be fresh. */
export function forgetCodexCliModels(): void { cache = null }

/**
 * Resolve the stored (model, effort) pair against what Codex actually offers.
 *
 * BOTH HALVES ARE VALIDATED AGAINST THE LIVE LIST, and a stored value that is
 * no longer offered falls back rather than being passed through. This is the
 * `codex update` case, which is not hypothetical — it is what happened between
 * the build that shipped the invented ids and this one. A user who picked
 * '5.1 Codex Max' in the old build has that string on disk; sending it to a
 * Codex that has never heard of it would start the task and fail at the API.
 *
 * An effort is only meaningful for the model it belongs to (Luna has no
 * 'ultra'), so it is checked against THAT model's list, not against all of
 * them.
 */
export function resolveCodexCliChoice(
  models: readonly CodexModel[],
  storedModel: string | undefined,
  storedEffort: string | undefined,
): { model?: CodexModel; effort?: string } {
  if (!models.length) return {}
  const model = storedModel ? models.find((m) => m.id === storedModel) : undefined
  if (!model) {
    if (storedModel) log.warn('codex-cli-model-not-offered', { storedModel, offered: models.map((m) => m.id) })
    return {}   // no model chosen (or no longer real) ⇒ Codex's own default
  }
  const effort = storedEffort && model.efforts.includes(storedEffort) ? storedEffort : undefined
  if (storedEffort && !effort) {
    log.warn('codex-cli-effort-not-offered', { model: model.id, storedEffort, offered: model.efforts })
  }
  return { model, effort }
}

/** How the pill and the settings screen name a choice: "5.6 Terra Extra High".
 *  Codex's own spelling in both halves — see toUiLabel / toEffortUiLabel. */
export function codexCliChoiceLabel(model: CodexModel | undefined, effort: string | undefined): string {
  if (!model) return 'Default'
  const i = effort ? model.efforts.indexOf(effort) : -1
  const effortLabel = i >= 0 ? model.effortLabels[i] : ''
  return [model.uiLabel, effortLabel].filter(Boolean).join(' ')
}
