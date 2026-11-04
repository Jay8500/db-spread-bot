-- Cache of each connected project's table list + suggested questions, built
-- by the project-info edge function, so the Tables page and the Ask page's
-- suggestions load instantly and don't spend AI quota on every visit.
alter table public.connected_projects
  add column if not exists info jsonb,
  add column if not exists info_at timestamptz;
