# Pack B — decisions taken during implementation

**Branch:** `arpit/launch-settings-explainers`
**Base for every diff below:** `arpit/launch-readiness` (`55cf515`) — *not* `origin/main`; see integration note I6.
**Files touched:** `desktop/engine-overrides/renderer/app/{Settings,Permissions,Privacy,Language,Account}.tsx`, the new `desktop/engine-overrides/renderer/app/help/**` (eight files), and this document. Nothing else.

This pack was implemented in two sittings. The first was killed mid-run by an API
session limit and left a WIP commit (`0aaa49b`) that had never been typechecked,
tested or verified. The second reviewed that work from scratch, found three
things wrong with it, fixed them, and verified the whole pack. Both sittings are
recorded here as one account; where the second overruled the first it says so.

---

## 1. The kill-switches are the one place the SPEC's premise is wrong

**This is the headline escalation. Read it before anything else.**

SPEC §2.7 asks for two kill-switches in Help & about, both default off, with
"descriptions [that] say what they did and that they are off for now". Decision
D7 states the curator and the librarian "are being disabled" for launch.

**The librarian is off. The curator is not, and nothing in these six packs turns
it off.**

| | Setting in main | IPC handler | Exposed by preload | Actually running? |
|---|---|---|---|---|
| Librarian | `librarianWriteEnabled`, default `false` (`init.ts:200`) | `remote:set-librarian-write-enabled` (`init.ts:3444`) | **no** | no — `LIBRARIAN_PARKED = true` (`init.ts:2143`) means no librarian session spawns at all |
| Curator | **none** | **none** | **no** | **yes** — `curator.start()` (`init.ts:2742`) is unconditional and schedules recurring sweeps |

So:

- The librarian row's **read** is real (`remote:get-settings` returns
  `librarianWriteEnabled`, `init.ts:3495`) and shows the true state. Its
  **write** cannot happen: the handler in main is orphaned because
  `electron/remote-preload.ts` never exposes it.
- The curator row has no backing at all. There is no setting to read, so it
  always renders off — while the curator is sweeping.

### What I did about it

I built both rows exactly as the SPEC requires — they exist, they default off —
and rendered them **disabled**: dimmed, inert, with a `title` of *"Not
adjustable in this release"*, plus one quiet line under the card.

The alternative was an enabled toggle, and I rejected it. An enabled toggle here
flips, calls an optional-chained method that does not exist, writes nothing, and
snaps back to off on the next mount. VERIFY §60 puts it better than I can: *"a
toggle that changes nothing is worse than no toggle."* `Toggle`'s `disabled`
prop is documented in `_shared.tsx` for precisely this case — *"the setting
isn't the user's to change … rendered dimmed and inert rather than hidden, so
the capability is discoverable"*.

I also changed the copy the WIP had written. It said *"Reviewed finished tasks
and proposed skills to save. **Off for now.**"* That sentence is false for the
curator. The descriptions now say what each feature **does** and never what
state it is in, because for the curator the app cannot currently know.

### To make them real — three lines, in two files this pack does not own

1. `electron/remote-preload.ts` — expose `remoteSetLibrarianWriteEnabled` →
   `invoke('remote:set-librarian-write-enabled')`. The handler already exists.
2. `electron/remote-preload.ts` — expose `remoteSetCuratorEnabled` →
   `invoke('remote:set-curator-enabled')`.
3. `electron/remote/init.ts` — add a `curatorEnabled` setting (default `false`),
   that handler, `curatorEnabled` on the `remote:get-settings` snapshot, and
   gate `curator.start()` on it.

Then flip `KILL_SWITCHES_WIRED` at the top of `Settings.tsx` from `false` to
`true` and nothing else in the renderer changes. The constant carries this same
list in a comment so it is discoverable from the code.

**Until step 3 lands, a shipped build runs the curator.** That is a product
decision, not a rendering one: it reads finished session transcripts and runs
LLM sweeps over them, which is worth a deliberate yes or no rather than an
oversight. Escalated.

## 2. The notch toggle persists, and still does not reach the notch

Integration note I1 already describes this and it is confirmed from this side.

What **is** real: `remote:set-overlay-auto-present` (`init.ts:3376`) writes
`overlayAutoPresent`, `remote:get-settings` reads it back, the preload exposes
both. So the toggle persists across a restart — VERIFY §10 passes.

What is missing is the last hop. Pack D added an additive `autoPresent` command
to the notch's IPC; two lines in `electron/remote/init.ts` must send it. Until
they do, the notch keeps its own default, which is **on** — so the ON position
already behaves correctly and it is the OFF position that does nothing. That
asymmetry is worth knowing when someone tests this: a toggle that "works" in one
direction is easy to tick off as working.

I did not touch `init.ts`. It is Pack F's file and this is I1, on the
coordinator.

## 3. `Account.tsx` — reassigned mid-flight, five lines changed

The overview's ownership table omitted `Account.tsx`; the coordinator reassigned
it to this pack (integration note I7). Five lines:

- two `SectionHeader` icons: `BehaviorIcon` → `ProfileIcon` (Profile) and
  `EngineIcon` (Engine). Pack A added both glyphs to `_shared.tsx` for exactly
  these call sites and left them unwired because it did not own this file. With
  this change `BehaviorIcon` has **one** call site in the whole app — VERIFY
  §48, which Pack A recorded as unreachable from where it sat.
- two `text-[12px]` → `text-[12.5px]`, the nearest step on D8's scale.
- the signed-out line, which read *"Sign in to use managed cloud and top up
  credits."* — the pay-per-use model migration `012_retire_payperuse.sql`
  retired. It now says *"Sign in to use the cloud engine and manage your
  subscription."* The same stale story was the paragraph D3 ordered deleted
  from Privacy; leaving it on Account would have moved the lie rather than
  removed it.

`History.tsx` remains unowned and untouched.

One thing I did **not** change: the file's header comment says the Managed card
*"embeds the full Billing UI (balance + top-up + recent activity)"*. That
describes `src/paywall/Billing.tsx`, which belongs to Pack E. If Pack E removes
top-up, this comment goes stale — but rewriting a comment about another pack's
component before that pack has landed would be guessing. Flagged for
integration.

## 4. Privacy — what the WIP got right, and the one number worth re-checking

Every sentence on the page is sourced, and I re-verified each source rather than
trusting the WIP's comment block:

| Claim | Source | Verified |
|---|---|---|
| no transcript or audio reaches us | `008_billing_reconcile.sql:49-72` — `log_usage` takes ten parameters and inserts eleven columns, none of them content | ✅ read in full |
| …and no migration has since added one | `grep -rin transcript backend/supabase/migrations/` → one hit, a comment in `013_fair_use.sql:7` | ✅ |
| diagnostics kept seven days | `dictationTelemetry.ts:20` — `const KEEP_DAYS = 7` | ✅ |
| diagnostics contain no transcript text | `dictationTelemetry.ts:19` — `export const DEV_BUILD = false`, and the comment above it: *"never ship true: production machines must not persist what users say"* | ✅ |
| diagnostics never leave the Mac | VERIFY §27's grep over `desktop/electron` + `desktop/engine-overrides` for telemetry + fetch/upload/post/send → **no matches** | ✅ |
| History is same-day | `db.ts:239` — `const cutoff = Date.now() - 24 * 60 * 60 * 1000` | ✅ |
| the agent runs here, under your account | `setup-status.ts:119-133` — both backends are programs installed on this Mac | ✅ |
| Dodo Payments is merchant of record | `007_dodo_webhook_rpcs.sql`, `011_subscriptions.sql` | ✅ |

Two notes on the wording, both deliberate:

**"Cleared daily" was not softened, it was replaced.** The old page stated one
retention for everything. Two different things are kept for two different
lengths of time and the page now says so in two separate rows. D3 called this
out; it is the single most likely thing on the page to be got wrong again if
someone edits it later, which is why the file's header comment says *"if you
change a sentence here, change the source comment with it."*

**"No telemetry or analytics SDKs" was qualified, not deleted.** It is literally
true — the app bundles no third-party analytics — but standing alone it reads as
*nothing is recorded*, and the app does keep local diagnostics. It now appears
as the third paragraph of the Diagnostics row, after what IS kept. VERIFY §24
allows either removal or qualification; qualifying is the more honest of the
two, because the fact itself is worth knowing.

## 5. The one claim on an explainer page I could not source

`help/BrowserUse.tsx` says Codex desktop brings its own browser control and does
not need the Chrome extension. **Nothing in this repository demonstrates that.**
`MANUAL_BROWSER_STEPS` (`setup-status.ts:164`) is added to the checklist
whenever the browser lane is enabled (`init.ts:339`), with no reference to which
agent is selected — so as the code stands, a Codex user is shown the extension
step too.

SPEC §4 and VERIFY §41 both require the page to say it, and SPEC §4 also says to
cut what cannot be verified. Those two instructions collide. What I did:

- kept the sentence, because the SPEC is a contract and this is its explicit
  requirement;
- narrowed it to claim only what **Codex** brings, not what unmute knows about
  it;
- added a sourced Note underneath — the setup step is listed whichever agent you
  have selected — so a Codex user does not read this page and then conclude the
  checklist is broken.

**Escalated.** Confirm on a real machine before launch, or cut the sentence.
It is the only unsourced product claim in the pack.

## 6. Where the SPEC was wrong about a fact, and I said so on the page

SPEC §2.4 justifies the new Screen Recording row as *"needed for capture's
screenshots"*. It is not. Dictation-time screenshot capture is an `fs.watch`
over your screenshot folder (`capture/screenshotWatch.ts:1-11`); it reads a file
macOS has already written and needs no screen-capture grant at all. The grant is
needed for the agent capturing a window during **computer use**
(`remote/ax/policy.ts:10-13`, `remote/cua/driver-manager.ts:92-100`).

The row belongs on the page — the SPEC is right that it was missing — but it is
worded for the reason that is true. Writing the SPEC's reason would have sent
users to System Settings for a grant that does nothing for them.

**The Screen Recording row has no live status.** Nothing in the renderer's IPC
surface reports it; the only probe lives inside a cua driver child process with
no channel back to this window. Rather than render a status pill that would be a
guess, the row states what the grant is for and opens the right System Settings
pane. Adding the IPC means touching `electron/`.

## 7. Judgement calls in Settings

**One `<h2>`, in `Settings.tsx`, driven by `SETTINGS_SECTIONS`.** The section
heading is looked up from Pack A's array rather than written into each section,
so the sidebar label and the page title cannot drift. `Permissions.tsx`,
`Language.tsx` and `Privacy.tsx` each lost their own `<h2>` and their own width
cap.

**Width is per-section.** Language's picker is a three-column grid of ninety-nine
languages and needs `max-w-3xl`; everything else reads better at `max-w-lg`. One
ternary, in the one file that knows which section is showing.

**The seventeen `window.electronAPI.x` call sites in `Settings.tsx` were left
longhand on purpose.** Every one of them is a type error, and converting them to
the `api()` cast idiom would have removed fourteen errors for free — which is
exactly why I did not. VERIFY §50 proves nothing was dropped by diffing the set
of `electronAPI.<name>` strings against the base commit. Routing them through an
accessor erases every name from that diff and turns a real guard into a rubber
stamp. New calls added by this pack go through `api()`, which the same check
permits. `Permissions.tsx` (13 errors) and `Language.tsx` (4 errors) had no such
guard on them and were converted, which is where most of this pack's error
reduction comes from.

**`LinkedRow` is a local component, not a change to `SettingRow`.** `SettingRow`
in `_shared.tsx` takes `description` as a plain `string`, so there is nowhere to
put a link in it, and widening its signature means editing a file this pack does
not own. `LinkedRow`'s layout is deliberately identical so the two read as one
row type.

**`Picker` replaces the native `<select>`.** D8 forbids the native dropdown, and
it was the one control in Settings that rendered in the system's chrome and
ignored every token in the app. Same value, same `onChange`, same device ids —
a button that opens a list of buttons.

**Three unrelated reads were un-nested.** In the base file,
`getIphoneMicEnabled`, `remoteGetScreenshotCapture` and
`remoteGetScratchpadEnabled` were called from inside the `getSoundFeedback()`
`.then()` — an accident of an earlier edit, not a dependency. If that one
promise ever rejected, three settings silently never loaded. They are now three
independent calls. No call, argument or key changed.

**"Replay onboarding" calls Pack A's `resetOnboarding()`.** The old button did
`localStorage.removeItem('unmute_onboarding_complete')` by hand. With Pack A's
two-key gate, clearing only that key leaves `unmute_onboarding_version` at `2`,
which resolves to the three-screen what's-new rather than the full nine-step
flow. `resetOnboarding()` clears both. This creates a module cycle
(`App → Settings → App`) which Pack A's §4 already flagged; it resolves under
ESM because the function is only ever called from a click handler.

**"Check for updates" opens the releases page rather than triggering the
updater.** There is no renderer-reachable "check now" IPC — the updater runs on
its own schedule in main. A button that pretended to trigger a check would be
the same defect as §1's toggles. The URL is the repository electron-builder
actually publishes to (`build/wire-into-engine.sh:270-275`), so what it opens is
what the in-app updater installs from, and the row says the app updates itself
in the background.

## 8. Judgement calls in the explainer layer

**One shell, in `help/index.tsx`, and every type size comes from it.** `Shell`
(which draws the back link, the title and the standfirst), `Sec`, `P`, `Li`,
`Lit` and `Note` are the only places a font size is written for any of the seven
pages — the page files themselves contain no `className` at all. D8's scale is
enforced in one file rather than seven.

**Each page carries a `SOURCES` comment naming the file and line behind its
claims.** This is the mechanism that makes SPEC §4's rule enforceable six months
from now: a sentence with no source in that block is a sentence to cut.

**Settings owns which help page is open, not the pages.** One piece of state
serves both entry points — the "What this does" links on Capture and Scratchpad,
and the index in Help & about — and it is cleared whenever the section changes,
so clicking Privacy in the sidebar cannot land you on a help page.

**The Scratchpad page is lifted, not written.** Its four points already existed
as design commentary in `scratchpadStore.ts:1-14` and `ScratchpadView.swift:3-11`
and had simply never been said to a user. SPEC §4 said to lift it rather than
reinvent it, and that is literally what happened, down to *"paper does not have
a dark mode"*.

**The Instruct page's chaining section deliberately does not claim a grace
window.** `keyboard.ts` contains a deferred-chain path, but `stopDictation`
emits `chain-expired` immediately (`keyboard.ts:386-392`), so the window is not
live. The chain that works — press the second key while the first is still
recording — is the one documented. This is D2's rescued content and getting it
subtly wrong would be worse than not carrying it over.

**The Computer use page claims nothing about other vendors' agents.** What is
checkable is where unmute registers these tools: `claude mcp add-json … --scope
user` (`remote/ax/register.ts:73`), i.e. into Claude Code, for every project.
That is what the page says.

## 9. Type scale and icons

Across the five screens and the eight help files, every `text-[Npx]` is now one
of `10 / 11 / 12.5 / 13 / 14 / 16 / 22`. There are no Tailwind size keywords
(`text-sm`, `text-xs`, …) left in any owned file. Counts:

```
5 × text-[10px]   18 × text-[11px]   11 × text-[12.5px]   15 × text-[13px]
3 × text-[14px]    1 × text-[16px]    3 × text-[22px]
```

`BehaviorIcon` had four call sites across three files. It now has one — the
"Behaviour" group in Audio & behaviour, which is what it depicts. Help took
`HelpIcon`, Account's two headers took `ProfileIcon` and `EngineIcon`,
Permissions' three groups took `ShieldIcon` / `KeyIcon` / `EngineIcon`.

## 10. The baseline, measured

`npm run typecheck` does not pass on the base commit and no pack can make it —
integration note I6. Measured the replacement way, `npx tsc -p
tsconfig.renderer.json`:

| | `arpit/launch-readiness` | HEAD |
|---|---|---|
| **Renderer total** | **137** | **95** |
| `Settings.tsx` | 27 | 17 |
| `Permissions.tsx` | 13 | 0 |
| `Language.tsx` | 4 | 0 |
| `Privacy.tsx` | 0 | 0 |
| `Account.tsx` | 2 | 2 |
| `App.tsx` | 11 | 4 |

All 17 remaining `Settings.tsx` errors are the same `Property 'electronAPI' does
not exist on type 'Window'` at the seventeen preserved longhand call sites —
see §7. The two on `Account.tsx` are unchanged module-resolution errors for
`../paywall/*`, which only exist after `build/wire-into-engine.sh` overlays
these files onto the OSS engine clone.

**Pack A's deliberate seam is closed.** `App.tsx(391,62)` — `TS2322` on the
`section` prop, the one error Pack A added on purpose and told this pack to
close — is gone. `SettingsProps` now carries `section?: SettingsSection`,
imported from `_shared.tsx`. `App.tsx` was not edited to achieve it; it is
optional so `Settings` still renders standalone, defaulting to `triggers`.

`npm test`: **1400 pass / 0 fail**, identical to the base commit.

## 11. What the second sitting changed in the WIP

The WIP commit was much further along than its message implied — all five
screens and all eight help files were written. It was, however, entirely
unverified: never typechecked, never tested, never diffed. Three things were
wrong with it:

1. **The kill-switch copy asserted a false state** — *"Off for now"* on a
   curator that is running. Rewritten, and both toggles disabled. §1.
2. **The unsourced Codex-browser sentence was flagged in a comment but shipped
   as an unqualified product claim.** Narrowed, and given a sourced Note. §5.
3. **`Account.tsx`'s header comment said "three lines" over a five-line
   change**, and did not record why the file had been touched by a pack the
   ownership table said did not own it. Corrected.

Everything else in the WIP survived review, and the sources it cited were
spot-checked against the files rather than taken on trust — including all eight
Privacy claims, `capture/types.ts:5` and `:9`, `scratchpadStore.ts:1-14`,
`ax/policy.ts:8-30`, `init.ts:198`, `:200`, `:3376`, `:3444`, `:3495`. Every
line number it quoted was right.

## 12. Everything escalated, in one list

| # | What | Whose |
|---|---|---|
| 1 | **The curator runs in a release build.** No setting, no handler, no gate. D7 assumed otherwise. One gate in `init.ts` + one preload line. | coordinator / Pack F |
| 2 | The librarian's IPC handler is orphaned — main handles it, the preload never exposes it. One line. | coordinator |
| 3 | The notch auto-present toggle persists but does not reach the notch process (I1). | coordinator / Pack F |
| 4 | *"Codex desktop brings browser control of its own"* is unsourced in this repository. Confirm on a real machine or cut it. | product |
| 5 | *"Unmute memory"* still appears in `renderer/remote/RemoteSettings.tsx:327` and `renderer/widget/WidgetApp.tsx:462,487`. D1 removes it from the product; it is gone from every file this pack owns. `RemoteSettings.tsx` is Pack C's; `WidgetApp.tsx` is unowned. | Pack C / coordinator |
| 6 | `Account.tsx`'s header comment describes Pack E's Billing card as having "top-up", which D3's retirement of pay-per-use may falsify. | Pack E / integration |
| 7 | Screen Recording has no live status because no IPC reports it. The row is honest about what it cannot show, but a status pill would be better. | follow-up |

Everything on VERIFY's `[eye]` list — the seven sections rendering, toggles
persisting across a real restart, grant buttons, the focus re-check, back links
— has not been exercised in a running app and is escalated rather than ticked.
