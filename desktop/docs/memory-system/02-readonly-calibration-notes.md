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

## 3. Write-mode safety — race conditions

The plan is to switch `librarianWriteEnabled` ON before live testing, so the
write path must be race-safe even though the gate currently ships OFF. The
concurrency hardening below was implemented up-front (write-gate stays OFF).

### Gate A — gardening was a second writer — CLOSED

`applyGardening` (`gardening.ts`) used to delete pruned files from the `init.ts`
daily `setInterval` on the main process — outside the librarian's serialized
queue, so with writes ON a prune could race a librarian session.

**Fixed:** the librarian's serial queue now carries two job kinds — `curate`
(a finished task) and `maint` (gardening). `Librarian.runMaintenance(fn)`
enqueues the prune behind any active session and blocks a new session until it
finishes, so gardening and the librarian can never mutate the store at once. The
`init.ts` garden timer now calls `librarian.runMaintenance(...)` instead of
running the pass directly. Covered by `librarian.test.ts`
("runMaintenance is serialized against librarian sessions").

### Atomic writes — CLOSED

`writeRecipe` used a fixed `${dest}.tmp` path, so two concurrent writers to the
same recipe clobbered each other's tmp and one `rename` hit ENOENT. Now the tmp
name carries `pid + a monotonic counter`, so concurrent writes each rename their
own tmp (last-writer-wins, no partial file, no orphan `.tmp`). Covered by
`recipe-store.test.ts` ("concurrent writeRecipe … unique tmp"). Combined with the
existing tmp-then-rename, every store reader (task dispatch `listRecipes` /
`installSkillsIntoCwd`) sees either the old or the new file, never a partial — and
`parseRecipe` is tolerant, so a malformed read degrades to skip, not crash.

### Accepted residual risks (no code; deliberate)

- **Gate B — read-only enforcement is prompt-only.** In read-only mode the
  librarian still spawns with `--dangerously-skip-permissions` and is told (not
  forced) "do not modify." This is **moot once writes are ON** — the chosen path —
  and in write mode the system already trusts the librarian as sole writer.
  Accepted; revisit only if a long read-only calibration phase is reintroduced.
- **Librarian subprocess writes are not guaranteed atomic.** The librarian is a
  Claude Code subprocess using its own `Write` tool, which may not write via
  tmp+rename. A reader could momentarily catch a half-written skill file. Bounded
  and self-healing: `parseRecipe` tolerance skips it, and the next task sees the
  finished file. Accepted; not worth intercepting subprocess I/O.

---

## 4. Removing the instrumentation

When calibration concludes, strip the temporary logging:

    grep -rn "TEMP(memory-debug)" desktop/electron/remote

Remove those `log.event` calls (and the now-unused `MEMORY_DEBUG` plumbing),
keeping any log lines we decide are worth as permanent operational signal.
