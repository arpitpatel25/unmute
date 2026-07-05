---
name: refresh-main-conversation
description: Garbage-collect the long-running main conversation — distills this whole thread + repo state into a fresh baseline document and stages a clean successor session, when the main thread has become summary-of-summary mush. Rare maintenance; use only when the main thread feels degraded or bloated.
---

# Refresh Main Conversation

After many features and many compactions, the main thread becomes
summary-of-summary-of-summary — quietly lossy, expensively long. This skill
re-baselines it: everything durable gets distilled into ONE baseline document,
and a fresh session adopts it as its starting context. Like squashing history:
the old thread is archived, not merged.

**Run this FROM the main conversation, at the parent repo.** Expect to use it
rarely (every N features, or when recall feels off) — if you're reaching for
it weekly, something else is wrong.

## Step 0 — absorb the mailbox first

Process `<parent>/.claude/handoffs/*.md` exactly as create-feature-workspace
does (read → summarize into the conversation → delete). The baseline must
include their content; never re-baseline over an unread mailbox.

## Procedure

1. **Compose the baseline** — the whole point; take it seriously. Write
   `<parent>/.claude/handoffs/BASELINE-<YYYY-MM-DD>.md` containing everything
   a successor needs and nothing it doesn't:
   - **What this project is** (a paragraph — the product thesis).
   - **Current state**: shipped version, what's in main, what's mid-flight,
     link-worthy paths (key docs, release pipeline notes).
   - **Standing decisions & sacred constraints**: every "do not drift" rule
     this thread has settled — the things a fresh session could innocently
     violate. This section is the crown jewels; scan the whole conversation
     memory for them, don't just list the recent ones.
   - **Known issues / open threads**.
   - **How we work**: the worktree+conversation workflow, these three skills,
     the release process.
   Target: comprehensive but readable — hundreds of lines is fine,
   transcripts are not.
2. **Verify with the user**: show the section headers + anything you were
   unsure about including. One round, not a ceremony.
3. **Stage the successor** — print exactly this, filled in:
   ```
   Baseline written: .claude/handoffs/BASELINE-<date>.md

   To start the refreshed main thread:
     cd <parent> && claude "Read .claude/handoffs/BASELINE-<date>.md and adopt
     it fully as your working context. You are the continuation of the main
     <repo> conversation."

   This thread is now archived — stop using it after the successor confirms.
   The baseline file stays (it doubles as the mailbox seed for the new thread).
   ```

## Rules

- NEVER delete the old session's transcript — archive by abandonment.
- The baseline is curated truth: if you're unsure whether something is still
  true, verify against the repo before writing it, or mark it "(unverified)".
- Do not run from a feature worktree; this is a parent/main-thread operation.
