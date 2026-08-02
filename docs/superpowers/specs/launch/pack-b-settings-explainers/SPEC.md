# Pack B — Settings, and the explainer layer

**Branch:** `arpit/launch-settings-explainers`
**Owns:** `renderer/app/Settings.tsx`, `Privacy.tsx`, `Permissions.tsx`, `Language.tsx`, and a new `renderer/app/help/**`
**Depends on:** Pack A merged (it defines the sub-navigation this pack fills)
**Read first:** `../00-OVERVIEW.md`

---

## 1. What is wrong today

Settings are scattered across four top-level tabs with no logic. The Remote panel is a different design system from everything around it. There is no notch setting, no way to switch off the curator or librarian, no update check and no route to help. Privacy describes a prepaid-credit billing model the app no longer runs and never mentions that an agent runs on your machine with elevated permissions. And the app explains none of its own features — every explanation in the product is a parenthetical inside a control row.

## 2. Settings becomes seven sections

Pack A supplies the active section as a prop. Render one section at a time.

### 2.1 Triggers
Keep the dark hero. Rename the three rows to **Dictate**, **Instruct**, **Orchestrate** — decision **D8**, one name per concept. The current labels ("AI format (Instruction trigger)", "Unmute Remote (Task trigger)") are two of the eighteen naming inconsistencies being removed.

### 2.2 Audio & behaviour
Existing rows: microphone, output mode, sound feedback, capture, scratchpad, iPhone mic, launch at login, lowercase, cleanup.

**Long descriptions become links.** Capture and Scratchpad currently carry multi-sentence paragraphs inside a control row. Each keeps one short line plus a **"What this does"** link to its Help page (§4).

### 2.3 Appearance & notch — new section
- **Show the notch automatically** — toggle, **default on**. Wire to the notch auto-present setting.
- **Surface material** — the existing Fixed / Live glass / Follow system control. Per decision **D5** this governs the expanded panel and the recording pill **only**, never the bar-level mass. Rewrite the description accordingly and remove the reference to macOS 26.2 and the Apple bug — internal detail does not belong in user copy.
- Widget position — unchanged.

### 2.4 Permissions
Move `Permissions.tsx` here as a section. Restructure into two groups:
- **Required** — Microphone, Accessibility
- **Only if you use these features** — Screen Recording (needed for capture's screenshots; currently missing entirely), Free up the Fn key
- **On-device engine** — the model download

Delete the string *"Optional — Groq cloud works without this"*. It names a vendor managed users never touch and is wrong. Call the local engine **On-device model (Parakeet v3)** here, matching Account and Privacy. It must not be called whisper.cpp anywhere a user can see.

### 2.5 Language
Move as-is. No change beyond becoming a section.

### 2.6 Privacy — rewritten
Decision **D3** established what is provably true. Structure it per feature, and state for each row whether data leaves the machine:

**Dictation**
- *Cloud* — leaves your Mac. Audio goes to the transcription service and is discarded when the text returns. We keep a timestamp, duration, model name and cost so we can bill you. **Verified:** `log_usage` (migration `008_billing_reconcile.sql:49`) has no transcript or audio column.
- *On-device* — stays local. Parakeet v3, no account, no network.

**Orchestrator** — currently absent from this page entirely, and it is the biggest data-flow question in the product.
- Your tasks never reach us. The agent runs on this Mac under your own account and credentials.
- Agents run with elevated permissions, stated plainly, with a link to the How it works page.

**Everything else**
- History — stays local, same-day.
- Diagnostics — stays local, **seven days**, never uploaded, contains no transcript text. `dictationTelemetry.ts`: `KEEP_DAYS = 7`, `DEV_BUILD = false`, and no upload path exists.
- Billing — email and subscription, processed by Dodo Payments.

**Delete** the prepaid-credits paragraph. **Correct** "cleared daily" — history is same-day, diagnostics are seven days; the current page states one retention for both and it is wrong.

### 2.7 Help & about — new section
- Version + **Check for updates** (currently version is static text)
- Replay onboarding — clears the version key Pack A exports
- Get help — links to the explainer pages
- **Advanced**: two kill-switches, both **default off** — *Skill curator* and *Librarian*. Descriptions say what they did and that they are off for now. Per decision **D1**, "Unmute memory" and its cleanup button are removed from the product entirely; if that row still exists anywhere in a file this pack owns, delete it.

## 3. The Orchestrator settings panel is NOT this pack

`RemoteSettings.tsx` belongs to Pack C. Do not touch it.

## 4. Explainer pages — `renderer/app/help/`

Seven pages, reachable from Settings → Help and linked from the feature each describes. One shared shell: back link, title, standfirst, sections. Same tokens as the rest of the app.

| Page | Must cover |
|---|---|
| **Dictation** | What it does; that it is transcription, not authorship; where it runs; cleanup |
| **Instruct** | Select-and-speak. **Must include chaining** — dictate with Fn, then immediately Caps Lock to reshape it. Decision **D2**: this is the one genuinely useful thing in the deleted Features tab and is documented nowhere else |
| **Capture** | The five real kinds — `url`, `path`, `line`, `block`, `image` (`capture/types.ts:5`) — and two destinations, `cursor` or `task` (`:9`). The boundary: unmute reads the clipboard only while the mic is on |
| **Scratchpad** | Holds instead of delivers; survives crash, quit and restart; settles rather than nags; the pad is paper, not chrome. This reasoning already exists in `scratchpadStore.ts:1-10` and `ScratchpadView.swift:3` — lift it, do not reinvent it |
| **Orchestrator** | Why voice, why the notch, who is driving. Links to Orchestrator → How it works |
| **Computer use** | Background control; the screen never moves; needs Accessibility; Codex desktop has it built in |
| **Browser use** | Your real signed-in Chrome; keep one window open; Codex ships its own so it is one step, Claude Code needs the extension |

**No Workflows page.** Decision **D1**.

Every claim about what a feature does must be checkable against the code. If you cannot verify a sentence, cut it.

## 5. Constraints

- Every control uses `_shared.tsx` components. No raw `<input type="checkbox">`, no native `<select>`.
- Type scale `22 / 16 / 14 / 13 / 12.5 / 11 / 10`, nothing between.
- One icon per concept. `BehaviorIcon` currently marks Profile, Engine, Behavior and Help — give three of them their own.
- Do not touch `App.tsx`, anything in `renderer/remote/`, or anything under `electron/`.
- Preserve every existing IPC call and settings key exactly. This is a layout and copy change; no behaviour moves.
- `npm run typecheck` passes; tests do not regress.

## 6. Definition of done

Settings has seven sections and no top-level tab for Permissions, Language or Privacy. The notch toggle exists and defaults on. Both kill-switches exist and default off. Privacy states, per feature, whether data leaves the machine, and every sentence on it is verifiable. Seven help pages exist and are reachable. No screen a user can see contains a raw checkbox or a native select.
