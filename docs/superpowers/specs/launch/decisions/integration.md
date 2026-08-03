# Integration decisions — coordinator

Work that belongs to no single pack, recorded as it surfaces. Applied on the integration branch after all six packs merge.

---

## I1 — Wire the notch's `autoPresent` command to the engine

**Raised by:** Pack D (`d1d7ec4`)

Pack D added an **additive** `autoPresent` command to `IPC.swift` because SPEC §7 assumed a channel that did not exist. The Swift side honours it and defaults to on when absent, so nothing is broken today — but the setting Pack B builds in Settings → Appearance & notch is **unreachable until the engine sends it**.

Two lines in `desktop/electron/remote/init.ts`:
- send `{ type: 'autoPresent', on: settings.get('overlayAutoPresent') }` beside the existing `appearance` push (~`:2642`)
- send it again from the `remote:set-overlay-auto-present` handler (~`:3376`)

`init.ts` is Pack F's file and F has landed, so this is safe to apply at integration. **Pack B's toggle is cosmetic until this is done** — its VERIFY §62 asks exactly this question, so expect it as an escalation from B.

## I2 — The notch's Codex model label is still the non-persisted one

**Raised by:** Pack F (`880adbe`)

`desktop/electron/remote/notch/notch-controller.ts:815` still sends `codexModelLabel`, the pre-Pack-F value that is not persisted, so the notch's Codex label goes blank after a restart. Pre-existing, one line, and in a file no pack owns. Switch it to the persisted `task.model` that Pack F now writes into `meta.json`.

## I3 — Toasts sent while the surface rests are not shown

**Raised by:** Pack D, deliberately not attempted.

Nothing may hang below the bar (the core rule of Pack D), and the bar has no room for a toast. Pack D gated the toast on `expanded` and logs the collapsed case rather than drawing it. Giving toasts their own surface is a **new surface**, out of scope for launch.

**Decision: accept for launch.** A toast that arrives while collapsed is logged and dropped. Revisit only if it turns out something important is delivered exclusively by toast — the notch's attention state already covers the case that matters (a task needing an answer).

## I5 — Pack A mounted a component Pack C was told to delete

**Raised by:** Pack A (`arpit/launch-shell-onboarding`). **Resolved in flight.**

Pack C SPEC §5 called `TaskPanel.tsx` unreachable and told C to delete it. Pack A's new Orchestrator tab **mounts it** as the default `tasks` segment — so deleting it would break the branch after merge.

Instructed C to keep the export and rework its contents instead. `TaskRow.tsx` and `AmbientIndicator.tsx` remain unreferenced; the delete-or-fold instruction stands for those two.

Two consequences also handed to C: mounting `TaskPanel` and routing `RemoteHowItWorks` puts *"Remote tasks"*, *"Hold the Remote key"* and *"How Remote works"* on screen for the first time, inside a tab the spec insists is called Orchestrator; and `TaskPanel` carries its own `tasks/how/setup` state while Pack A drives the same selection from `App.tsx`, so the outer control would go stale. C takes the segment as a prop.

**This is the class of failure the ownership table was supposed to prevent, and it did not** — because the conflict was not two packs editing one file, it was one pack *reviving* a file another was told to remove. Ownership tables catch write collisions, not lifecycle disagreements.

## I6 — Two defects in my own VERIFY documents

**Raised by:** Pack A. Corrections issued to B and C; D, E and F were unaffected or already worked around it.

1. **Wrong base branch.** Every VERIFY boundary section says to diff against `origin/main`. The packs are cut from `arpit/launch-readiness`, so that base wrongly attributes all six packs' spec files to whichever pack is being checked. Correct base is `arpit/launch-readiness`.
2. **`npm run typecheck` does not pass on the base commit.** It fails in `electron/` files most packs may not touch, and `&&` short-circuits so the renderer stage never runs at all. Asserting "typecheck passes" was unachievable from inside any pack. Replacement: measure the renderer stage directly (`npx tsc -p tsconfig.renderer.json`) and prove the error count did not increase.

Both were my errors, not the agents'. Pack A's two FAILs are entirely accounted for by them and are **not** real defects in its work.

## I7 — `Account.tsx` and `History.tsx` were unowned

**Raised by:** Pack A.

The ownership table in `00-OVERVIEW.md` omitted both. `Account.tsx` matters: it still uses `BehaviorIcon` for two section headers, which is exactly the duplication D8 forbids, and Pack A prepared `ProfileIcon`/`EngineIcon`/`HelpIcon` for it.

**Decision: `Account.tsx` reassigned to Pack B** (instructed at dispatch). `History.tsx` stays unowned — its findings are cosmetic (two names for one screen, a hardcoded `Fn` in the empty state, a chip for an engine that no longer exists) and it is safer to leave it for a follow-up than to hand a seventh file to a pack mid-flight.

## I8 — THE CURATOR IS STILL RUNNING. Blocking.

**Raised by:** Pack B's independent verifier. **Confirmed by me directly.**

`desktop/electron/remote/init.ts:2742` is a bare `curator.start()` — no gate, no setting, no handler. There is no `curatorEnabled` anywhere in main. Compare the librarian, which is properly parked: `LIBRARIAN_PARKED = true` at `:2143`, honoured at `:2270` and `:2664`.

Meanwhile Settings now tells the user, in shipping copy: *"Both are being switched off for this release."* **Half of that is false**, and the disabled toggle renders in the off position while the subsystem runs — asserting a state that is not true, which is exactly what a kill-switch must never do.

This is one of the user's explicit launch requirements, so it is not optional.

**Fix at integration** (`init.ts` sits in Pack F's lineage and cannot be touched cleanly from Pack B's branch): mirror the librarian's pattern — a `CURATOR_PARKED = true` constant guarding `curator.start()` — and only then is the Settings copy true. Prefer the constant over a live setting: D7 retires the curator for launch, and a real toggle implies it can be switched back on, which is a bigger promise than we want to make now.

## I9 — One unverified claim shipped in the explainers

**Raised by:** Pack B's verifier, and disclosed by Pack B itself in the file header.

`help/BrowserUse.tsx:76-77` states that Codex desktop brings its own browser control. Nothing in this repository sources it. It came from my design conversation, not from the code.

**Decision: needs machine confirmation before launch.** It is a claim about a third-party app's capabilities and it drives a recommendation ("Codex is one step, Claude Code is three"). If it turns out false, the sentence and the recommendation both change. On the escalation list.

## I10 — I1 was wrong: the notch toggle already works

**Superseded:** I1 above.

I recorded that Pack B's notch auto-present toggle was cosmetic until two lines landed in `init.ts`. Pack B's verifier disproved it. `maybePresent()` at `init.ts:784` opens with `if (settings.get('overlayAutoPresent') === false) return`, and it is the **only** path to `presentOrExpand` — every auto-present call site routes through it. The toggle works end to end today.

Pack D's additive `autoPresent` IPC command is a *refinement* — it lets the notch know its own policy — not the mechanism. Wiring it remains worth doing, but it is no longer blocking and the OFF position is not dead.

I corrected the over-cautious comment Pack B had written on my instruction (commit `5e3840d`), because it would have sent whoever picked up integration hunting for a hop that already exists.

## I11 — Two `visibleOnWall` rules now exist and disagree

**Raised by:** Pack C's verifier. Pack C could not fix it — `electron/` is out of its scope.

The renderer's `visibleOnWall` now enforces the 24-hour window. The main process keeps **its own copy** at `electron/remote/notch/notch-controller.ts:725`, untouched, whose comments still describe the old rule — `:723` *"sessions never fade"* — and `init.ts:1943` still says *"the renderer's visibleOnWall: non-shelved sessions always"*. All three statements are now false.

This is why the notch's count did not move when the wall's filter changed, which is the **correct** behaviour (the notch shows what is running; the wall shows what is visible — different sets). So the divergence is intentional in effect and accidental in origin.

**Fix at integration:** leave the two implementations separate, but rename the main-process copy so it cannot be mistaken for the renderer's rule, and correct all three stale comments. A same-named function with two definitions is a trap for whoever next edits either.

## I12 — Eight curator IPC handlers now have no consumer

**Raised by:** Pack C's verifier.

Removing Suggestions orphaned `curator:list-proposals`, `curator:get-proposal`, `curator:accept`, `curator:reject`, `curator:converse-start/write/stop` and `curator:conv-data` — eight handlers with zero renderer callers. Nothing crashes: all are pull-based `invoke` handlers, and the one push channel only fires after a call that no longer happens.

**Fix at integration, together with I8.** Parking the curator and deleting its unreachable IPC surface are the same job; doing one without the other leaves a switched-off subsystem still exposing an API.

## I13 — The sandbox directory picker is not built

**Raised by:** Pack C's verifier. **Spec item openly unmet, with a sound reason.**

SPEC §6 required replacing the free-text sandbox path field with a directory picker. Pack C shipped one-tap project chips instead and documented why: no `dialog.showOpenDialog` IPC exists, and `File.path` was removed in Electron 32 while the engine ships 40 — so a renderer-only picker is impossible.

**Decision: accept the chips for launch.** They cover the common case (adding a project you already use) without a main-process change. A real picker needs a new IPC handler in `init.ts` and belongs in a follow-up, not in a launch pack.

## I4 — Corner radius is an estimate, by necessity

**Raised by:** Pack D.

macOS exposes the cutout's bounds but **not its corner radius**. Pack D used `0.30 × barHeight` and erred large on the reasoning that a mass receding into the housing is invisible while one protruding past it is not.

**Decision: keep.** This is the correct trade. It is also the single most likely thing to need a nudge after looking at a real MacBook — VERIFY D §10 is the check, and if the junction reads wrong, this constant is the first thing to adjust.
