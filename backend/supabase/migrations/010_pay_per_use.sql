-- ============================================================
-- Migration 010: pay-per-use billing — NO per-event floor, cumulative 4x markup
-- ============================================================
-- Problem: usage_cost_cents floored EVERY event to 1 cent. A real dictation costs
-- ~0.05c of Groq, so every event billed the 1c minimum = ~18x the API cost. The
-- markup never even fired — the floor always won.
--
-- Goal (product principle: "charge only for what you use, affordable, no floor"):
-- bill ONLY actual usage x a configurable markup, with NO per-event minimum.
--
-- Policy decided with the owner: FORWARD-ONLY. We do NOT refund or touch any past
-- charges (already-deducted amounts stay as-is). We start the new model fresh from
-- NOW: advance the baseline, and count both usage and usage-debits only AFTER it.
--
-- How (cumulative): a user's usage charge SINCE the baseline =
--   floor( sum(raw Groq cost since baseline) * markup * 100 )  cents
-- sub-cent events accrue until the running total crosses a whole cent (the only
-- rounding is that final whole-cent floor — wallets can't hold fractional cents).
-- Usage is monotonic, so reconcile only ever tops the debit up to the target.

-- ── Configurable markup (was hardcoded 2.0 inside usage_cost_cents) ────
-- Change pricing any time with:  update public.billing_config set markup = 3;
alter table public.billing_config add column if not exists markup numeric not null default 4.0;

-- ── Cumulative reconcile, scoped to POST-baseline (forward-only) ───────
-- cur counts ONLY usage debits created since the baseline, so pre-baseline
-- charges (the old floored ones) are ignored and can't net against new usage.
create or replace function public.reconcile_balances()
returns table(usage_topped_up_cents int, users_reprojected int)
language plpgsql security definer set search_path = public as $$
declare v_baseline timestamptz; v_markup numeric; v_topped int := 0;
begin
  select baseline_ts, markup into v_baseline, v_markup from public.billing_config where id = 1;

  with tgt as (
    -- what each user SHOULD have paid for usage SINCE the baseline (no per-event floor)
    select ul.user_id,
           floor(sum(coalesce(ul.estimated_cost, 0)) * v_markup * 100)::int as target_cents
    from public.usage_logs ul
    where ul.created_at >= v_baseline
    group by ul.user_id
  ),
  cur as (
    -- usage debits applied SINCE the baseline (pre-baseline charges excluded)
    select user_id, coalesce(sum(-delta_cents), 0)::int as charged_cents
    from public.wallet_ledger
    where source = 'usage' and created_at >= v_baseline
    group by user_id
  ),
  owe as (
    select t.user_id, t.target_cents - coalesce(c.charged_cents, 0) as d
    from tgt t left join cur c on c.user_id = t.user_id
  ),
  ins as (
    insert into public.wallet_ledger (user_id, delta_cents, source, metadata)
    select user_id, -d, 'usage', jsonb_build_object('via', 'reconcile-cumulative')
    from owe where d > 0
    returning delta_cents
  )
  select coalesce(sum(-delta_cents), 0)::int into v_topped from ins;

  update public.profiles p
     set balance_cents = coalesce(
       (select sum(delta_cents) from public.wallet_ledger wl where wl.user_id = p.id), 0);

  usage_topped_up_cents := v_topped;
  select count(*) into users_reprojected from public.profiles;
  return next;
end $$;

grant execute on function public.reconcile_balances to service_role;

-- ── Start fresh from NOW: forward-only. No deletes, no refunds — past charges
--    stay exactly as they are; only NEW usage (after this instant) bills under the
--    new no-floor 4x model. ──
update public.billing_config set baseline_ts = now() where id = 1;
