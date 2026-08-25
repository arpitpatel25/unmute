# Notetaker transcript cleanup + auto-summarization — Implementation Plan

> Executed inline by the same session that wrote the spec (full context already loaded) — not dispatched to fresh subagents. Task structure kept for tracking/ordering, not as dispatch-ready subagent briefs.

**Goal:** Automatic, toggle-gated cleanup + summarization of every new meeting, through the user's own local headless Claude Code/Codex CLI, plus the settings/UI to control and view it — per the approved spec.

**Spec:** `docs/superpowers/specs/2026-08-25-notetaker-transcript-cleanup-and-summary-design.md`

## Global Constraints

- Provider ids in DB/settings/IPC match the existing `PROVIDERS` registry (`electron/remote/providers.ts`): `'claude'` and `'codex'` — not `'claude-code'` (the spec's prose label, not its storage value).
- `getAgentAvailability()` reuses `probeBackends()` (`electron/remote/init.ts:487`), filtered to the two PTY-transport CLI entries (`id === 'claude'`, `id === 'codex'`), never re-implements CLI detection.
- Cross-tree rule (per `notetakerInit.ts`'s own header comment, and this session's own precedent with `onOpenMeeting`/`onStopPendingChanged`): `engine-overrides/electron/` never imports `electron/remote/` directly. Only `getAgentAvailability` needs the hook; the headless-exec module itself is plain `child_process` and lives OSS-side, same-tree, no hook needed.
- DB migrations follow the existing pattern exactly: `CREATE TABLE IF NOT EXISTS` for new tables, `try { db.exec('ALTER TABLE ... ADD COLUMN ...') } catch {}` for new columns on `meetings` (matches `db.ts`'s own `engine`/`better_transcript` migrations).
- `insertMeeting()` does a full-row `INSERT OR REPLACE` — never route a pipeline-status-only update through it (would require re-supplying every other column or risk clobbering them). New narrow update functions instead, matching `updateMeetingTitle()`'s existing shape.
- No new sound ASSET files — no existing sound-effect infrastructure exists anywhere in this app (confirmed by search), and there's no reliable way to source a licensed "cute, mild, some bass" sound file in this session. Synthesize both chimes with the Web Audio API, in the notetaker widget's already-alive, always-running `AudioContext` (this session's own earlier fix made it never suspend) — zero asset files, zero licensing question, full control over character.
- Every new pure-logic function (id-matching/validation for cleanup, JSON-shape validation for summary, status-transition logic for retry) gets real unit tests, matching this codebase's established "pure logic tested, Electron glue hand-verified via live build" split.
- Full test suite + typecheck must stay clean (only the already-documented pre-existing exceptions) before this is called done — user explicitly asked for no regressions.

---

## Task 1: DB schema — new columns + settings table

**Files:**
- Modify: `engine-overrides/electron/db.ts`

**Interfaces:**
- Produces: `DBMeeting` gains `cleanup_status: 'disabled' | 'pending' | 'success' | 'failed'`, `summary_status` (same union), `cleaned_transcript_path: string | null`, `notes_path: string | null`. New `NotetakerSettingsRow` interface: `{ auto_pipeline_enabled: 0 | 1, provider: 'claude' | 'codex', cleanup_prompt: string | null, summary_prompt: string | null }`. New functions: `getNotetakerSettings(): NotetakerSettingsRow`, `saveNotetakerSettings(patch: Partial<...>): void`, `updateMeetingPipelineStatus(id: string, patch: { cleanup_status?: ...; summary_status?: ...; cleaned_transcript_path?: string | null; notes_path?: string | null }): void`.

- [ ] Add the 4 new `meetings` columns via `try { ALTER TABLE ... } catch {}`, one block per column, in `initDB()` right after the existing `meetings` `CREATE TABLE`.
- [ ] Add `CREATE TABLE IF NOT EXISTS notetaker_settings (id INTEGER PRIMARY KEY CHECK (id = 1), auto_pipeline_enabled INTEGER NOT NULL DEFAULT 0, provider TEXT NOT NULL DEFAULT 'claude', cleanup_prompt TEXT, summary_prompt TEXT)` — single-row table, `id=1` CHECK constraint enforces that. Seed the one row with `INSERT OR IGNORE INTO notetaker_settings (id) VALUES (1)` right after creation so `getNotetakerSettings()` never has to handle "no row yet."
- [ ] `getNotetakerSettings()`: `SELECT * FROM notetaker_settings WHERE id = 1`, cast to `NotetakerSettingsRow`.
- [ ] `saveNotetakerSettings(patch)`: build a dynamic `UPDATE notetaker_settings SET ... WHERE id = 1` from whichever keys are present in `patch` (mirrors no existing partial-update helper in this file — write a small `SET` clause builder, keys whitelisted to the 4 known columns, never string-interpolated user values into the SQL itself).
- [ ] `updateMeetingPipelineStatus(id, patch)`: same dynamic-SET-clause shape, `WHERE id = ?`.
- [ ] Extend `DBMeeting` interface, extend `insertMeeting()`'s column list + `stmt.run()` args to include the 4 new fields (defaulting new inserts to `cleanup_status/summary_status = 'disabled'`, `cleaned_transcript_path/notes_path = null` — the pipeline updates these later via `updateMeetingPipelineStatus`, never through a second `insertMeeting` call).
- [ ] Run `npm test` scoped to any existing db-adjacent tests (there may be none — this file has no `.test.ts` sibling per earlier session searches; if so, this task has no test step of its own, covered instead by Task 7's integration point).

## Task 2: Headless agent execution (OSS-side, no hook)

**Files:**
- Create: `engine-overrides/electron/notetaker/headlessAgent.ts`
- Test: `engine-overrides/electron/notetaker/headlessAgent.test.ts`

**Interfaces:**
- Produces: `runHeadlessAgent(provider: 'claude' | 'codex', input: string, opts?: { timeoutMs?: number }): Promise<{ ok: true; output: string } | { ok: false; error: string }>`. Default `timeoutMs = 300_000`.
- Consumes: Node's `child_process.spawn` only — no other module dependency.

- [ ] Write the function: `spawn('claude', ['-p', input])` for `provider === 'claude'`, `spawn('codex', ['exec', input])` for `'codex'` — collect stdout into a buffer, resolve `{ ok: true, output: stdout.trim() }` on exit code 0, `{ ok: false, error: <stderr or 'exit code N'> }` on non-zero exit or spawn error (`'error'` event), `{ ok: false, error: 'timed out after Nms' }` plus `child.kill()` if it outlives `timeoutMs`. Never throws — every path resolves.
- [ ] Test: mock `child_process.spawn` (matching whatever mocking pattern `keyboard.notetaker.test.ts`/`notetakerController.test.ts` already use for their own fakes — a plain injected fake, not a real spawn) to cover: success (exit 0, stdout captured), non-zero exit, spawn error, timeout. At minimum 4 cases.
- [ ] `node --import tsx --import ./electron/remote/test-setup.ts --test engine-overrides/electron/notetaker/headlessAgent.test.ts` passes.

## Task 3: Cleanup pass

**Files:**
- Create: `engine-overrides/electron/notetaker/transcriptCleanup.ts`
- Test: `engine-overrides/electron/notetaker/transcriptCleanup.test.ts`

**Interfaces:**
- Consumes: `runHeadlessAgent` (Task 2), `TranscriptSegment` type (already exists in `transcriptMerge.ts`).
- Produces: `DEFAULT_CLEANUP_PROMPT: string` (the spec §4 text, verbatim). `buildCleanupInput(segments: TranscriptSegment[]): string` — JSON-stringifies `segments.map((s, id) => ({ id, text: s.text }))`, prefixed with the prompt. `parseCleanupOutput(raw: string, segments: TranscriptSegment[]): TranscriptSegment[]` — pure function, the per-id validation logic from spec §4 (valid JSON array, id matches an input index once, non-empty text → use it; anything else for that id → fall back to that segment's own original `text`). Returns a NEW array, same length/order/metadata as input, only `text` ever differs. `cleanupTranscript(segments, provider, promptOverride?): Promise<{ ok: true; segments: TranscriptSegment[] } | { ok: false; error: string }>` — orchestrates prompt-build → `runHeadlessAgent` → `parseCleanupOutput`; `ok: false` only when the call itself failed or the response wasn't parseable JSON at all (matching spec §4's success/failure line).

- [ ] Write `DEFAULT_CLEANUP_PROMPT` (spec §4 text verbatim).
- [ ] Write `buildCleanupInput` — pure, trivial.
- [ ] Write `parseCleanupOutput` as its own pure, directly-testable function (this is the function most worth getting exhaustively right, since it's the whole hallucination-safety argument from the design discussion).
- [ ] Test `parseCleanupOutput`: valid full response; missing an id (falls back); duplicate id (second occurrence ignored, first wins or first ignored — pick one, document it in a comment, test it); malformed JSON entirely (every segment falls back); empty `text` in a returned entry (falls back, empty string is not a valid correction); extra unknown id in the response (ignored, doesn't crash). At least 6 cases.
- [ ] Write `cleanupTranscript` orchestration, with a fake `runHeadlessAgent` injected for its own tests (2-3 cases: happy path, call failure, unparseable-JSON-at-all failure).
- [ ] All new tests pass.

## Task 4: Summarization pass

**Files:**
- Create: `engine-overrides/electron/notetaker/notesSummary.ts`
- Test: `engine-overrides/electron/notetaker/notesSummary.test.ts`

**Interfaces:**
- Consumes: `runHeadlessAgent` (Task 2), `TranscriptSegment[]`.
- Produces: `DEFAULT_SUMMARY_PROMPT: string` (spec §5 text, verbatim). `export type MeetingNotes = { title: string; summary: string; keyPoints: string[]; decisions: string[]; actionItems: string[] }`. `buildSummaryInput(segments): string` — plain channel-labeled text, per spec §5 ("no raw JSON segment structure needed here"). `parseSummaryOutput(raw: string): MeetingNotes | null` — pure; requires non-empty `title` + `summary`, defaults missing array fields to `[]`, returns `null` on anything short of that. `generateNotes(segments, provider, promptOverride?): Promise<{ ok: true; notes: MeetingNotes } | { ok: false; error: string }>`.

- [ ] Write `DEFAULT_SUMMARY_PROMPT` (spec §5 text verbatim).
- [ ] Write `buildSummaryInput` — pure, joins segments as `${channel}: ${text}` lines (matches how the existing Agent capability already presents transcripts — check `notetaker.ts`'s own formatting for consistency before inventing a new one).
- [ ] Write `parseSummaryOutput` as its own pure function.
- [ ] Test `parseSummaryOutput`: full valid response; missing `title` (null); missing `summary` (null); missing optional arrays (defaults to `[]`); malformed JSON (null); non-string `title`/`summary` (null). At least 6 cases.
- [ ] Write `generateNotes` orchestration with injected fake `runHeadlessAgent` (happy path, call failure, unparseable failure — 3 cases).
- [ ] All new tests pass.

## Task 5: Availability hook (closed-source side) + wiring

**Files:**
- Modify: `electron/remote/init.ts` (expose availability, e.g. a small exported helper wrapping `probeBackends()`)
- Modify: `engine-overrides/electron/notetakerInit.ts` (`NotetakerInitHooks` gains `getAgentAvailability?: () => Promise<{ claude: boolean; codex: boolean }>`)
- Modify: `build/wire-into-engine.sh` (inject the hook the same way `onOpenMeeting`/`onStopPendingChanged` are already injected)
- Modify: `work/oss-engine/electron/main.ts` (hand-patch, same reasoning as this session's earlier hook additions — the wire script's idempotency guard would otherwise skip re-patching an already-patched file)

**Interfaces:**
- Consumes: `probeBackends()` (already exists, `electron/remote/init.ts:487`).
- Produces: `getAgentAvailability(): Promise<{ claude: boolean; codex: boolean }>` — filters `probeBackends()`'s result to `id === 'claude'` and `id === 'codex'`, reads `.ready`.

- [ ] Add a small exported function in `init.ts` near `probeBackends` (not exported before — check whether exporting it directly is simpler than wrapping; wrap only if `probeBackends` itself shouldn't become part of the module's public surface for unrelated reasons found on read).
- [ ] Add `getAgentAvailability` to `NotetakerInitHooks` type in `notetakerInit.ts`, with the same doc-comment shape as `onOpenMeeting`'s own (explains the cross-tree reason).
- [ ] Add the sed-patch block to `wire-into-engine.sh`, following the exact structure of the existing `onOpenMeeting`/`onStopPendingChanged` injections (import + pass into `initNotetaker({...})`).
- [ ] Hand-patch `work/oss-engine/electron/main.ts` to match (idempotency-guard reasoning, as documented at length earlier this session).
- [ ] No test for this task specifically — Electron/cross-process glue, matches this codebase's own established "not unit-tested" convention for this exact class of file (`notetakerInit.ts`'s own header comment). Verified instead via the live build in Task 11.

## Task 6: Pipeline orchestration — wire into `notetakerInit.ts`

**Files:**
- Modify: `engine-overrides/electron/notetakerInit.ts`

**Interfaces:**
- Consumes: `cleanupTranscript` (Task 3), `generateNotes` (Task 4), `getNotetakerSettings`/`updateMeetingPipelineStatus` (Task 1), `hooks.getAgentAvailability` (Task 5).
- Produces: pipeline runs automatically right after `persistSession()` finishes writing `transcript.json`, and is re-invokable (Task 7's retry IPC calls the same internal function).

- [ ] Add a `runNotetakerPipeline(meetingId: string, segments: TranscriptSegment[]): Promise<void>` function: reads `getNotetakerSettings()`; if `!auto_pipeline_enabled`, stamps both statuses `'disabled'` (once, only if they aren't already — don't re-stamp `disabled` over an existing `success`/`failed` on a retry-adjacent path) and returns. Otherwise stamps both `'pending'`, calls `cleanupTranscript`; on success writes `cleaned-transcript.json` (same directory convention as `transcript.json`) and stamps `cleanup_status='success', cleaned_transcript_path=...`, then calls `generateNotes` on the cleaned segments; on success writes `notes.json` and stamps `summary_status='success', notes_path=...`. Any failure at either stage stamps that stage `'failed'` and stops (summary is never attempted if cleanup didn't succeed, per spec §5).
- [ ] Call `runNotetakerPipeline` from the existing `persistSession()` call site in `HookedNotetakerSession.stop()`, fire-and-forget (`.catch()`-guarded, logged, never blocking the existing persist flow or throwing into it) — same non-blocking posture the existing transcription pipeline already has for its own async tail.
- [ ] Log every stage transition through the existing `notetakerLog`/`mlog` child logger, matching this session's own "significant logging" standard from the audio-pipeline work — at minimum: pipeline start (enabled/disabled), cleanup start/result, summary start/result, each with `meetingId` and timing.

## Task 7: IPC surface — settings + retry

**Files:**
- Modify: `engine-overrides/electron/notetakerInit.ts` (new `ipcMain.handle`s)
- Modify: `electron/remote-preload.ts` (new bridge functions)

**Interfaces:**
- Produces IPC channels: `notetaker:get-settings` → `NotetakerSettingsRow` (+ `{ availability: { claude, codex } }` merged in from the hook). `notetaker:save-settings` (patch) → void. `notetaker:retry-pipeline` (meetingId) → void, re-runs `runNotetakerPipeline` scoped to whichever stage(s) haven't succeeded (re-reads the meeting's current `cleanup_status`/`summary_status` from `getMeeting(id)` first — if `cleanup_status !== 'success'`, run both stages from cleanup; if `cleanup_status === 'success' && summary_status !== 'success'`, run summary only against the already-written `cleaned-transcript.json`).

- [ ] Add the three `ipcMain.handle` registrations, following this file's existing handler style (`notetaker:list-meetings`, `notetaker:rename-meeting`, etc. — same error-swallowing/logging conventions).
- [ ] Add the three preload bridge functions (`notetakerGetSettings`, `notetakerSaveSettings`, `notetakerRetryPipeline`), following the existing bridge functions' doc-comment style.

## Task 8: Agent capability — prefer cleaned/notes, fall back to raw

**Files:**
- Modify: `electron/remote/agent/capabilities/notetaker.ts`
- Modify: `electron/remote/agent/capabilities/notetaker.test.ts`
- Modify: `engine-overrides/electron/notetakerInit.ts`'s `notetakerAgentAdapters()` (the `read`/`search` implementations)
- Modify: `electron/remote/agent/constitution.ts`

**Interfaces:**
- `NotetakerAdapters.read`/`.search` (already exist, `notetaker.ts`'s own interface, unchanged signature) — only their OSS-side implementation in `notetakerAgentAdapters()` changes: read `cleaned-transcript.json` when `cleanup_status === 'success'`, else `transcript.json`. `notes.json`'s title (when `summary_status === 'success'`) supersedes `toMeetingSummary()`'s title for `notetaker_list`/`notetaker_read`'s meeting metadata.

- [ ] Update `notetakerAgentAdapters()`'s `read`/`search`/`list` in `notetakerInit.ts` to apply the fallback rule from spec §7 — never partially mix raw and cleaned within one read.
- [ ] Update `constitution.ts`'s existing notetaker paragraph with the one addition from spec §7 (cleaned transcript preferred silently; stored `notes.json` is a ready-made answer, not a rule to re-derive each time).
- [ ] Update `notetaker.ts`'s existing tests only if the capability's own interface/behavior changed (it shouldn't have — the adapters are what changed, and they're mocked in this test file already) — re-run to confirm, add a case only if the mock shape needs to grow to reflect the new fallback being exercised through the adapter contract.
- [ ] Existing `notetaker.test.ts` (11 cases) plus any additions pass.

## Task 9: Sound effects — synthesized start/stop chimes

**Files:**
- Modify: `engine-overrides/renderer/notetaker/NotetakerWidget.tsx`

**Interfaces:**
- Produces: `playNotetakerChime(ctx: AudioContext, direction: 'start' | 'stop'): void` — pure side-effecting function, no return value, synthesizes and plays immediately.

- [ ] Write `playNotetakerChime`: two-oscillator design — a soft sine-wave lead (two-note interval, rising for `'start'`, falling for `'stop'`, ~90ms each note, quick attack/decay `GainNode` envelope for the "mild/cute" character) layered with a quiet low-sine "thump" one to two octaves below the first note's pitch (short, felt more than heard, for "some bass to it"). All nodes created fresh per call and disconnected on their own `onended`, matching this file's existing node-lifecycle discipline elsewhere (`attachMicChunkTap`'s own dispose pattern).
- [ ] Call `playNotetakerChime(ctx, 'start')` in the existing `notetakerOnCaptureActive` handler's `false → true` transition; `playNotetakerChime(ctx, 'stop')` on the `true → false` transition — the exact same branch that already increments `sessionId`, using the same already-guaranteed-`'running'` `audioContextRef.current`.
- [ ] No dedicated test file (this is Web Audio synthesis, not pure logic — matches this file's own established untested-Electron/browser-glue convention) — verified by ear in the live build (Task 11).

## Task 10: Settings UI

**Files:**
- Modify: `engine-overrides/renderer/notetaker/NotetakerSettings.tsx`

**Interfaces:**
- Consumes: `api().notetakerGetSettings()`, `api().notetakerSaveSettings()` (Task 7).

- [ ] Read current file structure first (not yet read this session) before writing — follow its existing layout/style exactly rather than inventing new patterns.
- [ ] Add: toggle (off by default, label states this spends the user's own CLI usage per spec §8), disabled entirely when `availability.claude === false && availability.codex === false` (spec §8's explicit refinement).
- [ ] Add: provider picker, both options always shown, unavailable one visually disabled — same visual language as the Orchestrator Agents checklist (check that file for its exact green-check/disabled treatment before reimplementing from scratch).
- [ ] Add: two prompt textareas (cleanup, summary), each seeded from the default when the stored value is `null`, each with its own "Reset to default" button that saves `null` back (not the default text) — per spec §8's explicit reasoning (inherits future default changes).

## Task 11: Meeting Detail UI — Notes tab, Transcript Cleaned/Raw sub-tabs

**Files:**
- Modify: `engine-overrides/renderer/notetaker/MeetingDetail.tsx`

**Interfaces:**
- Consumes: `notes_path`/`cleaned_transcript_path`/`cleanup_status`/`summary_status` (now present on `DBMeeting` via IPC), `api().notetakerRetryPipeline()` (Task 7).

- [ ] Read current file structure first before writing.
- [ ] Add top-level Notes/Transcript tab pair (replacing today's single view) — reuse whatever tab/`SegmentedControl` component the codebase already has (checked in the persistence-ui spec's own §5 reference to `Orchestrator`'s sub-pages using one already) rather than building a new tab primitive.
- [ ] Transcript tab: Cleaned/Raw sub-tabs, Cleaned default and only enabled when `cleanup_status === 'success'` (else shows the disabled/pending/failed-with-retry state from spec §9); Raw always available, unchanged from today's existing render path.
- [ ] Notes tab: title + date/time (date/time likely already rendered elsewhere on this page — reuse, don't reformat), then Summary/Key Points/Decisions/Action Items as collapsible sections (omit a section entirely if its array/string came back empty, per spec §9 — never render an empty collapsed section), or the disabled/pending/failed-with-retry state.
- [ ] Wire the Retry button to `api().notetakerRetryPipeline(meetingId)`, then re-fetch the meeting row to reflect the new `pending` state immediately.

## Task 12: Full regression pass + live build

- [ ] `npx tsc -p tsconfig.typecheck.json --noEmit` and `npx tsc -p tsconfig.renderer.json --noEmit` — zero NEW errors beyond the already-documented pre-existing ones (both lists are known from this session; diff against them explicitly).
- [ ] `npm test` — zero new failures beyond the documented pre-existing `provider-contract.test.ts` flakes.
- [ ] Re-sync `work/oss-engine/electron/keyboard.ts` + `keyboard.notetaker.test.ts` (existing workflow) and run `keyboard.notetaker.test.ts` against the wired tree — unaffected by this feature, confirms no regression.
- [ ] `unmute-test-build` flow: version bump, flip `DEV_BUILD`/`devLogEnabled` for the build only, full signed build, install, verify version + TeamIdentifier, revert both flags. Live-verify: toggle on with an available provider, record a short real meeting, confirm cleanup + notes appear, confirm the retry button on a forced failure (e.g., temporarily wrong provider) recovers correctly, confirm start/stop chimes are audible and sound as intended, confirm the Agent's `notetaker_read` now returns cleaned text for that meeting.
- [ ] Commit as a new commit (or a small number of logically-grouped commits, matching this session's own established convention) once verified.
