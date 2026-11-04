// "Connect with Supabase" (OAuth). The browser does the redirect to
// Supabase's consent screen with a PKCE challenge; this function does the
// parts that need the client secret or the tokens:
//   { action: 'exchange', code, code_verifier, redirect_uri }
//       → stores the tokens in Vault as a new connection, returns its projects
//   { action: 'projects', connection_id } → that connection's projects
//   { action: 'add', connection_id, refs: string[] } → connects those projects
// Tokens never go back to the browser.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { cors, json } from '../_shared/http.ts';
import { connectionAccessToken, exchangeCode, ReconnectNeeded, saveTokens } from '../_shared/tokens.ts';

// Only our own pages may receive the authorization code.
const ALLOWED_REDIRECTS = new Set([
  'https://dbbot.spreadapps.in/connect/callback',
  'http://localhost:4200/connect/callback',
]);

interface SupabaseProject {
  ref: string;
  name: string;
  region: string;
  status: string;
  organization_id: string;
}

async function listProjects(accessToken: string): Promise<SupabaseProject[]> {
  const res = await fetch('https://api.supabase.com/v1/projects', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) throw new ReconnectNeeded();
  if (!res.ok) throw new Error(`Could not list your Supabase projects (${res.status}).`);
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows.map((p) => ({
    ref: String(p.ref ?? p.id),
    name: String(p.name ?? p.ref ?? p.id),
    region: String(p.region ?? ''),
    status: String(p.status ?? ''),
    organization_id: String(p.organization_id ?? ''),
  }));
}

/** The organization the user approved on the consent screen (an OAuth grant covers one org). */
async function approvedOrganization(accessToken: string): Promise<{ id: string; name: string } | null> {
  try {
    const res = await fetch('https://api.supabase.com/v1/organizations', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const orgs = (await res.json()) as { id?: string; slug?: string; name?: string }[];
    const o = orgs[0];
    return o ? { id: String(o.id ?? o.slug), name: String(o.name ?? o.slug ?? 'Supabase organization') } : null;
  } catch {
    return null;
  }
}

async function ownConnection(admin: SupabaseClient, connectionId: string, userId: string): Promise<boolean> {
  const { data } = await admin.from('supabase_connections').select('id').eq('id', connectionId).eq('owner_id', userId).maybeSingle();
  return !!data;
}

/** connected: 'login' (already via Supabase login), 'token' (added with a personal token — can be switched), or false. */
async function withConnectedFlag(admin: SupabaseClient, userId: string, projects: SupabaseProject[]) {
  const { data } = await admin.from('connected_projects').select('project_ref, connection_id').eq('owner_id', userId);
  const have = new Map((data ?? []).map((r: { project_ref: string; connection_id: string | null }) => [r.project_ref, r.connection_id]));
  return projects.map((p) => ({ ...p, connected: have.has(p.ref) ? (have.get(p.ref) ? 'login' : 'token') : false }));
}

/** Drops this user's other connections that no project uses (abandoned or superseded sign-ins); Vault tokens go with them. */
async function pruneUnusedConnections(admin: SupabaseClient, userId: string, keepId: string) {
  const { data: conns } = await admin.from('supabase_connections').select('id').eq('owner_id', userId).neq('id', keepId);
  if (!conns?.length) return;
  const { data: used } = await admin.from('connected_projects').select('connection_id').eq('owner_id', userId).not('connection_id', 'is', null);
  const usedIds = new Set((used ?? []).map((r: { connection_id: string }) => r.connection_id));
  const unused = conns.map((c: { id: string }) => c.id).filter((id: string) => !usedIds.has(id));
  if (unused.length) await admin.from('supabase_connections').delete().in('id', unused);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Not signed in' }, 401);
    const userId = u.user.id;

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');

    if (action === 'exchange') {
      const code = String(body.code ?? '');
      const verifier = String(body.code_verifier ?? '');
      const redirectUri = String(body.redirect_uri ?? '');
      if (!code || !verifier) return json({ error: 'The Supabase sign-in did not complete — try connecting again.' }, 400);
      if (!ALLOWED_REDIRECTS.has(redirectUri)) return json({ error: 'Unexpected return address.' }, 400);

      let tokens;
      try {
        tokens = await exchangeCode(code, verifier, redirectUri);
      } catch {
        return json({ error: 'That Supabase sign-in link has expired — try connecting again.' }, 400);
      }
      const org = await approvedOrganization(tokens.access_token);
      // Same organization connected before → refresh that connection's tokens
      // (a "Reconnect") instead of creating a duplicate.
      let connId: string | null = null;
      if (org) {
        const { data: existing } = await admin
          .from('supabase_connections')
          .select('id')
          .eq('owner_id', userId)
          .eq('organization_id', org.id)
          .maybeSingle();
        connId = existing?.id ?? null;
        if (connId) await admin.from('supabase_connections').update({ organization_name: org.name }).eq('id', connId);
      }
      if (!connId) {
        const { data: conn, error } = await admin
          .from('supabase_connections')
          .insert({ owner_id: userId, organization_id: org?.id ?? null, organization_name: org?.name ?? null })
          .select('id')
          .single();
        if (error || !conn) throw error ?? new Error('Could not save the connection.');
        connId = conn.id as string;
      }
      await saveTokens(admin, connId, tokens);
      await pruneUnusedConnections(admin, userId, connId);

      const projects = await listProjects(tokens.access_token);
      return json({
        connection_id: connId,
        organization_name: org?.name ?? null,
        projects: await withConnectedFlag(admin, userId, projects),
      });
    }

    const connectionId = String(body.connection_id ?? '');
    if (!connectionId || !(await ownConnection(admin, connectionId, userId))) {
      return json({ error: 'Connection not found — try connecting again.' }, 404);
    }

    if (action === 'projects') {
      const projects = await listProjects(await connectionAccessToken(admin, connectionId));
      const { data: c } = await admin.from('supabase_connections').select('organization_name').eq('id', connectionId).single();
      return json({
        connection_id: connectionId,
        organization_name: c?.organization_name ?? null,
        projects: await withConnectedFlag(admin, userId, projects),
      });
    }

    if (action === 'add') {
      const refs: string[] = Array.isArray(body.refs) ? body.refs.map(String).slice(0, 50) : [];
      if (!refs.length) return json({ error: 'Pick at least one project.' }, 400);
      // Only projects this connection can actually see.
      const visible = new Map((await listProjects(await connectionAccessToken(admin, connectionId))).map((p) => [p.ref, p]));
      const rows = refs
        .filter((r) => visible.has(r))
        .map((r) => ({
          owner_id: userId,
          connection_id: connectionId,
          name: visible.get(r)!.name,
          project_ref: r,
          project_url: `https://${r}.supabase.co`,
        }));
      if (!rows.length) return json({ error: 'Those projects are not in this Supabase account.' }, 400);
      // Existing rows (e.g. added earlier with a token) switch to this
      // connection but keep their name and read-only setting.
      const { data: existing } = await admin
        .from('connected_projects')
        .select('project_ref')
        .eq('owner_id', userId)
        .in('project_ref', rows.map((r) => r.project_ref));
      const existingRefs = new Set((existing ?? []).map((r: { project_ref: string }) => r.project_ref));
      const fresh = rows.filter((r) => !existingRefs.has(r.project_ref));
      if (fresh.length) {
        const { error } = await admin.from('connected_projects').insert(fresh);
        if (error) throw error;
      }
      if (existingRefs.size) {
        const { error } = await admin
          .from('connected_projects')
          .update({ connection_id: connectionId })
          .eq('owner_id', userId)
          .in('project_ref', [...existingRefs]);
        if (error) throw error;
      }
      return json({ added: rows.length });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('supabase-connect failed', e);
    const m = (e as Error)?.message ?? '';
    return json({ error: m.length < 160 ? m : 'Could not connect to Supabase right now.' }, e instanceof ReconnectNeeded ? 409 : 400);
  }
});
