// What's in a connected project, for people who don't want to open Supabase:
// every public table with its row count and columns, plus a handful of
// everyday questions to ask about it. Cached on connected_projects.info for
// 6 hours (pass refresh:true to rebuild).
// Body: { project_id: string, refresh?: boolean }
// → { tables: [{ name, rows, kind, columns: [{ name, type }] }], suggestions: string[], updated_at }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cors, json } from '../_shared/http.ts';
import { managementQuery } from '../_shared/management.ts';
import { projectAccessToken } from '../_shared/tokens.ts';
import { geminiJson } from '../_shared/gemini.ts';

const CACHE_MS = 6 * 60 * 60 * 1000;

interface TableInfo {
  name: string;
  rows: number | null;
  kind: 'table' | 'view';
  columns: { name: string; type: string }[];
}

const TABLES_SQL = `
  select c.relname as name,
         case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind,
         case when c.relkind in ('r', 'p') then greatest(coalesce(s.n_live_tup, 0), c.reltuples::bigint, 0) end as rows,
         coalesce((select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum)
                   from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'::json) as columns
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_tables s on s.relid = c.oid
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  order by c.relname`;

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

    const fresh = project.info && project.info_at && Date.now() - new Date(project.info_at).getTime() < CACHE_MS;
    if (fresh && body.refresh !== true) return json({ ...project.info, updated_at: project.info_at });

    const pat = await projectAccessToken(admin, project);
    if (!pat) return json({ error: 'No access saved for this project — reconnect it on the Projects page.' }, 400);

    const raw = await managementQuery(pat, project.project_ref, TABLES_SQL);
    const tables: TableInfo[] = raw.map((r) => ({
      name: String(r['name']),
      kind: r['kind'] === 'view' ? 'view' : 'table',
      rows: r['rows'] === null || r['rows'] === undefined ? null : Number(r['rows']),
      columns: Array.isArray(r['columns']) ? (r['columns'] as { name: string; type: string }[]) : [],
    }));
    // Reuse cached AI suggestions on a plain refresh of counts; rebuild them when the table set changed.
    const prevTables = new Set(((project.info?.tables ?? []) as TableInfo[]).map((t) => t.name).sort());
    const sameTables = prevTables.size === tables.length && tables.every((t) => prevTables.has(t.name));
    const suggestions: string[] =
      sameTables && Array.isArray(project.info?.suggestions) && project.info.suggestions.length
        ? project.info.suggestions
        : await aiSuggestions(tables);

    const info = { tables, suggestions };
    const now = new Date().toISOString();
    await admin.from('connected_projects').update({ info, info_at: now }).eq('id', project.id);
    return json({ ...info, updated_at: now });
  } catch (e) {
    console.error('project-info failed', e);
    const m = (e as Error)?.message ?? '';
    return json({ error: m.length < 160 ? m : 'Could not read this project right now.' }, 400);
  }
});
