-- Supabase accounts panel: remember which organization each connection is
-- for, and let the user give it a label (e.g. the account's email — the
-- Management API does not reveal it to OAuth apps).

alter table public.supabase_connections
  add column if not exists organization_id text,
  add column if not exists organization_name text,
  add column if not exists label text check (char_length(label) <= 120);

-- Users may rename their own connections, and change nothing else.
drop policy if exists "renames their connections" on public.supabase_connections;
create policy "renames their connections" on public.supabase_connections
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke update on public.supabase_connections from authenticated;
grant update (label) on public.supabase_connections to authenticated;

-- One connection per user per organization: connecting the same org again
-- refreshes that connection instead of adding a duplicate.
create unique index if not exists supabase_connections_owner_org_key
  on public.supabase_connections (owner_id, organization_id)
  where organization_id is not null;
