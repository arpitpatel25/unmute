# Native chat: reference decisions and validation record

Implementation record for `2026-09-05-native-chat-task-checklist.md`. This is not a claim that automated tests establish perfect native interaction. Live visual checks remain separately identified below.

## Baseline and references

- Source baseline: local main `15355de5`; worktree branch `arpit/unmute-astra-remove-terminal`.
- Installed `/Applications/unmute.app`: version/build `1.5.21-dev.20`. No source commit embedded in the inspected version fields; do not equate it with this worktree. It was not replaced or restarted.
- Installed Claude desktop `1.46388.3`; ChatGPT `26.831.20005`. The supplied Codex/Claude screenshots are visual reference, not measurements of these installed versions. Codex app inspection was denied by the computer-use safety boundary; no developer-mode relaunch or bypass was attempted.
- [OpenMausBot](https://github.com/milind-soni/OpenMausBot/tree/ff2fed15a7ed0a08ffab975d011fc0847adaba27), inspected at `ff2fed15a7ed0a08ffab975d011fc0847adaba27`: `server/drivers/claude.ts`, `server/drivers/codex.ts`, `src/components/Composer.tsx`, `ComposerAttachments.tsx`, and `src/lib/composer-attachments.ts`. Claude is structured CLI JSON input/output with an approval broker; Codex uses app-server requests/events. The UI owns drafts and renders semantic messages instead of terminal screen output. Its large-paste threshold is 900 characters/12 lines; editor growth is bounded. We reuse these interaction principles, not its fresh-session fallback on resume failure.
- [T3 Code](https://github.com/pingdotgg/t3code/tree/4d3907f63d71644e1918d76cd104b036535a1173), inspected at `4d3907f63d71644e1918d76cd104b036535a1173`: web `ComposerPromptEditor.tsx` has explicit composition/selection handling and internally scrolling bounded editor height; `ChatMarkdown.tsx` separates link/media/code behavior, supports GFM and sanitizes optional raw HTML. Useful principles: preserve composition, keep wide content locally scrollable, and treat provider-authored links as untrusted. Unmute renders native text rather than executing HTML.
- “Codeby” remains an unidentified reference: search did not establish the intended product/repository. No similarly named project was silently substituted. This does not change any requested Unmute feature.

## Transport and ownership

| Lane | Create / continue | Inputs and decisions | Stop / recovery |
| --- | --- | --- | --- |
| Unmute-owned Claude | Structured CLI stream-json; pinned session ID, exact resume, explicit fork | Ordered text, actual image bytes, file references, full pasted text; inline permission and question responses | Structured interrupt; restore completed frames and partial failed output; no automatic fresh fallback |
| Unmute-owned Codex | JSON-RPC app-server thread start/resume | Ordered typed input, inline approvals/questions and supported MCP forms; private attachment metadata | Turn interrupt, paginated history, unresolved-request replay; unknown acceptance locks resubmission until reconnect |
| Legacy Unmute CLI task | Explicit Resume migrates after the old runtime stops | No terminal-keystroke send from the GUI before migration | Exact recorded session/cwd; missing folder is an error, not a replacement workspace |
| Externally discovered CLI | Read-only observation | No silent transfer or second writer; start a distinct managed conversation | Original application owns execution; no task terminal fallback |
| Desktop-app integrations | Existing application adapters retained | Existing supported adapter controls remain; unsupported terminal-only interaction has explicit guidance | Original application is named correctly; no false Codex label for unrelated apps |

The same provider conversation format does not imply the same live process. Unmute's structured writer replaces the need for a TUI for owned chats; it must not run concurrently with a terminal writer on the same identity. CLI versions exercised: Claude `2.1.261`, Codex `0.153.2`. Unsupported setup/protocol errors surface as errors rather than falling back to ANSI parsing.

Compatibility is protocol-based, not a claimed numeric minimum: Claude must accept structured input/output, initialization/control requests and exact session resume; Codex must complete app-server initialization and the thread/turn methods used by the adapter. The versions above are the verified baseline, not evidence that every older version works. An incompatible binary fails initialization/control or reports an unsupported protocol operation; retain the draft, update the provider CLI and reconnect the recorded session. No automatic terminal or fresh-context fallback is permitted. Model and effort options require provider-reported metadata; an unavailable catalog is not license to invent model IDs.

The retained desktop adapters have different limits from owned CLI chat:

| Adapter | Create / read / continued text | Resume / stop / decisions | Images / files |
| --- | --- | --- | --- |
| Owned Claude structured | Implemented; synthetic live two-turn evidence | Exact resume and interrupt implemented; live one-time allow/deny and choice answer | Typed image bytes and file references implemented; live PNG, mixed-input fixtures |
| Owned Codex app-server | Implemented; synthetic live two-turn evidence | Exact resume/interrupt and structured decisions implemented; fixture evidence, live native decisions still manual | Typed local images and file references implemented; live PNG, mixed-input fixtures |
| Observed external Claude/Codex CLI | Read only; no Unmute creation or send on that external identity | Original process owns execution/decisions; no implicit takeover or second writer | No sending attachments into an external CLI identity |
| Codex desktop | Existing create/read/CDP send adapter retained; current-app acceptance manual | No Unmute provider-process resume; original app owns runtime; native desktop controls remain adapter-specific | Existing attachment-control adapter retained; current-app file-picker/payload acceptance manual |
| Claude desktop | Existing create/read/title-addressed native send adapter retained; current-app acceptance manual | No Unmute provider-process resume; existing consent actuator rechecks current prompt; app owns runtime | Existing image-paste actuator retained for continuation; creation with attachments explicitly rejected; no generic-file support claim |

These are code capability dispositions, not claims that the current installed desktop apps passed live automation. Unsupported actions remain explicit rather than opening a terminal.

### Reconciliation with earlier designs

The historical documents explain preserved contracts, not fresh verification:

- `2026-08-12-unified-task-composer-design.md`: retain one task-owned text/ordered-attachment draft and capture convergence. This migration supersedes its visible-terminal branch and Claude path-only delivery with structured input. Its eager attachment-file deletion is superseded by retention needed for undo, sent history and queued snapshots.
- `2026-08-13-expanded-reply-reliability-design.md`: retain adaptive one-line growth, shared draft propagation, acknowledged desktop attachment submission and non-blocking native transitions. The editor's current 144-point cap is an intentional new layout choice; old sizing values are not acceptance targets.
- `2026-08-13-notch-control-plane-design.md`: preserve native interaction ownership, generation-guarded transitions, helper replay and capture policy. Its blanket no-removal compatibility statement is superseded only for the task terminal UI explicitly removed by this request; navigation/reading/capture behavior remains in scope.
- `2026-08-21-provider-monitoring.md`: preserve separation of runtime, turn, transcript and human-blocked state; external readers keep event-first observation/reconciliation. For owned Claude, structured protocol events replace the historical PTY/hooks authority. An idle or existing process alone does not mean work is running.
- `2026-08-16-chat-view-blocks.md`: preserve open block vocabulary, provider-specific exposed content, turn grouping, readable width and contained wide output. Its old read-only scope no longer limits this implementation request; prior claims that the input layer was correct do not override the reported typing bug or the current audit. Diff/result/status coverage must meet the new checklist, not just old line-count summaries.
- Agent continuity is separately audited from `agent/continuity.ts`, `conversation.ts`, supervisor/journal/provider/configuration modules and the current reading-open fix. Historical six-hour/200-turn behavior is deliberately replaced only in the final independent Agent commit.

## Composer and layout decisions

Screenshots show a centered, bounded composer, separate folder context, compact permission/model controls, and transient menus. Relative spacing is translated to native notch constraints; no claim of exact screenshot pixels or DOM bounds is made.

| Element | Native implementation rule |
| --- | --- |
| Compact / expanded surface | Maximum 1040×860 / 1320×860 points; clamp after saved sizing/scaling to display minus 24 points |
| Composer | Maximum readable width 760 points, anchored below remaining-height conversation |
| Editor | System type 13.5 points, bounded growth to 144 points, then internal scrolling |
| Toolbar | 11.5-point labels, 28-point minimum row, horizontal overflow rather than pushing send off-screen |
| Attachments | 66-point bounded tray, aspect-preserving image previews, 28-point removal targets |
| Preview | Image bounded to 480×300; full selectable pasted text in 440×260 scrolling preview |
| New conversation | 400-point setup popover, provider plus searchable recent projects and native directory browse |
| Large paste | Named 900-character or 12-line conversion rule; full bytes retained, preview/copy/remove/restore-to-editor and undo/redo |

Limits: 10 attachments, 10 MB per PNG/JPEG/GIF/WebP image, 25 MB per other file, 50 MB combined. TIFF input is converted by native staging. Corrupt image decoding, unsupported types, unavailable files and limit failures preserve the draft and expose an error. Acquisition reserves original anchored order before asynchronous staging; failed items retain that order on retry. Per-item cancellation prevents late resurrection, and interrupted reservations recover as visible removable errors. Sent display groups user text and attachment tiles while retaining full provider input ordering.

Draft ownership uses native client revisions and per-task snapshots. Incoming acknowledgments cannot replace newer text; accepted sends clear only the exact submitted portion. File dialogs and task switching do not change draft ownership. Attachment-only messages are supported; empty whitespace is not. Enter/send share one path; Shift+Enter is a newline, composition confirmation is not submit. Owned busy turns support one durably queued follow-up separate from newer typing; Cancel preserves a saved item, and uncertain delivery requires explicit informed recovery rather than automatic replay. Independent queue review passed, including distinct captured input arriving while an earlier send awaits acknowledgement; newer input is queued or honestly retained, never acknowledged as part of an unrelated send.

## Session configuration, folders, and retention

Session home is under the configured remote base at `<base>/<user-key>/<task-uuid>`. New no-folder projects use the separate durable `<base>/.managed-projects/<user-key>/<uuid>` path; setup previews the full resolved path before creation. In-memory allocation reservations bind creation to that exact path and provider, expire after one hour, and reject collisions rather than choosing a different directory. Selecting an existing project uses its exact path, including an existing worktree. New chat allocates metadata but sends no fake prompt. Provider/cwd changes create a new conversation; they never silently migrate context. This safety implementation is awaiting independent review.

New owned sessions select maximum authorized access: Claude bypassPermissions when unfenced; Codex never/danger-full-access when unfenced and full-access consent permits. Enforced roots keep Claude manual with addDirs and Codex workspace-write; absent Codex full-access consent also keeps workspace-write. Setup shows the effective policy and downgrade reason. Explicit lower ask/plan/read-only choices remain effective and persisted on continuation. Global provider configuration is not rewritten. Canonical task instructions and scoped MCP credentials are injected on start/resume. Provider access does not grant macOS Accessibility, Screen Recording, Automation, or Microphone consent; existing permission diagnostics remain responsible for OS grants.

OS-permission audit: `cua/driver-client.ts` and `driver-manager.ts` keep computer-use children spawned by the signed Unmute app, not by a provider terminal, preserving Unmute's macOS permission identity. The existing manager checks Accessibility and Screen Recording separately and refreshes children when an Accessibility grant appears. Settings → Permissions rechecks microphone/Accessibility on focus and links to Screen Recording settings; the Screen Recording row intentionally does not claim live status. Computer Use remains an explicit opt-in. Automation grants remain macOS/app-target-specific, not something a provider approval flag grants. Runtime grant recognition and denial/recovery in the signed installed app remain manual acceptance checks; no OS permission was changed during this implementation.

Staged files are private owned copies. Removing a tray reference retains the copy for undo/history/in-flight sends; it never deletes the original. Only explicitly recognized temporary Unmute handoff files are cleaned after staging. Conversation retirement writes an external marker so the row cannot reappear, while preserving both legacy receipt bytes and project files—even with missing/malformed receipts, nested cwd or symlinked content. This intentionally does not reclaim retained receipt/attachment storage; safe project deletion is not implied by Remove. Closing a view is not task/project deletion. Ordinary task chats have no 20-message reset; the separate final Agent phase owns that policy.

## Evidence so far

### Remaining implementation gates

| Checklist area | Current gate |
| --- | --- |
| Structured task transport and ownership | Implemented; focused reviews, synthetic live transport checks, and integrated core compile passed |
| Editor, ordered staging, recovery, ordinary follow-up queue | Implemented and scoped reviews passed, including WebP Copy→Paste correction; manual native gestures pending |
| Folder allocation/retention, request identity, maximum new-session policy | Implemented and scoped review passed, including native acknowledgment replay and selected-folder setup corrections |
| Lifecycle/error feedback, rich results/diffs, history states, approval scope | Implemented; two scoped fix rounds and final re-review passed |
| Layout and accessibility | Native bounds/support checks passed; visual/IME/VoiceOver/display acceptance still manual |
| Unmute Agent persistence and exactly-20 reset | Deliberately not implemented yet; must follow the core commit and remain independently revertible |

These statuses do not check off the broader manual acceptance statements in the checklist. The implementation is not complete until the remaining code gates and final build are finished.

- Real disposable Claude conversation: two turns retained a synthetic marker under one provider session; an explicit fork retained that marker under a distinct pinned child ID. No user project work performed.
- Real disposable Codex conversation: two completed turns retained a synthetic marker under one thread. Existing unavailable/auth-required global MCP endpoints produced warnings; this work did not alter those endpoints.
- Real image input in both providers: a generated64×64 solid-red PNG (no user files) was sent through each structured adapter; both answered `Red`. Real Claude AskUserQuestion also round-tripped one choice request and its correlated `Blue` answer successfully. These are transport checks, not native picker/preview checks.
- Real Claude permission controls: one Write request denied (verified no file created), then a second explicitly allowed Write request completed in a newly allocated disposable workspace (verified synthetic file content). No user project or application setting was changed.
- Claude model/effort choices now come from CLI initialization metadata rather than a static screenshot catalog. Only each model's reported effort levels are offered; a16-test driver run covers catalog normalization and existing session contracts.
- Native controller/composer-focus regression: 162 passing tests. Claude manager integration: 6 passing tests, including stop during launch, restart history, empty new chat, exact resume, legacy migration, and external-writer refusal.
- Backend follow-up: 82 focused Claude channel/integration and Codex hub/parser tests pass, including reconnect-write ordering, ownership migration, per-session caps, private attachment storage, and inline MCP validation. Independent scoped review found all eight original findings addressed.
- Actual macOS image decoding validates PNG/JPEG/GIF/WebP asynchronously from private captured-byte copies; valid-format and corrupt-input checks pass. It does not use Electron's PNG/JPEG-only `nativeImage` buffer decoder for GIF/WebP. Artifact helpers restrict URI protocols and reveal executable/automation files instead of launching them; four combined image/artifact tests pass.
- Native focused composer/rendering checks: 52 passing; geometry/availability: 7 passing; Swift build passed. Other draft/input/provider checks are recorded in the temporary validation ledger.
- Native staging integration follow-up: 48 focused Swift tests and native build passed, including actual windowless AppKit editor/private-pasteboard checks; 38 backend and 4 controller checks passed. Independent scoped review confirmed cancellation, error propagation, ordering/retry, policy injection, off-main decoding, stale undo, bounded bookkeeping and interrupted recovery. One small WebP Copy→Paste type mismatch remains assigned to the content pass; native visual acceptance is still manual.
- Full worktree integration compile previously succeeded (native release, Electron main/preload and renderer). Final integrated build must be rerun after review fixes and the final Agent phase. Standalone typecheck has four engine-override module-resolution failures; integrated engine compile resolves those imports.

## Manual acceptance still required

### Cross-lane acceptance matrix

`Fixture` means deterministic code coverage, `Live` means the structured provider adapter was exercised with disposable synthetic input, and `Manual` means the built native UI still needs hands-on verification. These are different evidence levels, not interchangeable passes.

| Operation / state | Owned Claude | Owned Codex | External CLI / desktop |
| --- | --- | --- | --- |
| New, empty and first text | Fixture; Live text | Fixture; Live text | External CLI read-only; desktop adapter retained |
| Continued context | Live two-turn + explicit fork | Live two-turn | No second external CLI writer |
| Restart / reconnect / uncertain acceptance | Fixture | Fixture | Fixture provenance / explicit unsupported write |
| Image turn | Live generated PNG; all supported formats decode locally | Live generated PNG; all supported formats decode locally | Capabilities stay adapter-specific |
| Files / mixed text / large paste | Fixture ordered full payload + display projection | Fixture ordered full payload + display projection | No unsupported image/file claim |
| Busy / blocked / failed / stopped | Fixture lifecycle, partial output and controls | Fixture lifecycle and controls | Observe external state, original app owns execution |
| Permission allow / deny | Live synthetic Write deny and allow; Fixture request identity | Fixture request identity and decisions | No implicit change to external policy |
| Questions / MCP forms | Live choice answer; Fixture queue | Fixture questions, form validation and errors | Adapter-specific existing capabilities |
| Keyboard / send / paste / drop / voice | Shared editor/draft/capture fixtures; Manual native gestures | Shared editor/draft/capture fixtures; Manual native gestures | Read-only CLI cannot submit |
| Compact / expanded / resizing / long history | Shared layout/state fixtures; Manual visual acceptance | Shared layout/state fixtures; Manual visual acceptance | Shared shell where applicable |

For the native manual pass, cross each writable provider with empty/one-line/multiline/attachment-only/large-paste drafts; idle/starting/busy/approval/error states; compact/expanded sizes; Enter/send-button/paste/drop/microphone input. Repeat typing and removal while delayed updates arrive, then switch tasks and reopen. Check display bounds, focus, readable errors and retained content rather than only successful submission.

Do not mark these passed from unit tests: rapid typing during real streaming, IME and undo across asynchronous attachment acknowledgment, preview/menu/file-picker focus, native GUI attachment delivery in both providers, live Codex approvals/questions and native Claude decision-card interactions, microphone capture/cancel/failure, long-history scroll restoration, VoiceOver order/labels, representative MacBook/external-display screenshots, and reading-open behavior in the installed build. The user explicitly planned manual application testing; no installed-app modifications are implied by compiling this branch.
