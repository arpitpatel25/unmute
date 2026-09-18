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

/**
 * FIELD FAILURE (2026-09-18). The file alone was not enough either: the Agent
 * grepped it as `rg -m 50 'Tanmay|WhatsApp'` under a 12,000-token output cap.
 * The file is in indexing order, not time order, so the cap stopped at line
 * 3,186 of 15,855; the output then lost its middle, and 44 turns naming the
 * person never arrived. index_search is allowed only because it has neither
 * property sessions_search had — it reads the whole index and says what it has
 * not shown — and it sits BESIDE Grep, which the test above keeps named.
 */
test('the index can be searched whole, in every spelling, and a capped grep is not silence', () => {
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__index_search reads the WHOLE index/)
  // Speech is transcribed; one person is spelled five ways in a real index.
  assert.match(AGENT_PRINCIPLES, /give it every spelling/)
  // A common word beside a name widens the search, it does not narrow it.
  assert.match(AGENT_PRINCIPLES, /a common word beside it/)
  // A page with more after it is not the answer.
  assert.match(AGENT_PRINCIPLES, /When `remaining` is not zero you have not seen everything/)
  // And the hand-written grep keeps its warning.
  assert.match(AGENT_PRINCIPLES, /never cap it by count/)
  assert.match(AGENT_PRINCIPLES, /not a capped or truncated one/)
  // It finds WHICH sessions; the transcript still says what happened.
  assert.match(AGENT_PRINCIPLES, /the transcript at `o` is how you find out what happened/)
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
  // A FILE MAY BE RECOMMENDED; A TOOL MAY NOT BE MANDATED.
  //
  // This once asserted "in whatever order the question deserves", because the
  // first version of this rule refused to point anywhere. That was the right
  // instinct aimed at the wrong target: what made "Start with
  // mcp__unmute__sessions_search" harmful was that it sent the Agent into a
  // TOOL that failed silently and capped the queries it could express. A file
  // it greps itself has neither property — an empty result is visibly empty,
  // and its own judgement still applies on top. So the index is now named as
  // where a past-work question starts, and no tool is.
  assert.doesNotMatch(AGENT_PRINCIPLES, /Start with mcp__unmute__/)
  assert.match(AGENT_PRINCIPLES, /the index is where to start/)
})

/**
 * The rule used to fire on "another approach" and "an experiment", which is
 * exactly how someone phrases an ordinary change of direction — "let's try it
 * another way" would have forked. A fork nobody asked for leaves two sessions
 * with the same project, topic and opening, and that is what makes the right
 * one unfindable later.
 */
test('fork is a second session, not a change of direction', () => {
  assert.match(AGENT_PRINCIPLES, /FORK IS A SECOND SESSION/)
  assert.match(AGENT_PRINCIPLES, /carries on as its own thread/)
  // the direction-shaped phrasings must be named as NOT forks
  assert.match(AGENT_PRINCIPLES, /try it another way/)
  assert.match(AGENT_PRINCIPLES, /ordinary continuations of the SAME conversation/)
  // and the loose triggers must be gone
  assert.doesNotMatch(AGENT_PRINCIPLES, /asks for another approach/)
  assert.doesNotMatch(AGENT_PRINCIPLES, /an experiment, or to preserve/)
})

test('the verb is decided before the session', () => {
  assert.match(AGENT_PRINCIPLES, /WHAT THEY ARE ASKING FOR DECIDES WHERE IT GOES/)
  assert.match(AGENT_PRINCIPLES, /Nothing is resumed and nothing is opened/)
  // the trap: reads retrospective, is actually an instruction to act
  assert.match(AGENT_PRINCIPLES, /do that same thing again for this one/)
  assert.match(AGENT_PRINCIPLES, /whether there is a new object in the sentence/)
})

/**
 * Surfacing a card is free and undoes itself; putting words into a live session
 * makes it act, and no card closes hard enough to unedit a file. So the two
 * halves get opposite dispositions — and neither of them is a question.
 */
test('bringing a session up is free, delivering into it is not', () => {
  assert.match(AGENT_PRINCIPLES, /BRING IT UP FREELY; PUT WORDS IN IT CAREFULLY/)
  assert.match(AGENT_PRINCIPLES, /you never ask permission/)
  assert.match(AGENT_PRINCIPLES, /is not a request, it is an address/)
  assert.match(AGENT_PRINCIPLES, /the card appearing IS how you ask/)
})

test('the answer belongs to the session, and is never echoed back', () => {
  assert.match(AGENT_PRINCIPLES, /THE SESSION'S ANSWER IS THE SESSION'S/)
  assert.match(AGENT_PRINCIPLES, /do not repeat it/)
  assert.match(AGENT_PRINCIPLES, /two records of one exchange/)
  assert.match(AGENT_PRINCIPLES, /not the place the conversation happens/)
  // The handoff is the LINK. The notch classifies unmute://task/<id> as its own
  // link kind and routes a tap to focusTask — the same event a card click
  // sends — so the exact scheme here is load-bearing, not cosmetic.
  assert.match(AGENT_PRINCIPLES, /unmute:\/\/task\/<taskId>/)
  assert.match(AGENT_PRINCIPLES, /never invent a taskId/)
})

test('what is open, and the undo, are both named', () => {
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__sessions_open/)
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__session_close/)
  // Closing a card must never be described as deleting the conversation.
  assert.match(AGENT_PRINCIPLES, /never say a conversation was deleted/)
  // The undo is the Agent's to call, not a chore handed back to the user.
  assert.match(AGENT_PRINCIPLES, /rather than something to ask them to do/)
})

test('pocket tasks are matched from pocket_list, and none-found is said plainly', () => {
  assert.match(AGENT_PRINCIPLES, /call mcp__unmute__pocket_list first/)
  assert.match(AGENT_PRINCIPLES, /Several: ask which, naming\s+them/)
  assert.match(AGENT_PRINCIPLES, /there is no such task in the pocket/)
  // "Remove" leaves the pocket only; it is never a delete.
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__task_remove_from_pocket for 'remove it'/)
  assert.match(AGENT_PRINCIPLES, /it only leaves the pocket: it keeps\s+running, stays in the orchestrator/)
  assert.doesNotMatch(AGENT_PRINCIPLES, /\bshel(f|ve|ved)\b/i)
})

test('delete is the orchestrator\'s, only on an explicit delete, and only after a confirmation turn', () => {
  assert.match(AGENT_PRINCIPLES, /the POCKET is what is in front of them now; the ORCHESTRATOR holds every task/)
  assert.match(AGENT_PRINCIPLES, /Use it only when the\s+person explicitly asks to delete — never for remove, hide, close or clear/)
  assert.match(AGENT_PRINCIPLES, /confirmed: true only after they confirm in a later turn/)
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
  // The rule it must not contradict is still present and unweakened. It was
  // renamed when the word "note" was taken back from memory (2026-09-07): the
  // guard is the BEHAVIOUR — answer from memory, offer, stop — not the title.
  assert.match(AGENT_PRINCIPLES, /YOUR MEMORY ANSWERS WHAT YOU WERE TOLD TO KEEP/)
  assert.match(AGENT_PRINCIPLES, /Do not go looking/)
  // And the carve-out that caused the rename: a thing they MAINTAIN is a place.
  assert.match(AGENT_PRINCIPLES, /is not your memory\. It is a place in the world/)
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
  'pocket_list', 'task_rename', 'task_stop', 'task_end', 'task_remove_from_pocket', 'task_delete',
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

// ── THE PRECEDENCE RULES ────────────────────────────────────────────────────
//
// Every rule added to this file during 2026-09-07 collided with one already in
// it, and the model picked whichever was stated more absolutely — correctly,
// because nothing said which won. Three separate field failures, one shape.
// These tests assert the TIE-BREAKS, not that the paragraphs exist: a rule
// nobody has ranked is the bug, and it reads fine right up until it fires.

/**
 * FIELD FAILURE. "We had a discussion about CUA… I asked you if Codex has it…
 * and if we had the latest version… so let's continue the discussion please."
 * Three question-shaped clauses then a continuation, and it answered instead
 * of reopening — the retrospective rule fired because the recap was longer.
 */
test('a recap followed by "let\'s continue" is a continuation, not a question', () => {
  assert.match(AGENT_PRINCIPLES, /WHEN A MESSAGE DOES BOTH, THE ENDING GOVERNS/)
  assert.match(AGENT_PRINCIPLES, /how they told you WHICH session/)
  assert.match(AGENT_PRINCIPLES, /however many question-shaped sentences came first/)
  // ...and the other side of the tie-break, so this does not swallow a genuine question.
  assert.match(AGENT_PRINCIPLES, /no such closing instruction is retrospective/)
})

/**
 * FIELD FAILURE. Asked to add an item to the Unmute task list, sessions_open
 * returned a LIVE card titled "Unmute Apple Notes" — and it called task_create
 * anyway, because WORK THAT LEAVES UNMUTE said to, unconditionally.
 */
test('an existing home beats a new task, and "home" means a thread not a topic', () => {
  assert.match(AGENT_PRINCIPLES, /WORK THAT ALREADY HAS A HOME GOES HOME/)
  assert.match(AGENT_PRINCIPLES, /home of a thread, not of a topic/)
  // The over-routing guard: same subject is NOT enough, or every task in a repo
  // lands in whichever session once read that repo.
  assert.match(AGENT_PRINCIPLES, /same work continuing/)
  // It must cover sleeping sessions too — sessions_open only sees cards.
  assert.match(AGENT_PRINCIPLES, /a session that has to be woken is still its home/)
  assert.match(AGENT_PRINCIPLES, /only the ones with cards/)
  // And it must not become a rule against task_create, which is the normal case.
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__task_create is for work with nowhere to go yet/)
})

/**
 * It drifted to source files and to memory instead of the index. The index is
 * complete, so its silence is information — that is the fact that makes it a
 * sane first stop, and the fact that stops a fruitless 29 GB sweep after.
 */
test('the index is where a past-work question starts, and its silence counts', () => {
  assert.match(AGENT_PRINCIPLES, /the index is where to start/)
  assert.match(AGENT_PRINCIPLES, /ITS SILENCE MEANS SOMETHING/)
  assert.match(AGENT_PRINCIPLES, /not a reason to go hunting through 29 GB/)
  // Memory is a peer, not a loser: "what have I saved" is still memory's question.
  assert.match(AGENT_PRINCIPLES, /asked side by side rather than in order/)
})

/**
 * A resume can half-succeed: the session opens and the message does not land.
 * Reported as failure, that produced an apology and a clipboard.
 */
test('a half-delivered resume is described as what it is', () => {
  assert.match(AGENT_PRINCIPLES, /delivered:false/)
  assert.match(AGENT_PRINCIPLES, /sitting in its composer unsent/)
  assert.match(AGENT_PRINCIPLES, /never that it failed and never that it was delivered/)
})

/**
 * FIELD FAILURE, 2026-09-07, twice in five minutes. A request to add a line to
 * a note the person keeps became a memory write on zero searches; a request to
 * comp an account became a task on a single tool call, while a session naming
 * the right Supabase project sat one grep away. Both rules that should have
 * caught it were phrased as things to CONSIDER — "ask whether a session is
 * already doing this work" — which a model answers from priors and proceeds.
 */
test('the first act of a turn is a read, and all three are read together', () => {
  assert.match(AGENT_PRINCIPLES, /LOOK BEFORE YOU DECIDE ANYTHING/)
  // Parallel, not sequential: a sequence gives three chances to stop early.
  assert.match(AGENT_PRINCIPLES, /issued TOGETHER, in one message/)
  // All three named, and named as non-substitutable.
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__sessions_open/)
  assert.match(AGENT_PRINCIPLES, /session-index/)
  assert.match(AGENT_PRINCIPLES, /mcp__unmute__memory_list/)
  assert.match(AGENT_PRINCIPLES, /not substitutes/)
  // Reading BEFORE classifying is the whole point — classifying first is how
  // "this is just something to save" skips the search.
  assert.match(AGENT_PRINCIPLES, /BEFORE you have decided what kind of request this is/)
  assert.match(AGENT_PRINCIPLES, /You have not looked until a search has returned/)
  // The exception, stated rather than left to be invented: a read made
  // earlier in the SAME conversation counts, and a recollection does not.
  assert.match(AGENT_PRINCIPLES, /a read YOU MADE IN THIS CONVERSATION/)
  assert.match(AGENT_PRINCIPLES, /Your own recollection is not a read/)
  // And it expires, or turn 18 quietly trusts turn 1 again.
  assert.match(AGENT_PRINCIPLES, /a memory of a read, which is a prior again/)
})

test('answering is an outcome, so the Agent is not reduced to a router', () => {
  assert.match(AGENT_PRINCIPLES, /THEN DECIDE WHETHER ANYTHING NEEDS TO HAPPEN AT ALL/)
  assert.match(AGENT_PRINCIPLES, /You are\s+not a router/)
  // The line is finishable-in-this-turn, NOT read-versus-write: a read-only
  // sweep of thirty transcripts is still a task.
  assert.match(AGENT_PRINCIPLES, /not read-versus-write/)
})

test('several candidates are separated by what they touched, then by what the person did', () => {
  assert.match(AGENT_PRINCIPLES, /WHEN MORE THAN ONE COULD BE IT/)
  // Artifacts are read at decision time from the transcript, never kept in a
  // list — filtering them needs the context an index cannot carry.
  assert.match(AGENT_PRINCIPLES, /byte offset/)
  assert.match(AGENT_PRINCIPLES, /not kept in a list somewhere/)
  // Engagement is the tie-break, and the reason it beats any self-report.
  assert.match(AGENT_PRINCIPLES, /cannot write about itself/)
  // The field that carries it, and the two traps it exists to avoid.
  assert.match(AGENT_PRINCIPLES, /`returns` on the session row/)
  assert.match(AGENT_PRINCIPLES, /recency on its own points the wrong way/)
  assert.match(AGENT_PRINCIPLES, /Never rank on how a session says it went/)
  // A destination is resolved the same way — the note id is never spoken.
  assert.match(AGENT_PRINCIPLES, /appears nowhere in anything they ever said/)
})

test('the chosen session is named out loud, with the reason, before the work', () => {
  assert.match(AGENT_PRINCIPLES, /SAY WHICH ONE, AND WHY, IN THE SAME BREATH/)
  assert.match(AGENT_PRINCIPLES, /being wrong SILENTLY/)
  // It announces; it does not ask. Waiting would make every resume a question.
  assert.match(AGENT_PRINCIPLES, /not a request for permission/)
})

test('an open card is read alongside the index, and its silence proves nothing', () => {
  assert.match(AGENT_PRINCIPLES, /ALONGSIDE the index at the start of a turn, never instead of it/)
  assert.match(AGENT_PRINCIPLES, /says nothing whatever about what is on disk/)
})

/**
 * FIELD FAILURE, 2026-09-08. The Agent found exactly the right session for
 * "create a new dev build" — the one that had done every build that day — and
 * could not resume it, because it is a Claude session live in a terminal and a
 * session has one writer. What reached the person was the raw provider error,
 * "Could not resume Claude: Claude session closed", so they asked for a retry
 * of something that could never work. The retrieval was right; the sentence
 * was not.
 */
test('a session Unmute did not start is readable, not resumable', () => {
  assert.match(AGENT_PRINCIPLES, /A SESSION UNMUTE DID NOT START IS YOURS TO READ, NOT TO RESUME/)
  // The check is on cwd, which the index already records, and it happens FIRST.
  assert.match(AGENT_PRINCIPLES, /look at the cwd\s+BEFORE calling mcp__unmute__session_resume/)
  // And the reason is a real constraint, not a policy we invented.
  assert.match(AGENT_PRINCIPLES, /a Claude session has ONE writer/)
})

test('a blocked action is explained, offered an alternative, and only then asked about', () => {
  assert.match(AGENT_PRINCIPLES, /WHEN SOMETHING IS BLOCKED, SAY WHAT IS TRUE AND OFFER WHAT YOU CAN DO/)
  assert.match(AGENT_PRINCIPLES, /never an\s+explanation for them/)
  // Asking is bounded: only when the alternative differs in kind. Picking
  // between candidates is announced, not put to a vote.
  assert.match(AGENT_PRINCIPLES, /Choosing between candidate sessions is NOT/)
  assert.match(AGENT_PRINCIPLES, /never make a question out of a decision that is yours/)
})

/**
 * FIELD FAILURES, 2026-09-08 — four things that went wrong while nothing
 * "failed": a session was cited without being read, a decision not to resume
 * was never mentioned, a procedure stopped one step short, and a card closed
 * describing work it had already done as still to come.
 */
test('a session that did the job outranks a doc, and a citation means it was read', () => {
  assert.match(AGENT_PRINCIPLES, /A SESSION THAT DID THIS JOB OUTRANKS A DOCUMENT ABOUT IT/)
  assert.match(AGENT_PRINCIPLES, /Never name a session there you did not open/)
  // The document is not banned — it is the supplement, and attribution is owed.
  assert.match(AGENT_PRINCIPLES, /say which gave you what/)
})

test('choosing not to resume is said out loud, not only failing to', () => {
  assert.match(AGENT_PRINCIPLES, /DECLINING TO DO SOMETHING IS ALSO A THING TO SAY/)
  assert.match(AGENT_PRINCIPLES, /Explaining yourself is not only for what FAILS/)
})

test('a procedure runs to its last step, and stopping short is a decline', () => {
  assert.match(AGENT_PRINCIPLES, /A PROCEDURE IS FINISHED WHEN ITS LAST STEP IS DONE/)
  assert.match(AGENT_PRINCIPLES, /steps, not decoration/)
})

test('the closing line describes what happened, not what was in flight', () => {
  assert.match(AGENT_PRINCIPLES, /WHAT YOU SAY YOU DID IS WHAT YOU DID/)
  assert.match(AGENT_PRINCIPLES, /in the past tense/)
})

test('an unexplained refusal is met by changing shape, then by saying so', () => {
  assert.match(AGENT_PRINCIPLES, /A REFUSAL YOU DO NOT UNDERSTAND IS NOT ANSWERED BY GUESSING/)
  assert.match(AGENT_PRINCIPLES, /a SHAPE, not a size/)
  assert.match(AGENT_PRINCIPLES, /if two attempts do not land, stop/)
})

/**
 * FIELD FAILURE, 2026-09-08. "Delivered into the composer" was reported in
 * four paragraphs. The fact the person needed was the first clause; the rest
 * was everything the Agent had noticed on the way. A routing action and an
 * answer to a question were indistinguishable at a glance, so both had to be
 * read.
 */
test('an action is a one-line receipt in a fixed mould; a question is not', () => {
  assert.match(AGENT_PRINCIPLES, /AN ACTION GETS A RECEIPT, A QUESTION GETS AN ANSWER/)
  // The moulds are spelled out, because a style instruction alone does not hold.
  for (const mould of [/Continuing <name>/, /Sent to <name>/, /In <name>/, /Made <name>/, /Forked <name>/, /Closed <name>/]) {
    assert.match(AGENT_PRINCIPLES, mould)
  }
  // One extra line, and only when it changes what they do next.
  assert.match(AGENT_PRINCIPLES, /changes what they would do next/)
  // And the other half: a question keeps its full length.
  assert.match(AGENT_PRINCIPLES, /answer it at the length the answer takes/)
})
