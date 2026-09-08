# Pocket and conversation polish

Branch: `fix/pocket-conversation-polish`, created from local `main` at `095194e2` in a separate worktree. The original checkout and its uncommitted work were left untouched.

## Requested changes

- [x] Pocket uses latest accepted user-input time, including persisted timestamps after restart. Viewing a card and cancelled captures do not update this clock. Unseen needs-user/stuck/error states can temporarily lead; opening acknowledges that state and closing restores normal recency. A new accepted input releases a held browsing order.
- [x] Expanded conversations open on the latest user exchange after layout. Short exchanges clamp to the available content, showing prior context too. The existing latest-user anchor was appropriate; bounded, fully measured layout makes it reliable.
- [x] Native UI initially receives the latest ten visible user/assistant messages. Load earlier adds ten; switching tasks and closing, including blur/Space, resets the window. Intermediate Claude commentary belongs to work and does not evict the latest prompt. Legacy conversation-only records also paginate.
- [x] Expanded left/right navigation starts from the actual focused task. Bare arrows navigate while reading; editable fields and modified selection shortcuts retain their normal behavior.
- [x] Claude task notifications and synthetic provider envelopes are excluded from human messages in both block and legacy transcript projections. Their arrival no longer creates fake user turns or splits the work group.
- [x] Orchestrator tickets occupy one full-width row at all surface sizes. Removed new-conversation buttons from the wall, mini rail, and composer menus.
- [x] Pocket title and preview render inline Markdown, including links and emphasis.
- [x] User prompts and final answers have date/time when known and a button to copy the entire source message. Answers use a single native text storage so selection spans paragraphs, lists, and tables. No response-rating controls were added.
- [x] Latest user text message can be edited and regenerated in idle, Unmute-owned Claude/Codex conversations. Uses a provider-native child and rewinds to the prior answer; original provider history and a local edit recovery snapshot are retained. Earlier messages are not editable. Stale edits and terminal-only commands are refused before mutation. Failed replacement text is retained independently as a composer draft.
- [x] Claude and Codex share the existing per-turn work summary and divider; synthetic messages no longer interrupt it.
- [x] Shared native microphone waveform uses fixed horizontal dots/capsules that grow and shrink vertically with audio level. It no longer scrolls a history of samples sideways. Existing web waveform was already stationary.

## Loading scope

Previously the complete available transcript was sent to the native UI. A lazy SwiftUI stack only deferred some layout; it did not bound IPC or decoding. Pagination now bounds the conversation payload and visible message rendering. The backend still retains/reads provider history for tracking, editing, and fetching earlier pages. Work blocks within the selected exchanges remain available. This is UI history pagination, not provider-side paginated persistence.

## Verification

- 385 focused TypeScript tests passed across Claude/Codex projections, sessions, runtime recovery/routing, transcript parsing, queue and pagination.
- 110 task-manager tests passed in a separate focused run.
- 210 Swift tests passed; native application compiled.
- Native fixture screenshot inspected: latest exchange, short user bubble, Markdown, table, and message timestamps/copy controls lay out without overlap. See [conversation.png](conversation.png).
- Independent review identified and verified fixes for persistent-runtime rollback wiring, operation-scoped fork receipts, rejected-edit preflight, worker upgrades, fallback pagination, and close resets.
- `git diff --check` passed.

The broad repository run reported 3,179 passes and 28 failures. These include a SQLCipher Node ABI mismatch, generated-engine module resolution failures, existing logging/provider timing failures, and a desktop lifecycle test that stalled and was terminated to finish the run. Representative logging, curator, provider and hook failures also reproduce in the original main checkout. The isolated task-manager suite passes. The broad run is not green.

`npm run typecheck` reports the same five missing generated-engine imports in both this worktree and the original main checkout (`better-sqlite3`, paywall wiring, and ffmpeg); no additional errors were reported for the changed code.

## Review boundaries

The installed app was not replaced, real conversations were not regenerated, and the branch was not merged. Provider operations were verified through fixtures/RPC tests, not paid live submissions. Native visual inspection passed; automation could capture the fixture but could not drive its accessibility-unresolved window, so real keyboard/drag performance remains a manual smoke check. Editing is deliberately limited to owned, idle, text-only latest prompts; external app sessions and attachment-bearing latest prompts remain read-only. Historical messages without a source timestamp do not receive invented dates.
