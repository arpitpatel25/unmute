# unmute-cloud — Implementation Plan

This repo contains the **closed-source build distribution** of unmute, with a managed-cloud paywall layered on top of the open-source engine.

The OSS engine lives at `arpitpatel25/unmute-dictation` and is MIT-licensed. We pull it as a dependency, add paywall + auth + payments + backend integration, and ship a single unified DMG to end-users.

---

## 0. Why this repo exists

End users get one download from the website. That download includes three runtime options:

1. **Managed cloud** (this repo's addition) — sign in, top up credits, transcription via our backend → Groq
2. **BYOK** (from OSS engine) — user supplies their own Groq API key, calls Groq directly from device
3. **Local** (from OSS engine) — whisper.cpp on-device, fully offline

Default at fresh install: managed cloud with $0.50 free starter credit. User can switch to BYOK or local in Settings at any time.

When balance hits zero on managed cloud → app auto-falls-back to local whisper.cpp (already shipped in OSS engine) until the user tops up.

---

## 1. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Desktop App (this repo's build of unmute-dictation + paywall layer)  │
│                                                                       │
│ ┌────────────────────────────┐    ┌─────────────────────────────┐    │
│ │ OSS engine                 │    │ Paywall layer (this repo)   │    │
│ │ (unmute-dictation)         │    │ - Auth UI                    │    │
│ │ - Audio capture            │◄──►│ - Balance display            │    │
│ │ - Widget, keyboard, paste  │    │ - Top-up flow (Dodo)         │    │
│ │ - Local whisper.cpp        │    │ - Provider router            │    │
│ │ - BYOK Groq                │    │ - Managed-cloud client       │    │
│ └────────────────────────────┘    └─────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼ HTTPS (JWT-authenticated)
┌──────────────────────────────────────────────────────────────────────┐
│ Cloudflare Workers (edge, deployed via Wrangler)                     │
│                                                                       │
│ ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐    │
│ │ pipeline         │  │ config           │  │ payments         │    │
│ │ - JWT verify     │  │ - user config    │  │ - Dodo webhook   │    │
│ │ - Balance check  │  │ - feature flags  │  │ - Credit balance │    │
│ │ - Groq STT/LLM   │  │ - server cfg     │  │   on top-up      │    │
│ │ - Balance        │  └──────────────────┘  └──────────────────┘    │
│ │   decrement      │                                                  │
│ └──────────────────┘                                                  │
│         │                                                             │
│         ▼ (KV for hot balance, fire-and-forget logging)               │
│ ┌──────────────────┐                                                  │
│ │ Cloudflare KV    │ ← user balance cache (sub-10ms reads)            │
│ └──────────────────┘                                                  │
└──────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼ (async reconcile)
┌──────────────────────────────────────────────────────────────────────┐
│ Supabase                                                              │
│ - Auth (JWT, email magic-link or Sign in with Apple)                  │
│ - profiles (user + balance + plan)                                    │
│ - wallet_ledger (every credit/debit, auditable)                       │
│ - usage_logs (per-call cost, fire-and-forget)                         │
│ - topups (Dodo payment records)                                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Key architectural commitments:**

- **Balance check + decrement at the edge (KV), not Supabase** — sub-10ms vs 80-150ms. Source of truth is Supabase, reconciled async.
- **Groq passthrough, no caching** — audio is private and unique per request.
- **Streaming preserved** — pipeline worker streams Groq's response back to the client, never buffers.
- **All blocking work removed from hot path** — usage logging, balance reconciliation, telemetry all use `ctx.waitUntil()`.

---

## 2. Repository layout (proposed)

```
unmute-cloud/
├── PLAN.md                          ← this file
├── README.md                        ← public-facing intro (kept private until launch)
├── ARCHITECTURE.md                  ← detailed system design
│
├── desktop/                         ← Electron app wrapper around OSS engine
│   ├── oss-engine/                  ← git submodule pointing at unmute-dictation
│   ├── src/
│   │   ├── paywall/                 ← React components (sign-in, balance, top-up)
│   │   ├── electron/                ← IPC handlers for auth/balance/Dodo
│   │   └── provider-router.ts       ← routes STT/LLM to cloud/byok/local
│   ├── build/
│   │   └── build.sh                 ← pulls OSS, patches in paywall, builds DMG
│   └── package.json
│
├── backend/
│   ├── cloudflare/
│   │   ├── pipeline/                ← Groq proxy + balance enforcement
│   │   │   ├── src/index.ts
│   │   │   └── wrangler.toml
│   │   ├── config/                  ← user-config service
│   │   ├── payments/                ← Dodo webhook handler
│   │   └── shared/
│   │       ├── auth.ts              ← JWT verify (cached JWK)
│   │       ├── balance.ts           ← KV read/write atomics
│   │       └── config.ts
│   └── supabase/
│       ├── migrations/
│       └── functions/
│
└── docs/
    ├── DEPLOYMENT.md
    └── DODO_INTEGRATION.md
```

---

## 3. Reference repository

`arpitpatel25/bolo_ai` (cloned locally at `~/tools/unmute/BoloAI`) contains a working backend that we are **replicating and improving**, not reusing in place.

### Files to lift patterns from

| BoloAI source | Purpose | What to lift |
|---|---|---|
| `cloudflare/pipeline/src/index.ts` | Groq STT/LLM proxy | Auth + Groq forwarding + logging structure. **Drop the synchronous quota check.** Replace with KV balance decrement. |
| `cloudflare/pipeline/wrangler.toml` | Worker config | Bindings shape, secrets, env vars |
| `cloudflare/config/src/index.ts` | User-config service | JWT verify pattern, response shape |
| `cloudflare/supabase-proxy/src/index.ts` | Auth/DB proxy | JWT verify pattern (cached JWK from JWKS) |
| `cloudflare/shared/config.ts` | Shared model/provider config | Provider abstraction, Groq endpoints, model IDs |
| `supabase/migrations/001_initial.sql` | profiles + auth | Take as-is, extend `plan` enum to include `'managed'` |
| `supabase/migrations/002_usage_tracking.sql` | usage_logs table | Take as-is — log every Groq call for cost reconciliation |
| `supabase/migrations/003_telemetry_events.sql` | telemetry | Take as-is |
| `supabase/migrations/004_daily_caps.sql` | daily quota | **Reference only — replace with balance ledger** |
| `supabase/functions/admin/index.ts` | admin edge function | Pattern reference for admin RPCs |

### What we are NOT lifting

- `cloudflare/quick-chat/` — dead feature, not part of unmute
- `004_daily_caps.sql` daily quota model — paywall replaces this with balance ledger

---

## 4. Implementation phases

### Phase 0 — repo skeleton (1 day)

- [ ] Create directory structure per section 2
- [ ] Add `desktop/oss-engine` as a git submodule pointing at `arpitpatel25/unmute-dictation` main branch
- [ ] Add `.gitignore`, `.editorconfig`
- [ ] Wire up CI scaffolding (GitHub Actions) — lint + typecheck only, no deploy yet
- [ ] Stub `backend/cloudflare/pipeline/`, `backend/cloudflare/config/`, `backend/cloudflare/payments/`
- [ ] Initial commit, push to `arpitpatel25/unmute-cloud`

### Phase 1 — backend foundation (replicate from BoloAI) (3-4 days)

Goal: have the same backend functionality BoloAI has, but in this repo with the 3 latency fixes baked in.

#### 1.1 Supabase migrations (½ day)

- [ ] Copy `001_initial.sql` → add `'managed'` to plan enum, add `balance_cents INTEGER DEFAULT 0` column
- [ ] Copy `002_usage_tracking.sql` as-is (keep usage_logs for accounting)
- [ ] Copy `003_telemetry_events.sql` as-is
- [ ] **NEW** `004_wallet_ledger.sql` — every credit/debit row, source = `topup` | `usage` | `refund` | `adjustment`
- [ ] **NEW** `005_topups.sql` — Dodo payment records (provider_payment_id, amount_cents, status)
- [ ] Run `supabase db reset` against a fresh local instance to validate

#### 1.2 Cloudflare `pipeline` worker (1-2 days)

- [ ] Lift the JWT verify pattern from `bolo_ai/cloudflare/pipeline/src/index.ts:275-309` into `backend/cloudflare/shared/auth.ts`. Cache the JWK locally per worker instance.
- [ ] Lift the FormData parsing + Groq STT forwarding logic
- [ ] Lift the LLM transform call (Groq chat)
- [ ] Lift fire-and-forget usage logging via `ctx.waitUntil()`
- [ ] **Replace synchronous quota check** with KV balance read (`backend/cloudflare/shared/balance.ts:checkBalance(userId)`)
- [ ] **Replace post-response quota re-fetch** with: include current balance in response (read from same KV check above)
- [ ] Stream STT/LLM responses back to client — never buffer
- [ ] Add a `--dry-run` mode for testing without hitting Groq

#### 1.3 Cloudflare `config` worker (½ day)

- [ ] Lift end-to-end from BoloAI
- [ ] Add response field: `balance_cents`, `plan`, `provider_options: ['managed', 'byok', 'local']`

#### 1.4 Latency fixes (½ day)

- [ ] Verify no Supabase RPC is in the dictation request hot path
- [ ] Verify all logging is `ctx.waitUntil()`
- [ ] Verify `wrangler.toml` does **not** pin to a region (let CF route to nearest edge)
- [ ] Measure backend overhead in dev via timing logs; target <50ms p50

### Phase 2 — balance ledger + KV cache (2-3 days)

#### 2.1 KV balance cache

- [ ] Provision a KV namespace (`USER_BALANCE`) and bind it to `pipeline` + `payments` workers
- [ ] `backend/cloudflare/shared/balance.ts`:
  - [ ] `getBalance(userId)` — KV read, fallback to Supabase on miss, cache on warm
  - [ ] `decrementBalance(userId, costCents)` — atomic decrement, returns new balance
  - [ ] `setBalance(userId, cents)` — used by Dodo webhook
- [ ] Cost estimator: `estimateGroqCost(durationSeconds, model)` — pre-call estimate (~$0.04/hr Groq turbo)
- [ ] Post-response reconcile: actual cost from Groq response → adjust ledger via fire-and-forget

#### 2.2 Out-of-balance flow

- [ ] Pipeline returns HTTP 402 (Payment Required) when balance < estimated cost
- [ ] Response body: `{ code: 'INSUFFICIENT_BALANCE', balance_cents, top_up_url }`
- [ ] Desktop app sees 402 → auto-fallback to local whisper.cpp + surfaces a "Top up to use cloud" banner

### Phase 3 — Dodo Payments (2-3 days)

#### 3.1 Top-up flow

- [ ] Desktop app: "Top up" button opens Dodo Checkout in browser
- [ ] Pre-configured options: $10 / $15 / $25 (skip $5 — Stripe-equivalent math doesn't work)
- [ ] Free starter credit: $0.50 added on first sign-in (handled by `signup` trigger in Supabase)

#### 3.2 Dodo webhook handler (Cloudflare `payments` worker)

- [ ] Verify Dodo webhook signature
- [ ] On `payment.succeeded`:
  - [ ] Insert row into `topups` table
  - [ ] Insert row into `wallet_ledger` (source = `topup`)
  - [ ] Update profiles.balance_cents
  - [ ] Update KV cache
- [ ] On `payment.failed` / `payment.refunded`: handle gracefully, log only
- [ ] Idempotency: dedupe via Dodo's `event_id`

#### 3.3 Markup math

- [ ] **20% markup** on Groq's actual cost
- [ ] User-facing display: "Last session: $0.04 (Groq) + $0.008 (service) = $0.048"
- [ ] Ensure markup is applied at debit time, not at top-up time (matches "$10 in = $10 of credit, transparent per-use markup" model)

### Phase 4 — desktop app wrapper (4-5 days)

#### 4.1 OSS engine as submodule

- [ ] `git submodule add` for `unmute-dictation`
- [ ] Build script that pulls a tagged release, applies our patches/wires, builds
- [ ] Patch points: extend Settings, add new pre-launch sign-in flow, swap STT/LLM provider via router

#### 4.2 Auth flow

- [ ] First launch: sign-in screen with "Sign in with Apple" + "Email magic link"
- [ ] Supabase Auth SDK in renderer, JWT stored in keychain (NOT localStorage)
- [ ] Refresh token rotation handled by Supabase SDK
- [ ] Skip-for-now option → defaults to BYOK or local mode

#### 4.3 Balance display

- [ ] Top-right corner of main window: small pill showing `$9.47` + dropdown for top-up
- [ ] Live updates when transcription completes (decrements visibly)
- [ ] In-app top-up CTA when balance < $1.00

#### 4.4 Provider router

- [ ] User setting: `provider = 'managed' | 'byok' | 'local'`
- [ ] If managed + balance < estimate → auto-fallback to local + show "Out of credit" banner with top-up CTA
- [ ] If managed + signed out → prompt sign-in, fall back to local if dismissed

### Phase 5 — build & release pipeline (1-2 days)

- [ ] `desktop/build/build.sh`:
  1. Pull `unmute-dictation` at tagged release
  2. Wire in paywall layer (patches, additional source files)
  3. Run `electron-vite build` + `electron-builder --mac`
  4. Sign + notarize + staple (same env vars as OSS repo)
- [ ] Publish DMG to a public release (`arpitpatel25/unmute-app` or attach to OSS repo's release — TBD)
- [ ] Update auto-updater endpoint in OSS engine to point at the public release
- [ ] Update landing page download link to point at the new DMG

### Phase 6 — admin dashboard (later, optional)

- [ ] Lift `~/tools/unmute/monitor` as a starting point
- [ ] Replace daily-quota views with balance/ledger views
- [ ] Add top-up history + Dodo payment search
- [ ] Defer until product validated

---

## 5. Latency budget (target)

| Step | Budget | Notes |
|---|---|---|
| Device → Cloudflare edge | 50-100ms | Speed of light, ~India to nearest CF PoP |
| JWT verify (cached) | <5ms | Local |
| KV balance check + decrement | <10ms | Cloudflare KV edge read/write |
| Groq STT | inherent | Not in our control |
| Groq LLM (formatting) | inherent | Not in our control |
| Fire-and-forget reconcile + logging | 0ms | `ctx.waitUntil()`, non-blocking |
| Response serialize + return | 10-20ms | JSON |
| **Backend overhead (excl. Groq)** | **<50ms target** | vs BoloAI's current 150-300ms |

---

## 6. Open decisions

1. **Auth method UX:** Sign in with Apple (one-tap on Mac) vs Email magic link. Recommend: ship both; SIWA as primary.
2. **Free starter credit amount:** $0.50 recommended. Confirm.
3. **Top-up tiers:** $10 / $15 / $25 (skip $5). Confirm.
4. **Markup transparency:** show line-itemed cost (`Groq + service fee = total`) vs hide (just decrement total). Recommend line-itemed for trust.
5. **OSS engine integration mode:** git submodule (pinned to tag) vs npm dependency (published from OSS repo). Recommend git submodule for now — simpler.
6. **Public release artifact location:** publish to `arpitpatel25/unmute-dictation` releases (auto-updater works untouched) vs new public repo `arpitpatel25/unmute-app`. Recommend the former.
7. **Backend hosting:** Cloudflare Workers (free tier + per-request pricing) + Supabase (free tier up to 50K MAU). Both fine for MVP.

---

## 7. What's intentionally NOT in scope (yet)

- Subscription model — explicitly out, this is prepaid credits only
- Team / org accounts — solo-user MVP first
- Multi-currency pricing — USD only at launch
- Refunds via Dodo — manual for now
- Analytics dashboards beyond admin — defer
- Mobile / iOS — separate repo `UnmuteIOS`, not blocked by this work

---

## 8. Reference commands

```bash
# Clone reference repo
git clone https://github.com/arpitpatel25/bolo_ai ~/tools/unmute/BoloAI

# Run BoloAI's worker locally for reference
cd ~/tools/unmute/BoloAI/cloudflare/pipeline && npx wrangler dev

# Inspect Supabase migrations
ls ~/tools/unmute/BoloAI/supabase/migrations/

# OSS engine (this repo's downstream dependency)
git clone https://github.com/arpitpatel25/unmute-dictation desktop/oss-engine
```
