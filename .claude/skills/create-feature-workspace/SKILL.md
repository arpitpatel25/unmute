---
name: create-feature-workspace
description: Start a new feature — creates a git worktree + feature branch AND forks the current Claude Code conversation into it, so the feature session inherits this thread's context. Use when the user wants to begin work on a new feature/fix in its own isolated workspace.
---

# Create Feature Workspace

One command spawns everything a feature needs: an isolated **git worktree**, a
**feature branch**, and a **forked copy of the current conversation** staged in
that worktree — so the feature session starts already knowing everything this
thread knows.

## The workflow this belongs to (context)

The parent repo checkout is the permanent thing: the `main` branch, the main
Claude conversation, prod merges. Worktrees and their conversations are
disposable scaffolding: forked out per feature, merged back, deleted. The
sibling skill `merge-and-close-feature` handles the landing; this one handles
the spawning.

## Step 0 — absorb the mailbox (always, before anything)

Check `<parent-repo>/.claude/handoffs/` for `*.md` files. Each is a handoff
distillate from a feature that landed while this thread wasn't looking.
If any exist: read each, summarize its content into this conversation in 2-3
sentences per file ("Feature X landed: …"), then DELETE the file. This is how
merged features' context flows back into the main thread. If none exist, say
nothing and move on.

## Inputs — resolve, then ask ONLY what's missing

1. **Feature name** (required): short kebab-case, e.g. `voice-shortcuts`.
   If the user gave a description instead of a name, derive one and confirm it
   in passing (don't block on it). If nothing was given, ask.
2. **One-paragraph feature intent** (recommended): what this feature is for.
   If the user's invocation already describes it, use that; only ask if you
   have literally nothing.
3. **Parent repo root** (self-discover): `git worktree list` — the FIRST entry
   is the parent checkout. If the current directory isn't inside any git repo,
   ask which repo to use.
4. **Base branch**: `main` unless the user says otherwise.

## Procedure

Let `PARENT` = parent repo root, `NAME` = feature name,
`WT` = sibling path `<PARENT-parent-dir>/<repo-name>-<NAME>`
(e.g. `~/tools/unmute/unmute-cloud-voice-shortcuts`).

1. **Safety checks**:
   - `git -C "$PARENT" status --porcelain` — warn (don't block) if the parent
     tree is dirty.
   - Branch `feat/<NAME>` must not already exist; worktree path must be free.
     If either exists, say so and ask whether to reuse or rename.
2. **Worktree + branch**:
   ```bash
   git -C "$PARENT" worktree add "$WT" -b "feat/$NAME" main
   ```
3. **Fork the conversation**:
   - Find THIS session's transcript: compute the project slug of the current
     working directory (absolute path with every `/` and `.` replaced by `-`),
     then take the most recently modified `*.jsonl` in
     `~/.claude/projects/<slug>/`. Its basename (minus `.jsonl`) is the
     current session ID.
   - Compute the slug for `$WT` the same way, `mkdir -p` its folder under
     `~/.claude/projects/`, and `cp` the transcript there (same filename).
4. **Feature brief**: write the intent paragraph to `$WT/.claude/FEATURE.md`
   (create dir if needed) — the forked session's first anchor. Include: the
   feature name, the intent, today's date, and one line: "When done, invoke
   /merge-and-close-feature."
5. **Hand the user the key** — print exactly this, filled in:
   ```
   Workspace ready:
     worktree : <WT>   (branch feat/<NAME>)
     brief    : <WT>/.claude/FEATURE.md

   To start the feature session (inherits this conversation):
     cd <WT> && claude --resume <SESSION_ID> --fork-session
   ```

## Rules

- NEVER modify the parent checkout's branch or working tree (beyond reading).
- NEVER touch this session's own transcript beyond copying it.
- The whole thing is one shot when inputs are resolvable — do not ask
  questions the repo or the invocation already answers.
