# unmute-cloud

Closed-source build distribution + managed-cloud paywall layered on top of the open-source [unmute-dictation](https://github.com/arpitpatel25/unmute-dictation) engine.

This repo is **private**. The OSS engine stays MIT-licensed and fully functional on its own; this repo adds the optional managed-cloud tier (auth + balance ledger + prepaid credits) and produces the unified DMG that's distributed from the public website.

## What's where

| Path | Purpose |
|---|---|
| `PLAN.md` | High-level implementation plan |
| `backend/supabase/migrations/` | Additive SQL on top of BoloAI's existing migrations |
| `backend/cloudflare/pipeline/` | Groq proxy worker — only managed users hit this |
| `backend/cloudflare/payments/` | Dodo webhook handler (stub for now) |
| `backend/cloudflare/shared/` | Auth, balance KV, types, Groq config |
| `desktop/src/paywall/` | React paywall components (sign-in, balance pill, top-up, engine selector) |
| `desktop/electron/` | Main-process glue (auth IPC, balance polling, provider router, managed client) |
| `desktop/build/wire-into-engine.sh` | Build script — pulls OSS engine, wires paywall, builds DMG |
| `docs/DEPLOYMENT.md` | End-to-end deploy steps |

## Architecture in one paragraph

The OSS engine ships **BYOK** (your Groq key) and **Local** (whisper.cpp) modes. This repo adds **Managed** mode: user signs in via Supabase Auth, tops up credits via Dodo, and transcription routes through a Cloudflare Worker that verifies their JWT, decrements balance from a KV cache (atomic edge-fast), forwards to Groq, and reconciles to Supabase async. Backend overhead is targeted under 50ms. The provider router picks managed / BYOK / local per user state with auto-fallback. **Crucial: BYOK and Local users never touch our infrastructure — only Managed users do.** Free users cost us nothing.

## Quick start

See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).
