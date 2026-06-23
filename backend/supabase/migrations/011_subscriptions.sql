-- ============================================================
-- Migration 011: subscription model (replaces pay-per-use credits)
-- ============================================================
-- We move from a prepaid wallet balance to flat recurring subscriptions
-- (Dictation / Unmute) billed via Dodo. Access is no longer "balance > 0";
-- it is "has an active subscription whose period covers now, and whose plan
-- includes the requested feature".
--
-- Design:
--   * public.subscriptions          — source of truth, fed by Dodo webhooks
--   * public.processed_events       — webhook idempotency ledger
--   * profiles.sub_*                — denormalized fast-read columns (the edge
--                                     worker reads these, exactly as it read
--                                     balance_cents before)
--   * entitlement(user, feature)    — the single gate
--   * process_subscription_event()  — idempotent upsert from the webhook
--
-- Balance columns / wallet_ledger / topups are KEPT for history; nothing here
-- deletes them. Forward-only, matching the existing billing philosophy.

-- ── Source-of-truth subscription table ────────────────────────────────
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

-- ── Webhook idempotency ledger (first writer wins; replays are no-ops) ──
create table if not exists public.processed_events (
  provider_event_id text primary key,
  processed_at      timestamptz not null default now()
);

-- ── Denormalized entitlement on profiles (cheap edge read) ─────────────
alter table public.profiles add column if not exists sub_plan         text        not null default 'none' check (sub_plan in ('none','dictation','unmute'));
alter table public.profiles add column if not exists sub_status       text        not null default 'inactive';
alter table public.profiles add column if not exists sub_period_end   timestamptz;
alter table public.profiles add column if not exists dodo_customer_id text;

-- ── The single entitlement gate ────────────────────────────────────────
-- feature: 'dictation' (any paid plan) | 'remote' (only the 'unmute' plan).
create or replace function public.entitlement(p_user_id uuid, p_feature text)
returns boolean language sql stable set search_path = public as $$
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

-- ── Idempotent webhook handler: upsert subscription + denormalize ──────
-- Called by the payments worker on every Dodo subscription.* event. Maps the
-- Dodo status through; only an 'active' status grants entitlement (inactive
-- states collapse sub_plan -> 'none' so entitlement() returns false).
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
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_active boolean := (p_status = 'active');
begin
  -- Dedupe on the Dodo event id (webhook-id). Replays short-circuit.
  insert into public.processed_events(provider_event_id) values (p_event_id)
  on conflict (provider_event_id) do nothing;
  if not found then return; end if;

  insert into public.subscriptions(
    user_id, dodo_subscription_id, dodo_customer_id, plan, interval, status, current_period_end, product_id, updated_at)
  values (p_user_id, p_subscription_id, p_customer_id, p_plan, p_interval, p_status, p_period_end, p_product_id, now())
  on conflict (dodo_subscription_id) do update set
    status             = excluded.status,
    plan               = excluded.plan,
    interval           = excluded.interval,
    current_period_end = excluded.current_period_end,
    dodo_customer_id   = coalesce(excluded.dodo_customer_id, public.subscriptions.dodo_customer_id),
    updated_at         = now();

  update public.profiles set
    sub_plan         = case when v_active then p_plan else 'none' end,
    sub_status       = case when v_active then 'active' else p_status end,
    sub_period_end   = p_period_end,
    dodo_customer_id = coalesce(p_customer_id, dodo_customer_id)
  where id = p_user_id;
end;
$$;
