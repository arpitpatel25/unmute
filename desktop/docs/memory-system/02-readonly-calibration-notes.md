# Memory System — Read-Only Calibration Notes

Status as of branch `arpit/unmute-memory-system` (final commit `5d5ed20`).

The memory system is **built end-to-end** and ships in **read-only calibration
mode**: `librarianWriteEnabled` defaults `false`, so the librarian observes every
finished task and emits a `proposal.json` but mutates nothing in the store. This
is the "earns the pen last" phase — we watch its proposals against real tasks
before granting it write access.

This doc is the operator runbook for that phase: how to smoke-test it, what to
look for in the logs, and the two design gates that MUST be closed before
`librarianWriteEnabled` is ever turned on.

---

## 1. Heavy instrumentation (temporary)

Every memory decision logs its inputs + decision through `createLogger`/
`log.event`, tagged `// TEMP(memory-debug): remove after calibration` with a
`MEMORY_DEBUG: true` field. They are greppable for removal once calibration is
done. Key events to watch:

- `list-recipes` — what the store returned for a surface (count).
- `recipe-written` / `recipe-moved` — store mutations (should NOT appear in
  read-only mode except from a deliberate seed).
- `parse-recipe.*` — why a recipe file was rejected.
- `locate-transcript` / `reduce-transcript` — trace resolution + reduction size.
- `librarian-inputs` — the full set the librarian was handed for a task.
- The librarian's rendered prompt is also dropped to
  `<libCwd>/librarian-prompt.txt` for inspection.

---

## 2. Manual end-to-end smoke (Task 14)

This requires the live Electron app and a real voice/IPC dispatch on the user's
machine + subscription session — it cannot be automated by the test harness.

**Setup — seed one nursery recipe** (so injection has something to surface):

    mkdir -p ~/.unmute/remote/recipes/gmail
    # write a low-confidence recipe file there, e.g. gmail-inbox-sweep.md, with
    # single-line frontmatter: name, surface: gmail, confidence: low, the counters
    # at 0, and a short body. (Born in recipes/, never skills/.)

**Run:**

1. `cd desktop && npm run dev`.
2. Dispatch a **managed**, gmail-surface task (e.g. ask it to do something with
   your inbox). Then dispatch a **raw**-mode task.

**Verify injection (managed vs raw):**

- Managed gmail task: the dispatch log shows the nursery recipe injected
  (`nursery: 1`) and the hedged block appears in the executor prompt with the
  low-confidence STANCE ("Unverified lead… derive independently if it fails").
- Raw task: `nursery: 0` — no Unmute memory injected, no librarian handoff. The
  repo's own `.claude` context is still honored; only the Unmute memory layer is
  skipped.

**Verify the read-only librarian:**

- After the managed task finishes, a librarian session runs (serialized,
  off-critical-path) and writes a `proposal.json` in its libCwd.
- Confirm `~/.unmute/remote/recipes/` and `skills/` are **unchanged** (no
  `recipe-written`/`recipe-moved` events, file mtimes unchanged), and the seed
  recipe's counters did not move. The librarian proposed but did not write.

**Document** the observed proposals here as they accumulate, so we can judge the
librarian's quality before enabling writes.

### Observations log

_(append dated entries here during calibration)_

---

## 3. Gates that MUST close before `librarianWriteEnabled` = ON

Surfaced by the final whole-branch review. Both are inert while the write-gate is
OFF; they only bite once writes are enabled, so they are deliberately deferred to
the write-enable milestone — not to merge.

### Gate A — gardening is a second writer

`applyGardening` (`gardening.ts`) deletes pruned nursery files from the `init.ts`
daily `setInterval` on the main process — outside the librarian's serialized
write queue. With writes ON, a gardening prune can race a concurrent librarian
`moveRecipe`. Both deletes are `force: true` best-effort, so the worst case is a
benign lost delete, not a crash — but it violates the "only the librarian writes,
serialized" invariant.

**Before enabling writes:** either route `applyGardening` through the same
serialization as librarian writes (a shared store lock spanning the librarian's
spawned session), or make a documented, deliberate decision to accept gardening
as a second deterministic writer and bound the race.

### Gate B — read-only enforcement is prompt-only

In read-only mode the librarian still spawns with `--dangerously-skip-permissions`
and is handed the real store paths; the only thing preventing a write is the
prompt saying "do not modify." Calibration's whole value is zero-risk observation,
and that guarantee is currently soft.

**Decision needed:** either harden read-only mode (hand the librarian a read-only
copy/temp clone of the store for reads, or drop `--dangerously-skip-permissions`
for the read-only librarian so an autonomous write is auto-denied), or explicitly
accept prompt-only enforcement on the grounds that the system already trusts the
librarian as sole writer in write mode — and log that acceptance here.

---

## 4. Removing the instrumentation

When calibration concludes, strip the temporary logging:

    grep -rn "TEMP(memory-debug)" desktop/electron/remote

Remove those `log.event` calls (and the now-unused `MEMORY_DEBUG` plumbing),
keeping any log lines we decide are worth as permanent operational signal.
