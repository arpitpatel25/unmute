# Pack A — decisions taken during implementation

**Branch:** `arpit/launch-shell-onboarding`
**Base for the diff:** `arpit/launch-readiness` (`55cf515`)
**Files touched:** `desktop/engine-overrides/renderer/app/{App,Onboarding,_shared}.tsx` and this file. Nothing else.

This records every judgement call the SPEC did not make for me, why I made it that
way, and the two places where the SPEC or VERIFY does not match the repository as
it actually is. Written for someone who was not here.

---

## 1. The baseline is not green, and cannot be made green by this pack

SPEC §4 says *"`npm run typecheck` must pass"*. It does not pass on the base
commit and nothing in this pack's three files can make it pass.

`npm run typecheck` runs two `tsc` invocations:

| Stage | Config | Baseline | After this pack |
|---|---|---|---|
| 1 | `tsconfig.typecheck.json` (electron/remote) | **3 errors** | 3 errors, byte-identical |
| 2 | `tsconfig.renderer.json` (renderer) | **137 errors** | **123 errors** |

Stage 1 fails, so `&&` short-circuits and stage 2 never runs under `npm run
typecheck` at all. The three stage-1 errors are in `electron/remote/init.ts` and
`electron/remote/notch/notch-controller.ts` — files Pack F and Pack D own, and
which SPEC §4 forbids me from touching ("Do not touch anything under
`electron/`"). So the instruction is simply not satisfiable from here.

What I did instead: **no regression, and a measurable improvement.** Errors in
the three files this pack owns:

| File | Baseline | After |
|---|---|---|
| `App.tsx` | 11 | 5 |
| `Onboarding.tsx` | 9 | 1 |
| `_shared.tsx` | 0 | 0 |

The bulk of the remaining errors are environmental: `tsconfig.renderer.json`
typechecks the override files in isolation, but `../paywall/*`, `./Voice` and
`window.electronAPI` only exist after `build/wire-into-engine.sh` overlays these
files onto the OSS engine clone in `desktop/work/oss-engine/`. Every override file
in the repository has them. They are not introduced by this change.

The reduction came from adopting the `api()` cast-window idiom that
`Settings.tsx`, `TaskPanel.tsx` and `RemoteSetup.tsx` already use, instead of
touching `window.electronAPI` directly. That is a real fix, not a suppression:
the accessor is a typed shape, so calls through it are checked.

`npm test`: **1400 pass / 0 fail** before and after. No change.

## 2. The one type error this pack adds on purpose

`App.tsx` renders:

```tsx
<Settings onDictationKeyChange={setDictationKey} section={settingsSection} />
```

`Settings.tsx` belongs to Pack B and its `SettingsProps` does not have `section`
yet, so this is `TS2322` until Pack B lands. **This is deliberate and must not be
"fixed" here.** SPEC §4 and the dispatch instructions both say broken links from
this pack's nav into Pack B's screens are expected and correct, and that the fix
is never to edit a file this pack does not own.

I considered casting the component (`Settings as unknown as
React.ComponentType<…>`) to keep the file clean. I rejected it: the cast would
silence exactly the signal that tells Pack B its prop contract is unmet, and it
would be a lie in the type system rather than an honest unfinished seam.

It is the **only** new error, and it is one line.

## 3. Where the seven Settings sections are declared

`SettingsSection` and `SETTINGS_SECTIONS` live in **`_shared.tsx`**, not
`App.tsx`.

Reason: `App.tsx` imports `Settings.tsx`. If the section type also lived in
`App.tsx`, Pack B's `Settings.tsx` would have to import back from `App.tsx` — a
module cycle. `Settings.tsx` already imports `_shared.tsx`, so declaring the type
there costs Pack B nothing and creates no cycle.

`App.tsx` maps over `SETTINGS_SECTIONS` to render the sub-items, and carries a
comment naming all seven labels so the sidebar contract is legible from the file
that owns the sidebar.

**VERIFY assertion 15** ("Sidebar sub-items exist for settings: Triggers, Audio,
Appearance, Permissions, Language, Privacy, Help") names no file. The literal
labels are in `_shared.tsx`; the comment in `App.tsx` repeats them. Both files
are owned by this pack and both are in the diff.

## 4. Where the onboarding gate constants are declared

The opposite choice: `ONBOARDING_VERSION`, `ONBOARDING_VERSION_KEY`,
`LEGACY_ONBOARDING_COMPLETE_KEY`, `readOnboardingVersion()` and
`resetOnboarding()` all live in **`App.tsx`**, because SPEC §2.4 says "export the
key name from this file" and VERIFY 32–34 grep `App.tsx` specifically.

Pack B's "Replay onboarding" therefore imports from `./App`, which is a runtime
module cycle (`App → Settings → App`). It resolves correctly under ESM because
`resetOnboarding` is only *called* from a click handler, never read at module
evaluation time. Flagging it so nobody is surprised by it later.

**I export `resetOnboarding()` rather than just the key name.** Clearing only
`unmute_onboarding_version` would leave `unmute_onboarding_complete` behind,
which `readOnboardingVersion()` reads as version 1 — so "Replay onboarding" would
replay the three-screen *summary*, not the nine-step flow. The helper clears
both. Pack B should call `resetOnboarding()`; the key names are exported too, in
case it wants them for a diagnostics readout.

`markOnboardingSeen()` also removes the legacy key once the new one is written,
so the two can never disagree.

`readOnboardingVersion()` returns `ONBOARDING_VERSION` if `localStorage` throws.
Failing *closed* (straight into the app) is right: failing open would trap a user
in an onboarding flow whose completion can never be recorded.

## 5. Judgement calls in the shell

**Orchestrator sub-navigation is an in-content `SegmentedControl`, not sidebar
sub-items.** The SPEC mandates sidebar sub-items for Settings only, and VERIFY 9
asserts the sidebar has four items. Putting a second nest of sub-items in a 220px
rail would have muddied that. The four pages map to:

| Page | Renders | Owner of the component |
|---|---|---|
| `tasks` (default) | `TaskPanel` | Pack C |
| `how` | `RemoteHowItWorks` | Pack C |
| `setup` | `RemoteSetup` | Pack C |
| `settings` | `RemoteSetupEntry` + `RemoteSettings` | Pack C |

**The default moved from `settings` to `tasks`.** A destination described as
"what your agents are doing" that opens on a settings pane is the wrong first
frame. The old default is still one click away and both previously-reachable
components (`RemoteSetupEntry` → `RemoteSetup`, `RemoteSettings`) are still
reachable, which is what VERIFY 50 is guarding.

**`TaskPanel` is now mounted from the main window for the first time.** Its own
header comment says it was designed to live "as a tab in the main window", and it
was previously imported by nothing at all — the widened `'tasks'` page in the
SPEC's union needs something to render, and this is the component for it. It has
its own internal `how`/`setup` sub-pages that now duplicate the outer segmented
control; Pack C owns that file and can collapse the duplication. I did not touch
it.

**Sidebar sub-items carry no icons.** Seven new glyphs in a 220px rail would have
fought decision D8's one-icon-per-concept rule far more than they would have
helped anyone scan a seven-item list. Indent plus a rule does the job.

**The Language badge moved with the Language row** — it is now trailing content
on the Language *sub-item*, and the refresh effect fires whenever the app is not
sitting on that sub-item. Same behaviour as before, one level deeper.

**The pro-tip card gained a third key.** It named Dictate and Instruct; with
Orchestrate now a first-class trigger, omitting it from the one persistent hint
in the app would have been odd. Both key labels read from the live
`dictationKey`, as before.

## 6. Icons

- `SettingsIcon` keeps its **name** (VERIFY 12 greps for it) and gets entirely
  new path data: a real gear outline on a `0 0 24 24` viewBox. The old one was a
  circle with eight straight spokes, which reads as a sun or a spinner.
- `OrchestratorIcon` is new — four panes, matching the cockpit's `▦`.
- `VoiceIcon`, `PermissionsIcon`, `LanguageIcon` and `PrivacyIcon` are **deleted**
  from `App.tsx`. `VoiceIcon` was the duplicated glyph (Features *and* Remote);
  the other three belonged to tabs that no longer exist.
- `BehaviorIcon` in `_shared.tsx` **was a clock**, which is also what the
  sidebar's History row draws — two concepts, one glyph, exactly what D8
  prohibits. It is now a pair of sliders. Same export name, so no call site
  breaks.
- Added `HelpIcon`, `ProfileIcon` and `EngineIcon` to `_shared.tsx` so the four
  sections currently sharing `BehaviorIcon` have somewhere to go. **I did not
  change the call sites** — two are in `Settings.tsx` (Pack B) and two are in
  `Account.tsx`, which the overview's ownership table does not assign to any
  pack at all. See §9.

## 7. Judgement calls in onboarding

**Steps 5 and 6 of the SPEC's list are one screen each, and "Two permissions" is
genuinely one screen.** The SPEC's numbering ("6. Two permissions") reads as a
single step covering both, and that is how it is built: one screen, two
`PermissionRow`s from `_shared.tsx`, Continue disabled until both are granted,
no escape hatch. Nine steps total, as required.

**The plan step opens a real checkout.** "Pick a plan" that only describes plans
would be a leaflet. Signed out, the buttons read "Sign in" and call
`auth.openSignIn()`. Signed in, they call `paywallCreateSubscription(plan,
'month')` and hand the URL to `paywallOpenExternal` — the same IPC pair
`src/paywall/Billing.tsx` uses. Monthly only; the month/year toggle is Billing's
job and would have doubled this screen for a decision nobody makes during setup.
While a checkout is open the step polls `paywallGetSubscription` every 3s and
also re-reads on window focus, so it advances itself when the user comes back.
Failure is soft: an error line that says to subscribe later from Account, and the
free path stays available.

**"Continue free on the on-device model" is a quiet text button, not a third
card.** The SPEC requires it to be *offered*, and it is, with an honest line
underneath about what it costs you (slower, less accurate, no agents). Giving it
equal visual weight to the paid tiers would have been a different decision than
the one the SPEC took.

**The agent step's primary button depends on live status.** It reads
`remoteGetSetupStatus`. Not connected → "Set it up now" (primary) and "I'll do
this later" (secondary, always present). Already connected → a green confirmation
and a plain Continue. "I'll do this later" is never hidden or disabled.

**"Set it up now" needs a landing place, so `Onboarding` gained one optional
prop**: `onOpenAgentSetup?: () => void`. `App.tsx` wires it to "mark onboarding
seen, go to Orchestrator → Agents". Optional, so the component still renders
standalone. This is the only addition to the component's public shape.

**The macOS Globe-key tip survived, rewritten to be key-aware.** unmute always
uses the Fn/Globe key for *something* — it is either the dictation trigger or the
orchestrator trigger — so the tip is always relevant, but which role it is
serving now comes from the live setting rather than being assumed.

**No literal key name appears in any instruction.** `KEY_LABELS` is the single
place a key is spelled, and the orchestrator label is derived (`otherKey`). The
only occurrences of the string `Fn` outside that map are the two
`SegmentedControl` option labels on the "Your keys" step, which is the selector
itself.

**`WhatsNew` is a separate export in `Onboarding.tsx`**, with its own three-entry
array, rather than a mode flag on the nine-step flow. It keeps the `steps` array
at exactly nine and keeps two unrelated narratives from sharing state. It shares
the `Shell` (progress bar + counter) and the key-reading logic, and it also
offers the agent-setup shortcut, since "unmute runs agents now" is a poor message
to deliver with no way to act on it.

## 8. Type scale

Decision D8 fixes the scale at `22 / 16 / 14 / 13 / 12.5 / 11 / 10`. Across the
three owned files that meant:

- `text-[8px]`, `text-[9px]` → `text-[10px]`
- `text-[12px]` → `text-[12.5px]` (33 occurrences)
- `text-[15px]`, `text-[18px]`, `text-2xl`, `text-3xl` → `text-[16px]` or
  `text-[22px]`

`text-[12px]` → `text-[12.5px]` in `_shared.tsx` touches `SegmentedControl`,
`HeroKey`, `PermissionRow` and `UsageDetail`, which are rendered by Pack B's
screens too. That is intended — it is how the scale becomes global — but it means
Pack B will see a half-pixel shift in shared controls it did not make.

## 9. What I found that contradicts the plan

1. **SPEC §4 "`npm run typecheck` must pass" is not achievable.** It fails on the
   base commit, in `electron/`, which this pack is forbidden to touch. See §1.
   VERIFY assertion 47 (`exit 0`) has the same problem.
2. **VERIFY assertions 43–46 diff against `origin/main`.** The pack branches are
   cut from `arpit/launch-readiness` (`55cf515`), which is one commit ahead of
   `origin/main` (`ab45005`) and adds the six spec directories. A diff against
   `origin/main` therefore lists the spec files as "modified by this pack" and
   fails assertion 43 spuriously. The correct base for these packs is
   `arpit/launch-readiness`.
3. **`Account.tsx` is unowned.** The overview's ownership table assigns
   `App.tsx`, `Onboarding.tsx` and `_shared.tsx` to Pack A and four other screens
   to Pack B, and states that anything unlisted "must not be edited by any pack".
   `Account.tsx` and `History.tsx` are unlisted. `Account.tsx` uses
   `BehaviorIcon` for both "Profile" and "Engine", so **VERIFY assertion 14 can
   never reach one match** while that rule holds. `_shared.tsx` now exports
   `ProfileIcon` and `EngineIcon` ready for whoever is eventually allowed to
   change those two lines. This needs an owner assigned.
4. **The instruction key is not user-selectable.** SPEC §2.3 step 7 says
   "instruction key shown", which is what I built — Caps Lock is hardcoded
   throughout `keyListener`/`Settings.tsx`; only its on/off state
   (`paywallGetInstructionEnabled`) is live, and the step reflects that.

## 10. Consequences a human should look at

- Until Pack B lands, **Permissions, Language and Privacy are unreachable**. The
  sub-items exist and highlight, but `Settings.tsx` ignores the `section` prop
  and renders its current single page. This is the expected A→B seam.
- The nine-step flow, the three-screen summary, and the version gate have not
  been exercised in a running app — VERIFY marks those `[eye]`, and they are in
  the escalation list, not ticked here.
