# unmute-cloud

Private repo. The closed-source layer on top of the open-source
[unmute-dictation](https://github.com/arpitpatel25/unmute-dictation) engine — it
adds the managed-cloud tier and the orchestrator, and produces the signed,
notarized DMG distributed from the website.

The OSS engine stays MIT-licensed and fully functional on its own. **It is never
forked.** The build clones a pinned tag and copies `desktop/engine-overrides/`
over it.

---

## Start here

| If you want to… | Read |
|---|---|
| **Get it running on your Mac** | [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) |
| **Understand what this is and why** | [`UNMUTE_PROJECT_OVERVIEW.md`](./UNMUTE_PROJECT_OVERVIEW.md) |
| Deploy the backend | [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) |
| The cockpit vision, in the founder's words | [`docs/ORCHESTRATE-VISION.md`](./docs/ORCHESTRATE-VISION.md) |

## What's where

| Path | Purpose |
|---|---|
| `backend/supabase/migrations/` | Billing evolution, in order (`005 → 014`) |
| `backend/cloudflare/pipeline/` | Worker: auth + entitlement gate + STT/LLM proxy. Only managed users hit this. |
| `backend/cloudflare/payments/` | Worker: Dodo checkout + webhook |
| `desktop/engine-overrides/` | Files copied over the pulled OSS engine at build time |
| `desktop/electron/remote/` | The orchestrator — router, tasks, notch, capture, computer-use lanes |
| `desktop/native-notch/` | The Swift notch surface (SwiftUI + SwiftTerm) |
| `desktop/native-*/` | In-process macOS addons — paste, key listener, accessibility |
| `desktop/build/wire-into-engine.sh` | The whole build: clone engine → overlay → sign → notarize → DMG |

## Three modes, in one paragraph

The OSS engine ships **BYOK** (your own key) and **Local** (on-device model).
This repo adds **Managed**: sign in with Supabase, subscribe through Dodo, and
transcription routes through a Cloudflare Worker that verifies the JWT, checks
entitlement at the edge, and forwards to the provider. The provider router picks
managed / BYOK / local per user state with auto-fallback. **BYOK and Local users
never touch our infrastructure**, so free users cost us nothing.

## Two things that will bite you

**Never install an unsigned build.** macOS keys Keychain and Accessibility grants
by *code signature*, so `build:fast` / `--no-sign` produces an app that is signed
out with dead auto-paste — and nothing tells you why. Use it as a compile gate
only.

**Two files don't travel to git worktrees.** `desktop/.env.dev` and
`desktop/vendor/cua-driver/cua-driver` are both gitignored, so building from a
fresh worktree fails until you copy/fetch them. The build says so when it
happens; [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) says so beforehand.

## Quick commands

```bash
cd desktop
npm install
npm test          # ~1400 tests, ~2 min
npm run typecheck # 3 known pre-existing errors — see ONBOARDING
```
