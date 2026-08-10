/**
 * CODEX CLI — App Server events into task state.
 *
 * PURE AND CLOCKLESS, like observer.ts. Events in, a patch out; `now` injected.
 * No socket, no filesystem, no task manager — so the mapping can be tested
 * against the real notification names rather than against a mock of ourselves.
 *
 * WHAT REPLACED WHAT. The rollout reader (cli-observer.ts) folded a whole file
 * on every poll and answered one question: what state is this in. This is fed a
 * stream and answers three — the state, what the agent is doing right now, and
 * what it has said — because the protocol carries all three and the file only
 * ever carried the first reliably.
 *
 * THE TURN IS NOT THE THREAD, and getting that wrong is the bug this exists to
 * end. Codex reports `turn/completed` after every exchange while the thread
 * stays `idle` — alive, loaded, waiting for your next message. The rollout
 * reader saw `task_complete`, called the task done, and let its PTY be reaped;
 * the stage then announced "Session ended" over a conversation that had never
 * stopped. Here the two are separate signals, and only an errand's turn ending
 * means the work is over.
 */

import type { TaskState, TaskQuestion } from '../status-file'
import { activityFromCodexItem, clampLabel, type Activity } from '../activity'

/** What one event changes. Absent keys mean "unchanged" — this is a patch, not
 *  a state, so a stream of events can be applied in order without each one
 *  having to restate everything it did not touch. */
export interface CodexPatch {
  state?: TaskState
  /** null CLEARS the activity — the work stopped, which is different from
   *  "unchanged". An absent key would leave a finished task claiming to be
   *  running the last command it ran. */
  activity?: Activity | null
  /** Text the agent produced this event, to append to the transcript. */
  assistantText?: string
  /** Set once, when the thread is created — the id for resume and interrupt. */
  threadId?: string
  /** A blocking approval, turned into the question the surface already knows
   *  how to show. */
  question?: TaskQuestion
  /** True when a question was resolved and the task is no longer blocked. */
  clearQuestion?: boolean
  /** Set on a failed turn. */
  errorReason?: string
  /** Codex's own name for the thread — a real task title instead of the first
   *  sixty characters of what you said. */
  name?: string
}

/** The Codex thread lifecycle, as far as a task cares. */
export interface CodexThreadView {
  /** notLoaded | idle | active | systemError */
  status?: string
}

/** One notification off the wire. */
export interface AppServerEvent { method: string; params?: Record<string, unknown> }

/* NO `kind` PARAMETER HERE, DELIBERATELY.
 *
 * The obvious design passes oneoff/session in so the reducer can decide whether
 * a completed turn ends the work. It must not: `done` is the correct STATE for
 * both — an errand that finished and a session that finished a step are the
 * same fact about the turn. What differs is what `done` MEANS, and that belongs
 * to the surface (StageView.ended, notch-controller.demanding), which already
 * knows the kind. Deciding it twice is how the two disagreed. */

const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

/**
 * Turn one notification into a patch. Returns null for the sixty-odd
 * notifications that say nothing about a task (token usage, rate limits, MCP
 * startup, fuzzy file search…). Ignoring them explicitly beats a default case
 * that silently swallows a method that starts mattering later.
 */
export function reduceAppServerEvent(e: AppServerEvent): CodexPatch | null {
  const p = obj(e.params)
  switch (e.method) {
    case 'thread/started':
      return { threadId: s(p.threadId), state: 'processing' }

    case 'thread/name/updated':
      return { name: clampLabel(s(p.name)) }

    case 'turn/started':
      // A NEW TURN CLEARS A FINISHED ONE. Without this, replying to a done
      // session left the card showing the previous turn's result while the new
      // one ran.
      return { state: 'processing', activity: null, clearQuestion: true }

    case 'turn/completed': {
      const turn = obj(p.turn)
      const status = s(turn.status)
      // interrupted is NOT a failure — it is the ordinary way to stop a turn you
      // have seen enough of. Mapping it to `failed` made every deliberate Esc
      // demand the user's attention.
      if (status === 'failed') {
        const err = obj(turn.error)
        return { state: 'failed', activity: null, errorReason: s(err.message) ?? 'the turn failed' }
      }
      return { state: 'done', activity: null, clearQuestion: true }
    }

    case 'thread/status/changed': {
      const status = s(obj(p.status).type)
      // `active` is corroboration, not news — turn/started already said so. But
      // it is the one signal that survives a reconnect, so it is honoured.
      if (status === 'active') return { state: 'processing' }
      if (status === 'systemError') return { state: 'failed', activity: null, errorReason: 'Codex reported a system error' }
      // `idle` deliberately does NOT set a state. It means the thread is loaded
      // and waiting — which is true both between turns and while a turn is being
      // prepared. turn/completed owns the transition to done.
      return null
    }

    case 'item/started': {
      const item = obj(p.item)
      const type = s(item.type)
      if (!type) return null
      const a = activityFromCodexItem(type, item)
      return a ? { activity: a } : null
    }

    case 'item/completed': {
      const item = obj(p.item)
      const type = s(item.type)
      if (type === 'agentMessage') {
        // THE REPLY. This is what the rollout reader stopped finding when Codex
        // renamed its records, and why every Codex card said "no recorded
        // output" under a full conversation.
        const text = agentText(item)
        return text ? { assistantText: text, activity: null } : { activity: null }
      }
      // Any other item finishing means that piece of work is over. The next
      // item/started will say what replaced it.
      return { activity: null }
    }

    case 'error':
      return { state: 'failed', activity: null, errorReason: s(p.message) ?? 'Codex reported an error' }

    default:
      return null
  }
}

/**
 * An approval request → the question the surface already knows how to render.
 *
 * SEVEN WAYS A TURN CAN BLOCK, one shape out. Codex distinguishes a command
 * from a patch from a permission grant from an MCP elicitation; a person facing
 * the card only needs to know what is being asked and be able to say yes or no.
 * The distinction is kept in `kind` so the answer can be routed back correctly
 * — answering a patch approval as if it were a command is how a dialog is left
 * open while the task reports itself unblocked.
 */
export function questionFromApproval(method: string, params: unknown): TaskQuestion | null {
  const p = obj(params)
  const reason = s(p.reason)
  switch (method) {
    case 'execCommandApproval':
    case 'item/commandExecution/requestApproval': {
      const cmd = s(p.command) ?? (Array.isArray(p.command) ? (p.command as string[]).join(' ') : undefined)
      return ask(`Run this command?`, cmd ?? reason)
    }
    case 'applyPatchApproval':
    case 'item/fileChange/requestApproval': {
      const changes = obj(p.fileChanges)
      const n = Object.keys(changes).length
      return ask('Apply these file changes?', n ? `${n} file${n === 1 ? '' : 's'}` : reason)
    }
    case 'item/permissions/requestApproval':
      return ask('Grant this permission?', reason)
    case 'mcpServer/elicitation/request':
      return ask(s(p.message) ?? 'A tool is asking for input', reason)
    case 'item/tool/requestUserInput':
      return ask(s(p.prompt) ?? 'The agent needs input from you', reason)
    default:
      return null
  }
}

function ask(text: string, detail?: string): TaskQuestion {
  return {
    text: detail ? `${text}\n\n${detail}` : text,
    // `confirm` with two choices, not `free_text`: an approval is a yes/no, and
    // the card already renders choices as tappable chips. `irreversible` is
    // deliberately NOT set — Codex tells us what it wants to do, not how bad it
    // would be, and claiming to know is worse than not colouring the button.
    kind: 'confirm',
    choices: ['Approve', 'Deny'],
  }
}

/**
 * The wire value for an approval answer.
 *
 * `ReviewDecision` accepts richer forms (approve-and-remember, with policy
 * amendments). We send the plain ones deliberately: a remembered approval is a
 * standing grant the user did not knowingly make, and this surface asks one
 * question at a time.
 */
export function approvalDecision(answer: string): 'approved' | 'denied' {
  return /^(y|yes|approve|approved|allow|ok|go)/i.test(answer.trim()) ? 'approved' : 'denied'
}

/** The text of an agentMessage item, whichever shape this Codex version used.
 *  Three have been observed across versions; all three are read rather than
 *  betting on one, because betting on one is the whole reason this file
 *  exists. */
function agentText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim()
  if (typeof item.message === 'string' && item.message.trim()) return item.message.trim()
  const content = item.content
  if (Array.isArray(content)) {
    const joined = content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
        ? (c as { text: string }).text : ''))
      .join('')
      .trim()
    if (joined) return joined
  }
  return undefined
}
