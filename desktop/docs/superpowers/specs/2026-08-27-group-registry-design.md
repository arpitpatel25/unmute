# Group Registry & Subject-Led Naming — Design Spec (2026-08-27)

**Supersedes §2 of `2026-07-16-cockpit-grouping.md`.** That spec is otherwise
intact and remains the record of why live-only grouping was tried; read it
first. Exactly one of its numbered decisions is overturned here.

## Problem

Two complaints, one root cause.

**Names describe the action, not the subject.** "Open Dodo women's page",
"Update the pricing model". Fine on a single card; useless on a wall, where
several tasks share a subject and every title is a different verb applied to the
same invisible noun.

**Groups sprawl into near-duplicates** — "unmute", "unmute cloud", "unmute AI"
for one stream. Not a judgement failure. Four mechanical causes, none of which
involve the model being wrong:

1. **No normalization anywhere.** `setGroup` trimmed and truncated to 32 chars;
   every comparison was exact string equality. "unmute" and "Unmute" were two
   streams.
2. **Two independent authorities wrote the field.** Imported CLI sessions took
   the cwd basename ("unmute-cloud"); the router took the user's spoken words
   ("unmute"). Nothing reconciled them.
3. **The vocabulary was scoped per backend.** There is one router per backend and
   each is handed only its own tasks — deliberately, so a Claude router cannot
   propose resuming a Codex thread. But the LIVE GROUPS block was *derived from
   those already-filtered lists*, so a Claude task and a Codex task about one
   subject were structurally incapable of joining the same group.
4. **The vocabulary evaporated.** §2 made the screen the entire state: groups
   were the distinct labels across live tasks. A stream whose tasks had ended was
   invisible, so the next mention minted it again. §2 accepted this — *"a stream
   that briefly empties may get a fresh name later — rare… and correct when it
   happens."* Field evidence says it is not rare.

## The decision

**A durable registry of streams, and prevention rather than cleanup.**

1. **Groups persist.** `group-registry.ts` holds `{ id, label, key, source,
   createdAt, lastSeenAt }` in an Unmute-owned sidecar
   (`~/.unmute/remote/groups.json`), following `skill-usage.ts`'s ownership rule.
   This is the one reversal of §2.
2. **Identity is a folded key, never the raw label.** `group-key.ts` casefolds,
   collapses whitespace, folds `-` `_` `/` to spaces, and strips punctuation. It
   is why the second "Unmute" resolves to the first "unmute" instead of forking,
   and why the import path's "unmute-cloud" lands on the same stream the user
   calls "unmute cloud".
3. **Tasks are filed by id; the label is derived.** `Task.groupId` is the
   identity, `Task.group` the display name every surface renders. A rename is a
   one-field write on the entry — the old walk-and-rewrite worked only because
   nothing outlived it, and with persistence it would orphan every task not
   currently loaded.
4. **The vocabulary is backend-agnostic.** It is passed into
   `buildRoutingPrompt` as its own parameter rather than derived from the task
   lists. Task scoping is untouched: a group is metadata and cannot be dispatched
   into, so sharing it costs none of the separation scoping buys.
5. **The model's group is validated at parse**, exactly as `dir` is pinned to a
   known project path and `surface` to a canonical enum. A label naming a known
   stream canonicalizes to that stream's stored label; an unmatched label
   survives as written — that is the create path, and it is the normal case for
   new work.
6. **Assign-once still holds** (§5 of the prior spec, unchanged and now more
   true): a task is filed at dispatch or at the graduating follow-up, and after
   that only the user moves it.
7. **Names lead with the subject.** Both producers — the router's `name` contract
   and `PROMPTS.taskName` — plus the MCP `task_create` schema. The group names
   the stream; the name says which piece of work inside it.

## Deliberately NOT built: the periodic regrouping pass

Considered in full and ruled out on 2026-08-27. Recorded because it is the
obvious thing to reach for.

Every sprawl source above is a **prevention** bug. Fix all four and the mechanism
that mints duplicates is gone, so a pass that cleans them up afterwards would be
maintaining a problem that no longer generates cases.

Moving a task between groups is also a bad trade on its own terms. A card that
silently jumps sections is the "tear down and rebuild" complaint from the August
backlog, and it buys nothing back: retrieval does not depend on grouping. A
finished task carries its own `result.summary`, and the Agent reaches every
session directly via `sessions_list` / `session_read` and by reading
`~/.claude/projects` and `~/.codex/sessions`. Nothing is *lost* by a task sitting
in the wrong group — which makes the risk of moving it unjustified.

One honest limit on that argument: a **live** persistent session has no summary
(`result` is populated only on a terminal state), so the "nothing is lost" claim
rests on the risk asymmetry, not on summaries alone.

What remains automatic is only what cannot churn: filing an **ungrouped** task
(nothing jumps; something appears where there was nothing) and letting empty
machine-authored streams decay.

## Lifecycle

`auto` entries with no members and no activity past `GROUP_IDLE_EVICT_MS`
(45 days) are dropped after rehydrate. `user` entries never decay — their absence
would be a deletion nobody asked for. The window is generous on purpose: an
empty-but-remembered entry is the whole mechanism by which a returning stream
rejoins its old name, so pruning eagerly re-creates the bug this exists to fix.

## UI

A **Groups** section in the Orchestrator's settings panel: add and edit only.
Naming a stream adopts a matching one rather than duplicating it, and marks it
`user` — which exempts it from decay and tells the router it carries more weight
than a guess.

**Delete is absent on purpose.** Cards filed under an entry render its label, so
removing one would leave them pointing at a stream that no longer exists.

The walls need no change: labels still cross the notch IPC and reach the
renderer, so `groupSections.ts` and the Swift `WallView` are untouched. One known
nit — the notch keys per-group expansion state on the label, so a deliberate
rename collapses an open section. Acceptable while nothing renames
automatically.

## Migration

Every task on disk carries a bare label and no id. `rehydrate` resolves each into
an entry on first load, which is also the first deduplication the user sees:
case and spacing variants collapse with no model involved. Genuinely different
strings meaning one thing ("unmute cloud" vs "unmute AI") stay separate and are
left to voice curation — once, since the registry stops the list growing again.

## Files

`group-key.ts` (new, pure) · `group-registry.ts` (new, injectable path/clock/id)
· `task-manager.ts` (`Task.groupId`, `groupFromMeta` migration, `setGroup` /
`renameGroup` / `liveGroupIds`) · `router.ts` (`GroupOption`, vocabulary
parameter, `canonicalGroup`, curate-rename against the registry, subject-led name
contract) · `config.ts` (`PROMPTS.taskName`) · `mcp-server.ts` (`task_create`
name schema) · `init.ts` (registry construction, `groupVocabulary`,
`pruneGroups`, import reconciliation, three IPC handlers) · `remote-preload.ts` ·
`RemoteSettings.tsx` (Groups section).

## A hazard found on the way

A test in `router.test.ts` asserting the **absence** of a string
(`assert.ok(!p.includes(...))`) deadlocked the entire file — but only when it
passed. When it failed, the file completed normally. It froze the reporter after
test 9 while later tests kept executing, so it presented as a hang in an
unrelated Router timeout test. Rewriting it as a positive `assert.match` fixed it
completely; the mechanism was never identified. Prefer positive assertions in
this suite.
