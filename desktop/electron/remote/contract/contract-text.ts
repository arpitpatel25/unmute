// Unmute Remote — what a session is told about Unmute.
//
// This file used to hold a 244-line operating contract: a status-file protocol,
// a JSON schema, atomic-write instructions, a five-way task taxonomy, heartbeat
// cadence, browser-first tool routing, thoroughness exhortations, and a memory
// section describing a librarian that has been parked since 2026-08-03. It was
// installed as a CLAUDE.md in the session's directory, and — for project-bound
// spawns, where we refuse to write into the user's repo — pasted inline as the
// first USER TURN, then re-anchored around every follow-up.
//
// It is now four lines, and it lives in the system prompt (SESSION_PREAMBLE,
// session-policy.ts) rather than in the conversation. Everything it used to
// carry is either observed from outside (observer.ts, transcript.ts), pushed by
// a lifecycle hook (hooks.ts), or was describing something that no longer runs.
//
// The markers are kept because `installContract` still upserts by them, so an
// older CLAUDE.md written by a previous build is REPLACED rather than appended
// to — a user who ran the old version gets the 244 lines removed from their task
// directories the next time one is touched, instead of accumulating both.
//
// SINGLE SOURCE OF TRUTH: the text comes from SESSION_PREAMBLE. The old split —
// a .ts constant that was the runtime truth and a .md that "MUST be kept in
// sync" — had already drifted by six weeks and two schema fields when it was
// found. Now there is nothing to keep in sync.

import { SESSION_PREAMBLE } from '../session-policy'

export const CONTRACT_BEGIN = '<!-- UNMUTE-REMOTE-CONTRACT:BEGIN -->'
export const CONTRACT_END = '<!-- UNMUTE-REMOTE-CONTRACT:END -->'

export const CONTRACT_TEXT = `${CONTRACT_BEGIN}
${SESSION_PREAMBLE}
${CONTRACT_END}`
