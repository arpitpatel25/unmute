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

## I4 — Corner radius is an estimate, by necessity

**Raised by:** Pack D.

macOS exposes the cutout's bounds but **not its corner radius**. Pack D used `0.30 × barHeight` and erred large on the reasoning that a mass receding into the housing is invisible while one protruding past it is not.

**Decision: keep.** This is the correct trade. It is also the single most likely thing to need a nudge after looking at a real MacBook — VERIFY D §10 is the check, and if the junction reads wrong, this constant is the first thing to adjust.
