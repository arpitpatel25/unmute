# Subscription Pricing Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pay-per-use credit model with two flat recurring subscription tiers (Dictation $5.99/mo·$59/yr, Unmute = Dictation+Remote $8.99/mo·$89/yr), remove "bring your own API key" entirely, and gate access on an active subscription instead of a wallet balance.

**Architecture:** Entitlement becomes "does the user have an active subscription whose period covers now, and does its plan include the requested feature." We denormalize the subscription state onto `profiles` (fast edge read, exactly as `balance_cents` was used) and keep a `subscriptions` table as the source of truth fed by Dodo subscription webhooks. The pay-per-use debit/reconcile machinery is retired (columns kept for history, code paths removed). A hidden, soft fair-use cap (notify-only, never blocks) guards against abuse.

**Tech Stack:** Supabase Postgres (RPCs + pg_cron), Cloudflare Workers (payments worker + pipeline worker, TypeScript, Vitest), Electron + React (desktop paywall UI), Dodo Payments (subscriptions + hosted customer portal).

---

## Locked decisions (from the pricing discussion)

- **Tiers:** `dictation` ($5.99/mo, $59/yr) and `unmute` = dictation+Remote ($8.99/mo, $89/yr). Anchors (display-only strike-through): ~~$11.99~~ / ~~$17.99~~.
- **Hard paywall.** No free tier, **no trial** (`trial_period_days = 0`). A non-subscriber can do nothing.
- **Remove pay-per-use credits entirely** (clean cutover; `balance_cents`/`wallet_ledger`/`topups`/reconcile retired, not deleted).
- **Remove BYOK entirely** — provider chain becomes Managed → Local only.
- **Cancellation = Dodo hosted portal** (we build no cancel UI). End-of-period cancel.
- **Failed/lapsed payment:** Dodo dunning → `on_hold`; we grant a short grace (period_end), then lock on `expired`. History preserved.
- **Fair-use cap:** hidden, **soft (notify-only)**, never advertised as "unlimited."
- **Existing users:** auto-upgrade/comp handled LATER (out of scope for this plan; see Task 18 stub). The one real external payer (aashish) gets comped manually at cutover.

## ⚠️ Open external blocker (does NOT block code, blocks go-live)

**INR auto-recurring mandate floor (~₹15,000).** Our plans are far below this. Before flipping live, the owner must confirm with Dodo whether INR auto-recurring works below ₹15k, or whether Indian users must be billed in USD via Adaptive Currency. Code is currency-agnostic (Dodo handles currency), so build proceeds; **do not create live Dodo products or cut over until this is resolved.**

---

## File Structure (what changes and why)

### Supabase (`backend/supabase/migrations/`)
- **Create** `011_subscriptions.sql` — `subscriptions` table (source of truth), `profiles` denormalized columns (`sub_plan`, `sub_status`, `sub_period_end`, `dodo_customer_id`), `process_subscription_event` RPC (idempotent upsert from webhook), `entitlement(user_id)` helper, and retirement of the pay-per-use reconcile cron. One file: schema + RPCs change together.
- **Create** `012_fair_use.sql` — `fair_use_config` (singleton: hidden monthly cap), `monthly_usage(user_id, period_start)` view/materialized accessor over `usage_logs`, `over_fair_use(user_id)` helper. Separate file: fair-use is an independent concern.

### Cloudflare payments worker (`backend/cloudflare/payments/`)
- **Modify** `src/index.ts` — checkout creates a SUBSCRIPTION (plan→product_id), webhook handles `subscription.*` events, new `/portal` route mints a customer-portal session. Remove the one-time top-up credit path.
- **Modify** `wrangler.toml` — replace `DODO_TOPUP_PRODUCTS` with `DODO_SUBSCRIPTION_PRODUCTS` (plan+interval → product_id).
- **Modify** `../shared/dodo.ts` — add `createSubscriptionCheckout()` and `createPortalSession()` (the existing `createCheckoutSession` HTTP shape is reused).
- **No change** `../shared/dodoWebhook.ts` — signature scheme identical for subscription events.

### Cloudflare pipeline worker (`backend/cloudflare/pipeline/`)
- **Modify** `src/index.ts` — replace the `balance_cents < cost` gate (STT + stream + LLM paths) with a subscription-entitlement gate; on success, accumulate fair-use usage (log only) instead of debiting.
- **Modify** `../shared/balance.ts` → entitlement read helper (rename/repurpose to `getEntitlement`), KV-cached like balance was.

### Desktop app (`desktop/`)
- **Modify** `src/paywall/Billing.tsx` — replace top-up tiers UI with the 2-tier subscription pricing + "Manage subscription" (portal) button.
- **Modify** `electron/payments-client.ts`, `electron/paywall-glue.ts`, `electron/preload-extensions.ts` — IPC: `createSubscriptionCheckout(plan, interval)` + `openCustomerPortal()`.
- **Modify** `electron/provider-router.ts` + `provider-router.test.ts` — remove `'byok'` from `EngineMode`/`Provider`; chain becomes Managed → Local.
- **Modify** `src/paywall/EngineSettings.tsx` — remove the BYOK option from the selector.
- **Modify** `electron/paywall-route.ts` — remove BYOK branch; managed-or-local only.
- **Modify** the paywall gating UI (where `INSUFFICIENT_BALANCE`/top-up was surfaced) → "subscribe" / "your subscription is inactive" states.

---

## Phasing & dependencies

- **Phase A (Tasks 1–3):** Supabase schema + RPCs. No app dependency. Tested with SQL.
- **Phase B (Tasks 4–6):** Remove BYOK (desktop). Independent of Dodo.
- **Phase C (Tasks 7–10):** Payments worker subscription checkout + webhook + portal. Needs Dodo product IDs (owner-supplied) only at deploy/test time, not to write code.
- **Phase D (Tasks 11–13):** Pipeline worker entitlement gating + fair-use accumulation.
- **Phase E (Tasks 14–17):** Desktop paywall UI (pricing, portal, inactive states), retire credits UI.
- **Phase F (Task 18):** Cutover checklist (live products, backup, existing-user comp) — owner-gated.

Each task: write/extend a test, see it fail, implement, see it pass, commit.

---

## Task 1: Subscriptions schema + denormalized profile columns

**Files:**
- Create: `backend/supabase/migrations/011_subscriptions.sql`
- Test: `backend/supabase/tests/011_subscriptions.test.sql` (pgTAP-style assertions run via `supabase db execute`)

- [ ] **Step 1: Write the failing test** (asserts table + columns + helper exist)

```sql
-- backend/supabase/tests/011_subscriptions.test.sql
-- Run: psql "$SUPABASE_DB_URL" -f backend/supabase/tests/011_subscriptions.test.sql
\set ON_ERROR_STOP on
-- subscriptions table exists with required columns
select 1/ (case when count(*) = 1 then 1 else 0 end)
from information_schema.tables where table_schema='public' and table_name='subscriptions';
-- profiles has denormalized entitlement columns
select 1/ (case when count(*) = 4 then 1 else 0 end)
from information_schema.columns where table_schema='public' and table_name='profiles'
  and column_name in ('sub_plan','sub_status','sub_period_end','dodo_customer_id');
-- entitlement() returns false for a random unknown user
select 1/ (case when public.entitlement('00000000-0000-0000-0000-000000000000'::uuid, 'dictation') = false then 1 else 0 end);
\echo 'OK 011'
```

- [ ] **Step 2: Run it against a local/shadow DB to verify it fails**

Run: `psql "$SHADOW_DB_URL" -f backend/supabase/tests/011_subscriptions.test.sql`
Expected: FAIL (division by zero — table/columns/function absent).

- [ ] **Step 3: Write the migration**

```sql
-- backend/supabase/migrations/011_subscriptions.sql
-- Subscription model: source-of-truth table + denormalized fast-read columns on profiles.

create table if not exists public.subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  dodo_subscription_id  text unique not null,
  dodo_customer_id      text,
  plan                  text not null check (plan in ('dictation','unmute')),
  interval              text not null check (interval in ('month','year')),
  status                text not null check (status in ('pending','active','on_hold','cancelled','failed','expired')),
  current_period_end    timestamptz,
  product_id            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on public.subscriptions(user_id, updated_at desc);

-- Idempotency ledger for webhook events (replaces per-payment provider_event_id dedupe).
create table if not exists public.processed_events (
  provider_event_id text primary key,
  processed_at      timestamptz not null default now()
);

-- Denormalized entitlement onto profiles for cheap edge reads (mirrors old balance_cents pattern).
alter table public.profiles add column if not exists sub_plan         text   not null default 'none' check (sub_plan in ('none','dictation','unmute'));
alter table public.profiles add column if not exists sub_status       text   not null default 'inactive';
alter table public.profiles add column if not exists sub_period_end   timestamptz;
alter table public.profiles add column if not exists dodo_customer_id text;

-- Entitlement helper: active sub whose period covers now AND whose plan includes the feature.
-- feature: 'dictation' (any paid plan) | 'remote' (only 'unmute').
create or replace function public.entitlement(p_user_id uuid, p_feature text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user_id
      and p.sub_status = 'active'
      and (p.sub_period_end is null or p.sub_period_end > now())
      and (
        (p_feature = 'dictation' and p.sub_plan in ('dictation','unmute')) or
        (p_feature = 'remote'    and p.sub_plan = 'unmute')
      )
  );
$$;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `psql "$SHADOW_DB_URL" -f backend/supabase/migrations/011_subscriptions.sql && psql "$SHADOW_DB_URL" -f backend/supabase/tests/011_subscriptions.test.sql`
Expected: `OK 011`.

- [ ] **Step 5: Commit**

```bash
git add backend/supabase/migrations/011_subscriptions.sql backend/supabase/tests/011_subscriptions.test.sql
git commit -m "feat(billing): subscriptions schema + entitlement helper"
```

---

## Task 2: process_subscription_event RPC (idempotent webhook upsert)

**Files:**
- Modify: `backend/supabase/migrations/011_subscriptions.sql` (append the RPC)
- Test: `backend/supabase/tests/011b_process_event.test.sql`

- [ ] **Step 1: Write the failing test**

```sql
-- backend/supabase/tests/011b_process_event.test.sql
\set ON_ERROR_STOP on
-- seed a profile
insert into public.profiles (id, email) values ('11111111-1111-1111-1111-111111111111','t@e.com')
  on conflict (id) do nothing;
-- first event: activate
select public.process_subscription_event(
  'evt_1','sub_1','cus_1','11111111-1111-1111-1111-111111111111'::uuid,
  'unmute','month','active', now() + interval '30 days', 'pdt_x');
-- entitlement now true for remote
select 1/(case when public.entitlement('11111111-1111-1111-1111-111111111111'::uuid,'remote') then 1 else 0 end);
-- replay same event id: no error, no duplicate row
select public.process_subscription_event(
  'evt_1','sub_1','cus_1','11111111-1111-1111-1111-111111111111'::uuid,
  'unmute','month','active', now() + interval '30 days', 'pdt_x');
select 1/(case when (select count(*) from public.subscriptions where dodo_subscription_id='sub_1')=1 then 1 else 0 end);
\echo 'OK 011b'
```

- [ ] **Step 2: Run to verify it fails**

Run: `psql "$SHADOW_DB_URL" -f backend/supabase/tests/011b_process_event.test.sql`
Expected: FAIL (function `process_subscription_event` does not exist).

- [ ] **Step 3: Append the RPC to the migration**

```sql
-- append to backend/supabase/migrations/011_subscriptions.sql
-- Idempotent on provider_event_id. Upserts the subscription row AND the denormalized
-- profile columns in one transaction. Maps Dodo status → our sub_status/sub_plan.
create or replace function public.process_subscription_event(
  p_event_id        text,
  p_subscription_id text,
  p_customer_id     text,
  p_user_id         uuid,
  p_plan            text,
  p_interval        text,
  p_status          text,
  p_period_end      timestamptz,
  p_product_id      text
) returns void language plpgsql security definer as $$
declare
  v_active boolean := (p_status = 'active');
begin
  -- Dedupe: first writer wins; replays are no-ops.
  insert into public.processed_events(provider_event_id) values (p_event_id)
  on conflict (provider_event_id) do nothing;
  if not found then return; end if;

  insert into public.subscriptions(
    user_id, dodo_subscription_id, dodo_customer_id, plan, interval, status, current_period_end, product_id, updated_at)
  values (p_user_id, p_subscription_id, p_customer_id, p_plan, p_interval, p_status, p_period_end, p_product_id, now())
  on conflict (dodo_subscription_id) do update set
    status = excluded.status,
    plan = excluded.plan,
    interval = excluded.interval,
    current_period_end = excluded.current_period_end,
    dodo_customer_id = coalesce(excluded.dodo_customer_id, public.subscriptions.dodo_customer_id),
    updated_at = now();

  -- Denormalize onto profiles. Inactive states collapse sub_plan→'none' so entitlement() is false.
  update public.profiles set
    sub_plan = case when v_active then p_plan else 'none' end,
    sub_status = case when v_active then 'active' else p_status end,
    sub_period_end = p_period_end,
    dodo_customer_id = coalesce(p_customer_id, dodo_customer_id)
  where id = p_user_id;
end;
$$;
```

- [ ] **Step 4: Run to verify it passes**

Run: `psql "$SHADOW_DB_URL" -f backend/supabase/migrations/011_subscriptions.sql && psql "$SHADOW_DB_URL" -f backend/supabase/tests/011b_process_event.test.sql`
Expected: `OK 011b`.

- [ ] **Step 5: Commit**

```bash
git add backend/supabase/migrations/011_subscriptions.sql backend/supabase/tests/011b_process_event.test.sql
git commit -m "feat(billing): idempotent process_subscription_event RPC"
```

---

## Task 3: Retire the pay-per-use reconcile cron

**Files:**
- Create: `backend/supabase/migrations/012_retire_payperuse.sql`
- Test: `backend/supabase/tests/012_retire.test.sql`

- [ ] **Step 1: Write the failing test** (asserts the cron job is gone)

```sql
-- backend/supabase/tests/012_retire.test.sql
\set ON_ERROR_STOP on
select 1/(case when count(*) = 0 then 1 else 0 end)
from cron.job where jobname = 'reconcile-balances';
\echo 'OK 012'
```

- [ ] **Step 2: Run to verify it fails** (cron still scheduled from migration 010)

Run: `psql "$SHADOW_DB_URL" -f backend/supabase/tests/012_retire.test.sql`
Expected: FAIL.

- [ ] **Step 3: Write the migration**

```sql
-- backend/supabase/migrations/012_retire_payperuse.sql
-- Stop deriving debits from usage. Balance columns/tables are KEPT for history,
-- but the reconcile loop that mutated balances is removed (subscriptions gate access now).
do $$ begin
  perform cron.unschedule('reconcile-balances');
exception when others then null; end $$;
```

- [ ] **Step 4: Run to verify it passes**

Run: `psql "$SHADOW_DB_URL" -f backend/supabase/migrations/012_retire_payperuse.sql && psql "$SHADOW_DB_URL" -f backend/supabase/tests/012_retire.test.sql`
Expected: `OK 012`.

- [ ] **Step 5: Commit**

```bash
git add backend/supabase/migrations/012_retire_payperuse.sql backend/supabase/tests/012_retire.test.sql
git commit -m "chore(billing): retire pay-per-use reconcile cron"
```

---

## Task 4: Remove BYOK from the provider router (types + chain)

**Files:**
- Modify: `desktop/electron/provider-router.ts`
- Test: `desktop/electron/provider-router.test.ts`

- [ ] **Step 1: Update the test to assert Managed→Local only (no byok)**

```typescript
// provider-router.test.ts — replace BYOK cases
import { pickProvider } from './provider-router'
test('auto: managed when signed in, else local — never byok', () => {
  expect(pickProvider({ signedIn: true,  localReady: true }, 'auto')).toBe('managed')
  expect(pickProvider({ signedIn: false, localReady: true }, 'auto')).toBe('local')
})
test('managed mode requires sign-in, no fallback', () => {
  expect(pickProvider({ signedIn: true,  localReady: true }, 'managed')).toBe('managed')
  expect(pickProvider({ signedIn: false, localReady: true }, 'managed')).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop && npx vitest run electron/provider-router.test.ts`
Expected: FAIL (type `'byok'` still referenced; `ProviderState.byokKeySet` removed).

- [ ] **Step 3: Edit `provider-router.ts`**

```typescript
// provider-router.ts — narrowed types + chain
export type EngineMode = 'auto' | 'managed' | 'local'
export type Provider   = 'managed' | 'local'

export interface ProviderState {
  signedIn: boolean
  localReady: boolean
}

// Managed → Local. No BYOK.
export function pickProvider(state: ProviderState, mode: EngineMode): Provider | null {
  if (mode === 'managed') return state.signedIn ? 'managed' : null
  if (mode === 'local')   return state.localReady ? 'local' : null
  // auto
  if (state.signedIn) return 'managed'
  return state.localReady ? 'local' : null
}
```
Delete `InvalidByokKeyError`, `byokKeySet`, and any `'byok'` branch in this file.

- [ ] **Step 4: Run to verify it passes**

Run: `cd desktop && npx vitest run electron/provider-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/provider-router.ts desktop/electron/provider-router.test.ts
git commit -m "refactor(engine): drop BYOK — provider chain is Managed then Local"
```

---

## Task 5: Remove BYOK callers (route + key reads)

**Files:**
- Modify: `desktop/electron/paywall-route.ts`

- [ ] **Step 1: Find every BYOK reference**

Run: `cd desktop && grep -rn "byok\|Byok\|BYOK\|byokKeySet\|InvalidByokKey" electron/ src/ | grep -v node_modules`
Expected: a finite list (paywall-route.ts, EngineSettings.tsx handled in Task 6).

- [ ] **Step 2: Edit `paywall-route.ts`** — remove the `'byok'` branch so routing is managed-or-local. Replace any `tryByokSTT/LLM` call sites with the local fallback that already exists. (Show the concrete diff during execution; the branch is the `case 'byok':` / `provider === 'byok'` block.)

- [ ] **Step 3: Typecheck**

Run: `cd desktop && npx tsc -p tsconfig.node.json --noEmit`
Expected: zero new errors referencing `byok`.

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/paywall-route.ts
git commit -m "refactor(engine): remove BYOK routing branch"
```

---

## Task 6: Remove the BYOK option from Engine settings UI

**Files:**
- Modify: `desktop/src/paywall/EngineSettings.tsx`

- [ ] **Step 1: Edit the selector** — delete the `{ value: 'byok', ... }` option and its description; update the Auto description to "Picks the best available — Managed → Local".
- [ ] **Step 2: Remove any BYOK key-entry input + its handlers** in this component.
- [ ] **Step 3: Typecheck + lint**

Run: `cd desktop && npx tsc -p tsconfig.node.json --noEmit`
Expected: no `byok` references remain (`grep -rn byok src/ electron/` returns nothing).

- [ ] **Step 4: Commit**

```bash
git add desktop/src/paywall/EngineSettings.tsx
git commit -m "refactor(ui): remove BYOK from engine settings"
```

---

## Task 7: wrangler config — subscription products map

**Files:**
- Modify: `backend/cloudflare/payments/wrangler.toml`

- [ ] **Step 1: Replace `DODO_TOPUP_PRODUCTS`** with a plan+interval map (IDs are placeholders until the owner creates products; documented as such):

```toml
# plan:interval → Dodo subscription product_id. Fill real IDs at cutover (Task 18).
DODO_SUBSCRIPTION_PRODUCTS = '{"dictation:month":"REPLACE_dict_m","dictation:year":"REPLACE_dict_y","unmute:month":"REPLACE_unmute_m","unmute:year":"REPLACE_unmute_y"}'
```

- [ ] **Step 2: Commit**

```bash
git add backend/cloudflare/payments/wrangler.toml
git commit -m "config(payments): subscription products map (IDs pending)"
```

---

## Task 8: Dodo subscription checkout + portal helpers

**Files:**
- Modify: `backend/cloudflare/shared/dodo.ts`
- Test: `backend/cloudflare/shared/dodo.test.ts`

- [ ] **Step 1: Write failing tests** for `createSubscriptionCheckout` (correct body) and `createPortalSession` (correct URL), mocking `fetch`.

```typescript
// dodo.test.ts (additions)
import { createSubscriptionCheckout, createPortalSession } from './dodo'
test('subscription checkout posts product_cart + metadata.user_id', async () => {
  const calls: any[] = []
  const fetchMock = async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ checkout_url: 'https://x' }), { status: 200 }) }
  const r = await createSubscriptionCheckout({ apiBase: 'https://live.dodopayments.com', apiKey: 'k', productId: 'pdt_1', userId: 'u1', email: 'a@b.com', returnUrl: 'app://r' }, fetchMock as any)
  expect(calls[0].url).toContain('/checkouts')
  expect(calls[0].body.product_cart[0].product_id).toBe('pdt_1')
  expect(calls[0].body.metadata.user_id).toBe('u1')
  expect(r.checkoutUrl).toBe('https://x')
})
test('portal session hits customer-portal endpoint with customer id', async () => {
  const calls: any[] = []
  const fetchMock = async (url: string, init: any) => { calls.push({ url }); return new Response(JSON.stringify({ link: 'https://portal' }), { status: 200 }) }
  const r = await createPortalSession({ apiBase: 'https://live.dodopayments.com', apiKey: 'k', customerId: 'cus_1' }, fetchMock as any)
  expect(calls[0].url).toContain('/customers/cus_1/customer-portal/session')
  expect(r.portalUrl).toBe('https://portal')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend/cloudflare && npx vitest run shared/dodo.test.ts`
Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement in `dodo.ts`** (reusing the existing auth/header pattern of `createCheckoutSession`)

```typescript
// dodo.ts (additions)
type Fetch = typeof fetch
export async function createSubscriptionCheckout(
  a: { apiBase: string; apiKey: string; productId: string; userId: string; email: string; returnUrl: string },
  f: Fetch = fetch,
): Promise<{ checkoutUrl: string }> {
  const res = await f(`${a.apiBase}/checkouts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${a.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_cart: [{ product_id: a.productId, quantity: 1 }],
      customer: { email: a.email },
      metadata: { user_id: a.userId },
      return_url: a.returnUrl,
    }),
  })
  if (!res.ok) throw new Error(`dodo checkout ${res.status}: ${await res.text()}`)
  const j = await res.json() as { checkout_url?: string; payment_link?: string }
  return { checkoutUrl: j.checkout_url ?? j.payment_link ?? '' }
}

export async function createPortalSession(
  a: { apiBase: string; apiKey: string; customerId: string },
  f: Fetch = fetch,
): Promise<{ portalUrl: string }> {
  const res = await f(`${a.apiBase}/customers/${a.customerId}/customer-portal/session`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${a.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error(`dodo portal ${res.status}: ${await res.text()}`)
  const j = await res.json() as { link?: string; url?: string }
  return { portalUrl: j.link ?? j.url ?? '' }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend/cloudflare && npx vitest run shared/dodo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/cloudflare/shared/dodo.ts backend/cloudflare/shared/dodo.test.ts
git commit -m "feat(payments): Dodo subscription checkout + portal helpers"
```

---

## Task 9: Payments worker — subscription checkout + portal routes

**Files:**
- Modify: `backend/cloudflare/payments/src/index.ts`
- Test: `backend/cloudflare/payments/src/index.test.ts`

- [ ] **Step 1: Write failing tests** — `POST /checkout/subscription {plan,interval}` returns a checkout URL for a known plan and 400 for an unknown plan; `POST /portal` mints a portal URL when the user has a `dodo_customer_id`.
- [ ] **Step 2: Run to verify it fails.** Run: `cd backend/cloudflare && npx vitest run payments/src/index.test.ts` → FAIL.
- [ ] **Step 3: Implement** — parse `DODO_SUBSCRIPTION_PRODUCTS`, map `${plan}:${interval}` → product_id, call `createSubscriptionCheckout`; add `/portal` reading the user's `dodo_customer_id` from Supabase then `createPortalSession`. Remove the `amount_cents`→top-up product path.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit**

```bash
git add backend/cloudflare/payments/src/index.ts backend/cloudflare/payments/src/index.test.ts
git commit -m "feat(payments): subscription checkout + customer-portal routes"
```

---

## Task 10: Payments worker — subscription webhook handling

**Files:**
- Modify: `backend/cloudflare/payments/src/index.ts`
- Test: `backend/cloudflare/payments/src/index.test.ts`

- [ ] **Step 1: Write failing tests** — a verified `subscription.active` event calls `process_subscription_event` with `status='active'` and the right plan (derived from `product_id`); `subscription.cancelled`/`on_hold`/`expired` pass their status through; an unknown/`payment.succeeded` (renewal) event is ACK'd 200 without double-crediting; a replayed `webhook-id` is a no-op.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** the dispatch:

```typescript
// index.ts — webhook dispatch (sketch; signature verification unchanged)
const evt = verified.body
const type = evt.type as string
if (type.startsWith('subscription.')) {
  const d = evt.data
  const plan = productIdToPlan(env, d.product_id)        // reverse-map via DODO_SUBSCRIPTION_PRODUCTS
  const interval = productIdToInterval(env, d.product_id)
  await rpc(env, 'process_subscription_event', {
    p_event_id: headers.get('webhook-id'),
    p_subscription_id: d.subscription_id,
    p_customer_id: d.customer?.customer_id ?? null,
    p_user_id: d.metadata?.user_id,
    p_plan: plan,
    p_interval: interval,
    p_status: d.status,                                   // pending|active|on_hold|cancelled|failed|expired
    p_period_end: d.next_billing_date ?? null,
    p_product_id: d.product_id,
  })
}
return new Response('ok', { status: 200 })                // ACK everything else (incl. renewal payment.*)
```

- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit**

```bash
git add backend/cloudflare/payments/src/index.ts backend/cloudflare/payments/src/index.test.ts
git commit -m "feat(payments): handle Dodo subscription.* webhooks idempotently"
```

---

## Task 11: Pipeline entitlement read helper (KV-cached)

**Files:**
- Modify: `backend/cloudflare/shared/balance.ts` (add `getEntitlement`)
- Test: `backend/cloudflare/shared/balance.test.ts`

- [ ] **Step 1: Write failing test** — `getEntitlement(env, userId)` returns `{plan, status, periodEnd}` from KV when present, falls back to Supabase `profiles` on miss, and caches.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** `getEntitlement` mirroring `getBalance`'s KV+Supabase pattern, reading `sub_plan,sub_status,sub_period_end`. Add `setEntitlement` for webhook-side cache priming.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit**

```bash
git add backend/cloudflare/shared/balance.ts backend/cloudflare/shared/balance.test.ts
git commit -m "feat(pipeline): KV-cached subscription entitlement read"
```

---

## Task 12: Pipeline — replace balance gate with entitlement gate

**Files:**
- Modify: `backend/cloudflare/pipeline/src/index.ts`
- Test: `backend/cloudflare/pipeline/src/index.test.ts`

- [ ] **Step 1: Write failing tests** — STT/stream request with `sub_status='active'` + plan in (`dictation`,`unmute`) → allowed; inactive/expired → `402 SUBSCRIPTION_INACTIVE` with `{subscribe_url}`; an LLM/Remote request requires plan `unmute` else `403 UPGRADE_REQUIRED`.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** — replace the three `getBalance`/`estimateMaxCostCents`/`balance_cents < cost` blocks (STT ~line 198, stream ~line 334, LLM ~line 498) with `getEntitlement` checks:

```typescript
const ent = await getEntitlement(env, userId)
const active = ent.status === 'active' && (!ent.periodEnd || ent.periodEnd > Date.now())
if (!active) return err('SUBSCRIPTION_INACTIVE', 'Subscription required', 402, { subscribe_url: SUBSCRIBE_URL })
// Remote/LLM path only:
if (isRemote && ent.plan !== 'unmute') return err('UPGRADE_REQUIRED', 'Upgrade to Unmute for Remote', 403, { subscribe_url: SUBSCRIBE_URL })
```
Remove the optimistic debit (`setBalance(balanceAfter)`) — there is no per-call charge now.

- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit**

```bash
git add backend/cloudflare/pipeline/src/index.ts backend/cloudflare/pipeline/src/index.test.ts
git commit -m "feat(pipeline): gate on subscription entitlement, not balance"
```

---

## Task 13: Fair-use accumulation (soft, notify-only)

**Files:**
- Create: `backend/supabase/migrations/013_fair_use.sql`
- Modify: `backend/cloudflare/pipeline/src/index.ts`
- Test: `backend/supabase/tests/013_fair_use.test.sql`, `backend/cloudflare/pipeline/src/index.test.ts`

- [ ] **Step 1: Write failing test** — `fair_use_config` singleton exists with a hidden monthly cap (default `monthly_seconds = 360000` = 100 hours of dictation/user/month — generous, anti-abuse only); `over_fair_use(user_id)` returns false under cap, true over.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** `013_fair_use.sql`:

```sql
create table if not exists public.fair_use_config (
  id int primary key default 1 check (id = 1),
  monthly_seconds int not null default 360000  -- hidden; ~100h dictation/mo. Tune later.
);
insert into public.fair_use_config(id) values (1) on conflict do nothing;

create or replace function public.over_fair_use(p_user_id uuid) returns boolean
language sql stable as $$
  select coalesce(sum(audio_duration_seconds),0) >= (select monthly_seconds from public.fair_use_config where id=1)
  from public.usage_logs
  where user_id = p_user_id and created_at >= date_trunc('month', now());
$$;
```
In the pipeline worker, after a successful STT call, keep logging usage to `usage_logs` (already happens via `logUsageDurable`). Add a **non-blocking** check: if `over_fair_use` (read from the cached entitlement payload, refreshed hourly), set a response header `x-unmute-fair-use: notify` — the app shows a soft heads-up. **Never** return an error for this.

- [ ] **Step 4: Run to verify it passes** → PASS (SQL test + a worker test asserting over-cap sets the header but still 200s).
- [ ] **Step 5: Commit**

```bash
git add backend/supabase/migrations/013_fair_use.sql backend/cloudflare/pipeline/src/index.ts backend/cloudflare/pipeline/src/index.test.ts
git commit -m "feat(billing): hidden soft fair-use cap (notify-only)"
```

---

## Task 14: Desktop IPC — subscription checkout + portal

**Files:**
- Modify: `desktop/electron/payments-client.ts`, `desktop/electron/paywall-glue.ts`, `desktop/electron/preload-extensions.ts`

- [ ] **Step 1:** In `payments-client.ts` replace `createCheckout(amountCents)` with `createSubscriptionCheckout(plan, interval)` (POST `/checkout/subscription`) and add `openCustomerPortal()` (POST `/portal` → returns URL).
- [ ] **Step 2:** In `paywall-glue.ts` replace the `paywall:create-checkout` IPC handler with `paywall:create-subscription` + `paywall:open-portal`.
- [ ] **Step 3:** In `preload-extensions.ts` expose `paywallCreateSubscription(plan, interval)` and `paywallOpenPortal()`.
- [ ] **Step 4: Typecheck**. Run: `cd desktop && npx tsc -p tsconfig.node.json --noEmit` → no errors.
- [ ] **Step 5: Commit**

```bash
git add desktop/electron/payments-client.ts desktop/electron/paywall-glue.ts desktop/electron/preload-extensions.ts
git commit -m "feat(desktop): subscription checkout + portal IPC"
```

---

## Task 15: Desktop Billing UI — two-tier pricing

**Files:**
- Modify: `desktop/src/paywall/Billing.tsx`

- [ ] **Step 1:** Replace `TIERS_CENTS` top-up grid with the two subscription cards (Dictation / Unmute), a monthly⇄annual toggle, struck-through anchors (~~$11.99~~ / ~~$17.99~~), and a "Subscribe" button calling `paywallCreateSubscription(plan, interval)`.
- [ ] **Step 2:** Add a "Manage subscription" button (visible when the user has any subscription) calling `paywallOpenPortal()`.
- [ ] **Step 3:** Keep the existing return-bounce poll, but poll subscription status (active) instead of payment status.
- [ ] **Step 4: Typecheck** → clean.
- [ ] **Step 5: Commit**

```bash
git add desktop/src/paywall/Billing.tsx
git commit -m "feat(desktop): two-tier subscription pricing UI"
```

---

## Task 16: Paywall states — subscribe / inactive / upgrade

**Files:**
- Modify: the components that handled `INSUFFICIENT_BALANCE`/top-up (grep: `cd desktop && grep -rn "INSUFFICIENT_BALANCE\|top.?up\|balance_cents" src/ electron/ | grep -v node_modules`)

- [ ] **Step 1:** Map the new pipeline errors to UI: `SUBSCRIPTION_INACTIVE` → "Subscribe to use Unmute" screen; `UPGRADE_REQUIRED` → "Upgrade to Unmute for Remote" one-tap; remove all "out of credits / top up" copy.
- [ ] **Step 2:** Surface the `x-unmute-fair-use: notify` header as a soft, dismissible toast ("You're a power user — heads up"). Never blocks.
- [ ] **Step 3: Typecheck** → clean; `grep` shows no remaining `balance_cents`/top-up UI copy.
- [ ] **Step 4: Commit**

```bash
git add -A desktop/src desktop/electron
git commit -m "feat(desktop): subscription paywall states, retire credits UI"
```

---

## Task 17: Remove dead pay-per-use desktop code

**Files:**
- Modify/Delete: balance polling + top-up client code no longer referenced (e.g. `desktop/electron/balance-ipc.ts` if unused after Task 16).

- [ ] **Step 1:** `cd desktop && grep -rn "balance" electron/ src/ | grep -v node_modules` — delete now-dead modules/handlers; keep `/v1/me` only if it still serves subscription status (repurpose to return `sub_*`).
- [ ] **Step 2: Build the engine** to confirm nothing breaks: `cd desktop && ./build/wire-into-engine.sh compile` → succeeds.
- [ ] **Step 3: Commit**

```bash
git add -A desktop
git commit -m "chore(desktop): remove dead pay-per-use balance code"
```

---

## Task 18: Cutover checklist (owner-gated — NOT auto-run)

**Files:**
- Create: `docs/superpowers/plans/2026-06-23-subscription-cutover-checklist.md`

This task produces a checklist, not code. It must be executed by the owner with explicit go-ahead, because it touches LIVE Dodo + LIVE Supabase.

- [ ] Resolve the **INR ₹15k mandate** question with Dodo (USD-billing fallback if blocked).
- [ ] Create the 4 **live subscription products** in Dodo; paste IDs into `DODO_SUBSCRIPTION_PRODUCTS`.
- [ ] Confirm the **webhook endpoint** is subscribed to `subscription.*` events in the Dodo dashboard; verify `DODO_WEBHOOK_SECRET`.
- [ ] **Back up** `profiles`, `subscriptions`, `wallet_ledger`, `topups` (your standing rule) before applying migrations 011–013 to prod.
- [ ] Apply migrations 011–013 to prod (via `mcp apply_migration`, post-backup).
- [ ] Deploy payments + pipeline workers.
- [ ] **Comp aashish** a month: insert a manual `subscriptions` row (`plan='dictation'`, `status='active'`, `current_period_end = now()+30d`) + denormalize onto his profile.
- [ ] Smoke test: subscribe (test mode) → webhook → entitlement true → dictation works → portal cancel → `expired` → access locked.
- [ ] Lock down **RLS** on `billing_config` + backup tables (separate security item flagged earlier).

- [ ] **Commit** the checklist doc.

---

## Self-Review

**Spec coverage:** tiers/pricing → Tasks 7,15; hard paywall (no trial) → Task 12 (402 when inactive) + products `trial_period_days=0` (Task 18); remove pay-per-use → Tasks 3,12,17; remove BYOK → Tasks 4–6; cancellation via portal → Tasks 8,9,15; failed/lapsed → Task 10 (`on_hold`/`expired` → entitlement false); fair-use hidden soft cap → Task 13; existing-user comp → Task 18; entitlement gating → Tasks 11,12. All locked decisions map to a task. ✅

**Open dependency:** INR mandate (Task 18) — flagged, does not block code.

**Type consistency:** `EngineMode`/`Provider` (Task 4) used consistently in Tasks 5–6; `process_subscription_event` signature (Task 2) matches its caller (Task 10); `getEntitlement` shape `{plan,status,periodEnd}` (Task 11) matches its use (Task 12); `sub_plan`/`sub_status`/`sub_period_end` consistent across Tasks 1,2,11,12. ✅

**Placeholder scan:** Dodo product IDs are intentionally `REPLACE_*` (owner-supplied at cutover, Task 18) — the only deliberate placeholders, documented as such. No "TBD/handle edge cases" steps. ✅
