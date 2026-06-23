-- ============================================================
-- Migration 013: hidden, soft fair-use cap (notify-only)
-- ============================================================
-- Flat subscriptions, but the underlying Groq cost is usage-based. We guard
-- against abuse with a HIDDEN monthly ceiling. Policy (decided with owner):
--   * never advertised ("enough for all your daily dictation", never "unlimited")
--   * SOFT: over the cap we NOTIFY, we never block a transcription.
-- The pipeline worker reads over_fair_use() and, if true, sets a response
-- header the app surfaces as a gentle heads-up. The cap is generous (anti-abuse
-- only) and tunable in one place.

create table if not exists public.fair_use_config (
  id              int primary key default 1 check (id = 1),
  monthly_seconds int not null default 360000  -- ~100 hours of dictation / user / month
);
insert into public.fair_use_config(id) values (1) on conflict (id) do nothing;

-- True once a user's dictation seconds this calendar month reach the cap.
-- Reads from usage_logs (already written by the worker's durable usage log).
create or replace function public.over_fair_use(p_user_id uuid)
returns boolean language sql stable set search_path = public as $$
  select coalesce(sum(ul.audio_duration_seconds), 0)
           >= (select monthly_seconds from public.fair_use_config where id = 1)
  from public.usage_logs ul
  where ul.user_id = p_user_id
    and ul.created_at >= date_trunc('month', now());
$$;
