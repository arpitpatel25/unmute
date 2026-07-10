# Does the existing routine workflow change when we add the skills co-pilot?

**Short answer: the routine ENGINE stays unchanged — and that should be an
explicit design constraint — but "completely unchanged" is not accurate. The
existing system already reaches (read-only) into the user's skill territory, so
the two overlap at a real surface today. The changes are additive and land on
the shared SURFACE and shared LIBRARIES, not on routine behavior.**

Grounded in the current code (not speculation):

## What I verified in the code

1. **Voice-remote tasks run with the real HOME** (`task-manager.ts` uses
   `homedir()`; no isolated `CLAUDE_CONFIG_DIR`). So the user's global
   `~/.claude/skills` are already visible inside every voice-remote task — the
   co-pilot's future edits to those files will be seen by routine tasks
   automatically. Co-mingling already exists.

2. **The skill rail already lists the user's `~/.claude/skills`.**
   `remote:list-skills` (`init.ts` ~1606) walks `~/.unmute/remote/{skills,recipes}`
   **and** `~/.claude/skills`, merges them into ONE earned-trust ranking (pinned →
   runs → recency), deduped by name. The user's own skills are *already* first-
   class citizens of the existing surface.

3. **The usage ledger already credits the user's own skills.** `skill-usage.ts`
   counts `Skill` invocations for ALL skills and merges: frontmatter
   `runs_confirmed` for Unmute-owned + sidecar `runs` for everything — "for ALL
   skills incl. the user's own — **whose files we never write**."

## So: engine unchanged, but three real touchpoints (all additive)

**A. The rail is the co-pilot's natural home → the SURFACE evolves.**
The moment the co-pilot creates/updates the user's `~/.claude/skills`, those
changes *automatically* flow into the existing rail — new skills appear, updated
ones change, retired ones drop. That's not a change you make to the routine
engine; it's an emergent effect of a surface that already reads that directory.
The likely *addition*: **provenance/attribution.** Today every rail entry is
either an Unmute recipe or the user's static file. Once the co-pilot is actively
mutating user skills, the rail becomes a live, changing surface, and users will
ask "why did this change / where did this come from." The rail probably needs to
carry origin (Unmute-owned vs user-authored vs co-pilot-suggested) it doesn't
carry now. This is the single most concrete change to something that exists.

**B. The usage ledger is a shared dependency → EXTEND, don't change.**
The co-pilot needs richer signal than "runs" — it needs deviation / got-stuck /
outcome to drive update+retire decisions. That's an *additive extension* to the
ledger, and the routine system keeps consuming its existing half untouched. New
columns, not changed behavior.

**C. The stated invariant must be re-scoped (docs, not routine logic).**
Today the global principle is "Unmute NEVER writes `~/.claude/skills`." After the
co-pilot that is no longer globally true. The routine *code* still doesn't write
there — but the `skill-usage.ts` comment "whose files we never write" becomes
false-as-stated and must be updated to **"which the routine/librarian system
never writes; the skills co-pilot writes them only with explicit user consent."**
The boundary moves from a hard wall to a consent-gated door. If we don't re-state
this, a future reader trusts a stale invariant.

## The design rule this implies

**Adding the co-pilot must require ZERO changes to routine BEHAVIOR** — how
routines are discovered, graduated, judged by the librarian, or injected into
task cwds. If we ever find ourselves *needing* to change routine behavior to make
the co-pilot work, that's a red flag that we're merging the two systems we just
agreed to keep separate (see `05`). Legitimate changes are confined to:
- **additive** extensions of shared libraries (usage ledger, trace-reduction),
- the shared **surface** (the rail — a product decision, provenance/attribution),
- **re-stating** the write-boundary invariant per-system.

## Honest bottom line

The routine workflow's *behavior* stays intact, and we should hold that as a
constraint. But it does not remain literally "unchanged," because the current
product already surfaces and counts the user's own skills — so the co-pilot's
output flows into an existing shared surface. Plan for: rail provenance, an
additive ledger extension, and a re-scoped write-boundary. None of these touch
how routines actually work; all of them are integration seams that already exist
precisely because the current system was built to *read* the user's skills even
though it was forbidden to *write* them.
