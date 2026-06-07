-- ============================================================
-- Migration 007: Dodo webhook RPCs — atomic topup processing
-- ============================================================
-- Provides the single Postgres function the payments worker calls per
-- inbound payment.succeeded webhook. The function is:
--   * atomic            — topup insert + ledger insert + balance bump in one txn
--   * idempotent        — duplicate webhook events (Dodo retries up to 8x) are
--                          no-ops, signalled via is_duplicate=true return flag
--   * single round-trip — Worker → Supabase only once per webhook
--
-- The webhook handler dispatches by event type; this RPC handles only the
-- "succeeded → credit" path. Failed payments + refunds + disputes get
-- recorded with a smaller helper RPC (process_topup_terminal) that just
-- inserts a topup row in the matching status without touching balance.

-- ─── 1. process_topup_webhook ───────────────────────────────────
-- Inserts a succeeded topup + wallet_ledger row + bumps profiles.balance_cents.
-- On duplicate provider_event_id (Dodo retry), returns is_duplicate=true with
-- the EXISTING topup id and CURRENT balance — caller can safely 200-ACK.

CREATE OR REPLACE FUNCTION public.process_topup_webhook(
  p_event_id     TEXT,        -- webhook-id (dedupe key)
  p_payment_id   TEXT,        -- Dodo payment id (also UNIQUE on topups)
  p_user_id      UUID,
  p_amount_cents INTEGER,
  p_currency     TEXT,
  p_raw          JSONB DEFAULT '{}'::JSONB
) RETURNS TABLE (
  topup_id     UUID,
  new_balance  INTEGER,
  is_duplicate BOOLEAN
) AS $$
DECLARE
  v_topup_id UUID;
  v_balance  INTEGER;
BEGIN
  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'amount_cents must be positive (got %)', p_amount_cents;
  END IF;

  -- Atomic insert. If this exact event was already processed,
  -- ON CONFLICT skips the insert; v_topup_id stays NULL and we early-return.
  INSERT INTO public.topups (
    user_id, amount_cents, currency, status, provider,
    provider_payment_id, provider_event_id, raw
  ) VALUES (
    p_user_id, p_amount_cents, p_currency, 'succeeded', 'dodo',
    p_payment_id, p_event_id, p_raw
  )
  ON CONFLICT (provider_event_id) DO NOTHING
  RETURNING id INTO v_topup_id;

  IF v_topup_id IS NULL THEN
    SELECT id          INTO v_topup_id FROM public.topups   WHERE provider_event_id = p_event_id;
    SELECT balance_cents INTO v_balance FROM public.profiles WHERE id = p_user_id;
    RETURN QUERY SELECT v_topup_id, v_balance, TRUE;
    RETURN;
  END IF;

  -- Fresh topup: insert ledger row + bump balance.
  INSERT INTO public.wallet_ledger (user_id, delta_cents, source, topup_id)
  VALUES (p_user_id, p_amount_cents, 'topup', v_topup_id);

  UPDATE public.profiles
     SET balance_cents = balance_cents + p_amount_cents
   WHERE id = p_user_id
   RETURNING balance_cents INTO v_balance;

  RETURN QUERY SELECT v_topup_id, v_balance, FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.process_topup_webhook TO service_role;

-- ─── 2. process_topup_terminal ──────────────────────────────────
-- For non-credit events (payment.failed, refund.*, dispute.*). Records the
-- topup row at the matching status WITHOUT touching balance. Returns
-- is_duplicate=true on Dodo retries, same idempotency contract.
--
-- We still record failed/disputed events for audit + dispute investigation.

CREATE OR REPLACE FUNCTION public.process_topup_terminal(
  p_event_id     TEXT,
  p_payment_id   TEXT,
  p_user_id      UUID,
  p_amount_cents INTEGER,
  p_currency     TEXT,
  p_status       TEXT,
  p_raw          JSONB DEFAULT '{}'::JSONB
) RETURNS TABLE (topup_id UUID, is_duplicate BOOLEAN) AS $$
DECLARE
  v_topup_id UUID;
BEGIN
  IF p_status NOT IN ('failed', 'refunded') THEN
    RAISE EXCEPTION 'invalid terminal status: %', p_status;
  END IF;

  INSERT INTO public.topups (
    user_id, amount_cents, currency, status, provider,
    provider_payment_id, provider_event_id, raw
  ) VALUES (
    p_user_id, p_amount_cents, p_currency, p_status, 'dodo',
    p_payment_id, p_event_id, p_raw
  )
  ON CONFLICT (provider_event_id) DO NOTHING
  RETURNING id INTO v_topup_id;

  IF v_topup_id IS NULL THEN
    SELECT id INTO v_topup_id FROM public.topups WHERE provider_event_id = p_event_id;
    RETURN QUERY SELECT v_topup_id, TRUE;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_topup_id, FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.process_topup_terminal TO service_role;
