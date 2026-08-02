# Pack A — App shell, navigation, onboarding

**Branch:** `arpit/launch-shell-onboarding`
**Owns:** `desktop/engine-overrides/renderer/app/App.tsx`, `.../Onboarding.tsx`, `.../_shared.tsx`
**Blocks:** Pack B (B fills the routes this pack defines)
**Read first:** `../00-OVERVIEW.md`

---

## 1. What is wrong today

The main window has eight flat sidebar destinations with no hierarchy. Two of them render the identical icon. One of them is not ours. The orchestrator — the centre of the product — is labelled "Remote". Onboarding describes a dictation tool that stopped being the whole product a year ago, states a pricing model the app no longer runs, and never mentions the notch, which `App.tsx:13-15` itself records as the single task and attention surface.

## 2. The target

### 2.1 Four destinations

```
History        what you said
Orchestrator   what your agents are doing
Account        who you are and what you pay
Settings       everything else
```

`Permissions`, `Language` and `Privacy` become sections **inside** Settings (Pack B builds them). `Features` is deleted entirely.

### 2.2 Changes to `App.tsx`

- `type Tab` becomes `'history' | 'orchestrator' | 'account' | 'settings'`.
- Delete the `voice` tab, its `SidebarButton`, and the `import Voice from './Voice'` line. See decision **D2** — the chaining content it held is Pack B's responsibility, not ours; do not attempt to preserve the component.
- Rename the `remote` tab to `orchestrator` throughout: the `Tab` union, the state, the label, and `remotePage`. The user-visible string is **"Orchestrator"**, never "Remote".
- Every sidebar item gets its own icon. `VoiceIcon` must appear at most once in the file. Replace the hand-drawn `SettingsIcon` (straight-line spokes) with a proper gear.
- Settings gains sub-navigation. When `activeTab === 'settings'`, the sidebar renders sub-items beneath it: **Triggers · Audio & behaviour · Appearance & notch · Permissions · Language · Privacy · Help & about.** Pack B owns what those render; this pack owns the navigation state and passes the active section down as a prop.
- Orchestrator keeps its existing sub-page state, widened to: `'tasks' | 'how' | 'setup' | 'settings'`.

### 2.3 Onboarding — nine steps

Replace all eight steps. The new sequence:

1. **Welcome** — "Speak. It happens." Dictate anywhere, and hand real work to a coding agent with the same voice.
2. **What unmute does** — three things, each on its own key: Dictate (Fn), Instruct (Caps Lock), Orchestrate (Right Opt). Not two.
3. **The notch** — the surface where tasks live. It must be introduced; today it never is.
4. **What leaves your Mac** — see §3 below. Copy is fixed and may not be improvised.
5. **Pick a plan** — the two real tiers from `Billing.tsx`: Dictation $4.99/mo, Unmute $7.99/mo. Continuing free on the on-device model is offered.
6. **Two permissions** — Microphone and Accessibility, both required, **neither skippable**.
7. **Your keys** — dictation key selectable; the orchestrator key is shown as whichever key dictation is not using; instruction key shown. All read live from settings.
8. **Connect an agent** — optional and deferrable. "I'll do this later" is a first-class button.
9. **Ready.**

**Every key label reads from the live setting.** No step may print the literal string `Fn` where the user's chosen key belongs. This is a bug in the current steps 6 and 7.

### 2.4 The gate — decision D4

Today: `localStorage.getItem('unmute_onboarding_complete')`, an unversioned boolean. Every existing user has it set, so a revamp would reach new installs only.

Replace with `unmute_onboarding_version`, an integer. Current version is `2`.

- absent → full nine-step flow (new install)
- `< 2` → **three-screen "what's new"**: (1) unmute now runs coding agents by voice, (2) the notch is where they live, (3) pricing is a subscription. Then set to `2`.
- `>= 2` → straight to the app

Read the legacy key once for migration: if `unmute_onboarding_complete === 'true'` and the new key is absent, treat as version `1`.

Settings → Help's "Replay onboarding" clears the version key entirely (Pack B calls it; export the key name from this file).

## 3. Fixed copy — step 4, do not improvise

Decision **D3** established what is provably true. Use these words:

> **What leaves your Mac**
> Written plainly, because the honest answer is not "nothing".
>
> - **Dictation audio** goes to our transcription service and is discarded the moment the text comes back. We keep a timestamp, a duration and the model name so we can bill you — never the audio, never the text.
> - **Orchestrator tasks never reach us.** The agent runs on your Mac, under your own account, with your own credentials. unmute passes it your words and reads its status back.
> - **On-device mode sends nothing at all.** No account, no network.
> - **Diagnostics stay here.** unmute keeps a local log of how each dictation was served — for seven days, on this Mac, never uploaded. It does not contain what you said.

## 4. Constraints

- Do not edit any file this pack does not own. Settings, Privacy, Permissions and Language belong to Pack B; **leave them untouched even though the nav now points at them.** Broken links between A and B are expected and correct at this stage.
- Do not touch anything under `electron/`.
- Keep the existing token system and Tailwind classes. This is not a re-skin.
- Every control uses `_shared.tsx` components. No raw `<input type="checkbox">`, no native `<select>` in any screen a user sees.
- Type scale is fixed to `22 / 16 / 14 / 13 / 12.5 / 11 / 10`. Nothing between.
- `npm run typecheck` must pass. Tests must not regress.

## 5. Definition of done

The app builds, shows four destinations, none of them named Remote or Features, no icon is used for two different concepts, onboarding runs nine steps with live key labels, and a user with the old completion flag sees a three-screen summary rather than nothing.
