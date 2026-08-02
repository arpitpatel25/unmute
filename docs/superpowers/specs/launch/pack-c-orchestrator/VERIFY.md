# Pack C — verification

**You did not write this code.** Disprove that it is finished. PASS / FAIL / ESCALATE with evidence. Do not fix anything.

Paths relative to `desktop/engine-overrides/renderer/remote/`.

---

## A. Cockpit is gone

1. `[auto]` No user-visible "Cockpit".
   `grep -rin "cockpit" *.tsx` → matches only in the route hash `#/orchestrate` context or comments explicitly about the old name. **Any rendered string is a FAIL.** List every match and classify.
2. `[auto]` The wall header renders "Orchestrator".
3. `[eye]` The window title says Orchestrator.

## B. Needs-you band

4. `[auto]` A band renders tasks in `needs-user` above all groups.
5. `[auto]` It is not rendered when empty — find the guard.
6. `[eye]` With one waiting task it appears at the top, amber, glowing. With none, no empty header is left behind.

## C. The 24-hour window

7. `[auto]` `visibleOnWall()` no longer unconditionally returns true for sessions.
   `grep -n -A 10 "function visibleOnWall" OrchestrateWall.tsx` → the line `if (t.kind === 'session') return true` **must be gone**
8. `[auto]` A 24-hour bound exists in that function.
9. `[auto]` A `Last 24h` header control exists.
10. `[auto]` It can be switched to show everything.
11. `[eye]` **Critical.** With the filter on and older tasks present, the control states how many are hidden. Silent truncation is a FAIL.
12. `[eye]` Switching to "All" restores the 46-day-old card.
13. `[eye]` A long-running session untouched for 3 days disappears under the filter and returns under All. This is the intended behaviour change — confirm it is reversible, not destructive.

## D. Disclosure controls

14. `[auto]` The per-group control no longer says "Show all".
    `grep -n "Show all" OrchestrateWall.tsx` → **no matches**
15. `[auto]` It says `+N more`.
16. `[auto]` An "Expand all" control exists in the header.
17. `[eye]` Expand all expands every group and does not change the time filter.
18. `[eye]` Expand all pressed twice does not collapse or double-render.

## E. The rail

19. `[auto]` Projects is gone.
    `grep -in "projects" OrchestrateWall.tsx` → no rendered section
20. `[auto]` Suggestions is gone.
    `grep -in "suggestion" OrchestrateWall.tsx` → **no matches**
21. `[auto]` `SkillReviewPopup` is no longer mounted — it opened from a Suggestions row.
22. `[auto]` "Unmute memory" and its cleanup button are gone.
    `grep -in "unmute memory\|recipeCount\|skillCount\|Clean up" RemoteSettings.tsx` → **no matches**
23. `[auto]` Four rail sections remain: Queue, One-offs, Skills, Shelf.
24. `[auto]` No copy implies unmute still learns.
    `grep -rin "learns\|gets better\|improves" *.tsx` → **no matches** (decision D7)

## F. Tickets — the core ask

25. `[auto]` `providerLabel()` still exists and is still rendered on the card.
26. `[eye]` **Every card shows its agent.** Not just non-default ones.
27. `[auto]` The card renders `model`.
28. `[auto]` The card renders `cwd`.
29. `[auto]` **Model is not invented.** If `t.model` is absent the card must render the agent alone — find the guard. Any fallback that substitutes a settings value or a hardcoded default is a **FAIL** (decision D6).
30. `[eye]` Expanded ticket shows all four: Agent, Model, Working directory, Permissions.
31. `[auto]` Vendor colour marks exist and differ per vendor.
32. `[eye]` On a wall mixing Claude Code and Codex desktop cards, you can tell them apart without reading.

## G. Buttons ask the registry

33. `[auto]` Resume is gated on `provider.canResume`.
    `grep -n "canResume" OrchestrateWall.tsx` → **at least one match, gating a button**
34. `[auto]` Terminal is gated on `provider.hasTerminal`.
35. `[auto]` **No legacy id comparisons remain.**
    `grep -n "agent !== 'codex-desktop'\|agent === 'codex-desktop'" *.tsx` → matches only as a documented fallback for an old payload. Classify each; a match used to decide a button is a **FAIL**.
36. `[eye]` A Codex desktop ticket shows "Open in Codex" and **no** Resume button — not a disabled one.

## H. Dead code

37. `[auto]` `TaskPanel.tsx` is deleted or imported by something reachable.
38. `[auto]` `AmbientIndicator.tsx` is deleted or imported by something reachable.
39. `[auto]` `TaskRow.tsx` is deleted or imported by something reachable.
40. `[auto]` **No file in this directory is imported by nothing.** For each `*.tsx`, grep the repo for an import of it. List any orphans. Orphans are a FAIL.
41. `[auto]` `RemoteHowItWorks` is imported by something reachable from the app.
42. `[eye]` How it works is reachable from the Orchestrator sub-nav and renders.
43. `[auto]` Its copy no longer says "Remote".
    `grep -n "Remote" RemoteHowItWorks.tsx` → no rendered string
44. `[auto]` Its copy no longer implies Claude Code is the only backend.

## I. The settings panel

45. `[auto]` No raw checkboxes.
    `grep -n 'type="checkbox"' RemoteSettings.tsx RemoteSetup.tsx` → **no matches**
46. `[auto]` No native selects.
    `grep -n "<select" RemoteSettings.tsx` → **no matches**
47. `[auto]` "Executor" is gone.
    `grep -n "Executor" RemoteSettings.tsx` → **no matches**
48. `[auto]` `FALLBACK_CATALOG` no longer renders unconditionally — model chips follow the selected agent.
49. `[eye]` **Select Codex desktop: Haiku/Sonnet/Opus must not be shown.** This is the specific bug being fixed.
50. `[eye]` Sandbox roots has a directory picker, not a free-text field.
51. `[auto]` The trigger toggle appears once in the app, not twice.
    `grep -rn "Remote trigger\|remoteTrigger" RemoteSettings.tsx` → **no matches** (it lives in Settings now, which Pack B owns)

## J. Setup page

52. `[auto]` The self-contradiction is resolved: the page must not both say the extension is the only requirement and that everything else is optional.
    `grep -n "exactly ONE thing\|required" RemoteSetup.tsx` — read the surrounding copy and judge. Contradiction = FAIL.
53. `[eye]` The Codex "Connect" button warns before quitting the user's Codex app.

## K. Boundaries — FAILs

54. `[auto]` `git diff --name-only origin/main...HEAD` contains only files under `renderer/remote/`. **Any other path is a FAIL.**
55. `[auto]` `App.tsx` untouched (Pack A).
56. `[auto]` Nothing under `renderer/app/` changed (Pack B).
57. `[auto]` Nothing under `electron/` changed (Pack F).
58. `[auto]` `useRemoteTasks.ts` untouched — Pack F owns it.

## L. It builds

59. `[auto]` `cd desktop && npm run typecheck` → exit 0
60. `[auto]` `cd desktop && npm test` → no regression; `groupSections.test.ts` passes
61. `[auto]` No TODO/FIXME/placeholder introduced.

## M. Where this most plausibly broke something else

62. `[auto]` **Pack F landed first.** Confirm `RemoteTask` has a `model` field. If it does not, this pack was built against a type that does not exist and the model display is fiction. Check `useRemoteTasks.ts`.
63. `[eye]` The notch reads task state from the same source. Changing `visibleOnWall` must not have altered what the notch counts — the notch shows *running*, the wall shows *visible*, and they are not the same set.
64. `[eye]` Deleting `TaskPanel` removed the only importer of `RemoteHowItWorks`, `TaskRow` and `RemoteSetup`. Confirm `RemoteSetup` is still reachable — it was reached via `RemoteSetupEntry`, which must survive.
65. `[eye]` The Shelf still works — shelved tasks are excluded by `visibleOnWall` and surfaced separately; the 24h change touches the same function.
66. `[eye]` Removing the Suggestions section may have orphaned the IPC that fed it. Confirm nothing in main is now broadcasting to a listener that no longer exists.
