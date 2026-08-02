# Pack B — verification

**You did not write this code.** Disprove the claim that it is finished. PASS / FAIL / ESCALATE, with evidence for every FAIL. Do not fix anything.

`[auto]` run the command. `[eye]` needs a running app — ESCALATE, never self-certify.

Paths below are relative to `desktop/engine-overrides/renderer/app/`.

---

## A. Structure

1. `[auto]` Settings renders one section at a time, driven by a prop from Pack A.
2. `[eye]` All seven sections reachable: Triggers, Audio & behaviour, Appearance & notch, Permissions, Language, Privacy, Help & about.
3. `[auto]` `Permissions.tsx`, `Language.tsx`, `Privacy.tsx` no longer export standalone top-level tab screens — they are sections.
4. `[eye]` No section is blank or shows a placeholder.

## B. Triggers

5. `[auto]` The three rows are named `Dictate`, `Instruct`, `Orchestrate`.
6. `[auto]` The old labels are gone.
   `grep -n "AI format\|Task trigger\|Unmute Remote" Settings.tsx` → **no matches**
7. `[eye]` Toggling each trigger still works and still persists.

## C. Appearance & notch

8. `[auto]` A "show the notch automatically" toggle exists.
9. `[auto]` It defaults to **on** — find the `useState` initialiser and confirm.
10. `[eye]` Toggling it persists across an app restart.
11. `[auto]` The macOS-version detail is gone from user copy.
    `grep -n "26\.2\|Apple bug\|previous Space" Settings.tsx` → **no matches**
12. `[auto]` The surface-material description says it governs the panel and pill, not the notch mass (decision D5).

## D. Permissions

13. `[auto]` **The vendor leak is gone.**
    `grep -n "Groq" Permissions.tsx` → **no matches**
14. `[auto]` Screen Recording is present.
    `grep -in "screen recording" Permissions.tsx` → **at least one match**
15. `[auto]` `whisper` does not appear in user-visible copy.
    `grep -in "whisper" Permissions.tsx` → matches only in variable/function names, never in a rendered string. Classify each.
16. `[auto]` The local engine is called Parakeet here.
17. `[eye]` Required and optional groups are visually distinct.
18. `[eye]` Grant buttons still work; status still refreshes on window focus.

## E. Privacy — the highest-risk screen

19. `[auto]` **The obsolete billing model is gone.**
    `grep -in "prepaid\|credits" Privacy.tsx` → **no matches**
20. `[auto]` **The wrong retention claim is gone.**
    `grep -n "cleared daily" Privacy.tsx` → **no matches**
21. `[auto]` Seven-day diagnostics retention is stated.
    `grep -n "seven days\|7 days" Privacy.tsx` → **at least one match**
22. `[auto]` The orchestrator has its own section.
    `grep -in "orchestrat" Privacy.tsx` → **at least one match**
23. `[auto]` Elevated permissions are stated plainly.
    `grep -in "elevated\|broad access" Privacy.tsx` → **at least one match**
24. `[auto]` The "No telemetry or analytics SDKs" claim is either removed or qualified — it must not stand alone while local diagnostics exist.
25. `[eye]` **Every sentence on this page is verifiable.** For each claim, name the file and line that proves it. Any claim you cannot source is a FAIL. Reference evidence: `backend/supabase/migrations/008_billing_reconcile.sql:49` (usage_logs columns), `desktop/engine-overrides/electron/dictationTelemetry.ts` (`KEEP_DAYS = 7`, `DEV_BUILD = false`, no upload path).
26. `[auto]` `usage_logs` has not gained a transcript or audio column since this was written — re-read migration 008 and confirm.
27. `[auto]` Confirm telemetry still never leaves the machine.
    `grep -rn "telemetry" desktop/electron desktop/engine-overrides --include="*.ts" | grep -i "fetch\|upload\|post\|send"` → **no matches**. If this now returns anything, the Privacy copy is false and this is a **FAIL**.

## F. Help & about

28. `[auto]` A "Check for updates" control exists.
29. `[auto]` "Replay onboarding" clears the **version** key Pack A introduced, not the legacy boolean.
30. `[auto]` Both kill-switches exist: skill curator and librarian.
31. `[auto]` Both default to **off**.
32. `[auto]` "Unmute memory" and its cleanup button do not appear in any file this pack owns.
    `grep -in "unmute memory\|recipes ·\|Clean up" Settings.tsx Privacy.tsx Permissions.tsx Language.tsx` → **no matches** (a match in `RemoteSettings.tsx` is Pack C's, → ESCALATE)
33. `[eye]` Turning the curator off stops the curator. Verify the toggle reaches the main process, not just local state.

## G. Explainer pages

34. `[auto]` Seven page files exist under `help/`.
35. `[auto]` **There is no Workflows page** (decision D1).
    `ls help/ | grep -i workflow` → **no matches**
36. `[auto]` No file anywhere in this pack claims unmute learns or improves from your work — that story is retired with the curator (D7).
    `grep -rin "learns from\|gets better at\|improves over time" Settings.tsx help/` → **no matches**
37. `[auto]` **Chaining is documented** (decision D2 — the one thing rescued from the deleted Features tab).
    `grep -rin "chain" help/` → **at least one match**, on the Instruct page
38. `[auto]` The Capture page names all five kinds: `url`, `path`, `line`, `block`, `image`.
39. `[auto]` The Capture page states the clipboard boundary — only while the mic is on.
40. `[auto]` The Scratchpad page covers all four: survives restart, settles rather than nags, holds instead of delivers, paper not chrome.
41. `[auto]` The Browser page states Codex has browser control built in and Claude Code needs the extension.
42. `[auto]` The Computer use page states the screen never moves and Accessibility is required.
43. `[eye]` Every page is reachable from Settings → Help, and each has a working back link.
44. `[eye]` Capture and Scratchpad rows in Settings link to their pages.

## H. Discipline

45. `[auto]` No raw checkboxes in owned files.
    `grep -n 'type="checkbox"' Settings.tsx Privacy.tsx Permissions.tsx Language.tsx help/*` → **no matches**
46. `[auto]` No native selects.
    `grep -n "<select" Settings.tsx Privacy.tsx Permissions.tsx Language.tsx help/*` → **no matches**
47. `[auto]` Type scale respected. Extract every `text-[Npx]`; every N ∈ `{22,16,14,13,12.5,11,10}`. List violations.
48. `[auto]` `BehaviorIcon` is no longer reused across unrelated sections — at most one call site in owned files.
49. `[auto]` No control row contains a description longer than ~140 characters; longer explanations must be a link. Measure each `description=` string and list any over.

## I. Nothing moved that should not have

50. `[auto]` **Every existing IPC call still present.** Diff the set of `window.electronAPI.*` calls in `Settings.tsx` before and after: `git show origin/main:desktop/engine-overrides/renderer/app/Settings.tsx | grep -o "electronAPI[.?][a-zA-Z]*" | sort -u` vs the same on HEAD. **Nothing may be missing.** Additions are fine.
51. `[auto]` Every settings key string is unchanged — no key was renamed.
52. `[eye]` Every toggle still persists across restart. This is a layout change; no behaviour may have moved.

## J. Boundaries — FAILs, not judgement calls

53. `[auto]` `git diff --name-only origin/main...HEAD` contains only paths under `renderer/app/` owned by this pack, plus new `renderer/app/help/**`. **Any other path is a FAIL.**
54. `[auto]` `App.tsx` untouched — Pack A owns it.
55. `[auto]` Nothing under `renderer/remote/` changed — Pack C owns it.
56. `[auto]` Nothing under `electron/` or `backend/` changed.

## K. It builds

57. `[auto]` `cd desktop && npm run typecheck` → exit 0
58. `[auto]` `cd desktop && npm test` → no regression against `origin/main`
59. `[auto]` No TODO/FIXME/placeholder introduced.

## L. Where this most plausibly broke something else

60. `[eye]` The curator kill-switch is new IPC. If it does not exist in main yet, this pack cannot have wired it — confirm whether the toggle is real or cosmetic. A toggle that changes nothing is worse than no toggle.
61. `[eye]` Moving Permissions into Settings may have dropped its window-focus re-check, which lived in a `useEffect` on the old top-level screen.
62. `[eye]` The notch auto-present toggle must reach the notch process. Confirm it is not writing a setting nothing reads.
63. `[auto]` `EnginePillars`/`Billing` still render on Account — this pack must not have broken the shared `_shared.tsx` exports they import.
