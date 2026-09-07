import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_PRINCIPLES, agentConstitution } from './constitution'

/**
 * `a64ab19` replaced the paragraph telling the Agent to Glob and Grep the disk
 * with one describing an index — and left both tools in the allowlist. It kept
 * the capability and lost the instruction to use it, which is an Agent that
 * behaves LESS capable than a bare Claude Code session while holding the exact
 * tools that would answer. This is the test that keeps the raw disk nameable.
 */
test('the raw-search path is named, not merely permitted', () => {
  assert.match(AGENT_PRINCIPLES, /Glob, Grep and Read/)
  assert.match(AGENT_PRINCIPLES, /~\/\.claude\/projects/)
  assert.match(AGENT_PRINCIPLES, /~\/\.codex\/sessions/)
})

/**
 * FIELD FAILURE (2026-09-06). `sessions_search` read 64 KB from a transcript's
 * head and 64 KB from its tail — 0.369% of a real 33.9 MB session — and made
 * every query token mandatory, so "opened" or "wrong" discarded a session
 * outright. The Agent called it 22 times over 144s and $2.15 and never found a
 * session that was on disk the whole time; a bare Claude Code session found it
 * with one grep. A tool over readable data caps the Agent at the queries its
 * schema author imagined, so the replacement is a FILE, and no prose may send
 * the Agent to a query tool first.
 */
test('no tool stands between the Agent and the transcripts', () => {
  assert.doesNotMatch(AGENT_PRINCIPLES, /sessions_search/)
  assert.doesNotMatch(AGENT_PRINCIPLES, /Start with mcp__unmute__/)
})

test('the verbatim turn index is described, with its limits, and never mandated', () => {
  assert.match(AGENT_PRINCIPLES, /session-index/)
  assert.match(AGENT_PRINCIPLES, /turns\.jsonl/)
  // Naming what it OMITS is what lets the Agent decide to go past it.
  assert.match(AGENT_PRINCIPLES, /no assistant replies/)
  assert.match(AGENT_PRINCIPLES, /no summary of any kind/)
  // ...and naming what makes it CHEAP and COMPLETE is what makes reaching for
  // it first a decision the Agent can make on the facts, rather than an order.
  // The first live run grepped 29 GB because nothing told it the alternative
  // was complete; a paragraph that lists only limits argues against itself.
  assert.match(AGENT_PRINCIPLES, /complete, and current to the second/)
  assert.match(AGENT_PRINCIPLES, /29 GB/)
  assert.match(AGENT_PRINCIPLES, /26 MB/)
  assert.match(AGENT_PRINCIPLES, /the way IN to them/)
  // Still described, never ordered.
  assert.doesNotMatch(AGENT_PRINCIPLES, /Start with mcp__unmute__/)
  assert.match(AGENT_PRINCIPLES, /in whatever order the question deserves/)
})

test('what is open, and the undo, are both named', () => {
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__sessions_open/)
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__session_close/)
  // Closing a card must never be described as deleting the conversation.
  assert.match(AGENT_PRINCIPLES, /never say a conversation was deleted/)
  // The undo is the Agent's to call, not a chore handed back to the user.
  assert.match(AGENT_PRINCIPLES, /rather than something to ask them to do/)
})

test('there is one retrieval rule and it points at the transcripts', () => {
  // The digest tier was removed with the summary sweep, so the ladder is flat:
  // no record to read first, and nothing to fall back FROM. A lingering
  // "read the record first" would send the Agent to a file nothing writes.
  assert.doesNotMatch(AGENT_PRINCIPLES, /READ THAT FILE FIRST/)
  assert.doesNotMatch(AGENT_PRINCIPLES, /recent-sessions\.md/)
  assert.match(AGENT_PRINCIPLES, /\.claude\/projects/)
  assert.match(AGENT_PRINCIPLES, /\.codex\/sessions/)
  assert.match(AGENT_PRINCIPLES, /only true once you have actually looked/)
})

/**
 * The ladder and the retrieval rule point opposite ways. Without an explicit
 * seam, "fall back to searching the disk" contradicts "do not go looking", and
 * the Agent crawls the filesystem every time it is asked where something was
 * saved.
 */
test('the ladder is sealed off from the memory-retrieval rule', () => {
  assert.match(AGENT_PRINCIPLES, /NONE OF THIS APPLIES TO YOUR OWN MEMORY/)
  assert.match(AGENT_PRINCIPLES, /empty memory is still an honest answer/)
  // The rule it must not contradict is still present and unweakened.
  assert.match(AGENT_PRINCIPLES, /RETRIEVAL MEANS YOUR MEMORY/)
  assert.match(AGENT_PRINCIPLES, /Do not go looking/)
})

test('the record is named by path, so there is one place to look', () => {
  // The pre-built digest was withdrawn with the summary sweep; the Agent is
  // pointed at the transcripts on disk instead.
  assert.match(AGENT_PRINCIPLES, /\.claude\/projects\//)
})

/**
 * Cross-harness continuation is composed by the Agent, not by a template in
 * TypeScript, and it must never be described as moving a thread.
 */
test('carrying work across harnesses is composed, and described honestly', () => {
  assert.match(AGENT_PRINCIPLES, /read what you need, write the account yourself/)
  assert.match(AGENT_PRINCIPLES, /Never paste session identifiers into the context prose/)
  assert.match(AGENT_PRINCIPLES, /never "moved them to Codex"/)
})

test('resuming needs no name for the session', () => {
  assert.match(AGENT_PRINCIPLES, /session_resume/)
  assert.match(AGENT_PRINCIPLES, /never answer a question about their own past with a question/)
})

test('continuation policy keeps resume, fork, synthesis, and fresh work distinct', () => {
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__session_fork/)
  assert.match(AGENT_PRINCIPLES, /same conversation/i)
  assert.match(AGENT_PRINCIPLES, /alternative|branch/i)
  assert.match(AGENT_PRINCIPLES, /several sessions|multiple sessions/i)
  assert.match(AGENT_PRINCIPLES, /start clean|fresh/i)
})

test('reopening never manufactures a continuation prompt', () => {
  assert.match(AGENT_PRINCIPLES, /omit intent/i)
  assert.doesNotMatch(AGENT_PRINCIPLES, /Continue from where we left off/)
})

test('synthesis preserves exact source and artifact provenance', () => {
  assert.match(AGENT_PRINCIPLES, /sourceSessions/)
  assert.match(AGENT_PRINCIPLES, /artifacts/)
  assert.match(AGENT_PRINCIPLES, /decisions, constraints/i)
})

/**
 * The summary sweep and its index went in cc48bbf, and "the record" went with
 * them. Aiming the Agent at a file nothing writes is the same fault the
 * neighbouring tier was rewritten to avoid.
 */
test('resuming sends the Agent to the transcripts, not to a withdrawn record', () => {
  assert.doesNotMatch(AGENT_PRINCIPLES, /[Ff]ind it in the record/)
})

/** Deleted tools must not still be advertised as available. */
test('no removed tool is still named as if it existed', () => {
  for (const gone of ['sessions_list', 'sessions_search', 'session_read', 'session_continue_in']) {
    assert.doesNotMatch(AGENT_PRINCIPLES, new RegExp(gone), `${gone} is gone but still named`)
  }
})

test('the session preamble is composed in, not replaced', () => {
  const composed = agentConstitution('SESSION PREAMBLE HERE')
  assert.match(composed, /^SESSION PREAMBLE HERE/)
  assert.ok(composed.includes(AGENT_PRINCIPLES))
})

/**
 * The Agent could always READ a file and could always store a memory, but it
 * had no way to put the FILE itself into one — attachments only ever arrived as
 * screenshots taken mid-utterance. "Save this video" produced a sentence about
 * a video.
 */
test('keeping an actual file is named, with the large-file answer', () => {
  assert.match(AGENT_PRINCIPLES, /memory_keep_file/)
  assert.match(AGENT_PRINCIPLES, /kept by reference to where it already lives, never refused/)
  assert.match(AGENT_PRINCIPLES, /A link goes in references/)
})

test('it is told to find the file rather than guess at its path', () => {
  assert.match(AGENT_PRINCIPLES, /never assemble a path from where you expect a thing to be/)
})

// ── THE TOOL NAMES IN THIS PROSE MUST BE THE REAL ONES ──
//
// FIELD FAILURE (2026-08-31). Asked to save something, the Agent called
// `memory_search`, got "No such tool available", called `memory_list`, got the
// same, and then told the user "my memory tools were unavailable" and created a
// task instead. Its memory was never unavailable: the tools are exposed over
// MCP as `mcp__unmute__memory_search` (init.ts registers the server under the
// key `unmute`), and the very next call in that transcript —
// `mcp__unmute__task_create` — succeeded.
//
// The list of real names is in the model's context on every turn. A tool call
// is still GENERATED text, not a menu selection, so a wrong name is possible
// however good the list is. What made it likely was this file: it named every
// tool bare, priming a string that does not exist, and relied on the model to
// translate silently. It did so 34 times for memory_search alone before this.
//
// Removing the mismatch is the cheap half. The rule below it is the half that
// actually protects the user.

const TOOL_NAMES = [
  'memory_list', 'memory_store', 'memory_search', 'memory_get',
  'task_create', 'task_status', 'session_resume', 'session_fork',
  'sessions_open', 'session_close',
  'unmute_history_search', 'unmute_history_copy',
  'notetaker_list', 'notetaker_read', 'notetaker_search', 'notetaker_open',
]

test('every tool it is told to call is named exactly as it is exposed', () => {
  for (const name of TOOL_NAMES) {
    for (const m of AGENT_PRINCIPLES.matchAll(new RegExp(name, 'g'))) {
      const before = AGENT_PRINCIPLES.slice(Math.max(0, m.index - 14), m.index)
      assert.ok(
        before.endsWith('mcp__unmute__'),
        `"${name}" appears without its mcp__unmute__ prefix — that string is not a tool`,
      )
    }
  }
})

/**
 * The more important half. A missing-tool error says "you spelled it wrong",
 * not "you have no memory" — and the Agent turned one into the other, then
 * substituted an action nobody asked for and reported a capability outage that
 * had not happened.
 */
test('a missing-tool error is a naming mistake, not a capability outage', () => {
  assert.match(AGENT_PRINCIPLES, /No such tool/i, 'names the error it must not misread')
  assert.match(AGENT_PRINCIPLES, /retry with the full name/i, 'says what to do instead')
  assert.match(AGENT_PRINCIPLES, /never tell the person a capability of yours is unavailable/i,
    'and forbids the false report that was actually made')
})

test('it must not silently substitute a different action for the one asked', () => {
  assert.match(AGENT_PRINCIPLES, /do something else instead/i)
})
