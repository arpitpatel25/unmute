# Pack C — Orchestrator UI

**Branch:** `arpit/launch-orchestrator-ui`
**Owns:** `renderer/remote/OrchestrateWall.tsx`, `RemoteSettings.tsx`, `RemoteSetup.tsx`, `RemoteSetupEntry.tsx`, `RemoteHowItWorks.tsx`, `TaskPanel.tsx`, `TaskRow.tsx`, `AmbientIndicator.tsx`
**Depends on:** Pack F merged — the `model` field on `RemoteTask` comes from there
**Read first:** `../00-OVERVIEW.md`

---

## 1. What is wrong today

The wall calls itself COCKPIT. Every visible card says "Ready", including one 46 days old, because `visibleOnWall()` returns true for every session forever. The rail carries a Projects list you cannot act on and a Suggestions inbox fed by a curator that is being switched off. The settings panel is raw checkboxes and a native select in an app that has a design system. And 625 lines of finished UI — including the entire trust page — are unreachable because the only thing that imports them is itself unimported.

## 2. Naming

**"Cockpit" is deleted from the product.** The surface is the **Orchestrator**, everywhere: the header, the window title, comments, log lines, test names. Search the whole pack for `cockpit` case-insensitively and replace it. `#/orchestrate` as a route hash may stay — it is not user-visible — but nothing rendered may say Cockpit.

## 3. The wall

### 3.1 Needs-you band
A task waiting on an answer outranks eleven that finished. Render a **Needs you** band above every group, containing tasks in `needs-user`, amber, with the glow. When empty it is not rendered at all. Everything else keeps its existing router-assigned group.

### 3.2 The 24-hour window
`visibleOnWall()` (`OrchestrateWall.tsx:76`) currently returns `true` for every `kind === 'session'` regardless of age. Replace with: **live now, or updated within 24 hours**, for every kind including sessions.

This is a real behaviour change — a session untouched since Tuesday will disappear. That is correct **only if it is visible and reversible**: the header carries a **`Last 24h ▾`** control. Switching it to "All" restores the old behaviour. Silent truncation is forbidden; if the filter hides anything, the control says how many.

### 3.3 Two disclosure controls, two different words
`Last 24h` is a time filter and lives once, in the header. The per-group control is **grid density**, not time — items hidden because the row is full. Rename it from `Show all · 12` to **`+7 more`**. Different verb, different shape, no chance of reading it as a second time filter.

### 3.4 Expand all
A header control that expands every visible group to show all its cards. Idempotent, and it does not change the time filter.

### 3.5 The rail
Remove **Projects** — a directory list with no action attached. Remove **Suggestions** — the curator's review inbox, which with the curator off can never receive anything again (decision **D7**). Remove **Unmute memory** and its cleanup button from the settings panel (decision **D1**).

The rail becomes four sections, each actionable: **Queue · One-offs · Skills · Shelf.** Skills stays as a read-only archive; nothing new will ever be added to it, and no copy may imply otherwise.

### 3.6 Empty state
Agent connected, nothing running: one microphone affordance, one example phrase in the user's own vocabulary — *"Press ⌥ and say what you want done."* — and the last finished task if there is one. No illustration. It is a workspace between jobs, not an error.

### 3.7 No agent installed
Neither Claude Code nor Codex present. Do not render the settings panel for a thing that cannot run. Render: what the orchestrator is, the two agents with a route to install each, and the reassurance that dictation works without any of it. This is the most likely first-run experience after launch.

## 4. The ticket

### 4.1 On the card
The footer carries, in dim ink and never competing with the title: **agent · model**, the **working directory**, and the age.

Provider already ships — `providerLabel()` at `OrchestrateWall.tsx:158` and rendered at `:215`, from commit `60a221e`. Do not rebuild it; verify it survives the redesign. `cwd` already ships on every task. **`model` arrives from Pack F** — if that field is absent, render agent alone rather than inventing a value.

Each vendor gets a small colour mark so the wall is scannable without reading: Claude terracotta, Codex green, Claude desktop violet. The text label stays.

### 4.2 Inside the ticket
Four fields, always: **Agent · Model · Working directory · Permissions**. Then live output where the backend has it, then actions.

### 4.3 Buttons ask the registry, never the id
Resume renders only when `provider.canResume`. A live terminal only when `provider.hasTerminal`. Codex desktop has neither, so its ticket shows **Open in Codex** and the conversation projection instead — not a greyed-out Resume. The rule already exists in the provider registry; use it. A dead control is worse than an absent one.

## 5. Resurrect what is already written

`TaskPanel.tsx` is imported by nothing; `RemoteHowItWorks.tsx` and `TaskRow.tsx` are reachable only through it; `AmbientIndicator.tsx` is imported by nothing.

- **`RemoteHowItWorks.tsx`** is a finished trust page. Give it a real route — Orchestrator → **How it works** (Pack A defined the sub-nav slot). Update its copy for the current product: it is not only Claude Code any more, and "Remote" becomes "Orchestrator".
- **`TaskPanel.tsx`, `TaskRow.tsx`, `AmbientIndicator.tsx`** — delete them, unless a component is genuinely needed for the new ticket, in which case fold it in and delete the wrapper. Do not leave unreachable files in the tree.

## 6. The settings panel

`RemoteSettings.tsx` is the single biggest visual-quality gap in the app: raw `<input type="checkbox">`, a native `<select>`, ad-hoc 12px text. Rebuild it with `_shared.tsx` components — `Toggle`, `SegmentedControl`, `SettingRow`, `SectionHeader`.

- **"Executor" is jargon.** It becomes **Agent**, and it is a proper control showing what each backend is good at — not a bare dropdown.
- **Model chips must follow the selected agent.** `FALLBACK_CATALOG` hardcodes Haiku/Sonnet/Opus and renders them even when Codex desktop is selected. Ask the backend for its own vocabulary, or show none. Never show one backend's models under another.
- **Sandbox roots** gets a directory picker. A free-text field with the placeholder `/Users/you/Downloads` is not a control.
- **The trigger toggle appears twice** — here and in Settings → Triggers. Keep the Settings one; remove it from this panel.

## 7. Constraints

- Do not touch `App.tsx` (Pack A), `renderer/app/**` (Pack B), or anything under `electron/` (Pack F owns `task-manager.ts`, `init.ts`, `useRemoteTasks.ts`).
- If `RemoteTask.model` does not exist yet, Pack F has not landed. Stop and report; do not add the field yourself.
- Preserve every existing IPC call.
- `npm run typecheck` passes; tests do not regress. `groupSections.test.ts` must still pass.

## 8. Definition of done

Nothing says Cockpit. Needs-you is a band at the top. The wall shows the last 24 hours with a visible, reversible control. The rail has four actionable sections. Every ticket names its agent, its model and its directory, on the card and inside it. Buttons ask the registry. How it works is reachable. No unreachable component remains in the tree. No raw checkbox or native select survives.
