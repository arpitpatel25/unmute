# Cockpit Grouping — Design Spec (signed 2026-07-16)

> **§2 is superseded** by `2026-08-27-group-registry-design.md`. Groups are no
> longer live-only: they persist in a registry, because the accepted
> consequence below — "a stream that briefly empties may get a fresh name
> later — rare" — turned out not to be rare, and was the main source of
> near-duplicate groups. Everything else here still holds, §5 (assign-once)
> included.

## Problem

The Orchestrate wall renders every task as an equivalent card in a flat grid. Field feedback: "what do I do?" — users with many live Claude Code sessions disengage because the wall gives no entry point. People already juggle tens of terminal tabs and refuse to close them; they group in their heads because no tool does it for them. Grouping is the wall's core legibility feature.

## The model (decided in conversation, 2026-07-16)

1. **Group by aboutness, never by activity type.** A group answers "what is this work *about*?" — the project, the artifact, the stream ("unmute", "launch video", "on-call") — never the verb ("coding", "media", "research"). No taxonomy exists anywhere, not even in the prompt.
2. **Live groups only. The screen is the entire state.** The group set at any moment is exactly the distinct `group` values of live tasks. No registry, no history, no decay. Wall empties → clean slate; past groups have zero influence. Accepted consequence: a stream that briefly empties may get a fresh name later — rare (persistent tasks live days; cleanup is manual and lazy) and correct when it happens.
3. **Stream altitude.** The group is the ongoing stream ("on-call"); the item (ticket PAY-123) is the card. Test in prompt: "a group is something the user will still care about next week."
4. **Join beats create.** Ten groups of one task = no grouping. Create only for a clearly distinct ongoing subject, named in the user's own words (2–3 words, the subject, never a category word). When unsure: none (ungrouped).
5. **One decision, frozen.** Group assigned once (at dispatch for new sessions; at the graduating follow-up for one-offs). The machine never reshuffles. Only user curation mutates.
6. **User's words win.** If the utterance names a group ("for the launch video, …"), that's the group. Voice curation ("group these two as X", "rename that group") always wins and is immediate.
7. **cwd is evidence, not a rule.** A session about a repo often doesn't start in it. The repo/folder basename is one signal to the LLM alongside the intent text — no separate deterministic path.

## Who decides: the router (zero added LLM cost)

Every command already runs one routing call on the **user's own plan**. Extend it:

- **Input**: each live task line gains its `group` (or `-`); the distinct live group list is thereby visible in context.
- **Output**: `RouteDecision` gains optional `group` — applied to the task the decision creates (`new`) or targets (`followup`/`answer`) **only if that task has no group yet** (freeze). Malformed/absent ⇒ ungrouped, silently. Grouping is metadata, never a gate: it must never delay or fail a dispatch.
- **Curation**: new action `curate` with `ops: [{op:"set_group", taskIds, group} | {op:"rename_group", from, to}]`, resolved by the router against the snapshot it already has ("these two", "the video ones"). Host applies ops directly.

**Judgment call — no MCP surface.** `mcp-server.ts`'s documented invariant ("sessions may ADD work, never TOUCH the wall; wall-reading deliberately absent") stays intact. Voice curation is user-initiated and flows through the router; sessions never gain wall-mutation tools. If a future feature needs session-side curation, that reversal gets its own decision.

**Graduation**: a one-off graduates on its 2nd follow-up — a routed command — so the same mechanism groups it at that moment. No contract/status-file changes.

## UI (explicitly minimal — user directive)

- Cards, rail, Stage, filters: **unchanged**. Nothing removed.
- The sessions grid gains **group section headers**: each live group renders as a header + its cards; ungrouped tasks render last under no header (no invented label beyond a muted "ungrouped" divider when at least one named group exists; with zero named groups the wall looks exactly like today).
- **Newest on the left** within a section (store is already newest-first; preserved). Sections ordered by most-recent member activity, most active first.
- No seen-bits, zones, weights, verdicts, cranks, or corrections ledgers (old branch discarded wholesale).

## Out of scope (deliberate)

Manual drag/drop or dropdown regrouping UI (voice curation covers influence; revisit on demand). Group persistence/registry. Hierarchy/subgroups. One-off grouping before graduation. MCP curation tools. History surfaces.

## Files (implementation map)

`task-manager.ts` (Task.group + setGroup/renameGroup + meta persistence + rehydrate) · `router.ts` (RoutableTask.group, RouteDecision.group + curate action, prompt contract, parseDecision) · `init.ts` (snapshotOf, serializeTask, apply group on new/target, apply curate ops) · `useRemoteTasks.ts` (RemoteTask.group) · `OrchestrateWall.tsx` (group sections around the existing grid) + a pure, tested `groupSections` helper · tests for router parse, task-manager persistence, and the section builder.
