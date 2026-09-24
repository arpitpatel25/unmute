-- Reports are written by the authenticated pipeline worker with its service
-- role. Neither other users nor normal client tokens can read them.
create table if not exists public.bug_reports (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  summary text not null,
  dictated_text text not null,
  screenshot_paths text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.bug_reports enable row level security;
revoke all on public.bug_reports from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bug-report-screenshots', 'bug-report-screenshots', false, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
