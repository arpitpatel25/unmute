-- ============================================================
-- Migration 009: reconcile must apply the markup (charge parity)
-- ============================================================
-- Bug found during end-to-end verification of 008:
--   The worker stores usage_logs.estimated_cost = the RAW Groq provider cost
--   (rawGroqCostUsd, no markup) — that field is meant for margin analysis.
--   But reconcile debited usage_cost_cents(estimated_cost) = ceil(raw*100),
--   i.e. it charged the RAW cost and silently dropped the 2x markup that the
--   worker's own sttCostCents/llmCostCents apply (MARKUP_MULTIPLIER = 2.0 in
--   backend/cloudflare/shared/groq.ts). Result: the ledger UNDER-charged vs
--   intended pricing — invisible on tiny dictations (1c floor) but 2x off on
--   larger LLM transforms.
--
-- Fix: usage_cost_cents applies the markup, matching the worker exactly:
--   sttCostCents = ceil(rawUsd * MARKUP * 100); llmCostCents likewise.
-- estimated_cost stays RAW (still correct for margin reporting); only the
-- BILLED amount gets the markup. Keep BILLING_MARKUP below in sync with
-- MARKUP_MULTIPLIER in shared/groq.ts.
--
-- Rollback: re-create usage_cost_cents without the * 2.0 factor (see 008).
-- Safe: CREATE OR REPLACE of an immutable function, no data mutated. Reconcile
-- only CREATES missing debits, so already-charged rows are untouched; new debits
-- (and any not-yet-charged usage) bill at the corrected marked-up price.

create or replace function public.usage_cost_cents(p_estimated_cost numeric)
returns int language sql immutable as $$
  -- BILLING_MARKUP = 2.0 — keep synced with MARKUP_MULTIPLIER in shared/groq.ts
  select greatest(1, ceil(coalesce(p_estimated_cost, 0) * 2.0 * 100))::int
$$;
