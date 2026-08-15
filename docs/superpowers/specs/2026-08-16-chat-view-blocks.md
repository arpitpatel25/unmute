# Chat view blocks — every agent, everything the source offers

**Status:** approved, implementing
**Branch:** `arpit/ui-polish`
**Design mock:** https://claude.ai/code/artifact/5b18d181-b402-497e-a8bd-7fecd4c75861
**Source audit:** https://claude.ai/code/artifact/7e59ea22-6823-4f2f-86b6-6659d2037a59

---

## 1. The problem

The notch chat view renders three things — a user bubble, an answer block, and a
grey "work" row. Everything else our sources carry is discarded at parse time.

A user watching a Codex task in Unmute sees strictly less than the same task in
Codex's own window. Worse, some of what is missing is **not** cosmetic:

- A tool call the user **rejected** renders identically to one that succeeded.
- A sub-agent doing work renders as nothing, so a busy task looks stalled.
- A turn's file changes are invisible, so "what did it actually do" is unanswerable.

The cause is not thin sources. It is one narrow row type, declared four times by
hand, that every provider must squeeze into:

```
{ role: 'user'|'assistant'|'commentary'|'tool'|'work', text,
  title?, code?, output?, durationMs?, ok? }
```

declared in `task-manager.ts:209`, `notch-client.ts:97`, `IPC.swift:186`, and
`ConversationPresentation.swift:3`, then collapsed to three render kinds.

## 2. What this changes, and what it must not

**In scope:** the read path only — how a session's content is parsed, carried to
the notch, and drawn.

**Explicitly out of scope, and must not be touched:**

- `sendTaskReply` and every delivery transport (CDP composer, app-server
  `turn/start`, PTY `writeDraftText`/`submitDraft`/`pasteImage`)
- Right-option and Fn capture, pasteboard handoff, image staging
- Terminal-view vs non-terminal-view delivery differences
- Approval answering, interrupt, task lifecycle, state derivation

The input layer is already correct: transports differ per provider and meet at a
**capability interface**, gated by capability rather than provider name. Nothing
here changes that. The 1539-test remote suite is the regression gate.

## 3. Verified source inventory

Everything below was measured, not inferred. Corpus: **185 Codex rollouts**
(82,385 lines), **400 Claude transcripts** (55,956 lines), one **live app-server
capture** (63 messages, 12 methods), and the Codex binary's own type table.

### 3.1 Codex CLI — app-server JSON-RPC (primary), rollout (fallback)

We own the thread (`hub.startThread`), so state is **pushed**. `pollCodexCli`
returns early when the hub owns the thread — "the protocol wins".

Wire methods observed live:

| Method | Params |
|---|---|
| `item/started` | `item, threadId, turnId, startedAtMs` |
| `item/completed` | `item, threadId, turnId, completedAtMs` |
| `item/agentMessage/delta` | `threadId, turnId, itemId, delta` — per character |
| `turn/started` | `threadId, turn{id, items[], status, startedAt}` |
| `turn/completed` | `threadId, turn{…, completedAt, durationMs, items[]}` |
| `turn/diff/updated` | `threadId, turnId, diff` — **full unified git diff, live** |
| `thread/tokenUsage/updated` | `tokenUsage.total{totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}` |
| `account/rateLimits/updated` | `rateLimits.primary{usedPercent, windowDurationMins, resetsAt}, credits{hasCredits, balance}` |
| `thread/status/changed` | `status{type, activeFlags[]}` |
| `thread/started` | `thread{id, sessionId, forkedFromId, parentThreadId, preview, historyMode, model…}` |
| `mcpServer/startupStatus/updated` | `threadId, name, status, error, failureReason` |
| `remoteControl/status/changed` | `status, serverName, installationId` |

Item shapes (`item.type`, **camelCase on the wire**):

| Item | Fields |
|---|---|
| `userMessage` | `id, clientId, content[{type, text, text_elements}]` |
| `agentMessage` | `id, text, phase, memoryCitation` |
| `reasoning` | `id, summary[], content[]` |
| `commandExecution` | `id, command, cwd, processId, source, status, commandActions[], aggregatedOutput, exitCode, durationMs, pluginId, scriptPath` |
| `fileChange` | `id, changes[{path, kind{type: add\|modify\|delete}, diff}], status` |

Additional notification types present in the binary's table but not exercised by
the probe turn — treat as **expected, decode defensively**:
`item/reasoning/delta`, `item/reasoningSummary/delta`,
`item/commandExecution/outputDelta`, `item/fileChange/outputDelta`,
`turn/plan/updated`, `thread/contextCompacted`, `mcpToolCall/progress`,
`hook/started`, `hook/completed`, `thread/name/updated`, `model/rerouted`,
`item/guardianApprovalReview/{started,completed}`, `error`, `warning`.

> `turn/plan/updated` is the source of "2 of 3". Not observed in the probe (the
> prompt was too small to plan), name confirmed in the binary table.

### 3.2 Codex Desktop — rollout JSONL only

`pollCodexDesktop` → `driver.snapshot()` → `readThread()` → `parseRollout()`.
No app-server on this lane. CDP is delivery only, never reading.

30 distinct event kinds. Ranked by volume, with disposition:

| Event | Count | Carries |
|---|---|---|
| `response_item/message` | 25,121 | `role, content[], phase` |
| `event_msg/agent_message` | 22,564 | `message, phase, memory_citation` |
| `event_msg/token_count` | 6,354 | `info.total_token_usage{…}, info.model_context_window, rate_limits{used_percent, window_minutes, resets_at, plan_type}` |
| `response_item/reasoning` | 5,170 | `summary, encrypted_content, content` |
| `response_item/custom_tool_call` | 4,847 | `name, input, call_id, status` |
| `response_item/custom_tool_call_output` | 4,846 | `output, call_id` |
| `event_msg/agent_reasoning` | 2,177 | `text` — the bold thinking headers |
| `event_msg/task_started` | 2,039 | `turn_id, started_at, model_context_window, collaboration_mode_kind` |
| `event_msg/task_complete` | 2,013 | `duration_ms, time_to_first_token_ms, last_agent_message, error` |
| `event_msg/user_message` | 1,989 | `message, images[], local_images[], audio[], text_elements[]` |
| `response_item/function_call` | 795 | `name, arguments, namespace, call_id` |
| `response_item/function_call_output` | 795 | `output, call_id` |
| `turn_context` | 674 | `cwd, workspace_roots, model, effort, summary, personality, approval_policy, sandbox_policy, permission_profile, collaboration_mode, timezone` |
| `event_msg/mcp_tool_call_end` | 647 | `invocation{server, tool, arguments}, duration{secs, nanos}, result, read_only_hint` |
| `event_msg/thread_settings_applied` | 553 | `thread_settings{model, model_provider_id, service_tier}` |
| `event_msg/item_completed` | 504 | `item{…}` — PascalCase item model |
| `event_msg/patch_apply_end` | 503 | `changes{path → {type, content}}, stdout, stderr, success, status` |
| `session_meta` | 198 | `cwd, originator, cli_version, model_provider, git, base_instructions, dynamic_tools, parent_thread_id, forked_from_id` |
| `event_msg/web_search_end` | 143 | `query, action, results[]` |
| `compacted` / `context_compacted` | 52 / 51 | `replacement_history, window_number, window_id` |
| `response_item/web_search_call` | 30 | `action, status` |
| `response_item/agent_message` | 27 | `author, recipient, content[]` — inter-agent |
| `event_msg/turn_aborted` | 22 | `reason, duration_ms, started_at, completed_at` |
| `event_msg/sub_agent_activity` | 20 | `agent_path, agent_thread_id, kind, occurred_at_ms` |
| `event_msg/thread_rolled_back` | 6 | `num_turns` |
| `response_item/tool_search_{call,output}` | 3 / 3 | `arguments, tools[]` |
| `world_state`, `inter_agent_communication_metadata` | 212 / 27 | — |

Item types inside `item_completed` (**PascalCase in the rollout**):
`Reasoning{summary_text, raw_content}`,
`McpToolCall{server, tool, arguments, readOnlyHint, status, result, duration}`,
`AgentMessage{content[], phase}`, `UserMessage{content[]}`,
`CommandExecution{command[], cwd, parsed_cmd, source, status, stdout, stderr, aggregated_output, exit_code, duration, formatted_output, process_id}`,
`Extension{kind, query, action, results}`, `ContextCompaction{id}`.

**Casing differs between lanes** — camelCase on the wire, PascalCase on disk.
Normalise at the reader boundary.

**No plan payload exists in any rollout.** Searched all 185 files: zero. Codex
Desktop cannot show "2 of 3" and must not fake it.

`patch_apply_end` lands **mid-turn** (line 14 of a 20-line turn in a real file),
so file counts are live on this lane too.

### 3.3 Claude Code CLI — `~/.claude/projects/**/*.jsonl`

Also the read path for Claude Desktop, via `cliSessionId`.

Record types: `assistant` 24,686 · `user` 13,669 · `attachment` 3,595 ·
`last-prompt` 2,482 · `mode` 2,288 · `permission-mode` 2,281 · `ai-title` 2,191 ·
`system` 1,596 · `file-history-snapshot` 1,120 · `queue-operation` 663 ·
`agent-name` 591 · `file-history-delta` 247 · `worktree-state`/`relocated` 322 ·
`started`/`result` 210.

Content blocks: `tool_result` 11,819 · `tool_use` 11,799 · `thinking` 6,947 ·
`text` 6,240 · `image` 135.

Tool distribution: Bash 6,101 · Read 1,407 · Edit 1,306 · Write 338 ·
WebFetch 319 · ToolSearch 282 · Agent 212 · WebSearch 186.

`toolUseResult` shapes:

| Shape | Fields |
|---|---|
| Edit | `filePath, oldString, newString, originalFile, structuredPatch[{oldStart, oldLines, newStart, newLines, lines[]}], userModified, replaceAll` |
| Write/create | `type:'create', filePath, content, structuredPatch` |
| Read | `type:'text', file{filePath, content}` |
| Bash | `stdout, stderr, interrupted, isImage, noOutputExpected` |
| WebSearch | `query, results[], durationSeconds` |
| WebFetch | `bytes, code, codeText, result` |
| ToolSearch | `matches[], query, total_deferred_tools` |

Envelope fields: `message.model`, `message.usage{input_tokens, output_tokens,
cache_read_input_tokens, cache_creation_input_tokens, service_tier}`,
`message.stop_reason`, `effort`, `gitBranch`, `cwd`, `version`, `isSidechain`,
`agentId`, `attributionAgent`, `attributionSkill`, `attributionMcpServer`,
`attributionMcpTool`, `attributionPlugin`, `toolDenialKind`,
`interruptedMessageId`, `isApiErrorMessage`, `apiErrorStatus`,
`compactMetadata{trigger, preTokens, postTokens}`, `isCompactSummary`,
`permissionMode`, `imagePasteIds`.

`system` subtype `stop_hook_summary` carries `durationMs`, `messageCount`.

### 3.4 Web search results — links yes, logos no

Across 1,988 real result objects:

```
url 99% · title 100% · snippet 100% · domain 99% · thumbnail_url 5%
favicon/logo field: NONE
```

`thumbnail_url` is a content image, not a mark. **Decision:** derive a monogram
from the domain. No third-party favicon fetch — it would leak the user's
browsing to a favicon host from inside the notch.

## 4. The block model

One open discriminated union, replacing the flat row. Defined once in TypeScript;
Swift decodes tolerantly.

```ts
type Block =
  | { kind: 'message';    role: 'user'|'assistant'; text: string; at?: number }
  | { kind: 'reasoning';  text: string; streaming?: boolean }
  | { kind: 'command';    label: string; command: string; cwd?: string
                        ; exitCode?: number; output?: string; durationMs?: number
                        ; status: 'running'|'ok'|'failed' }
  | { kind: 'fileChange'; path: string; verb: 'Added'|'Edited'|'Deleted'
                        ; added: number; removed: number }
  | { kind: 'mcpCall';    server: string; tool: string; args?: string
                        ; durationMs?: number; ok?: boolean; readOnly?: boolean }
  | { kind: 'fileRead';   path: string; lines?: number }
  | { kind: 'search';     query: string; results: Source[] }
  | { kind: 'plan';       steps: { text: string; status: 'todo'|'active'|'done' }[] }
  | { kind: 'subAgent';   name: string; status: 'running'|'done'|'failed' }
  | { kind: 'denied';     what: string; reason?: string }
  | { kind: 'error';      message: string }
  | { kind: 'compaction'; before?: number; after?: number; trigger?: string }
  | { kind: 'unknown';    raw: string }

interface Source { title: string; domain: string; url: string; snippet?: string }

interface TurnMeta {                 // per turn, never per panel
  status: 'running' | 'done' | 'failed'
  durationMs?: number
  steps: number
  files: number
  added: number
  removed: number
  plan?: { done: number; total: number }
}

interface Usage {                    // panel footer
  used: number; window: number
  rateLimitPercent?: number; resetsAt?: number
}
```

**The open rule.** A decoder that meets an unrecognised `kind` produces
`{kind:'unknown', raw}` and the renderer draws a quiet plain row. It must never
fall through to an assistant bubble — today's `default:` branch in
`ConversationPresentation.build` does exactly that, which is why an unknown row
currently renders as a *wrong* message rather than a neutral one.

This rule is what makes providers independent: a reader may emit a richer kind
before the surface learns to draw it, on any single lane, with no coordination.

## 5. Provider mapping

| Block | Codex CLI (app-server) | Codex Desktop (rollout) | Claude Code CLI |
|---|---|---|---|
| `message` | `item userMessage/agentMessage` + `item/agentMessage/delta` | `event_msg user_message` / `agent_message` | `content[] text` |
| `reasoning` | `item reasoning` + reasoning deltas | `event_msg agent_reasoning.text` | `content[] thinking` |
| `command` | `item commandExecution` (exitCode, durationMs, aggregatedOutput) | `custom_tool_call` + `_output`, `item CommandExecution` | `tool_use Bash` + `toolUseResult{stdout, stderr, interrupted}` |
| `fileChange` | `item fileChange.changes[]` + `turn/diff/updated` | `patch_apply_end.changes` | `toolUseResult.structuredPatch` → ±lines |
| `mcpCall` | `mcpToolCall/progress`, `item McpToolCall` | `mcp_tool_call_end{invocation, duration}` | `tool_use mcp__*` + `attributionMcpServer/Tool` |
| `fileRead` | `item commandExecution` (read source) | `custom_tool_call` | `tool_use Read` + `toolUseResult.file` |
| `search` | `item Extension kind=web.search` | `web_search_end{query, results[]}` | `tool_use WebSearch` + `toolUseResult{query, results}` |
| `plan` | `turn/plan/updated` | **none — do not fake** | `tool_use TaskCreate`/`TaskUpdate` |
| `subAgent` | `sub_agent_activity` | `sub_agent_activity` | `isSidechain` + `attributionAgent` |
| `denied` | approval decision | inferred from missing output | `toolDenialKind` |
| `error` | `error` notification | `task_complete.error` | `isApiErrorMessage`, `apiErrorStatus` |
| `compaction` | `thread/contextCompacted` | `context_compacted` / `compacted` | `compactMetadata{preTokens, postTokens}` |
| `usage` | `thread/tokenUsage/updated`, `account/rateLimits/updated` | `token_count.info`, `rate_limits` | `message.usage` |

## 6. Rendering rules

**Turn grouping.** Consecutive non-`message` blocks between two messages form one
**work group**. Each group owns its own `TurnMeta`. There is no panel-level
progress: a panel-wide strip describes one turn while floating above all of them,
and in a three-turn thread its counts are ambiguous.

**Live vs settled.**

- running → group expanded; streaming reasoning and output visible; meta line
  reads `4 steps · 2 files +215 −12 · 2 of 3`
- complete → group collapses to `Worked for 2m 46s ›`; file changes surface as
  their own rows; final answer renders as markdown

A collapsed *running* group still shows its meta line, so it reports itself.
Earlier turns keep their counts permanently (`Worked for 8s · 2 steps`).

**Sources** are a section **inside** the work group, never chat rows. Monogram
(derived from domain) + title + domain, opening in the default browser
(`target=_blank`, `rel=noopener`). Snippet only in the expanded state.

**Jump to latest** is the only pinned element, shown solely when scrolled off the
live end. While a turn runs it carries the status, so a scrolled-away reader
still knows. The panel opens scrolled to the live end.

**Width: 520pt.** At 440 file paths truncate. Body 13px/1.5, mono 11px.

**Markdown** renders in `message` blocks only.

## 7. Code plan

| Layer | File | Change |
|---|---|---|
| Wire type | `electron/remote/notch/notch-client.ts` | add `blocks?: Block[]`, `turnMeta`, `usage` beside existing `conversation?: TurnP[]` |
| Task record | `electron/remote/task-manager.ts:209` | add `blocks?: Block[]`; keep `conversation` |
| Reader — CLI | `electron/remote/codex/app-server-events.ts` | extend `reduceAppServerEvent` past its 14 cases to the full notification set; emit blocks |
| Reader — Desktop | `electron/remote/codex/rollout.ts` | `parseRollout` emits blocks; keep `CodexTurn[]` for the fallback |
| Reader — Claude | `electron/remote/transcript.ts` | emit blocks from content blocks + `toolUseResult` |
| Swift wire | `native-notch/Sources/unmute-notch/IPC.swift` | `Block` decoding with `unknown` passthrough |
| Swift model | `ConversationSupport/ConversationPresentation.swift` | group by turn; `default:` → `.unknown`, never `.answer` |
| Swift views | `unmute-notch/ConversationPanel.swift` | one view per kind; work group; sources; jump-to-latest |

**Compatibility.** `conversation` stays and keeps working. The renderer prefers
`blocks` when present. A provider that has not been migrated is unaffected — but
all three are migrated in this change, so the fallback exists for rehydrated
sessions persisted before the upgrade, not as a staging device.

## 8. Tests

- **Readers:** one test per block kind per provider, from real fixture lines
  copied out of the corpus (not invented).
- **Casing:** camelCase (wire) and PascalCase (rollout) both map to the same block.
- **Open rule:** an unknown kind decodes to `unknown` and renders as a plain row —
  asserted in both TS and Swift.
- **Grouping:** three-turn thread produces three groups, each with its own meta;
  earlier groups keep their counts.
- **Live/settled:** a running group is expanded with a meta line; a completed one
  collapses and keeps it.
- **Regression gate:** the full 1539-test remote suite stays green; typecheck
  shows no new errors.
- **No input-path diff:** `git diff --stat` must not touch `sendTaskReply`,
  executors, CDP paste, or pasteboard files.

## 9. Fidelity

Rather than eyeballing spacing, measure the real Codex window over CDP —
computed line-height, block spacing, max line width, collapsed-row metrics — and
match. Same measure-the-app method that resolved the delivery bugs on 2026-08-15.

## 10. Starting cold

Everything needed to continue is in the repo. Nothing lives only in a chat log.

**Evidence.** `electron/remote/codex/__fixtures__/app-server-live-turn.jsonl` is
a real captured turn — 63 messages, 12 methods — and is the record behind §3.1.
`capture-app-server.mjs` beside it re-runs the capture if the protocol moves:

```bash
node electron/remote/codex/__fixtures__/capture-app-server.mjs
```

It is bounded on every axis (90s, 8MB, server killed in a finally block).
**Do not run `codex app-server --help`** — it starts a server and floods stdout;
it filled this machine's disk on 2026-08-15.

Re-derive the rollout and transcript inventories with plain aggregation over
`~/.codex/sessions/**/rollout-*.jsonl` and `~/.claude/projects/**/*.jsonl`;
counts in §3.2 and §3.3 are from those, and will differ on another machine while
the field shapes will not.

**Definition of done.** One delivery, not a staged rollout. All three readers,
the wire, the Swift views, and the fidelity pass ship together. A provider is
not "done" while its blocks are unimplemented, and the feature is not done while
any lane still renders through the old flat row.

**Decisions already made** — do not relitigate without a reason:

| Decision | Why |
|---|---|
| Panel width **520pt** | 440 truncates file paths |
| Source **monograms**, not favicons | no logo field exists; a favicon host would see the user's browsing |
| Links open the **default browser** | `target=_blank`, `rel=noopener` |
| Sources sit **inside** the work group | they are evidence for the work, not chat messages |
| Progress is **per turn** | a panel strip is ambiguous in a multi-turn thread |
| Codex Desktop shows **no plan** | zero plan payloads exist in any rollout |
| One renderer, **views per kind** | per-provider renderers would drift and every new provider would start blank |

**Regression guards.** These were expensive to get right and must not move:
image paste into both terminal and non-terminal views, right-option and Fn
capture, the pasteboard handoff, verified composer submission, and Codex
attachment delivery. If a diff touches `sendTaskReply`, the executors, the CDP
paste path or `pasteboardHandoff`, it has left this spec's scope.

## 11. Non-goals

- Rewriting the provider/transport abstraction. It is correct.
- Per-provider renderers. One renderer, per-kind views; a new provider inherits a
  working chat view instead of starting blank.
- Real favicons (privacy cost, see §3.4). Monogram now; a setting later if wanted.
- Editing or acting on blocks. This is a read surface.
