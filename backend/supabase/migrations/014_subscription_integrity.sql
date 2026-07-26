-- ============================================================
-- Migration 014: subscription integrity — derive, don't assign
-- ============================================================
-- Fixes a class of bug where a user's entitlement was decided by whichever
-- webhook fired last, rather than by what the user actually holds.
--
-- Observed failure (2026-07-24): a user held an ACTIVE 'unmute' subscription
-- (paid through 2026-08-23) and a stale 'dictation' subscription that went
-- 'on_hold'. The on_hold event arrived second and overwrote profiles.sub_*,
-- revoking a paying customer's access. Because processed_events dedupes by
-- event id, the good event could never replay to repair it — the profile
-- stayed wrong indefinitely.
--
-- Two changes:
--
--   1. process_subscription_event() no longer ASSIGNS the profile from the
--      incoming event. It upserts that event's own subscription row, then
--      RECOMPUTES the profile from every row the user holds. An event about a
--      dead subscription can no longer speak for a live one.
--
--   2. entitlement() honours 'on_hold' while the paid-for period still covers
--      now(). Dodo puts a subscription 'on_hold' when a renewal charge fails
--      and retries for up to 30 days; it does NOT advance the billing date on
--      failure, and (per Dodo's docs) it never auto-cancels — an unrecovered
--      subscription stays 'on_hold' forever. So the grace MUST be bounded by
--      current_period_end: the customer keeps exactly what they paid for and
--      not a day more. A bounced card is not churn, but it is not a free tier
--      either.
--
-- Forward-only. Backfill at the bottom repairs every already-corrupted profile
-- rather than waiting for each account's next webhook.

-- ── Recompute a profile from the subscriptions the user actually holds ──
--
-- "Best" subscription = the one a fair reading of the account would pick:
--   1. active outranks on_hold
--   2. the richer plan outranks the lesser one ('unmute' > 'dictation')
--   3. the longest remaining runway wins
--
-- Rows that are cancelled / expired / failed, or whose period has lapsed, are
-- not candidates at all.
--
-- If nothing qualifies, sub_plan collapses to 'none' (entitlement() then
-- returns false regardless of status), but sub_status keeps the most recent
-- row's real status so the UI can say "your payment failed" instead of the
-- much colder "subscribe".
create or replace function public.refresh_subscription_profile(
  p_user_id     uuid,
  p_customer_id text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_best   public.subscriptions%rowtype;
  v_latest public.subscriptions%rowtype;
begin
  select s.* into v_best
  from public.subscriptions s
  where s.user_id = p_user_id
    and s.status in ('active', 'on_hold')
    -- 'active' may legitimately carry a null period end (lifetime / unbounded).
    -- 'on_hold' may not: an unbounded hold would be a permanent free tier.
    and (
      (s.status = 'active'  and (s.current_period_end is null or s.current_period_end > now())) or
      (s.status = 'on_hold' and s.current_period_end is not null and s.current_period_end > now())
    )
  order by
    (s.status = 'active') desc,
    (s.plan = 'unmute') desc,
    s.current_period_end desc nulls first
  limit 1;

  if found then
    update public.profiles set
      sub_plan         = v_best.plan,
      sub_status       = v_best.status,
      sub_period_end   = v_best.current_period_end,
      dodo_customer_id = coalesce(p_customer_id, v_best.dodo_customer_id, dodo_customer_id)
    where id = p_user_id;
    return;
  end if;

  -- Nothing live. Report the most recent row's status for messaging purposes.
  select s.* into v_latest
  from public.subscriptions s
  where s.user_id = p_user_id
  order by s.updated_at desc
  limit 1;

  update public.profiles set
    sub_plan         = 'none',
    sub_status       = coalesce(v_latest.status, 'inactive'),
    sub_period_end   = v_latest.current_period_end,
    dodo_customer_id = coalesce(p_customer_id, dodo_customer_id)
  where id = p_user_id;
end;
$$;

-- ── The entitlement gate ───────────────────────────────────────────────
-- feature: 'dictation' (any paid plan) | 'remote' (only the 'unmute' plan).
--
-- Grants on 'active', and on 'on_hold' while the paid period still covers now.
-- The redundant period check on the active branch is kept so a lapsed row can
-- never grant access through either path.
create or replace function public.entitlement(p_user_id uuid, p_feature text)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user_id
      and (
        (p.sub_status = 'active'  and (p.sub_period_end is null or p.sub_period_end > now())) or
        (p.sub_status = 'on_hold' and p.sub_period_end is not null and p.sub_period_end > now())
      )
      and (
        (p_feature = 'dictation' and p.sub_plan in ('dictation','unmute')) or
        (p_feature = 'remote'    and p.sub_plan = 'unmute')
      )
  );
$$;

-- ── Idempotent webhook handler ─────────────────────────────────────────
-- Upsert the subscription this event is about, then derive the profile from
-- the user's whole set. The event is authoritative about its OWN row and
-- nothing else — that is the entire fix.
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

  perform public.refresh_subscription_profile(p_user_id, p_customer_id);
end;
$$;

-- Duplicate detection lives in the payments worker (reconcileDuplicates), which
-- reads the same liveness rule over PostgREST. It is deliberately not a
-- function here: the worker needs the rows in order to call Dodo's cancel
-- endpoint, so a second SQL copy of the ranking would only be able to drift.

-- ── Backfill ───────────────────────────────────────────────────────────
-- Repair every profile that has ever had a subscription. Without this, an
-- account corrupted by the old assign-from-event logic stays broken until its
-- next webhook — and a cancelled or permanently-on_hold subscription may never
-- produce another one.
do $$
declare
  r record;
begin
  for r in select distinct user_id from public.subscriptions loop
    perform public.refresh_subscription_profile(r.user_id);
  end loop;
end;
$$;
