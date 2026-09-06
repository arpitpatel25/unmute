# Unmute Agent main-session continuity and metadata

> **For agentic workers:** use test-driven development. User approved implementation, new commits, and a signed/notarized dev installation.

**Goal:** Unmute Agent operates only on verified main conversations, with descriptive titles and resolved workspaces compulsory at creation and continuation boundaries.

**Architecture:** Shared bounded transcript provenance reader feeds discovery and a fail-closed execution guard. Metadata travels separately from user prompts, is validated at capability and host boundaries, and is stamped before a task becomes visible. Existing native resume/fork identities and operation receipts remain unchanged.

**Scope:** Unmute Agent only; ordinary dictation, manual tasks, and provider execution semantics remain unchanged. Preserve existing history and user files.

- [x] Add failing provenance tests for Codex child vs main, Claude sidechains, incomplete/unknown records, legitimate main forks, and oversized metadata.
- [x] Implement bounded structured provenance projection; filter catalog; expose execution guard with useful parent-session diagnostics.
- [x] Add failing metadata tests for required title/workspace, inheritance, canonical resolution, prompt separation, and pre-publication stamping.
- [x] Implement capability schemas, workspace discovery, host enforcement, and both handoff host paths. Validate synthesis sources too.
- [x] Ensure an idle-only Agent worker handover loads the new tool schemas after installation; preserve running task workers and recover a restarted Agent worker using fresh configuration.
- [x] Run targeted and broader regression suites; review diff and resolve scoped failures. Provenance: 19 passing; metadata/continuity: 76 passing; socket handover/restart: 6 passing; encrypted memory under Electron: 15 passing. Broad host-Node suite has native ABI mismatch and pre-existing timing/hanging tests; standalone typecheck has five existing wired-tree import errors. Packaged build remains the integration gate.
- [ ] Commit scoped changes; build next signed/notarized dev version with temporary verbose logging, restore logging switches, install recoverably, verify signature/version and launch.

## Acceptance checks

- The observed review child `01a073da-1210-7350-8f45-0209839d74be` is ineligible; main `01a073ca-74d6-7c92-af61-c5030ad0fcbf` remains eligible.
- Supplying a child ID directly cannot bypass discovery filtering.
- Missing/placeholder metadata cannot create a card. Existing canonical workspace is inherited without duplicate groups.
- No prompt is injected for naming; resume retains exact source ID, fork retains native child identity and retry deduplication.
- No live user conversation is forked, resumed, deleted, or sent a test message during verification.
