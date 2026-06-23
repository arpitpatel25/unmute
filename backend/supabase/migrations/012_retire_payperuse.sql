-- ============================================================
-- Migration 012: retire the pay-per-use reconcile loop
-- ============================================================
-- Subscriptions gate access now (migration 011), so we stop deriving per-call
-- debits from usage. The reconcile cron (migration 010) is unscheduled.
--
-- We KEEP balance_cents, wallet_ledger, topups, billing_config, and the
-- reconcile_balances() function itself for history/forensics — only the
-- recurring job that mutated balances is removed. Forward-only; nothing here
-- changes any existing balance.

do $$ begin
  perform cron.unschedule('reconcile-balances');
exception when others then
  -- job may already be gone (idempotent re-run); ignore.
  null;
end $$;
