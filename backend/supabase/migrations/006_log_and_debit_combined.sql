-- ============================================================
-- Migration 006: Combine usage_log insert + wallet debit into one RPC
-- ============================================================
-- Before: pipeline worker fired two REST calls (insert usage_logs + debit_wallet
-- RPC) via ctx.waitUntil. Both were async but added up — two Supabase
-- round-trips. This rolls them into a single function call.

CREATE OR REPLACE FUNCTION public.log_and_debit(
  p_user_id              UUID,
  p_amount_cents         INTEGER,
  p_call_type            TEXT,          -- 'stt' | 'llm'
  p_flow_type            TEXT,          -- 'dictation' | 'transform' | ...
  p_provider             TEXT,
  p_model                TEXT,
  p_prompt_tokens        INTEGER,
  p_completion_tokens    INTEGER,
  p_audio_duration_seconds NUMERIC,
  p_estimated_cost       NUMERIC,
  p_latency_ms           INTEGER,
  p_metadata             JSONB DEFAULT '{}'::JSONB
) RETURNS TABLE (usage_log_id UUID, new_balance INTEGER) AS $$
DECLARE
  v_log_id UUID;
  v_new_balance INTEGER;
BEGIN
  -- 1. Insert usage_logs row
  INSERT INTO public.usage_logs (
    user_id, call_type, flow_type, provider, model,
    prompt_tokens, completion_tokens, total_tokens,
    audio_duration_seconds, estimated_cost, latency_ms
  )
  VALUES (
    p_user_id, p_call_type, p_flow_type, p_provider, p_model,
    COALESCE(p_prompt_tokens, 0), COALESCE(p_completion_tokens, 0),
    COALESCE(p_prompt_tokens, 0) + COALESCE(p_completion_tokens, 0),
    COALESCE(p_audio_duration_seconds, 0), COALESCE(p_estimated_cost, 0),
    COALESCE(p_latency_ms, 0)
  )
  RETURNING id INTO v_log_id;

  -- 2. Insert ledger row and decrement balance (mirrors debit_wallet)
  IF p_amount_cents > 0 THEN
    INSERT INTO public.wallet_ledger (user_id, delta_cents, source, usage_log_id, metadata)
    VALUES (p_user_id, -p_amount_cents, 'usage', v_log_id, p_metadata);

    UPDATE public.profiles
       SET balance_cents = balance_cents - p_amount_cents
     WHERE id = p_user_id
     RETURNING balance_cents INTO v_new_balance;
  ELSE
    SELECT balance_cents INTO v_new_balance FROM public.profiles WHERE id = p_user_id;
  END IF;

  RETURN QUERY SELECT v_log_id, v_new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.log_and_debit TO service_role;
