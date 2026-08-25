/**
 * What a harness transcript says about itself, without a model.
 *
 * THE FIRST USER MESSAGE IS THE ANSWER MOST OF THE TIME. Asked "which session
 * was that doc in?", the thing that identifies a session is what the person
 * opened it by saying — "Help me think through the fundamentals of what a
 * general-purpose computer-use agent needs to handle…" tells you what that
 * session is far better than its uuid, its directory, or a paragraph a model
 * would charge to write. So facts come first and summaries stay lazy.
 *
 * PURE by construction — no fs, no clock. It is handed text and returns what
 * that text says, which is what makes 717 files testable as a handful of
 * fixtures. The caller decides how much of a file to read; see `HEAD_BYTES`
 * and `TAIL_BYTES` in scan.ts for why it is never the whole thing.
 */

export type Harness = 'claude' | 'codex'

export interface TranscriptFacts {
  /** The harness's own conversation id, when the file states one. */
  sessionId?: string
  /** Working directory the session ran in, when the file states one. */
  cwd?: string
  /** What the person opened with — the strongest identifying signal. */
  opening?: string
  /** The last thing the model said, which is usually where they left off. */
  closing?: string
  /** User turns seen in what was read. A floor, never a total. */
  turnsSeen: number
}

/** Openings and closings are excerpts, not content. */
export const MAX_EXCERPT = 400

export function excerpt(raw: string, limit = MAX_EXCERPT): string {
  const flat = raw.replace(/\s+/gu, ' ').trim()
  const points = [...flat]
  return points.length <= limit ? flat : `${points.slice(0, limit - 1).join('')}…`
}

function jsonLines(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    // A head/tail read cuts mid-line at both ends. A broken line is expected,
    // not exceptional, so it is skipped in silence.
    try { out.push(JSON.parse(trimmed)) } catch { /* truncated edge */ }
  }
  return out
}

/** Codex response items carry `input_text` / `output_text` blocks. */
function textOfCodexContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { text: string } => (
      !!block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text)
    .join(' ')
}

function textOfClaudeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } => (
      !!block && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text)
    .join(' ')
}

/**
 * Unmute's own framing is not what the session is about.
 *
 * Every task Unmute dispatches opens with the same preamble, and every Agent
 * turn opens with providerTranscript()'s. Left in, every Unmute session in the
 * index would be identified by identical boilerplate — which is the same as
 * having no opening at all.
 */
const FRAMING = [
  /^Treat saved or selected material/i,
  /^You are running as an Unmute task/i,
  /^<command-name>/i,
  /^Caveat: The messages below were generated/i,
  // A subagent fork inherits the parent's history behind this marker. The
  // fork's opening is the parent's context, not what the person asked for.
  /^<fork-boilerplate>/i,
  /**
   * THE CATEGORY, NOT THE PHRASING.
   *
   * Enumerating these was whack-a-mole: "You are implementing Task 5 (the last
   * task) of a plan…", then "You are doing a FINAL, WHOLE-PLAN review…", then
   * "You are reviewing one task's implementation…", then the next one. Each
   * pattern fixed exactly one wording and the next spawn invented another.
   *
   * What they share is the form. An opening addressed as "You are …" is a
   * briefing written BY software FOR software — a fork, a plan worker, a
   * reviewer, a notetaker summarisation call. Nobody dictates "You are
   * reviewing one task's implementation" at their laptop.
   *
   * The honest cost: a person could conceivably open a session by typing "You
   * are wrong about the migration". They would lose an opening line and the
   * session would still be searchable by its closing and its project. That is
   * a far smaller error than a fifth of the index presenting machine
   * scaffolding as the user's own work.
   */
  /^You are\b/i,
  /**
   * An opening that starts by stating an absolute path is a briefing too:
   * "In the repo at /Users/…/worktrees/arpit+notetaker, investigate…".
   *
   * Dictation cannot produce a path like that, and a person addressing their
   * own machine does not need to tell it where its own repository is. Being
   * marked derived hides a session from the digest and from default search —
   * it never deletes it, and `includeDerived` still reaches it — so a false
   * positive here costs a rank, not a record.
   */
  /^(?:In|Under|At)\s+(?:the\s+\w+\s+at\s+)?[/~](?:[\w.+-]+\/){2,}/i,
]

function isFraming(text: string): boolean {
  return FRAMING.some((pattern) => pattern.test(text.trim()))
}

/** Strips the sections providerTranscript() adds, leaving the person's words. */
export function unwrapAgentTurn(text: string): string {
  const marker = 'User request:\n'
  const at = text.indexOf(marker)
  if (at < 0) return text
  const rest = text.slice(at + marker.length)
  const end = rest.indexOf('\n\nRecent redacted exchange summaries:')
  const capabilities = rest.indexOf('\n\nAvailable authenticated capabilities:')
  const cut = [end, capabilities].filter((index) => index >= 0).sort((a, b) => a - b)[0]
  return cut === undefined ? rest : rest.slice(0, cut)
}

export function claudeFacts(text: string): TranscriptFacts {
  const facts: TranscriptFacts = { turnsSeen: 0 }
  for (const value of jsonLines(text)) {
    const line = value as Record<string, unknown>
    if (!facts.sessionId && typeof line.sessionId === 'string') facts.sessionId = line.sessionId
    if (!facts.cwd && typeof line.cwd === 'string') facts.cwd = line.cwd

    const message = line.message as { content?: unknown } | undefined
    if (line.type === 'user' && message) {
      const body = unwrapAgentTurn(textOfClaudeContent(message.content)).trim()
      if (!body || isFraming(body)) continue
      facts.turnsSeen += 1
      if (!facts.opening) facts.opening = excerpt(body)
    }
    if (line.type === 'assistant' && message) {
      const body = textOfClaudeContent(message.content).trim()
      if (body) facts.closing = excerpt(body)
    }
  }
  return facts
}

export function codexFacts(text: string): TranscriptFacts {
  const facts: TranscriptFacts = { turnsSeen: 0 }
  for (const value of jsonLines(text)) {
    const line = value as { type?: unknown; payload?: unknown }
    const payload = (line.payload ?? {}) as Record<string, unknown>

    if (line.type === 'session_meta') {
      if (typeof payload.session_id === 'string') facts.sessionId = payload.session_id
      if (typeof payload.cwd === 'string') facts.cwd = payload.cwd
      continue
    }
    // TWO SOURCES SAY THE SAME THING, AND WE NEED BOTH.
    //
    // `event_msg` is the readable stream, but Codex writes an enormous
    // `session_meta` first — it embeds the whole base-instructions prompt, and
    // one file measured 21 MB before its first user turn. Any bounded head read
    // lands inside that blob and sees no conversation at all, which is how ten
    // of the first eighty-five sessions indexed with no opening.
    //
    // `response_item` carries the same turns in the API's own shape and is
    // interleaved from the start, so whichever the reader's window happens to
    // reach, one of them answers.
    if (line.type === 'response_item') {
      const role = payload.role
      const body = unwrapAgentTurn(textOfCodexContent(payload.content)).trim()
      if (!body) continue
      if (role === 'user' && !isFraming(body)) {
        facts.turnsSeen += 1
        if (!facts.opening) facts.opening = excerpt(body)
      }
      if (role === 'assistant') facts.closing = excerpt(body)
      continue
    }
    if (line.type !== 'event_msg' || typeof payload.message !== 'string') continue

    const body = unwrapAgentTurn(payload.message).trim()
    if (payload.type === 'user_message') {
      if (!body || isFraming(body)) continue
      facts.turnsSeen += 1
      if (!facts.opening) facts.opening = excerpt(body)
    }
    if (payload.type === 'agent_message' && body) facts.closing = excerpt(body)
  }
  return facts
}

export function factsFor(harness: Harness, text: string): TranscriptFacts {
  return harness === 'claude' ? claudeFacts(text) : codexFacts(text)
}

/**
 * Merge what the head said with what the tail said.
 *
 * The head owns identity and the opening; the tail owns the closing. Turn
 * counts are summed and remain a floor — the middle of the file was never
 * read, and a number that pretends otherwise would be worse than an honest
 * "at least this many".
 */
export function mergeFacts(head: TranscriptFacts, tail: TranscriptFacts): TranscriptFacts {
  return {
    ...(head.sessionId ?? tail.sessionId ? { sessionId: head.sessionId ?? tail.sessionId } : {}),
    ...(head.cwd ?? tail.cwd ? { cwd: head.cwd ?? tail.cwd } : {}),
    ...(head.opening ?? tail.opening ? { opening: head.opening ?? tail.opening } : {}),
    ...(tail.closing ?? head.closing ? { closing: tail.closing ?? head.closing } : {}),
    turnsSeen: head.turnsSeen + tail.turnsSeen,
  }
}
