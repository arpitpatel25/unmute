# Pack G — the notch's own cockpit, and the vanishing notch

**Branch:** `arpit/launch-notch-cockpit`
**Owns:** `desktop/native-notch/**`, `desktop/electron/remote/notch/notch-controller.ts`
**Read first:** `../00-OVERVIEW.md`, `../decisions/pack-d-notch.md`, `../decisions/pack-c-orchestrator.md`

---

## 1. Two defects found by testing an installed build

### 1.1 The notch is invisible — and it is my spec that is wrong

From the field log:

```
state -> dormant  window=x=959 y=1058 w=2 h=22  mass=[0|0|0]  fillet=0
geometry recomputed: screen=1920x1080 hasNotch=false
```

Pack D implemented the Pack D spec faithfully: *"Dormant → nothing at all. An always-visible idle indicator stops being an indicator."* The result is a 2-pixel window. With no task running there is nothing on screen at all — and on a display with no physical cutout there is not even a notch to hint at where it would be.

**That reasoning ignored that the notch is not only an indicator. It is the way in** — the click target for opening the orchestrator. A surface you cannot find is not restraint, it is a missing affordance.

**Fix: dormant collapses into idle.** There is always a minimal presence — the wordmark wing on a notched display, the small centred slab on one without. "Nothing" stops being a state. Delete the dormant branch rather than leaving a state nothing can reach; if the engine still sends `dormant`, render it exactly as idle.

The original concern was real and is addressed by *quietness*, not absence: idle is small, dim, and does not glow. Only attention glows.

### 1.2 There are two cockpits, and only the React one was rebuilt

`renderer/remote/OrchestrateWall.tsx` (the `#/orchestrate` window) was rebuilt by Pack C. The cockpit **inside the notch** is a separate Swift implementation — `WallView.swift`, fed by `notch-controller.ts`'s `CockpitPayload` — and nothing has touched it. It still shows the rails Pack C removed.

Confirmed in the installed bundle: `SUGGESTIONS`→0, `COCKPIT`→0, `Orchestrator`→36, but `PROJECTS`→**4**, from `notch-controller.ts:978` and `WallView.swift:252`.

This is a planning miss, not a pack failure: I mapped `OrchestrateWall.tsx` and assumed it was *the* cockpit.

## 2. Bring the Swift cockpit in line

Apply to `WallView.swift` and the payload that feeds it what Pack C applied to the React wall.

**Remove:**
- **Projects** — a directory list with no action attached. Drop `projects` from `CockpitPayload` (`notch-controller.ts:235`, `:978`) and its rail from `WallView.swift:252`.
- **Suggestions** — the curator's review inbox. The curator is now parked (`CURATOR_PARKED`, `init.ts`), so it can never receive anything again. Drop `suggestions` (`:979`) and the rail, and the review popup it opened.

**Keep:** Queue, One-offs, Skills (read-only archive), Shelf.

**Rename:** the word **cockpit** is retired. Every user-visible string is **Orchestrator**. Internal identifiers (`CockpitPayload`, the `.cockpit` state) may keep their names — renaming the wire format is a bigger change than this pack should make — but **nothing rendered may say Cockpit**.

**Carry across, so the two surfaces finally agree:**
- a **needs-you** band above every group
- **agent · model** and the **working directory** on every card, using the same rules Pack C used — `providerOf()` for the label, and **if `model` is absent render the agent alone, never a default** (decision D6)
- buttons ask the provider registry: Resume only where `canResume`, terminal only where `hasTerminal`

**Do NOT carry across the 24-hour filter.** The notch answers "what is happening now" and must not hide a live session because a filter says so — see integration item I11, which deliberately keeps the two rules separate. This is the one place the surfaces are allowed to differ, and it is on purpose.

## 3. Constraints

- Do not touch `renderer/**` — Pack C owns the React wall and it is already correct.
- Do not touch `electron/remote/init.ts` beyond what removing the two payload fields requires.
- Scratchpad visual identity is settled and must not change (`ScratchpadView.swift:3-17`).
- `swift build` passes; `Checks/run.sh` passes; `npm test` no regression.

## 4. Definition of done

The notch is always visible and clickable, in every state, on every display. Its cockpit shows four rails, says Orchestrator, puts needs-you first, and names the agent, model and directory on each card — and it still shows a live session the wall's 24-hour filter would hide.
