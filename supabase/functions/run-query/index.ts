// Actually runs SQL against a connected project — the only place that does.
// Statement type is reclassified here from the raw SQL (never trusted from
// the client), writes/schema-changes are refused unless the project has
// allow_writes on AND confirmed:true was sent, and every attempt — success
// or failure — is written to query_log.
// Body: { project_id, sql, statement_type, prompt, confirmed }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cors, json } from '../_shared/http.ts';
import { managementQuery } from '../_shared/management.ts';

const ROW_LIMIT = 500;

function classify(sql: string): 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other' {
  const s = sql.trim().toLowerCase();
  if (/^(drop|truncate|alter|create)\b/.test(s)) return 'ddl';
  if (/^insert\b/.test(s)) return 'insert';
  if (/^update\b/.test(s)) return 'update';
  if (/^delete\b/.test(s)) return 'delete';
  if (/^(select|with)\b/.test(s)) return 'select';
  return 'other';
}

/** Rejects stacked statements (naive but enough for a single-user tool: one real statement, optional trailing `;`). */
function isSingleStatement(sql: string): boolean {
  const body = sql.trim().replace(/;\s*$/, '');
  return !body.includes(';');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: 'Not signed in' }, 401);

  const body = await req.json().catch(() => ({}));
  const projectId = String(body.project_id ?? '');
  const sql = String(body.sql ?? '').trim();
  const prompt = String(body.prompt ?? '').slice(0, 500);
  const confirmed = body.confirmed === true;
  if (!projectId || !sql) return json({ error: 'Nothing to run.' }, 400);
  if (!isSingleStatement(sql)) return json({ error: 'Only one statement can run at a time.' }, 400);

  const { data: project } = await admin
    .from('connected_projects')
    .select('id, name, project_ref, allow_writes, owner_id')
    .eq('id', projectId)
    .eq('owner_id', u.user.id)
    .single();
  if (!project) return json({ error: 'Project not found.' }, 404);

  const statementType = classify(sql);
  // Anything that isn't a plain read — including 'other' (GRANT, DO, VACUUM…)
  // — needs writes enabled AND an explicit confirmation.
  const isWrite = statementType !== 'select';
  if (isWrite && (!project.allow_writes || !confirmed)) {
    return json({ error: `${project.name} is read-only, or this wasn't confirmed as a write.` }, 403);
  }
  // Reads may run without a confirm click, so make "read" structural, not
  // just a keyword check: Postgres refuses a data-modifying CTE
  // (WITH x AS (DELETE …)) inside a subquery, so wrapping guarantees a
  // "select" can't change rows. Also caps rows server-side.
  const execSql = isWrite
    ? sql
    : `select * from (\n${sql.replace(/;\s*$/, '')}\n) as dbbot_q limit ${ROW_LIMIT + 1}`;

  const logResult = async (status: 'success' | 'failed', error: string | null) => {
    await admin.from('query_log').insert({
      owner_id: u.user!.id,
      project_id: projectId,
      prompt: prompt || sql.slice(0, 120),
      generated_sql: sql,
      statement_type: statementType,
      status,
      error,
    });
  };

  const { data: pat } = await admin.rpc('get_project_pat', { p_project_id: projectId });
  if (!pat) {
    await logResult('failed', 'No token saved for this project.');
    return json({ rows: null, row_count: null, error: 'No token saved for this project.' });
  }

  try {
    const rows = await managementQuery(pat, project.project_ref, execSql);
    await logResult('success', null);
    return json({ rows: rows.slice(0, ROW_LIMIT), row_count: rows.length, error: null });
  } catch (e) {
    const message = (e as Error)?.message ?? 'Query failed.';
    await logResult('failed', message.length < 300 ? message : message.slice(0, 300));
    return json({ rows: null, row_count: null, error: message });
  }
});
