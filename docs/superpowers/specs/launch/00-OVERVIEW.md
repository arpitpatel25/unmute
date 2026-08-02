# Launch readiness — pack overview

**Base:** `origin/main` @ `ab45005`
**Branch convention:** `arpit/launch-<pack>`
**Scope:** everything required to put unmute in front of strangers. The working-directory picker is explicitly out of scope (parked by the user). Test-worker isolation is tracked separately.

---

## How these documents work

Each pack is a directory containing two files:

| File | Audience | Job |
|---|---|---|
| `SPEC.md` | the implementing agent | What to build, every decision already taken, the constraints it must not violate |
| `VERIFY.md` | a **fresh** agent that did not write the code | A dense assertion list. Every line is a question with a yes/no answer |

**The verification rule.** The implementing agent must not tick its own checklist. When implementation is complete it spawns a subagent whose only input is `VERIFY.md` and the diff. That subagent answers every assertion independently and reports failures. An assertion marked `[auto]` must be proved by running the stated command; one marked `[eye]` needs a human and is escalated to the user, never self-certified.

**The spec is a contract, not a suggestion.** Nothing in it is optional. If an instruction turns out to be wrong or impossible, the agent stops and reports — it does not substitute its own judgement and continue.

---

## File ownership — the rule that prevents silent losses

Packs run in parallel worktrees. Two agents editing one file on two branches will produce a merge that drops work without erroring. **A file has exactly one owner.** An agent that needs to change a file it does not own stops and reports instead of editing it.

| Pack | Owns | May read |
|---|---|---|
| **A — Shell & onboarding** | `renderer/app/App.tsx`, `renderer/app/Onboarding.tsx`, `renderer/app/_shared.tsx` | everything |
| **B — Settings & explainers** | `renderer/app/Settings.tsx`, `renderer/app/Privacy.tsx`, `renderer/app/Permissions.tsx`, `renderer/app/Language.tsx`, `renderer/app/help/**` (new) | everything |
| **C — Orchestrator UI** | `renderer/remote/OrchestrateWall.tsx`, `renderer/remote/RemoteSettings.tsx`, `renderer/remote/RemoteSetup.tsx`, `renderer/remote/RemoteSetupEntry.tsx`, `renderer/remote/RemoteHowItWorks.tsx`, `renderer/remote/TaskPanel.tsx`, `renderer/remote/TaskRow.tsx`, `renderer/remote/AmbientIndicator.tsx` | everything |
| **D — Notch** | `desktop/native-notch/**` | everything |
| **E — Auth** | `electron/paywall-glue.ts`, `src/paywall/AuthContext.tsx`, `src/paywall/supabase-client.ts` | everything |
| **F — Model plumbing** | `electron/remote/task-manager.ts`, `engine-overrides/renderer/remote/useRemoteTasks.ts`, `electron/remote/init.ts` | everything |

Anything not listed is unowned and must not be edited by any pack.

## Ordering

```
        ┌── D (notch)      ── independent, start immediately
        ├── E (auth)       ── independent, start immediately
        ├── F (model)      ── independent, start immediately
        │
A (shell) ──► B (settings & explainers)      B needs A's routes
        F ──► C (orchestrator UI)            C needs F's model field
```

**A → B** and **F → C** are hard sequences. D and E share nothing with anything.

---

## Decisions taken, with evidence

Recorded here so no pack re-litigates them.

### D1 — Workflows are out of scope for launch
No workflows feature exists. The word appears twice in the repository, both in comments. The nearest real system is `recipe-store.ts` (nursery/skill tiers, confidence scores), which is written by the curator and librarian — both of which are being disabled. Explaining a feature that does not exist is worse than explaining neither. **No workflows explainer is written. "Unmute memory" is removed from settings.**

### D2 — The Features tab is dropped, its unique content is preserved
`Voice.tsx` is not in this repo; it comes from the OSS engine (`arpitpatel25/unmute-dictation` @ `v1.3.6`) and is overlaid by `wire-into-engine.sh`. Read at `desktop/work/oss-engine/renderer/app/Voice.tsx` — 287 lines documenting Dictate, Instruct, and **chaining** (dictate with Fn, then immediately Caps Lock to reshape it). The first two are superseded by the new explainer pages. **Chaining is genuinely useful and is not documented anywhere else — Pack B must carry it into the Instruct explainer.**

### D3 — Privacy copy, verified line by line
Traced through `backend/`. What is provably true:

- **`usage_logs` stores no content.** `log_usage` (migration `008_billing_reconcile.sql:49`) takes exactly: `user_id, call_type, flow_type, provider, model, prompt_tokens, completion_tokens, audio_duration_seconds, estimated_cost, latency_ms`. No transcript column, no audio column. ✅ *"We do not store your transcripts"* is true.
- **Telemetry never leaves the machine.** `dictationTelemetry.ts` writes JSONL to `<userData>/telemetry/`. No fetch/upload path exists anywhere in the codebase. ✅
- **Telemetry excludes transcript text in production.** `DEV_BUILD = false`; transcript text is only included when true, which is dev-only. ✅
- **Retention is 7 days, not 1.** `KEEP_DAYS = 7`. ⚠️ The current Privacy tab says dictations are *"cleared daily"*. **That is wrong** and Pack B must correct it: history is same-day, telemetry is seven days.
- **"No telemetry or analytics SDKs"** is true as written (no third-party SDK) but misleading, because the app does keep local diagnostics. Pack B must say so plainly rather than deleting the claim.

### D4 — Existing users get a short "what's new", not the full flow
The onboarding gate is a single unversioned boolean, so a revamp would reach new installs only. It becomes versioned. Users who completed the old flow see a **three-screen** summary of what changed, not all nine steps.

### D5 — The notch mass is opaque, always
The `Fixed / Live glass` surface setting governs the expanded panel and the recording pill only. The bar-level mass is opaque black, because it impersonates the physical notch and any translucency breaks the illusion at the join. This also sidesteps the macOS 26.2 glass-caching bug for that surface.

### D6 — Model is a historical fact
Recorded on the task at dispatch and persisted, never derived from settings at render time. A task started under Sonnet must not claim Opus because the picker moved since.

### D7 — Suggestions removed, Skills kept read-only
Suggestions is the curator's review inbox; with the curator off it can never receive anything. Skills survives as an archive of what was already learned. **Consequence accepted:** the "unmute learns your work" story leaves the product for now, and no copy anywhere may claim it.

### D8 — Visual direction for the main window
Keep the existing token system (`cream` / `ink` / `accent #D97757`) — it is coherent and shipped. What changes is discipline, not palette:
- one type scale: `22 / 16 / 14 / 13 / 12.5 / 11 / 10` and nothing between
- one control vocabulary: `Toggle`, `SegmentedControl`, `SettingRow`, `SectionHeader`. Raw `<input type="checkbox">` and native `<select>` are forbidden in any screen a user sees
- one icon per concept; `BehaviorIcon` is currently used for four unrelated sections and must not be
- long explanations become a "What this does" link to a Help page, never a paragraph inside a control row

---

## Out of scope, deliberately

- Working directory / worktree picker — parked by the user
- Test-worker KV isolation — separate, backend-only
- Any change to billing amounts or plan structure
- The cockpit's grouping algorithm (router-assigned groups) — unchanged
