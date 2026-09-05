# Unmute native chat: implementation and acceptance checklist

Status: implementation authorized by the subsequent user request and in progress. See `2026-09-05-native-chat-reference-and-validation.md` for source-backed decisions and evidence. Unchecked acceptance items are not implied passes.

Baseline: local `main` commit `15355de5`, branch `arpit/unmute-astra-remove-terminal`, September 5, 2026. This consolidates the original seven-part task list, the OpenMausBot investigation, the supplied Codex/Claude screenshots, and the subsequent composer and Unmute Agent requirements. It extends that scope rather than replacing it.

Goal: make the notch a complete graphical chat interface for Claude and Codex tasks, with no terminal view required to understand or operate a task. Every user action, provider state, attachment, and failure must have a defined presentation and recovery path.

This is a moderately detailed task inventory and future verification checklist, not implementation code or a claim that the listed features already work. Unchecked items include investigation, design decisions, implementation, and acceptance checks. Complete the final Unmute Agent lifecycle phase last, in its own independently revertible commit.

## 1. Baseline and reference investigation

### Existing code to audit before changing it

The baseline already contains substantial relevant functionality; preserve and finish it rather than assuming it is absent:

| Area | Current evidence / starting points |
| --- | --- |
| Native editor and attachments | `desktop/native-notch/Sources/unmute-notch/ConversationPanel.swift`: AppKit editor, image thumbnails, remove buttons, paste handling. Its `updateNSView` can replace the editor string; investigate synchronization before attributing the reported typing loss to a specific cause. |
| Composer sizing | `desktop/native-notch/Sources/ComposerSupport/ComposerHeight.swift`: current editor height clamps to 30–76 points. This is a measured code value, not a proposed design target. |
| Draft ownership | `desktop/electron/remote/task-draft.ts`, its tests, and `task-manager.ts`: trace mutations, attachment storage, submission, acknowledgment, and task switching. |
| Conversation rendering | Native `BlockConversation.swift`, `ConversationSupport/*`, Electron `blocks.ts`, `blocks-claude.ts`, and `codex/blocks-*.ts`. |
| Session transport | `task-manager.ts`, `remote/codex/*`, Claude session readers, and provider adapters. Structured Codex support exists alongside PTY paths; one documented path still spawns a TUI attached to the same thread. |
| Notch ownership | `remote/notch/notch-controller.ts`, `notch-client.ts`, native `AppController.swift` and `IPC.swift`. Preserve the latest fix that keeps Agent chat open while it is being read. |
| Agent continuity | `remote/agent/continuity.ts`: currently six-hour idle expiration and a 200-turn ceiling. The new requirement is 20 user messages, with no clock-based reset. |
| Agent chat | `remote/agent/conversation.ts`: snapshot/restore and purge already exist; currently caps stored entries at 400 and individual text at 20,000 characters. Audit truncation and durable restore behavior. |
| Agent execution/configuration | `agent/controller.ts`, `supervisor.ts`, `provider.ts`, `providers/claude-headless.ts`, `providers/codex-headless.ts`, `constitution.ts`, `persona.ts`, `policy.ts`, `tokens.ts`, and `memory/*`. Existing headless execution can resume conversations; process persistence and conversation persistence are different properties. |

- [ ] Record the installed Unmute build/version and its source relationship before live comparisons. Do not assume the running app is built from this worktree.
- [ ] Reconcile prior specs with actual code: `2026-08-12-unified-task-composer-design.md`, `2026-08-16-chat-view-blocks.md`, expanded-reply reliability, control-plane, provider monitoring, and Agent rework documents. Their historical completion claims are not fresh verification.
- [ ] Inventory each supported lane separately: owned Claude Code, owned Codex, externally discovered CLI sessions, and desktop-app integrations. Mark create/resume/read/send/interrupt/approval/image/file support per lane.
- [ ] Inspect [OpenMausBot](https://github.com/milind-soni/OpenMausBot) at a recorded commit: follow composer → request → provider process/session → structured events → renderer, including permission callbacks and reconnect history. Its README describes locally running CLIs and inline decisions; the exact implementation must be established from source.
- [ ] Determine whether each OpenMausBot provider uses an SDK, CLI structured input/output, app-server, or another transport. Document session IDs, resume rules, configuration injection, and control-message handling with source paths. Do not assume Claude and Codex use identical mechanisms.
- [ ] Clarify session equivalence: same underlying provider/session format does not automatically mean the same active terminal process or safe simultaneous writers. Verify whether an existing TUI-created session can be resumed and how ownership is transferred.
- [ ] Inspect the installed Codex and Claude desktop composer states represented in the screenshots. Record app version, viewport, display scale, and observations. Use DOM/computed bounds if available; otherwise use native accessibility and screenshots. Developer-mode relaunch is an investigation option, not a prerequisite or a reason to disrupt active chats.
- [ ] Record relative width, padding, editor growth, toolbar alignment, thumbnail proportions, menu placement, and message line length. Translate those relationships to the notch rather than copying a desktop window's pixel dimensions.
- [ ] Review T3 and Codeby references from the original list after identifying the intended repositories/products; do not silently substitute similarly named projects. Extract useful rendering patterns without making their entire feature sets requirements.
- [ ] Produce a capability/reference table showing observed behavior, proposed Unmute behavior, and provider limitations. Skills recording, Notes integrations, a plugin marketplace, and full browser UI are reference inventory only unless separately approved; existing MCP/browser activity must still render correctly.

Acceptance: source-backed transport map, current-code gap list, and annotated reference/layout observations exist before architecture or visual choices are locked. The supplied screenshots inform the inventory; no live DOM measurements have been made in this planning pass.

## 2. Structured session transport and terminal removal

- [ ] Define one task event/state contract with session, turn, message, tool-call, attachment, and approval identities, timestamps, and completion/error status. Preserve provider-specific metadata where needed.
- [ ] Establish authoritative structured sources for message deltas, tool activity, approvals, questions, lifecycle, and completion. Do not derive those from ANSI output, cursor movement, spinner text, or terminal-screen scraping.
- [ ] Select supported transports for Claude and Codex after the source audit; specify minimum versions and explicit unsupported-version behavior. Headless execution itself is acceptable when the conversation is resumable and fully controllable through the GUI.
- [ ] Support fresh sessions and continuation with stable provider IDs, correct project/cwd, model, effort, instructions, permissions, and MCP setup.
- [ ] Distinguish an owned writable session from an externally observed session. Prevent simultaneous writers, wrong-session delivery, or silently cloning a session when the user expects continuation.
- [ ] Normalize streaming and persisted history without double-rendering the same message or changing its order. Handle delayed, duplicate, partial, and out-of-order events.
- [ ] Reconnect after app restart, sleep, transport loss, or provider exit; recover the correct history, active state, and unresolved requests without automatically resending a potentially accepted turn.
- [ ] Support cancellation and clean shutdown through provider controls. Separate stopping a turn, closing a view, and ending a session.
- [ ] Preserve existing routing, task/group identity, memory integration, capture delivery, session discovery, and worktree/cwd behavior through the transport change.
- [ ] Remove terminal toggles, terminal-dependent sizing, keystroke-based reply/approval delivery, and unnecessary PTY mirrors for migrated task lanes only after their GUI paths pass acceptance.
- [ ] Retain useful diagnostic logs without exposing raw terminal output as the task interaction surface. Unsupported lanes must explain their limitation rather than silently opening a terminal.

Acceptance: create, continue, attach, approve/deny, answer a question, stop, reconnect, and finish representative Claude and Codex tasks entirely from the GUI. Task state remains correct with no TUI window or PTY display.

## 3. Visible task state and immediate feedback

- [ ] Render an immediate local submission state before the first provider event, then distinguish accepted, launching/connecting, queued, working, streaming, and finished.
- [ ] Use truthful labels: “Starting” before provider acknowledgment, “Working” when active, and provider-exposed reasoning/status when available. Do not invent hidden reasoning or call every silent interval “Thinking.”
- [ ] Define icon, label, elapsed time behavior, available actions, and composer availability for every state below.

| State | Required feedback / action |
| --- | --- |
| Empty / ready | Useful empty state and usable composer; optional starter prompts must not obscure it. |
| Staging attachments / submitting | Local progress; prevent premature or duplicate submission. |
| Starting / reconnecting | Visible activity before tokens arrive; actionable failure if connection fails. |
| Queued | Show that the message has not begun and allow a supported cancellation path. |
| Working / streaming / tool running | Stable activity row, current exposed action, progressively rendered output. |
| Approval required | Inline request with explicit decision controls. |
| Question / blocker | Clear explanation and answer/recovery control. |
| Cancelling / cancelled | Acknowledge the stop request and retain partial output. |
| Completed | Clear completion; remove active spinners and restore expected input behavior. |
| Failed / provider unavailable | Specific, readable error and retry or settings action. |
| Rate limited / context limit / auth expired | Explain the actual constraint and any provider-supplied recovery/reset time. |
| Connection uncertain | Avoid claiming completion or failure solely because output is quiet; provide reconnect/status recovery. |

- [ ] Handle tools with no text output, long first-token delays, subprocess activity, provider compaction, and multi-step turns without a blank or frozen appearance.
- [ ] Keep task cards, expanded chat, unread indicators, and attention indicators consistent. Opening or reading another task must not misroute an event or steal focus.
- [ ] Cover failure before session creation, failure after acceptance, interrupted streams, process crashes, and a final answer followed by delayed lifecycle events.

Acceptance: submit a delayed task and see feedback immediately; every terminal/blocked state has a visible explanation and the relevant action. Silence does not become a fabricated provider state.

## 4. Reliable editor and draft lifecycle

- [ ] Reproduce the disappearing-character/flicker report with rapid typing while provider events, draft acknowledgments, and layout updates arrive. Trace editor identity, stale snapshots, bindings, caret replacement, and focus; fix the verified cause.
- [ ] Establish draft revision/ownership rules so remote snapshots cannot overwrite newer typing. Keep selection, caret, composition text, and undo history stable through unrelated re-renders.
- [ ] Support ordinary typing, multiline text, Unicode/emoji, CJK/IME composition, selection replacement, undo/redo, cut/copy/paste, select-all, and familiar navigation shortcuts.
- [ ] Enter submits; Shift+Enter inserts a newline; the send button uses the same submit path. IME confirmation must not accidentally send.
- [ ] Reject whitespace-only submission, but permit supported attachment-only messages. Define clear unavailable/busy button states and accessible labels.
- [ ] Preserve a per-task draft across collapsing/reopening, task switching, and popup/file-picker interactions. Define and verify draft recovery after restart, including staged attachment availability.
- [ ] Snapshot the submitted draft atomically. Clear only the accepted portion after acknowledgment; typing added during send must survive.
- [ ] Preserve text and attachments on rejection or staging/delivery failure. Differentiate retryable rejection from uncertain acceptance; prevent duplicate turns from Enter plus click or repeated callbacks.
- [ ] Define behavior while a turn is running: follow-up queue or provider-supported steering, with explicit labeling. Never silently interrupt or drop the draft.
- [ ] Keep user text literal; commands such as `/clear` must use a defined command/control path where supported and must not accidentally become ordinary agent instructions.

Acceptance: rapid typing during streaming loses zero characters; send methods behave identically; task switching preserves separate drafts; failed sends recover without manual reconstruction.

## 5. Files, images, screenshots, and large pasted text

### Picking and staging

- [ ] Add a discoverable attachment action with the appropriate icon and native picker. Separate “attach file” from “choose working folder.”
- [ ] Support multiple file selection and supported drag/drop from Finder, screenshot paste, copied images, and file URLs. Define precedence when the pasteboard contains both image and text representations.
- [ ] Publish capability-based accepted formats, count, per-file and total-size limits before upload/submission. Cover documents/code/text as well as images; folder selection must not silently imply recursive attachment.
- [ ] Stage temporary screenshot/paste files into owned storage with stable identities. Do not depend on clipboard contents or a temporary source remaining available after selection.
- [ ] Handle picker cancel, unreadable/deleted files, unsupported types, oversized files, corrupt images, duplicate names, and duplicate selections with visible feedback and intact drafts.

### Attachment presentation

- [ ] Images have aspect-preserving thumbnails, accessible names, loading/error states, a preview action, and an individual × removal button with a usable hit target.
- [ ] Non-image files have a type icon, name, useful size/type metadata, and removal. Long names truncate visually without losing the full accessible/tooltip name.
- [ ] Multiple attachments wrap or scroll in a bounded area without pushing the editor or send controls off-screen. Preserve selection order.
- [ ] Removing an item before send excludes it from the payload. Removing one item leaves all other items and draft text intact; removing the last restores the empty attachment state.
- [ ] Sent messages retain usable image/file representations on reload. Opening a preview and dismissing it must not submit, discard, or steal the draft's caret.

### Large paste as a content item

- [ ] Define a named, configurable character/line threshold for converting a large paste into a collapsed “Pasted text” item; choose its value from reference inspection and notch usability checks rather than guessing here.
- [ ] Show a compact label and size/line count, with expand/preview, copy, and × remove actions. Preserve the complete original text, whitespace, indentation, and encoding; never silently truncate it.
- [ ] Distinguish this draft content item from a real attached file and an agent-generated artifact. Specify whether “edit” expands it or restores it to the editor; retain text typed before/after the paste.
- [ ] Serialize the complete content using a supported provider input form and preserve mixed text/image/pasted-text ordering. Collapsing is presentation only, not permission to omit content.
- [ ] Check just below/at/above threshold, multiple large pastes, mixed small/large paste, undo conversion, deletion, failed send, and reopening the draft.

### Delivery and storage

- [ ] Verify each provider receives the intended image bytes or supported file references together with the text as one logical turn. A printed filesystem path alone is not proof that the provider received an image.
- [ ] Show attachment readiness before send; expose unsupported combinations before partially submitting a turn. Preserve items on delivery failure.
- [ ] Define owned-file retention for drafts, sent history, retries, and abandoned drafts. Removing a reference must never delete the user's original file or another message's shared attachment.

Acceptance: paste a screenshot, preview it, remove it, add two files and large text, then send; the GUI and provider agree exactly on the submitted items. Repeat with failures and after reopen.

## 6. Composer controls and configuration

- [ ] Working-folder selector: current folder label, recent/searchable projects where available, native browse, full-path disambiguation, missing-folder handling, and correct cwd on submission. Define existing-session folder-change behavior explicitly.
- [ ] Provider/model selector: actual selected provider and model, available choices from supported capability/catalog sources, loading/unavailable/error states, and stable selection across reopen. Do not hard-code screenshot model names as permanent choices.
- [ ] Effort selector: only supported levels, understandable current value, correct backend mapping, and valid fallback when model/provider changes. Distinguish pending selection from settings already applied to a running session.
- [ ] Permission selector: readable modes and descriptions, actual effective scope, and provider-specific mapping. A “Full access” label must accurately match effective behavior.
- [ ] Plan mode: include only when the adapter supports its actual semantics; display active mode and transitions clearly. Unsupported controls should explain why or be absent.
- [ ] Plus menu: clear grouping, consistent icons, keyboard navigation, highlighted/focused states, Escape/outside dismissal, and bounded positioning. Do not advertise unimplemented integrations.
- [ ] Microphone/dictation: idle, recording, transcribing, error, cancel, and confirmed insertion states; permission denial/device failure; append at the intended position without overwriting typing. Distinguish dictation from a separate live voice mode.
- [ ] Preserve Right-Option/Fn capture routing, screenshot capture, and ordered speech-plus-inserts. Capture targeted to a draft must not send prematurely or land in a different task after focus changes.
- [ ] Show relevant MCP/browser/tool availability or errors where they affect use. Full plugin installation, skill recording, and a new live voice product remain separate scope.

Acceptance: each visible control performs its advertised action and the next turn uses the displayed effective settings. Menus, recording, and file dialogs preserve drafts.

### Project and session folder lifecycle

- [ ] Audit where Unmute currently creates project folders, worktrees, session metadata, transcripts, temporary files, and staged attachments. Distinguish the provider's working directory from Unmute-owned session storage.
- [ ] Define and document a predictable default base directory for new projects, with a user-selectable location and a visible resolved path before creation. Selecting an existing project uses that project; it must not silently create another copy or run from an incidental launch directory.
- [ ] Specify behavior when no folder is selected: use an explicitly defined managed workspace or require project selection when the task needs it. Never silently fall back to the home directory or an unrelated repository.
- [ ] Define unique naming, collision handling, and when separate tasks share a project versus receive an isolated directory/worktree. Preserve the selected branch/worktree and prevent parallel tasks from accidentally sharing an unintended checkout.
- [ ] Validate creation and access errors, missing/moved folders, spaces/Unicode in paths, and restart/resume. Reopening a session restores its recorded working directory; it must not create a replacement silently.
- [ ] Define retention and cleanup separately for projects/worktrees, session records, and temporary attachments. Closing or clearing chat must not delete project files; cleanup may remove only identified Unmute-owned disposable data, with explicit user action for project/worktree deletion.

Acceptance: new-project, existing-project, no-selection, parallel-task, failed-creation, and restart flows use the expected visible paths. Session cleanup leaves user projects and unrelated worktrees intact.

## 7. Approvals, questions, and Claude/Codex permissions

- [ ] For sessions Unmute creates, configure the maximum permissions supported by the provider that the user has authorized: filesystem/workspace access, command execution, network access, and applicable MCP/computer-use tools. Apply these through per-session launch/API settings; do not modify global Claude/Codex defaults, unrelated terminal sessions, or externally attached sessions' policies.
- [ ] Map this policy explicitly for both Claude Code and Codex, including sandbox mode and approval settings. Honor a user's lower selected permission level and report any provider-enforced limits; “maximum” must not mean claiming capabilities that were not granted.
- [ ] Preserve the authorized session policy across follow-ups, resume, reconnect, and Unmute-created replacement sessions. Verify effective settings rather than assuming flags were accepted, and show any downgrade or configuration failure.
- [ ] Audit macOS Accessibility, Screen Recording, Automation, and other relevant OS permissions separately from provider approval prompts. Identify the process/app that needs each grant, surface missing grants with the correct settings guidance, and verify existing grants are recognized without repeated requests. Session configuration must not pretend to grant or bypass OS consent.

- [ ] Render provider approval requests as inline cards with the proposed command/file/tool action, relevant scope/cwd, and supported allow/deny choices. Preserve differences between one-time and broader approvals.
- [ ] Support structured user questions: choices, free text, multiple required answers, submission validation, and a sent/pending acknowledgment state.
- [ ] Keep multiple pending requests separately identified; handle requests arriving during other activity, expired requests, cancellation, denial, and reconnect replay.
- [ ] Bind decisions to the correct session/request and disable repeat submission after acceptance. A rejected decision delivery remains actionable.
- [ ] Audit both providers' current sandbox, approval policy, MCP tool rules, workspace roots, and instruction conflicts. Explain why excessive requests occur before changing policy.
- [ ] Make routine safe operations work under the selected policy; retain meaningful confirmations for actions that need them. Do not equate fewer prompts with globally disabling safeguards.
- [ ] Audit unnecessary clarification loops separately from permission prompts: fix conflicting setup or instructions, preserve legitimate missing-information questions.
- [ ] Compare representative safe tasks before/after by counting avoidable prompts and successful completion; also verify a genuinely restricted action still requests approval.

Acceptance: Unmute-created Claude and Codex sessions receive the maximum supported user-authorized access, retain it on resume, and produce materially fewer avoidable interruptions. Global defaults and unrelated sessions remain unchanged; lower user-selected policies and OS-level consent remain effective. Approvals and blockers can be resolved entirely in chat, with no request hidden behind terminal output.

## 8. Message rendering and conversation navigation

- [ ] Inventory actual provider content types and give every supported type a renderer or explicit fallback. Preserve unknown events diagnostically without breaking the conversation.
- [ ] Render Markdown paragraphs, headings, emphasis, links, lists, blockquotes, tables, and fenced code. Incomplete streaming Markdown must not destabilize layout.
- [ ] Code blocks preserve whitespace, have language labels and copy actions, and scroll horizontally within bounds. Long URLs/paths and tables cannot stretch the notch.
- [ ] Render user text and sent attachments, assistant commentary/final answers, provider-exposed reasoning summaries, tool calls/results, commands/exit codes, file changes/diffs, plan progress, MCP/browser results, and relevant artifacts.
- [ ] Distinguish running/succeeded/failed/denied/cancelled tools. Support expandable details and long output without turning the default view into a log dump.
- [ ] Show subagent/progress information, citations, warnings, and context-compaction markers when the provider actually exposes them. Do not fabricate missing fields.
- [ ] Provide copy/select actions, safe link/file opening, preview dismissal, and clear artifact names. Provider content cannot execute scripts through rendering.
- [ ] Preserve full user/assistant content behind folding; audit existing character caps and prevent silent content loss in the readable record.
- [ ] Auto-follow only when near the bottom. Reading older messages preserves scroll position as content streams; show a jump-to-latest/unread cue when appropriate.
- [ ] Preserve stable message identities, expanded details, and scroll position across incremental updates, task switching, collapse/reopen, and history loading.
- [ ] Define empty, loading-history, missing-history, partial-history, and failed-history states. Long conversations remain responsive through bounded/lazy rendering as needed.

Acceptance: a mixed-content fixture renders in the notch with correct order, status, copy behavior, and no clipping; streaming and history replay converge on the same conversation.

## 9. Notch proportions, layout, and accessibility

- [ ] Produce a small layout specification with measured reference ratios and chosen native spacing/type tokens: outer margins, readable content width, composer padding, row gaps, icon targets, corner radii, and menu offsets.
- [ ] Define compact and expanded dimensions with min/preferred/max bounds relative to the available display area. Prefer a taller reading surface and a wider view where useful, while constraining line length and avoiding a composer stretched across the display.
- [ ] Size the editor from one line to a bounded multiline height, then scroll internally. Attachment trays, large-paste cards, and toolbars share explicit space budgets so messages remain readable.
- [ ] Keep the composer anchored, give the conversation the remaining height, and handle long approvals/questions without burying their action buttons.
- [ ] Position project/model/permission/plus menus within screen edges, with sufficient room above or below. Dialogs must not trigger unintended notch dismissal.
- [ ] Verify MacBook notch geometry, small/large external monitors, display scaling, screen changes, and multiple displays. Avoid clipping at the top safe area or bottom screen edge.
- [ ] Preserve the latest “chat stays open while reading” behavior through reconciliation, provider updates, and navigation. Closing the view must not cancel work; opening another task must transfer surface ownership cleanly.
- [ ] Cover hover, pressed, selected, focused, disabled, loading, and error appearances for each control. Use consistent provider/status icons and adequate text/placeholder contrast.
- [ ] Support keyboard traversal, visible focus, VoiceOver names/order, accessible removal buttons, text scaling where supported, and reduced motion. Do not announce every streamed character.

Acceptance: compare empty, multiline, many-attachment, large-paste, streaming, long-history, approval, and error screenshots at representative display sizes. No controls overlap, no content forces whole-window horizontal scrolling, and the editor retains usable space.

## 10. Verification and migration gates

- [ ] Build a matrix crossing provider/lane with: new/resumed/reconnected session; text/image/file/large paste; idle/busy/blocked/failed; compact/expanded; keyboard/mouse/paste/drop/voice input.
- [ ] Use deterministic fixtures for event ordering, deduplication, malformed events, draft acknowledgment races, unknown acceptance, and late events after stop/reset.
- [ ] Exercise native interaction checks for typing under updates, IME, shortcuts, previews/removal, menu focus, resizing, and scrolling; unit tests alone cannot establish visual correctness.
- [ ] Run representative live Claude and Codex conversations through multi-turn work, an image question, a file operation, approval denial/allow, user question, cancellation, failure, and restart recovery.
- [ ] Verify provider-received payloads and settings, not only rendered bubbles. Record results without leaking prompts, tokens, or private attachments into general logs.
- [ ] Regression-check existing task routing/groups, direct dictation, capture, session discovery, memory, and the Agent reading/open-state fix.
- [ ] Record performance observations for first visible feedback, typing responsiveness, long-history rendering, and attachment staging; investigate noticeable stalls rather than claiming visual perfection from a successful build.
- [ ] Remove legacy task terminal paths only once the capability matrix has explicit pass/unsupported dispositions. Keep migration commits reviewable and rollbackable without losing session data.

Completion evidence: checked acceptance items, relevant automated checks, live interaction results, and before/after screenshots. Any unsupported provider capability is explicitly documented; no silent fallback undermines the GUI-only goal.

## 11. Final phase only: Unmute Agent persistence and 20-message reset

This phase is specifically for the Unmute Agent, not ordinary Claude/Codex task chats. Implement it after the task GUI migration and verification, in a separate commit containing only the Agent lifecycle/configuration changes and their tests. Reverting that commit must leave the completed task GUI intact. The user's references to “invitation/mutation” are interpreted here as the Unmute Agent based on the surrounding request, not a new subsystem.

### Persistent conversation and configuration

- [ ] Audit actual fresh/resume behavior before describing the current Agent as non-persistent. Identify durable session identity, process lifetime, runtime ownership, chat snapshot storage, and restart restoration independently.
- [ ] Make normal Agent follow-ups share the intended provider conversation until reset. Preserve identity across reopen, idle time, and recoverable process/app restart; never depend solely on keeping a terminal process alive.
- [ ] Show the Agent's actual provider in the expanded notch, with model where available and readable unavailable/error states. A fallback or provider change must be visible and must not imply nonexistent cross-provider context continuity.
- [ ] Load the Agent's canonical prompt/instructions from the designated file(s) at initial creation and every post-clear initialization. Reapply persona/constitution, working context, MCP definitions and access, model/effort, tool rules, environment, and memory access through the supported transport.
- [ ] Verify the effective configuration rather than merely passing flags. Missing/unreadable prompt files or failed MCP setup must produce an actionable state instead of an apparently ready but underconfigured Agent.
- [ ] Preserve existing safeguards: strict MCP configuration, tool allow/deny rules, mutation authorization, token scoping/expiry, capability boundaries, interruption handling, provider failure reporting, and memory isolation. Persistent operation must renew credentials correctly without broadening privileges.

### Exact counting and clear boundary

- [ ] Replace the six-hour idle rule and 200-turn policy with a configurable default of exactly 20 accepted user messages. No time-based reset. Idle time alone must not erase a conversation.
- [ ] Count each unique accepted user message once, whether typed or dictated. Exclude assistant/tool/system messages, streaming fragments, duplicate delivery/replay, and rejected submissions. Retries of the same accepted message do not increment the count again.
- [ ] Adopt the safe boundary: let message 20 and its response finish, then clear before accepting message 21 into the new conversation. If the turn fails/cancels after acceptance, settle it before reset. Do not wipe an active approval or interrupt the twentieth answer merely because the counter reached 20.
- [ ] Implement a real provider context clear/reset, using a supported `/clear` operation or equivalent fresh-context API/session creation. Verify support for each transport; do not send a literal slash command as ordinary text and assume it worked.
- [ ] Reset the visible Agent conversation and provider context together after successful clear/reinitialization. Show a concise “Conversation cleared after 20 messages” state so the transition is understandable.
- [ ] Preserve an unsent draft and queued next user input through reset; route it only after the new session is correctly initialized. Do not erase other task chats, durable memory, project configuration, or unrelated records.
- [ ] Persist the accepted-message count and reset generation alongside session identity, so restarting at 19/20 does not bypass or repeat the boundary.
- [ ] Make reset failure recoverable: retain coherent old state, show the failure, and prevent the next message from entering an uncertain context. Ignore late events from the old generation and serialize concurrent send/reset operations.
- [ ] Distinguish clearing the active conversation from deleting underlying diagnostic/history files. Do not add permanent transcript deletion to this requirement; separately document what record retention already does.

### Independent acceptance and rollback

- [ ] Verify messages 1, 19, 20, and 21; rapid concurrent submission; rejected send; accepted retry; cancelled twentieth turn; pending approval; app restart at the boundary; and reset failure/retry.
- [ ] Verify idle periods do not clear the chat and ordinary task chats never inherit this 20-message policy.
- [ ] Verify the first post-clear response has the canonical instructions and working MCP tools, while prior transient conversation context is actually gone.
- [ ] Verify durable memory remains available and existing mutation safeguards still enforce the same boundaries before/after clear and restart.
- [ ] Verify provider identification in the expanded view and the existing “stays open while reading” behavior.
- [ ] Keep this phase independently revertible: reversing its commit restores prior Agent lifecycle policy without reverting shared GUI work, corrupting saved sessions, or removing memory.

## Delivery order

1. Reference/code audit and capability/layout decisions.
2. Structured transport and truthful state/approval handling.
3. Reliable composer, attachments/large paste, configuration controls, and rich rendering.
4. Notch layout/accessibility checks and complete GUI acceptance; retire the task terminal paths.
5. Unmute Agent persistence/configuration/reset changes, last and in their own commit.

This checklist began as the planning-only deliverable. The subsequent implementation request now authorizes its execution; keep implementation evidence separate from unverified manual acceptance.
