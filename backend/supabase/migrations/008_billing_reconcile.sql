-- ============================================================
-- Migration 008: Reconcilable balance — never lose a bill
-- ============================================================
-- Problem: the worker's `log_and_debit` ran fire-and-forget (ctx.waitUntil) and
-- recorded the usage + debit ATOMICALLY. ctx.waitUntil is best-effort (Cloudflare
-- can drop it), so a dropped call silently lost BOTH the usage record and the
-- debit — and a lost bill is unrecoverable (no trace to reconcile from). That is
-- exactly what happened: managed usage stopped being recorded/charged on
-- 2026-06-04 14:26 for every user, with no error surfaced.
--
-- Fix (two parts; the worker change is in backend/cloudflare/pipeline):
--   1. DECOUPLE: the worker records only the USAGE (the durable bill) via
--      `log_usage` — never the debit. Recording the bill is the thing we must
--      never lose; applying the charge can lag.
--   2. RECONCILE: a scheduled job derives the debit from the durable usage_logs
--      (idempotent via usage_log_id) and re-projects every balance from the
--      ledger. A missed/late record is recovered; balance is always correct.
--
-- Verified invariant (all 16 users, 0 drift): balance_cents == sum(wallet_ledger).
-- So balance is a clean PROJECTION of the durable ledger — reconcile just keeps
-- that projection exact and fills any gap.
--
-- Policy "start fresh from now": baseline = the moment this runs. All usage
-- BEFORE the baseline is forgiven (never charged); only NEW managed usage debits
-- going forward. Dry-run verified: 0 missing debits, 0 balances change on apply.
--
-- Latency: reconcile runs on a 2-minute cron, entirely off the dictation hot
-- path. Recording usage stays after-the-response in the worker. Zero impact on
-- dictation latency (the cost was never required to be instantaneous).

-- ── Forgiveness baseline ──────────────────────────────────────────────
create table if not exists public.billing_config (
  id          int primary key default 1,
  baseline_ts timestamptz not null default now(),
  constraint billing_config_singleton check (id = 1)
);
insert into public.billing_config (id) values (1) on conflict (id) do nothing;

-- ── Integer-cents cost (matches the worker: ceil, min 1 cent) ─────────
create or replace function public.usage_cost_cents(p_estimated_cost numeric)
returns int language sql immutable as $$
  select greatest(1, ceil(coalesce(p_estimated_cost, 0) * 100))::int
$$;

-- ── log_usage: record the BILL durably, NO debit (decoupled) ──────────
-- The worker calls this instead of log_and_debit. Recording the usage is the
-- thing that must never be lost; the debit is applied later by reconcile from
-- this durable row, so a failed/dropped debit is always recoverable.
create or replace function public.log_usage(
  p_user_id                UUID,
  p_call_type              TEXT,
  p_flow_type              TEXT,
  p_provider               TEXT,
  p_model                  TEXT,
  p_prompt_tokens          INTEGER,
  p_completion_tokens      INTEGER,
  p_audio_duration_seconds NUMERIC,
  p_estimated_cost         NUMERIC,
  p_latency_ms             INTEGER
) RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.usage_logs (
    user_id, call_type, flow_type, provider, model,
    prompt_tokens, completion_tokens, total_tokens,
    audio_duration_seconds, estimated_cost, latency_ms
  ) VALUES (
    p_user_id, p_call_type, p_flow_type, p_provider, p_model,
    COALESCE(p_prompt_tokens, 0), COALESCE(p_completion_tokens, 0),
    COALESCE(p_prompt_tokens, 0) + COALESCE(p_completion_tokens, 0),
    COALESCE(p_audio_duration_seconds, 0), COALESCE(p_estimated_cost, 0),
    COALESCE(p_latency_ms, 0)
  )
  RETURNING id;
$$;

GRANT EXECUTE ON FUNCTION public.log_usage TO service_role;

-- ── reconcile_balances: apply missing debits + re-project balances ────
-- For every billable usage_log AFTER the baseline with no ledger debit yet,
-- create the debit (idempotent via usage_log_id), then set every
-- balance_cents = sum(wallet_ledger). Safe to run repeatedly.
create or replace function public.reconcile_balances()
returns table(missing_debits_created int, users_reprojected int)
language plpgsql security definer set search_path = public as $$
declare v_baseline timestamptz; v_created int;
begin
  select baseline_ts into v_baseline from public.billing_config where id = 1;

  with ins as (
    insert into public.wallet_ledger (user_id, delta_cents, source, usage_log_id, metadata)
    select ul.user_id, -public.usage_cost_cents(ul.estimated_cost), 'usage', ul.id,
           jsonb_build_object('via', 'reconcile')
    from public.usage_logs ul
    where ul.created_at >= v_baseline
      and coalesce(ul.estimated_cost, 0) > 0
      and not exists (select 1 from public.wallet_ledger wl where wl.usage_log_id = ul.id)
    returning 1
  )
  select count(*) into v_created from ins;

  update public.profiles p
     set balance_cents = coalesce(
       (select sum(delta_cents) from public.wallet_ledger wl where wl.user_id = p.id), 0);

  missing_debits_created := v_created;
  select count(*) into users_reprojected from public.profiles;
  return next;
end $$;

GRANT EXECUTE ON FUNCTION public.reconcile_balances TO service_role;

-- ── Schedule: reconcile every 2 minutes (pg_cron) ─────────────────────
-- Background, off the hot path. Self-heals any missed/late debit within ~2 min.
select cron.schedule('reconcile-balances', '*/2 * * * *', $$ select public.reconcile_balances(); $$);
