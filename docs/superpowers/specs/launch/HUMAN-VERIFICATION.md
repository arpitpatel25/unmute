# What still needs a human, on a real Mac

Every automated check across the six packs has been run and passed. **~100 assertions could not be**, because they need a running app, a physical notch, or a signed build. They were reported as ESCALATE rather than self-certified — an agent ticking a box it cannot see is worse than an empty box.

This is those items, ordered by what would hurt most if it were wrong, and grouped so you can do each group in one sitting.

---

## Before anything else — two claims that are not proven

**1. The auth fix has never been observed working.** Pack E could not run the reproduction: `desktop/work/oss-engine` is absent from its worktree, so no build was producible. The *mechanism* is confirmed at the library level; the *symptom* is not.

> Sign in on a **signed** build. Close the main window — the red button, not merely hiding it. Leave the app running past a full token lifetime. Dictate. It must transcribe on Cloud, with no "signed out" and no drop to the on-device model.

Then the harder one, which is the regression I fixed at integration and which nothing has tested:

> Same again, but after the wait: **quit the app entirely, relaunch, and dictate.** Still signed in. This is the case where a rotated token had to reach disk with no renderer alive to write it.

Run this on a signed build. An unsigned local build degrades `safeStorage` to plaintext and produces a *different* logout symptom that will confuse the result.

**2. `help/BrowserUse.tsx` claims Codex desktop ships its own browser control.** Nothing in this repository sources that — it came from a design conversation. It also drives a recommendation ("Codex is one step, Claude Code is three"). Confirm it on a machine, or change both the sentence and the recommendation.

---

## The notch — 34 items, and the reason this pack is mostly human

Pack D's whole purpose is how a surface looks against a physical cutout. Almost none of it is checkable in code.

**On a MacBook with a notch, unexpanded (dormant / idle / task / attention):**
1. **Nothing renders below the menubar.** Sight along the bar's bottom edge on a light wallpaper. This is the bug the pack exists to fix.
2. **Zoom in on both junctions with the cutout.** Any seam, gap, bitten-out curve, or black mismatch is a failure. Test in *attention*, where the amber rim traces any misalignment.
3. Does it read as *"the notch is wider"* — or as a pill parked beside a notch? That distinction is the whole design.
4. The outward quarter-circle flare is visible at both outer ends.

**Motion:**
5. **Slow-motion capture of expand and collapse**, watching the fillets stay attached to the mass. A fixed-size overlay detaches mid-spring; that is the specific failure being checked.
6. Expand and collapse feel symmetrical.
7. With Reduce Motion on, nothing springs and nothing is broken.

**Displays:**
8. Hot-plug an external monitor while running — layout re-evaluates without a restart. Unplug it. Move the surface between screens.
9. A Mac with no built-in notch at all.
10. A non-default display scaling — a hardcoded bar height surfaces here.

**Behaviour:**
11. Hover grows the mass and reveals more, and **never opens the panel**. Move the pointer across the bar to a menu extra: nothing disruptive happens.
12. A 200-character task name degrades gracefully; status stays fully readable.
13. A menubar crowded with menu extras — no overlap, no clipping.
14. Fixed / Live glass / Follow system changes the panel and pill and leaves the mass **unchanged**.
15. Only *attention* glows.
16. The scratchpad still looks like paper, in both appearances.

**Things the notch shares with other surfaces:**
17. The recording pill still appears correctly in both Top center and Top right.
18. The wall and task surfaces fill correctly — the panel's inner padding grew 14pt a side.
19. Terminal 80/60 ratio still honoured.
20. Multi-Space: switch away and back.

---

## The orchestrator — 19 items

21. **Every card names its agent**, including default Claude Code ones.
22. Click a ticket: Agent, Model, Working directory, Permissions all present.
23. With Claude Code and Codex cards on one wall, tell them apart **by the colour square alone**, without reading.
24. A Codex desktop ticket shows *open in Codex* and **no Resume button at all** — not a greyed one.
25. **The 24h filter states how many it hides.** `Last 24h · N older hidden`. Old tasks vanishing with no count is a failure.
26. Click through to `All` — the 46-day-old card returns.
27. A *live* session untouched for 3 days stays visible under the filter; a dead one vanishes and returns under All.
28. `Expand all` expands every group and does not change the time filter. Press it twice — nothing collapses or double-renders.
29. One task in `needs-user` sits above every group, amber, glowing. Answer it — **no empty header or gap is left behind**.
30. Settings → select **Codex desktop**: Haiku/Sonnet/Opus must not appear.
31. Setup → Codex **Connect** shows a confirm dialog before quitting the user's Codex app.
32. Shelve a task: it leaves the wall, appears under Shelf, and comes back.
33. Run for a few minutes with the dev console open: no `No handler registered`, no unhandled IPC.

---

## The main window — 26 items

**Onboarding:**
34. Walk all nine steps forward and back; nothing blank.
35. **Set the dictation key to Right Option, then replay onboarding.** Every instruction must say "Right Opt", and Orchestrate must say "Fn". Hardcoded keys were a real bug here.
36. The three gate scenarios: legacy flag only → three "what's new" screens then version 2; no keys → all nine steps; version 2 → straight in.
37. Permissions step hard-blocks until both are granted.

**Settings:**
38. All seven sections load; none blank.
39. Every toggle survives a restart. This was a layout move — nothing should have shifted.
40. **Curator and librarian toggles are disabled and read off.** They are now genuinely off (`CURATOR_PARKED`), so the copy is finally true — confirm the tooltip explains why they cannot be changed.
41. Turn "Show the notch automatically" off, restart, run a task to completion: the notch must **not** come forward.
42. Permissions: Grant on mic and accessibility, then switch to System Settings and back — status refreshes on focus.
43. Help: all seven explainer pages open and their back links return.
44. Capture and Scratchpad rows link to their pages.

**Shell:**
45. Sidebar shows exactly four rows with four distinct glyphs; brand and pro-tip intact.
46. Pro-tip keycaps track a live dictation-key change.
47. Update banner and sign-in overlay layer above the new nav.
48. Orchestrator's four segments each render.

---

## Model plumbing — the one test that proves it is not lying

49. **Dispatch a task with the model set to Sonnet. Let it finish. Change the picker to Opus. The finished card must still say Sonnet.**

If it says Opus, decision D6 is violated and every historical card is misreporting. Pack F could not run this — nothing rendered the field until Pack C landed, so it is genuinely untested end to end.

50. Restart the app: the finished task still says Sonnet — proving it came from `meta.json`, not memory.
51. A task created before this release renders as agent-only, with no invented model.
52. Dispatch on all three backends: Claude Code CLI, Codex desktop, and adopt one from Claude desktop.
53. With the Codex app **closed**, dispatch still succeeds and simply records no model.

---

## Known-open, decided rather than fixed

These are not bugs to find — they are choices recorded in `decisions/integration.md`, listed so nobody rediscovers them as surprises.

- **I12** — eight curator IPC handlers now have no consumer. Left in place: `tap-skill` is still live, the preload still exposes the rest, and removing them unverified is how you break something subtle.
- **I13** — the sandbox directory picker is not built. Electron 32 removed `File.path` and no `showOpenDialog` IPC exists, so a renderer-only picker is impossible. One-tap project chips ship instead.
- **I3** — a toast arriving while the notch is collapsed is logged and dropped. The bar has no room and nothing may hang below it.
- **I4** — the cutout corner radius is an estimate; macOS does not expose it. If the junction reads wrong at item 2 above, this constant is the first thing to adjust.
- **Pack E risks 3–15** — fifteen residual auth risks, each stated rather than smoothed over, in `decisions/pack-e-auth.md` §6. Worth reading before launch; none are believed reachable, several would need a follow-up to close properly.
