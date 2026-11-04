// What's in a connected project, for people who don't want to open Supabase:
// tables (row counts, columns, RLS), database functions (with code), triggers,
// security rules (RLS policies) and edge functions — all linked to each other —
// plus everyday suggested questions. Cached on connected_projects.info for 6 h.
//
// Body: { project_id, refresh?: boolean }                         → ProjectInfo
//       { project_id, explain: { kind, name } }                   → { explanation }
//   kind: 'table' | 'function' | 'trigger' | 'policy' | 'edge_function'
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { cors, json } from '../_shared/http.ts';
import { managementQuery } from '../_shared/management.ts';
import { projectAccessToken } from '../_shared/tokens.ts';
import { geminiJson } from '../_shared/gemini.ts';

const CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_DEF = 8000;

interface TableInfo {
  name: string;
  rows: number | null;
  kind: 'table' | 'view';
  rls: boolean;
  columns: { name: string; type: string }[];
}
interface FunctionInfo {
  name: string;
  args: string;
  returns: string;
  language: string;
  security_definer: boolean;
  definition: string;
  /** Public tables whose names appear in the code. */
  tables: string[];
}
interface TriggerInfo {
  name: string;
  table: string;
  function: string;
  enabled: boolean;
  definition: string;
}
interface PolicyInfo {
  name: string;
  table: string;
  command: string;
  roles: string;
  permissive: string;
  using: string | null;
  check: string | null;
}
interface EdgeFunctionInfo {
  slug: string;
  name: string;
  status: string;
  version: number | null;
  verify_jwt: boolean | null;
  updated_at: string | null;
}
interface Explanation {
  summary: string;
  points: string[];
  hash: string;
  at: string;
}
interface Info {
  tables: TableInfo[];
  functions: FunctionInfo[];
  triggers: TriggerInfo[];
  policies: PolicyInfo[];
  edge_functions: EdgeFunctionInfo[] | null;
  /** Why edge functions couldn't be listed (e.g. missing permission), if so. */
  edge_functions_note: string | null;
  suggestions: string[];
  explanations?: Record<string, Explanation>;
}

const TABLES_SQL = `
  select c.relname as name,
         case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind,
         c.relrowsecurity as rls,
         case when c.relkind in ('r', 'p') then greatest(coalesce(s.n_live_tup, 0), c.reltuples::bigint, 0) end as rows,
         coalesce((select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum)
                   from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'::json) as columns
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_tables s on s.relid = c.oid
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  order by c.relname`;

// Skips functions that belong to extensions (pgcrypto etc.) — only the project's own.
const FUNCTIONS_SQL = `
  select p.proname as name,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_function_result(p.oid) as returns,
         l.lanname as language,
         p.prosecdef as security_definer,
         left(pg_get_functiondef(p.oid), ${MAX_DEF}) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.prokind in ('f', 'p')
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  order by p.proname
  limit 200`;

const TRIGGERS_SQL = `
  select t.tgname as name, c.relname as table_name, p.proname as function_name,
         t.tgenabled <> 'D' as enabled, pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid
  where n.nspname = 'public' and not t.tgisinternal
  order by c.relname, t.tgname`;

const POLICIES_SQL = `
  select tablename as table_name, policyname as name, cmd as command, array_to_string(roles, ', ') as roles,
         permissive, qual as using_expr, with_check
  from pg_policies where schemaname = 'public'
  order by tablename, policyname`;

/** Words a person would use for a table name: walk_ins → "walk ins". */
const words = (t: string) => t.replace(/_/g, ' ').trim();

/** No-AI fallback so suggestions always exist. */
function basicSuggestions(tables: TableInfo[]): string[] {
  const big = [...tables].filter((t) => t.kind === 'table').sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0)).slice(0, 3);
  const out: string[] = [];
  for (const t of big) {
    const hasDate = t.columns.some((c) => /created_at|_date$|_at$/.test(c.name));
    out.push(hasDate ? `${words(t.name)} added today` : `latest 10 ${words(t.name)}`);
    out.push(`how many ${words(t.name)}`);
  }
  out.push('list all tables with row counts');
  return [...new Set(out)].slice(0, 6);
}

async function aiSuggestions(tables: TableInfo[]): Promise<string[]> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return basicSuggestions(tables);
  const schema = tables
    .filter((t) => t.kind === 'table')
    .slice(0, 40)
    .map((t) => `- ${t.name} (${t.rows ?? '?'} rows): ${t.columns.map((c) => c.name).join(', ')}`)
    .join('\n');
  const system = `You suggest everyday questions a non-technical business owner or staff member would type into a "ask your database in plain English" box.
Rules: 6 questions, each 2–7 words, simple casual English, specific to THIS data (use the real business words from table/column names — e.g. "today's walk-ins", "pending payments", "top 5 doctors this month"), mostly about today / this week / pending / totals / latest. No SQL words, no table names with underscores, no questions needing data that isn't there.`;
  try {
    const r = await geminiJson<{ questions?: string[] }>(
      apiKey,
      system,
      [{ role: 'user', text: `Tables:\n${schema}` }],
      { type: 'OBJECT', properties: { questions: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['questions'] },
      0.4,
    );
    const qs = (r.questions ?? []).map((q) => String(q).trim()).filter((q) => q && q.length <= 80);
    return qs.length >= 3 ? qs.slice(0, 6) : basicSuggestions(tables);
  } catch (e) {
    console.error('suggestions failed, using basic ones', e);
    return basicSuggestions(tables);
  }
}

async function listEdgeFunctions(pat: string, ref: string): Promise<{ list: EdgeFunctionInfo[] | null; note: string | null }> {
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions`, { headers: { Authorization: `Bearer ${pat}` } });
    if (res.status === 401 || res.status === 403) {
      return { list: null, note: 'Needs the "Edge Functions: read" permission — add it to the OAuth app, then Reconnect this account.' };
    }
    if (!res.ok) return { list: null, note: `Could not list edge functions (${res.status}).` };
    const rows = (await res.json()) as Record<string, unknown>[];
    return {
      note: null,
      list: rows.map((f) => ({
        slug: String(f.slug ?? f.name),
        name: String(f.name ?? f.slug),
        status: String(f.status ?? ''),
        version: f.version === undefined ? null : Number(f.version),
        verify_jwt: typeof f.verify_jwt === 'boolean' ? f.verify_jwt : null,
        updated_at: f.updated_at ? new Date(Number(f.updated_at) || String(f.updated_at)).toISOString() : null,
      })),
    };
  } catch {
    return { list: null, note: 'Could not list edge functions right now.' };
  }
}

async function buildInfo(pat: string, ref: string, prev: Info | null): Promise<Info> {
  const [rawTables, rawFns, rawTrig, rawPol, edge] = await Promise.all([
    managementQuery(pat, ref, TABLES_SQL),
    managementQuery(pat, ref, FUNCTIONS_SQL).catch(() => []),
    managementQuery(pat, ref, TRIGGERS_SQL).catch(() => []),
    managementQuery(pat, ref, POLICIES_SQL).catch(() => []),
    listEdgeFunctions(pat, ref),
  ]);
  const tables: TableInfo[] = rawTables.map((r) => ({
    name: String(r['name']),
    kind: r['kind'] === 'view' ? 'view' : 'table',
    rls: r['rls'] === true,
    rows: r['rows'] === null || r['rows'] === undefined ? null : Number(r['rows']),
    columns: Array.isArray(r['columns']) ? (r['columns'] as { name: string; type: string }[]) : [],
  }));
  const tableNames = tables.map((t) => t.name);
  const functions: FunctionInfo[] = rawFns.map((r) => {
    const definition = String(r['definition'] ?? '');
    return {
      name: String(r['name']),
      args: String(r['args'] ?? ''),
      returns: String(r['returns'] ?? ''),
      language: String(r['language'] ?? ''),
      security_definer: r['security_definer'] === true,
      definition,
      tables: tableNames.filter((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(definition)),
    };
  });
  const triggers: TriggerInfo[] = rawTrig.map((r) => ({
    name: String(r['name']),
    table: String(r['table_name']),
    function: String(r['function_name']),
    enabled: r['enabled'] !== false,
    definition: String(r['definition'] ?? ''),
  }));
  const policies: PolicyInfo[] = rawPol.map((r) => ({
    name: String(r['name']),
    table: String(r['table_name']),
    command: String(r['command'] ?? 'ALL'),
    roles: String(r['roles'] ?? ''),
    permissive: String(r['permissive'] ?? ''),
    using: (r['using_expr'] as string | null) ?? null,
    check: (r['with_check'] as string | null) ?? null,
  }));

  // Reuse AI suggestions while the set of tables is unchanged.
  const prevTables = new Set((prev?.tables ?? []).map((t) => t.name));
  const sameTables = prevTables.size === tables.length && tables.every((t) => prevTables.has(t.name));
  const suggestions = sameTables && prev?.suggestions?.length ? prev.suggestions : await aiSuggestions(tables);

  return {
    tables,
    functions,
    triggers,
    policies,
    edge_functions: edge.list,
    edge_functions_note: edge.note,
    suggestions,
    explanations: prev?.explanations ?? {},
  };
}

/** Everything the AI needs to explain one object, as text. */
function contextFor(info: Info, kind: string, name: string): string | null {
  const fn = (n: string) => info.functions.find((f) => f.name === n);
  if (kind === 'function') {
    const f = fn(name);
    if (!f) return null;
    const usedBy = info.triggers.filter((t) => t.function === name).map((t) => `${t.name} on ${t.table}`);
    return `Database function ${f.name}(${f.args}) returns ${f.returns}, language ${f.language}${f.security_definer ? ', SECURITY DEFINER (runs with its owner\'s rights)' : ''}.
Called by triggers: ${usedBy.join('; ') || 'none'}.
Code:
${f.definition}`;
  }
  if (kind === 'trigger') {
    const t = info.triggers.find((x) => x.name === name);
    if (!t) return null;
    return `Trigger: ${t.definition}${t.enabled ? '' : ' (DISABLED)'}
It runs this function:
${fn(t.function)?.definition ?? `${t.function} (code not available)`}`;
  }
  if (kind === 'policy') {
    const p = info.policies.find((x) => `${x.table}.${x.name}` === name);
    if (!p) return null;
    return `Row-level security policy "${p.name}" on table ${p.table}, applies to ${p.command} for roles ${p.roles} (${p.permissive}).
USING (which existing rows are visible/affected): ${p.using ?? '—'}
WITH CHECK (which new/changed rows are allowed): ${p.check ?? '—'}`;
  }
  if (kind === 'table') {
    const t = info.tables.find((x) => x.name === name);
    if (!t) return null;
    const trig = info.triggers.filter((x) => x.table === name).map((x) => x.definition);
    const pol = info.policies.filter((x) => x.table === name).map((x) => `${x.name}: ${x.command} for ${x.roles}, using ${x.using ?? '—'}, check ${x.check ?? '—'}`);
    const fns = info.functions.filter((f) => f.tables.includes(name)).map((f) => f.name);
    return `Table ${t.name} (${t.rows ?? '?'} rows), row-level security ${t.rls ? 'ON' : 'OFF'}.
Columns: ${t.columns.map((c) => `${c.name} ${c.type}`).join(', ')}
Triggers: ${trig.join('\n') || 'none'}
Security policies: ${pol.join('\n') || 'none'}
Functions that mention it: ${fns.join(', ') || 'none'}`;
  }
  if (kind === 'edge_function') {
    const e = info.edge_functions?.find((x) => x.slug === name);
    if (!e) return null;
    const mentions = info.tables.map((t) => t.name).filter((t) => e.slug.includes(t.replace(/_/g, '-')) || e.slug.includes(t));
    return `Supabase Edge Function "${e.name}" (slug ${e.slug}), status ${e.status}, version ${e.version ?? '?'}, ${e.verify_jwt === false ? 'callable WITHOUT login (verify_jwt off)' : 'requires a logged-in user (verify_jwt on)'}.
The code itself is not available — explain only from the name and settings, and say that clearly. Related-sounding tables: ${mentions.join(', ') || 'none'}.`;
  }
  return null;
}

async function hashOf(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function explain(admin: SupabaseClient, projectId: string, info: Info, kind: string, name: string) {
  const ctx = contextFor(info, kind, name);
  if (!ctx) return json({ error: 'Not found — refresh and try again.' }, 404);
  const key = `${kind}:${name}`;
  const hash = await hashOf(ctx);
  const cached = info.explanations?.[key];
  if (cached && cached.hash === hash) return json({ explanation: cached, cached: true });

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return json({ error: 'AI is not configured yet.' }, 500);
  const system = `You explain parts of a Supabase/Postgres database to a non-technical business owner.
Write simple English, no jargon (say "checks that…", "runs automatically when…", "only lets a user see their own…").
"summary": 1–2 sentences — what it is for, in business terms.
"points": 3–6 short bullets: when it runs / who can use it, what data it reads, what it changes, anything risky or surprising (e.g. "anyone can call this without logging in", "deletes rows", "bypasses security rules"). Never invent behaviour that isn't in the given code.`;
  const r = await geminiJson<{ summary?: string; points?: string[] }>(
    apiKey,
    system,
    [{ role: 'user', text: ctx.slice(0, 12000) }],
    {
      type: 'OBJECT',
      properties: { summary: { type: 'STRING' }, points: { type: 'ARRAY', items: { type: 'STRING' } } },
      required: ['summary', 'points'],
      propertyOrdering: ['summary', 'points'],
    },
    0.2,
  );
  const explanation: Explanation = {
    summary: String(r.summary ?? '').trim(),
    points: (r.points ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 6),
    hash,
    at: new Date().toISOString(),
  };
  // Re-read so a concurrent explain isn't lost, then store.
  const { data: row } = await admin.from('connected_projects').select('info').eq('id', projectId).single();
  const current = (row?.info ?? info) as Info;
  current.explanations = { ...(current.explanations ?? {}), [key]: explanation };
  await admin.from('connected_projects').update({ info: current }).eq('id', projectId);
  return json({ explanation, cached: false });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Not signed in' }, 401);

    const body = await req.json().catch(() => ({}));
    const projectId = String(body.project_id ?? '');
    const { data: project } = await admin
      .from('connected_projects')
      .select('id, project_ref, owner_id, connection_id, info, info_at')
      .eq('id', projectId)
      .eq('owner_id', u.user.id)
      .single();
    if (!project) return json({ error: 'Project not found.' }, 404);

    const prev = (project.info ?? null) as Info | null;
    // Older caches (before functions/triggers/etc. were added) count as stale.
    const complete = !!prev && Array.isArray(prev.functions);
    const fresh = complete && project.info_at && Date.now() - new Date(project.info_at).getTime() < CACHE_MS;

    let info: Info;
    let updatedAt: string;
    if (fresh && body.refresh !== true) {
      info = prev!;
      updatedAt = project.info_at;
    } else {
      const pat = await projectAccessToken(admin, project);
      if (!pat) return json({ error: 'No access saved for this project — reconnect it on the Projects page.' }, 400);
      info = await buildInfo(pat, project.project_ref, complete ? prev : null);
      updatedAt = new Date().toISOString();
      await admin.from('connected_projects').update({ info, info_at: updatedAt }).eq('id', project.id);
    }

    if (body.explain?.kind && body.explain?.name) {
      return await explain(admin, project.id, info, String(body.explain.kind), String(body.explain.name));
    }
    // Explanations are fetched one at a time; don't ship them all on every load.
    const { explanations: _omit, ...rest } = info;
    return json({ ...rest, explained: Object.keys(info.explanations ?? {}), updated_at: updatedAt });
  } catch (e) {
    console.error('project-info failed', e);
    const m = (e as Error)?.message ?? '';
    return json({ error: m.length < 160 ? m : 'Could not read this project right now.' }, 400);
  }
});
