/**
 * The Agent's chat.
 *
 * The Agent used to speak in captions: one line, low on the screen, gone in a
 * few seconds. That shape decided everything else about it — the 200-character
 * cap, the instruction never to write a long answer, and the awkward question
 * of where a long answer should GO instead (the clipboard, a file, a task).
 * Every one of those was a workaround for having nowhere to put words.
 *
 * It has somewhere now. The Agent is an element of the pocket, its card shows
 * the concise line, and opening the card shows this: the whole exchange, in the
 * same chat view every other backend already renders into. So "list everything
 * we have to do" is simply answered, at whatever length the answer takes, and
 * the user reads it where it was said.
 *
 * ONE CLOCK, NOT TWO. What clears this is exactly what makes the provider start
 * a fresh session — see continuity.ts. A conversation the user can read but the
 * model has forgotten (or the reverse) is worse than either, so the purge is
 * the same decision applied to both halves.
 *
 * THE MEMORY IS NOT THIS. Purging clears what was SAID; it never touches the
 * memory store, which is the durable half and the whole reason a short-lived
 * conversation costs nothing.
 */

/** One thing said, by one side. */
export interface AgentChatTurn {
  role: 'user' | 'agent'
  text: string
  at: number
  /** Set on a turn that failed, so the view can render it as an error rather
   *  than as something the Agent claimed. */
  failed?: boolean
}

/**
 * How much is kept.
 *
 * A cap on TURNS, not bytes: the view scrolls, and the cost that matters is
 * the one paid re-rendering it. Old turns fall off the front, which is the
 * right end — the last thing said is the thing being read.
 */
export const AGENT_CHAT_MAX_TURNS = 400

/** The longest single turn kept verbatim. Beyond this the view is unusable
 *  anyway and the provider transcript remains the record. */
export const AGENT_CHAT_MAX_CHARS = 20_000

export interface AgentChatSnapshot {
  /** The run these turns belong to. A new run means a new conversation. */
  runId: string | null
  turns: AgentChatTurn[]
}

export class AgentChat {
  private runId: string | null = null
  private items: AgentChatTurn[] = []

  /** What the user said. Recorded before the turn runs, so a failure still
   *  leaves the question visible above the error. */
  said(text: string, at: number): void {
    this.push({ role: 'user', text, at })
  }

  /** What the Agent answered. `failed` marks a turn that did not land. */
  answered(text: string, at: number, failed = false): void {
    this.push({ role: 'agent', text, at, ...(failed ? { failed } : {}) })
  }

  /** Bind the conversation to a provider run. Called when a turn starts. */
  bind(runId: string): void {
    this.runId = runId
  }

  /**
   * PURGED, NOT TRIMMED. Everything goes: continuity has decided the model is
   * starting fresh, and leaving the user reading an exchange the Agent can no
   * longer refer to is the one outcome worse than an empty panel.
   */
  purge(): void {
    this.runId = null
    this.items = []
  }

  get length(): number { return this.items.length }
  get isEmpty(): boolean { return this.items.length === 0 }

  /** The last thing the Agent said — the concise line the pocket card shows. */
  lastAnswer(): AgentChatTurn | null {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].role === 'agent') return this.items[i]
    }
    return null
  }

  snapshot(): AgentChatSnapshot {
    return { runId: this.runId, turns: [...this.items] }
  }

  restore(snapshot: AgentChatSnapshot): void {
    this.runId = snapshot.runId
    this.items = structuredClone(snapshot.turns)
  }

  private push(turn: AgentChatTurn): void {
    const text = turn.text.trim()
    if (!text) return
    this.items.push({ ...turn, text: turn.text })
  }
}

/**
 * The one line the pocket card shows for an answer.
 *
 * NOT A SUMMARY, AND NOT A SECOND ANSWER — the first line of the real one. A
 * model asked for both a short version and a long one writes the short one as
 * an afterthought (the argument caption.ts made, and it still holds); the
 * difference now is that the long version is on screen one tap away rather
 * than clipped into nothing.
 *
 * So: first paragraph, first sentence if that paragraph is long, and an ellipsis
 * to say plainly that there is more. The card is a pointer into the chat.
 */
export function conciseLine(text: string, max = 140): string {
  const first = text.trim().split(/\n{2,}/)[0]?.replace(/\s+/g, ' ').trim() ?? ''
  if (!first) return ''
  if (first.length <= max) return first
  // Prefer a sentence boundary, but only one that is actually near the cap —
  // cutting at the first full stop of a long paragraph loses more than it saves.
  const stop = first.slice(0, max).lastIndexOf('. ')
  if (stop > max * 0.5) return first.slice(0, stop + 1)
  const space = first.slice(0, max).lastIndexOf(' ')
  return `${first.slice(0, space > max * 0.5 ? space : max).trimEnd()}…`
}
