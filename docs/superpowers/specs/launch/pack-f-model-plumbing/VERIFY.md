# Pack F — verification

**You did not write this code.** Disprove that it is finished. PASS / FAIL / ESCALATE with evidence. Do not fix anything.

The central risk in this pack is a **plausible lie**: a card that shows a model, looks correct, and is wrong because the value was read from settings instead of recorded at dispatch. Section C is the part that matters.

---

## A. The field exists end to end

1. `[auto]` `Task` has `model?: string`.
   `grep -n "model" desktop/electron/remote/task-manager.ts | head -20`
2. `[auto]` `dispatch()` accepts a model in its options object.
3. `[auto]` The task is constructed with it.
4. `[auto]` It is written to `meta.json` — find the `JSON.stringify` that already carries `agent` and `sessionId`.
5. `[auto]` `rehydrate()` reads it back.
6. `[auto]` The renderer payload includes it — `init.ts` around the line that sends `provider: providerOf(t.agent)`.
7. `[auto]` `RemoteTask` in `useRemoteTasks.ts` declares `model?: string`.
8. `[auto]` It is documented in the same style as the `provider` block, and the comment states why it is not re-derived.

## B. Per-backend sources

9. `[auto]` The `claude` path captures the model actually passed as `--model`, not a separately-read setting.
10. `[auto]` The `codex-desktop` path reads from the Codex app's own model source.
11. `[auto]` The `claude-code-desktop` path reads from its catalogue.
12. `[auto]` **No path exists for `codex` (Codex CLI).** It is not dispatchable; adding one is a FAIL.
13. `[auto]` When the model cannot be determined, **nothing is stored**.
    Search for any fallback: `grep -n "model.*||\s*'\|model.*??\s*'\|'unknown'\|'default'" task-manager.ts init.ts` → a literal fallback string is a **FAIL**.

## C. It is a historical fact — the highest-risk section

14. `[auto]` **No render-time derivation.** Nothing reads settings, `getModels()`, or the model catalogue to fill this field when building the renderer payload. Trace the value from `init.ts`'s send back to its origin: it must come from the persisted task, not from a live setting lookup. **A settings read anywhere on that path is a FAIL** — it would silently misreport every old task.
15. `[auto]` `model` is assigned exactly once per task, at creation. Grep for every assignment; more than one write path (other than rehydrate reading from disk) needs justification.
16. `[eye]` **The decisive test.** Dispatch a task with the model set to Sonnet. Wait for it to finish. Change the model picker to Opus. The finished task's card must still say **Sonnet**. If it says Opus, decision D6 is violated and this pack has shipped a lie.
17. `[eye]` Restart the app. The finished task still says Sonnet — proving it came from `meta.json`, not from memory.

## D. Backward compatibility

18. `[eye]` A task created before this change rehydrates without error.
19. `[eye]` It carries no model and renders as agent-only — not "unknown", not a default.
20. `[auto]` **No backfill exists.** Any code that assigns a model to a task that did not have one is a FAIL.
21. `[auto]` No existing `meta.json` key was renamed or removed.
    `git diff origin/main...HEAD -- desktop/electron/remote/task-manager.ts | grep "^-.*meta.json\|^-.*JSON.stringify"` — inspect every removal.
22. `[eye]` An older engine reading a `meta.json` written by this build still works — the change must be purely additive.

## E. Boundaries — FAILs

23. `[auto]` `git diff --name-only origin/main...HEAD` contains **only**: `desktop/electron/remote/task-manager.ts`, `desktop/electron/remote/init.ts`, `desktop/engine-overrides/renderer/remote/useRemoteTasks.ts`. Anything else is a FAIL.
24. `[auto]` `providers.ts` untouched — the registry is not this pack's, and its ids are an append-only disk format.
25. `[auto]` Nothing else under `renderer/remote/` changed — Pack C owns it.
26. `[auto]` Nothing under `renderer/app/` changed.
27. `[auto]` No Swift file changed.

## F. It builds

28. `[auto]` `cd desktop && npm run typecheck` → exit 0
29. `[auto]` `cd desktop && npm test` → no regression
30. `[auto]` `providers.test.ts` passes.
31. `[auto]` `codex/lifecycle.test.ts` and `claude-desktop/lifecycle.test.ts` pass — both exercise the creation paths this pack modified.
32. `[auto]` `codex/separation.test.ts` passes — it pins the rule that a task never rebuilds on the wrong backend.
33. `[auto]` No TODO/FIXME introduced.

## G. Where this most plausibly broke something else

34. `[eye]` **Dispatch still works for every backend.** This pack edits the creation path for all three dispatchable ones. Create a task on Claude Code CLI, on Codex desktop, and adopt one from Claude desktop. All three must appear correctly.
35. `[eye]` Resume still works for Claude Code CLI. `resume()` rebuilds from `meta.json`, which just gained a key.
36. `[eye]` Fork still works — `adoptForkSessionId` / `stageForkSource` read the same metadata.
37. `[eye]` A task killed and rehydrated after an app restart keeps its agent **and** its model.
38. `[auto]` The Codex app-server read added for the model must not become a blocking call on the dispatch path. Confirm it is not awaited in a way that delays task creation — the app-server call is ~1ms but a failure must not hang or fail the dispatch.
39. `[eye]` If the Codex app is closed when a task is created, dispatch still succeeds and simply records no model.
40. `[eye]` The notch still receives its task payload correctly — `init.ts`'s send path is shared with `notch-controller.ts`.
