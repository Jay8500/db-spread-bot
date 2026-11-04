-- DB Spread Bot — "Connect with Supabase" (OAuth) support.
-- A connection = one OAuth grant (one Supabase organization the user
-- approved). Its access + refresh tokens live encrypted in Vault as
-- connection/<id>/tokens (JSON); only the edge functions (service_role) can
-- read or write them. Projects added through a connection point at it via
-- connected_projects.connection_id; manually-added projects keep using their
-- own PAT (project/<id>/pat) as before.

create table if not exists public.supabase_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.supabase_connections enable row level security;

drop policy if exists "owns their connections" on public.supabase_connections;
create policy "owns their connections" on public.supabase_connections
  for select using (owner_id = auth.uid());
drop policy if exists "deletes their connections" on public.supabase_connections;
create policy "deletes their connections" on public.supabase_connections
  for delete using (owner_id = auth.uid());
-- Rows are created only by the supabase-connect edge function (service_role).

alter table public.connected_projects
  add column if not exists connection_id uuid references public.supabase_connections(id) on delete cascade;

-- Re-adding the same project (e.g. upgrading a PAT project to a Supabase
-- login) updates the existing row instead of duplicating it.
create unique index if not exists connected_projects_owner_ref_key
  on public.connected_projects (owner_id, project_ref);

-- A browser user may only attach their OWN connection to a project.
drop policy if exists "owns their projects" on public.connected_projects;
create policy "owns their projects" on public.connected_projects
  for all using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and (connection_id is null
         or exists (select 1 from public.supabase_connections c
                    where c.id = connection_id and c.owner_id = auth.uid()))
  );

-- The edge function inserts with service_role (auth.uid() is null there), so
-- keep the owner it passes in; browser inserts are still forced to the caller.
create or replace function public.connected_projects_set_owner() returns trigger
language plpgsql as $$
begin
  new.owner_id := coalesce(auth.uid(), new.owner_id);
  return new;
end $$;

-- ───────────── Encrypted OAuth tokens (Vault), service_role only ─────────────
create or replace function public.set_connection_tokens(p_connection_id uuid, p_tokens text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_name text; v_id uuid;
begin
  v_name := 'connection/' || p_connection_id || '/tokens';
  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    perform vault.create_secret(p_tokens, v_name, 'DB Spread Bot Supabase OAuth tokens');
  else
    perform vault.update_secret(v_id, p_tokens);
  end if;
end $$;

create or replace function public.get_connection_tokens(p_connection_id uuid) returns text
language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'connection/' || p_connection_id || '/tokens';
$$;

-- Supabase grants EXECUTE on new public functions to anon/authenticated by
-- default — revoke explicitly so the browser can never read OAuth tokens.
revoke all on function public.set_connection_tokens(uuid, text), public.get_connection_tokens(uuid)
  from public, anon, authenticated;
grant execute on function public.set_connection_tokens(uuid, text), public.get_connection_tokens(uuid) to service_role;

create or replace function public.supabase_connections_purge_tokens() returns trigger
language plpgsql security definer set search_path = public, vault as $$
begin
  delete from vault.secrets where name = 'connection/' || old.id || '/tokens';
  return old;
end $$;
drop trigger if exists supabase_connections_purge_tokens on public.supabase_connections;
create trigger supabase_connections_purge_tokens after delete on public.supabase_connections
  for each row execute function public.supabase_connections_purge_tokens();
