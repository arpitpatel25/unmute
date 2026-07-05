---
name: merge-and-close-feature
description: Finish a feature — merges its branch into main at the parent repo, pushes, distills THIS conversation into a handoff for the main thread, and tears down the worktree. Use from inside a feature workspace session when the work is done and verified.
---

# Merge and Close Feature

The landing sequence for a feature workspace: **code merges to main**, **this
conversation's learnings flow back to the main thread** (as a distillate, not
a transcript), and **the scaffolding is torn down**. The sibling skill
`create-feature-workspace` is the spawner; this is the harvester.

## Preconditions — verify, and STOP with a clear report if any fail

1. Current directory is inside a **worktree** (not the parent):
   `git worktree list` — parent is the first entry; if we ARE the first entry,
   stop: "this looks like the parent checkout, nothing to close."
2. Working tree is **clean** (`git status --porcelain`). If dirty: show what's
   uncommitted and ask — commit it (offer to), stash it, or abort. Never merge
   a dirty tree silently.
3. Tests/typecheck: if the repo has obvious verification commands (npm test,
   typecheck), run them. On failure: report and ask whether to proceed anyway
   — never silently merge red.

## Inputs — self-discovered, ask only on ambiguity

- `BRANCH` = current branch (`git branch --show-current`).
- `PARENT` = first entry of `git worktree list`.
- `WT` = current worktree root (`git rev-parse --show-toplevel`).
- Target branch: `main` unless told otherwise.

## Procedure

1. **Merge at the parent** (never from inside the worktree):
   ```bash
   git -C "$PARENT" pull -q origin main
   git -C "$PARENT" merge --no-edit "$BRANCH"
   git -C "$PARENT" push origin main
   ```
   On merge conflict: stop, report the conflicting files, and ask how to
   proceed (resolve here / abort). Never force anything.

2. **Write the handoff** — the conversation-merge. Compose a distillate of
   THIS feature session (you lived it — write from memory + `git log` of the
   branch). Target 10–25 lines. Structure:
   ```markdown
   # Handoff: <BRANCH> (<date>)
   ## What landed
   <2-4 lines: the feature, user-visible behavior>
   ## Decisions made (the WHY that isn't obvious from code)
   <bullets — only decisions a future session could accidentally violate>
   ## Gotchas / lessons
   <bullets — bugs found, dead ends, constraints discovered>
   ## Open threads
   <bullets — anything deliberately left undone; write "none" if none>
   ```
   Save to `"$PARENT"/.claude/handoffs/<YYYY-MM-DD>-<BRANCH-sanitized>.md`
   (create the dir if needed). This mailbox is absorbed by the main thread the
   next time any of these workflow skills runs there.

3. **Prune the branch** (it's merged): `git -C "$PARENT" branch -d "$BRANCH"`.
   If `-d` refuses, the merge didn't actually land — investigate, don't `-D`.

4. **Teardown — the part that outlives this session.** The worktree cannot be
   removed while this session stands in it. Print exactly this, filled in, as
   the FINAL output:
   ```
   Landed: feat/<NAME> → main (pushed). Handoff written for the main thread.

   Last step — run AFTER quitting this session:
     git -C <PARENT> worktree remove <WT>

   This conversation is now spent (its learnings live in the handoff +
   commits). No need to keep it.
   ```

## Rules

- The handoff is a DISTILLATE: decisions, gotchas, open threads. Never paste
  transcripts, logs, or code into it — the repo already carries those.
- Never delete the worktree yourself; never delete an unmerged branch.
- If the user asks to close WITHOUT merging (abandoning the feature), confirm
  explicitly, skip steps 1–3, still offer a brief "abandoned: why" handoff.
