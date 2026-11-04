-- DB Spread Bot — control-plane schema.
-- This project's OWN database: a list of connected Supabase projects, their
-- (vault-encrypted) Management API tokens, and a log of every query that
-- actually ran against them. It never stores another project's DATA, only
-- the connection + the audit trail.

create table if not exists public.connected_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  project_ref text not null,
  project_url text not null,
  allow_writes boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.connected_projects enable row level security;

create policy "owns their projects" on public.connected_projects
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create or replace function public.connected_projects_set_owner() returns trigger
language plpgsql as $$
begin
  new.owner_id := auth.uid();
  return new;
end $$;
drop trigger if exists connected_projects_set_owner on public.connected_projects;
create trigger connected_projects_set_owner before insert on public.connected_projects
  for each row execute function public.connected_projects_set_owner();

-- Append-only audit trail: every query actually run (not every SQL generated —
-- generation alone, before a Confirm & Run click, is never logged or executed).
create table if not exists public.query_log (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.connected_projects(id) on delete cascade,
  prompt text not null,
  generated_sql text not null,
  statement_type text not null,
  status text not null check (status in ('success', 'failed')),
  error text,
  executed_at timestamptz not null default now()
);
alter table public.query_log enable row level security;

create policy "owns their activity" on public.query_log
  for select using (owner_id = auth.uid());
-- No insert/update/delete policy for authenticated users — only the
-- run-query edge function (service_role) writes rows here, so the log can't
-- be edited or deleted from the app itself.

-- ───────────── Encrypted project tokens (Supabase Vault) ─────────────
-- Each Management API PAT is stored encrypted in vault.secrets as
-- project/<project_id>/pat. set_project_secret is callable by the owning
-- user (adding/rotating a token); get_project_pat is callable only by
-- service_role (the edge functions), never by the browser — the PAT itself
-- must never reach client code.

create or replace function public.set_project_secret(p_project_id uuid, p_pat text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_name text; v_id uuid;
begin
  if not exists (select 1 from public.connected_projects where id = p_project_id and owner_id = auth.uid()) then
    raise exception 'permission denied';
  end if;
  v_name := 'project/' || p_project_id || '/pat';
  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    perform vault.create_secret(p_pat, v_name, 'DB Spread Bot project PAT');
  else
    perform vault.update_secret(v_id, p_pat);
  end if;
end $$;

create or replace function public.get_project_pat(p_project_id uuid) returns text
language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'project/' || p_project_id || '/pat';
$$;

revoke all on function public.set_project_secret(uuid, text), public.get_project_pat(uuid) from public, anon;
grant execute on function public.set_project_secret(uuid, text) to authenticated;
grant execute on function public.get_project_pat(uuid) to service_role;

-- Removing a project deletes its stored token too.
create or replace function public.connected_projects_purge_secret() returns trigger
language plpgsql security definer set search_path = public, vault as $$
begin
  delete from vault.secrets where name = 'project/' || old.id || '/pat';
  return old;
end $$;
drop trigger if exists connected_projects_purge_secret on public.connected_projects;
create trigger connected_projects_purge_secret after delete on public.connected_projects
  for each row execute function public.connected_projects_purge_secret();
