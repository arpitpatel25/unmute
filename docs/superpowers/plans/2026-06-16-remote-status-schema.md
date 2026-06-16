# Unmute Remote — Status-File Schema (PROPOSED — needs sign-off)

> **This is the frozen wire protocol between Unmute and Claude Code (PRD §6.1).**
> It is the ONE artifact the product owner wants eyes on before it goes
> load-bearing. Everything downstream (completion detection, needs-user,
> notifications, recipe capture) keys off this. Once approved, treat it as
> stable — changing it later means re-coordinating both sides.
>
> Blast radius if changed after approval: `desktop/electron/remote/status-file.ts`
> (types + reader) and `desktop/electron/remote/contract/contract.md` (the
> instructions Claude follows). Nothing else hard-codes the field names.

## Ownership (decided, PRD)
- **Unmute creates the file and owns its path.** It scaffolds an initial
  `status.json` with `{ "schema_version": 1, "state": "processing" }` before
  the task starts, and passes Claude the exact path.
- **Claude only writes content into the fields.** It never chooses the path,
  never creates the file from scratch.
- **Unmute only ever reads** the file after scaffolding — it never edits the
  content Claude owns (PRD §6.1).

## Atomic-write contract (decided, PRD #2 — both sides)
- **Claude writes atomically:** write to `status.json.tmp` in the same dir,
  then `rename()` over `status.json`. Rename is atomic on the same filesystem,
  so Unmute never observes a half-written file.
- **Unmute reads tolerantly:** a missing / truncated / invalid-JSON read is
  treated as "no update this poll" — ignored, retried on the next poll. A
  partial read never errors the task.

## Path convention (decided, PRD #5)
```
~/.unmute/remote/<userKey>/<taskId>/status.json     # the status file
~/.unmute/remote/<userKey>/<taskId>/recipe.json     # recipe-suggestion scratch (PRD §8.1 / §9)
~/.unmute/remote/<userKey>/<taskId>/                 # the session working dir (cwd for the PTY)
~/.unmute/remote/logs/remote-<runId>.log            # session logs (PRD owner ask)
```
- `<userKey>`: the signed-in managed user id if present, else `local` (Remote
  works regardless of managed sign-in — it drives the user's own Claude Code).
- `<taskId>`: a uuid minted by Unmute per capture. Per-task dir ⇒ **zero
  cross-task contention** (PRD §6.1) — status files are never shared.

## The schema (JSON)

```jsonc
{
  // ── written by Unmute at scaffold time; Claude must preserve it ──
  "schema_version": 1,                  // integer; bump only on breaking change

  // ── the lifecycle state (PRD §5.3). Claude transitions this. ──
  "state": "processing",                // "processing" | "needs-user" | "done" | "failed"

  // ── heartbeat (PRD: push model). Claude updates on every meaningful step. ──
  "updated_at": "2026-06-16T15:04:00Z", // ISO-8601; logical heartbeat. NOTE: file
                                        //   mtime is the AUTHORITATIVE staleness
                                        //   signal (PRD §6.3) — this field is for
                                        //   human/log readability + sanity-checking.
  "step": "unzipping archive",          // optional short human label of the current step;
                                        //   surfaced in the task row as live status detail.

  // ── on state="done" (PRD §13.4 #3: result must land ON the task) ──
  "result": {
    "summary": "Extracted 12 files to ~/Downloads/report/",  // one-line human summary (required on done)
    "detail": "report.pdf, data.csv, … (12 files)",          // optional longer text
    "artifacts": [                                            // optional — clickable in the row
      { "type": "path", "value": "~/Downloads/report/" },    // "path" | "url"
      { "type": "url",  "value": "https://…" }
    ]
  },

  // ── on state="failed" (PRD §13.4 #4: surface WHY) ──
  "error": {
    "reason": "report.zip is password-protected",  // human-readable cause (required on failed)
    "detail": "unzip exited 82"                     // optional technical detail
  },

  // ── on state="needs-user" (PRD §7) ──
  "question": {
    "text": "Which Rishi? I found 3 in Slack.",     // required when needs-user
    "kind": "free_text",                            // "free_text" | "choice" | "confirm"
    "choices": ["Rishi Sharma", "Rishi Patel", "Rishi K"],  // present when kind="choice"
    "irreversible": false                           // true when this is a §10.7 destructive-action confirm
  },

  // ── recipe capture (PRD §8.1 / §9): a POINTER, not inline. ──
  // The doer writes its actual suggestion into recipe.json (its own scratch
  // file); here it only flags that a suggestion exists so the librarian pass
  // (a later plan) knows to look. Keeps the status file small + single-purpose.
  "recipe_suggestion": {
    "present": true,
    "scratch_path": "~/.unmute/remote/<userKey>/<taskId>/recipe.json"
  }
}
```

## Field rules (what the reader enforces)
- `state` is the only strictly-required field for a valid read; a read missing
  `state` is treated as "no update" (tolerant reader).
- `result.summary` SHOULD be present when `state="done"`; `error.reason` SHOULD
  be present when `state="failed"`. If absent, the row shows a generic message
  and logs a warning (so we can see Claude under-reported).
- `question.text` MUST be present when `state="needs-user"`; if absent, the
  staleness backstop (PRD §6.3) still catches the stall as a fallback.
- Unknown extra fields are ignored (forward-compatible).

## What is intentionally NOT here
- No PTY output / transcript (that streams separately, PRD §4.3 render-on-demand).
- No thinking tokens / prose (the whole point of the file channel, PRD §6.2).
- No credentials, no MCP tokens (PRD §12 — Unmute is never in the credential path).
