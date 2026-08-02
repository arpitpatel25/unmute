# Pack A — verification

**You did not write this code.** Your job is to disprove the claim that it is finished. Answer every assertion with PASS, FAIL, or ESCALATE. A FAIL needs the evidence that produced it. Do not fix anything.

`[auto]` — run the command; the stated result is the only PASS.
`[eye]` — requires a running app or human judgement. Report as ESCALATE with what you would need.

Run all commands from the repo root.

---

## A. The tab is gone

1. `[auto]` No import of `./Voice` remains.
   `grep -rn "from './Voice'" desktop/engine-overrides/renderer/app/` → **no matches**
2. `[auto]` No `Voice` component is rendered.
   `grep -n "<Voice" desktop/engine-overrides/renderer/app/App.tsx` → **no matches**
3. `[auto]` The word "Features" is not a nav label.
   `grep -n '"Features"\|>Features<' desktop/engine-overrides/renderer/app/App.tsx` → **no matches**
4. `[auto]` The `Tab` union has exactly four members and none is `voice`.
   `grep -n "type Tab" desktop/engine-overrides/renderer/app/App.tsx`
5. `[auto]` No dead `voice` branch survives.
   `grep -n "activeTab === 'voice'" desktop/engine-overrides/renderer/app/App.tsx` → **no matches**

## B. Remote is renamed

6. `[auto]` No user-visible "Remote" string in the shell.
   `grep -n '"Remote"\|>Remote<' desktop/engine-overrides/renderer/app/App.tsx` → **no matches**
7. `[auto]` "Orchestrator" appears as a nav label.
8. `[auto]` The tab id is `orchestrator`, not `remote`.
9. `[eye]` The sidebar reads: History, Orchestrator, Account, Settings — in that order, four items only.

## C. Icons

10. `[auto]` `VoiceIcon` is referenced at most once.
    `grep -c "<VoiceIcon" desktop/engine-overrides/renderer/app/App.tsx` → **0 or 1**
11. `[auto]` No icon component is rendered twice in the sidebar. Extract every `<XIcon` occurrence inside the nav block; the list must have no duplicates.
12. `[auto]` `SettingsIcon` no longer draws straight-line spokes — its path data changed from the original.
13. `[eye]` No two sidebar rows show the same glyph.
14. `[auto]` In `_shared.tsx`, `BehaviorIcon` is not the icon for more than one section across the codebase.
    `grep -rn "icon={<BehaviorIcon" desktop/engine-overrides/renderer/` → **at most one match** (note: Pack B owns the other call sites — if matches are outside this pack's files, record as ESCALATE, not FAIL)

## D. Settings sub-navigation

15. `[auto]` Sidebar sub-items exist for settings: `Triggers`, `Audio`, `Appearance`, `Permissions`, `Language`, `Privacy`, `Help`.
16. `[auto]` The active settings section is passed to the Settings component as a prop.
17. `[eye]` Clicking Settings reveals seven sub-items; clicking each changes the highlighted one.
18. `[auto]` Orchestrator sub-page state includes all four of `tasks`, `how`, `setup`, `settings`.

## E. Onboarding — structure

19. `[auto]` The steps array has exactly nine entries.
20. `[auto]` A step introduces the notch.
    `grep -in "notch" desktop/engine-overrides/renderer/app/Onboarding.tsx` → **at least one match**
21. `[auto]` A step names the orchestrator.
    `grep -in "orchestrat" .../Onboarding.tsx` → **at least one match**
22. `[auto]` The old two-ways framing is gone.
    `grep -n "Two ways to use your voice" .../Onboarding.tsx` → **no matches**
23. `[auto]` The false pricing line is gone.
    `grep -n "no subscription, no minimum\|Pay only for what you use" .../Onboarding.tsx` → **no matches**
24. `[auto]` The real prices appear: `4.99` and `7.99`.
25. `[auto]` Accessibility is not skippable.
    `grep -n "Skip for now" .../Onboarding.tsx` → **no matches**
26. `[auto]` Microphone and Accessibility are both present and both marked required.
27. `[auto]` A step offers deferring agent connection ("later").
28. `[eye]` Stepping through all nine works; back/forward never lands on a blank screen.

## F. Onboarding — no hardcoded keys

29. `[auto]` **Critical.** No literal `Fn` in JSX text where a user's key belongs.
    `grep -n '>Fn<\|"Fn"' .../Onboarding.tsx` → every match must be inside a *selector option label* (e.g. the Fn/Right Option picker), never a sentence telling the user which key to press. List every match and classify it.
30. `[auto]` The component reads the dictation key from settings (`getDictationKey` or an equivalent prop).
31. `[eye]` Set the dictation key to Right Option, replay onboarding: every instruction says Right Opt, and the orchestrator key shows Fn.

## G. The gate

32. `[auto]` `unmute_onboarding_version` is read and written.
33. `[auto]` The legacy key is read for migration.
    `grep -n "unmute_onboarding_complete" .../App.tsx` → **at least one match, in a migration path**
34. `[auto]` The current version constant is `2` and is exported.
35. `[auto]` A three-screen "what's new" path exists for `version < 2`.
36. `[eye]` With `unmute_onboarding_complete='true'` and no version key: three screens, then the app, and the version key is set to 2.
37. `[eye]` With no keys at all: the full nine steps.
38. `[eye]` With version 2: straight to the app, no interruption.

## H. Discipline

39. `[auto]` No raw checkboxes in owned files.
    `grep -n 'type="checkbox"' desktop/engine-overrides/renderer/app/App.tsx .../Onboarding.tsx .../_shared.tsx` → **no matches** (`_shared.tsx`'s `Toggle` internals are the single permitted exception — classify, do not auto-fail)
40. `[auto]` No native `<select` in owned files → **no matches**
41. `[auto]` Font sizes are on the scale. Extract every `text-[Npx]` in owned files; every N must be one of `22, 16, 14, 13, 12.5, 11, 10`. List violations.
42. `[eye]` No visual regression in the sidebar: brand, nav, pro-tip card all still render correctly.

## I. Boundaries — these are FAILs, not judgement calls

43. `[auto]` No file outside this pack's ownership was modified.
    `git diff --name-only origin/main...HEAD` → every path must be one of: `App.tsx`, `Onboarding.tsx`, `_shared.tsx` (under `desktop/engine-overrides/renderer/app/`). **Any other path is a FAIL.**
44. `[auto]` Nothing under `electron/` changed.
45. `[auto]` Nothing under `backend/` changed.
46. `[auto]` `Settings.tsx`, `Privacy.tsx`, `Permissions.tsx`, `Language.tsx` are untouched — they belong to Pack B.

## J. It builds

47. `[auto]` `cd desktop && npm run typecheck` → exit 0
48. `[auto]` `cd desktop && npm test` → no test that passed on `origin/main` now fails
49. `[auto]` No `TODO`, `FIXME`, or placeholder text was introduced.
    `git diff origin/main...HEAD | grep -n "^+.*\(TODO\|FIXME\|Lorem\|placeholder\)"` → **no matches**

## K. Where this most plausibly broke something else

Check these specifically; they are the failure modes this change invites.

50. `[eye]` The Orchestrator tab still opens its existing sub-pages. Renaming `remote` → `orchestrator` touches the state that drives `RemoteSetup`/`RemoteSettings`, which this pack does not own — confirm the rename did not orphan them.
51. `[auto]` `remote-preload.ts` and any IPC that referenced the tab name still compile. If the tab id crossed an IPC boundary, this pack broke it.
52. `[eye]` The `dictationKey` prop still flows to the sidebar pro-tip — it was wired through the deleted `Voice` tab's sibling and may have been cut with it.
53. `[eye]` Deep links / the update banner / the sign-in overlay still render above the new nav.
