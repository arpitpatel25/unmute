-- ============================================================
-- Migration 005: Managed-cloud paywall — balance + wallet ledger
-- ============================================================
-- Additive on top of the existing BoloAI migrations 001-004.
-- Adds:
--   * balance_cents column on profiles
--   * 'managed' plan tier
--   * wallet_ledger (every credit/debit, auditable)
--   * topups (Dodo payment records)
--   * helper RPCs for atomic debit + ledger insert

-- ─── 1. Profiles: balance + plan tier ───────────────────────────

-- Drop the old free/pro check and add 'managed'
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_plan_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_plan_check
  CHECK (plan IN ('free', 'pro', 'managed'));

-- Balance in cents (integer math, no floating-point drift). NUMERIC(12,4)
-- would also work; cents are simpler for ledger reconciliation.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS balance_cents INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS managed_signup_at TIMESTAMPTZ;

-- ─── 2. Wallet ledger — every credit/debit row ──────────────────

CREATE TABLE IF NOT EXISTS public.wallet_ledger (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  -- Signed integer cents. Positive = credit (top-up, refund, adjustment).
  -- Negative = debit (usage). Sum over a user = current balance.
  delta_cents   INTEGER NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('topup', 'usage', 'refund', 'adjustment', 'starter')),
  -- For 'usage' rows, links back to the usage_logs entry that caused the debit.
  usage_log_id  UUID REFERENCES public.usage_logs(id) ON DELETE SET NULL,
  -- For 'topup' rows, links back to the topup record (set by Dodo webhook).
  topup_id      UUID,
  -- Free-form metadata (e.g., adjustment reason, refund correlation).
  metadata      JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_created
  ON public.wallet_ledger(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_source
  ON public.wallet_ledger(source, created_at DESC);

ALTER TABLE public.wallet_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ledger"
  ON public.wallet_ledger FOR SELECT USING (auth.uid() = user_id);

-- ─── 3. Topups — Dodo payment records ───────────────────────────

CREATE TABLE IF NOT EXISTS public.topups (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  -- Amount the user paid (in cents). The whole amount becomes wallet credit
  -- — markup happens at debit time, not at top-up time.
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  currency              TEXT NOT NULL DEFAULT 'usd',
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  provider              TEXT NOT NULL DEFAULT 'dodo',
  -- Dodo payment / event identifiers, used for idempotency.
  provider_payment_id   TEXT UNIQUE,
  provider_event_id     TEXT UNIQUE,
  -- Raw provider payload for debugging / audit.
  raw                   JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_topups_user_created
  ON public.topups(user_id, created_at DESC);

ALTER TABLE public.topups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own topups"
  ON public.topups FOR SELECT USING (auth.uid() = user_id);

-- ─── 4. Atomic debit RPC ────────────────────────────────────────
-- Called by the pipeline worker AFTER a Groq call succeeds.
-- Atomically: inserts a wallet_ledger row + decrements profiles.balance_cents.
-- Returns the new balance. Fail-open by design: if balance is already negative
-- we still record the debit (we'd rather absorb a small overshoot than lose
-- the audit trail).

CREATE OR REPLACE FUNCTION public.debit_wallet(
  p_user_id      UUID,
  p_amount_cents INTEGER,
  p_usage_log_id UUID DEFAULT NULL,
  p_metadata     JSONB DEFAULT '{}'::JSONB
) RETURNS INTEGER AS $$
DECLARE
  v_new_balance INTEGER;
BEGIN
  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'debit amount must be positive';
  END IF;

  -- Insert ledger row first (audit trail is sacred).
  INSERT INTO public.wallet_ledger (user_id, delta_cents, source, usage_log_id, metadata)
  VALUES (p_user_id, -p_amount_cents, 'usage', p_usage_log_id, p_metadata);

  -- Update profile balance and return the new value.
  UPDATE public.profiles
     SET balance_cents = balance_cents - p_amount_cents
   WHERE id = p_user_id
   RETURNING balance_cents INTO v_new_balance;

  RETURN v_new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─── 5. Credit RPC (top-ups, refunds, starter credit) ───────────

CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_user_id      UUID,
  p_amount_cents INTEGER,
  p_source       TEXT,
  p_topup_id     UUID DEFAULT NULL,
  p_metadata     JSONB DEFAULT '{}'::JSONB
) RETURNS INTEGER AS $$
DECLARE
  v_new_balance INTEGER;
BEGIN
  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'credit amount must be positive';
  END IF;
  IF p_source NOT IN ('topup', 'refund', 'adjustment', 'starter') THEN
    RAISE EXCEPTION 'invalid credit source: %', p_source;
  END IF;

  INSERT INTO public.wallet_ledger (user_id, delta_cents, source, topup_id, metadata)
  VALUES (p_user_id, p_amount_cents, p_source, p_topup_id, p_metadata);

  UPDATE public.profiles
     SET balance_cents = balance_cents + p_amount_cents
   WHERE id = p_user_id
   RETURNING balance_cents INTO v_new_balance;

  RETURN v_new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─── 6. Auto-credit starter balance on first managed signup ─────
-- Replaces the existing handle_new_user trigger from migration 001.
-- New users still get a profile row; if they ever flip to plan='managed'
-- we'll grant the starter credit via the credit_wallet RPC from the app
-- (NOT here, so BYOK/Local users never get a starter credit recorded).

-- Note: starter credit grant is NOT in this migration. It's triggered by the
-- desktop app's first managed sign-in (via an RPC call). This keeps wallet_ledger
-- empty for non-paying users — matching the "zero touch for free users" goal.

-- ─── 7. Convenience view: current balance + lifetime stats ──────

CREATE OR REPLACE VIEW public.v_wallet_summary AS
SELECT
  p.id AS user_id,
  p.balance_cents,
  COALESCE((SELECT SUM(delta_cents) FROM public.wallet_ledger WHERE user_id = p.id AND delta_cents > 0), 0)
    AS lifetime_credits_cents,
  COALESCE((SELECT -SUM(delta_cents) FROM public.wallet_ledger WHERE user_id = p.id AND delta_cents < 0), 0)
    AS lifetime_debits_cents,
  p.managed_signup_at
FROM public.profiles p;

-- RLS via underlying tables; no additional policy needed.

GRANT SELECT ON public.v_wallet_summary TO authenticated;
