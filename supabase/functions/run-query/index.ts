// Actually runs SQL against a connected project — the only place that does.
// Statement type is reclassified here from the raw SQL (never trusted from
// the client), writes/schema-changes are refused unless the project has
// allow_writes on AND confirmed:true was sent, and every attempt — success
// or failure — is written to query_log.
// Body: { project_id, sql, statement_type, prompt, confirmed }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cors, json } from '../_shared/http.ts';
import { managementQuery } from '../_shared/management.ts';
import { projectAccessToken } from '../_shared/tokens.ts';

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

const PREVIEW_TAG = '$dbbot_preview$';
const PREVIEW_ROWS = 10;

/**
 * Wraps an INSERT/UPDATE/DELETE in a DO block that runs it, counts and samples
 * the affected rows, then RAISEs — and the raise rolls the whole change back.
 * So the database is left exactly as it was; only the error text carries the
 * preview out.
 */
function previewSql(sql: string): string {
  const body = sql.replace(/;\s*$/, '');
  if (body.includes(PREVIEW_TAG)) throw new Error('Unsupported statement.');
  const withReturning = /\breturning\b/i.test(body) ? body : `${body} returning *`;
  return `do ${PREVIEW_TAG} declare dbbot_n bigint; dbbot_sample text; begin
with dbbot_x as (${withReturning})
select count(*), (select coalesce(json_agg(t), '[]'::json) from (select * from dbbot_x limit ${PREVIEW_ROWS}) t)::text
  into dbbot_n, dbbot_sample from dbbot_x;
raise exception 'DBBOT_PREVIEW %', json_build_object('count', dbbot_n, 'rows', dbbot_sample::json)::text;
end ${PREVIEW_TAG}`;
}

function parsePreview(message: string): { count: number; rows: Record<string, unknown>[] } | null {
  const at = message.indexOf('DBBOT_PREVIEW ');
  if (at < 0) return null;
  const rest = message.slice(at + 'DBBOT_PREVIEW '.length);
  // The JSON is followed by Postgres context lines — try the longest prefix that parses.
  for (let end = rest.lastIndexOf('}'); end > 0; end = rest.lastIndexOf('}', end - 1)) {
    try {
      const v = JSON.parse(rest.slice(0, end + 1));
      if (typeof v?.count === 'number') return { count: v.count, rows: Array.isArray(v.rows) ? v.rows : [] };
    } catch {
      /* keep shrinking */
    }
  }
  return null;
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
  // preview:true = dry run of a change: report how many rows it would touch
  // (and what they'd look like), then roll back. Nothing is saved or logged.
  const preview = body.preview === true;
  if (!projectId || !sql) return json({ error: 'Nothing to run.' }, 400);
  if (!isSingleStatement(sql)) return json({ error: 'Only one statement can run at a time.' }, 400);

  const { data: project } = await admin
    .from('connected_projects')
    .select('id, name, project_ref, allow_writes, owner_id, connection_id')
    .eq('id', projectId)
    .eq('owner_id', u.user.id)
    .single();
  if (!project) return json({ error: 'Project not found.' }, 404);

  const statementType = classify(sql);
  // Anything that isn't a plain read — including 'other' (GRANT, DO, VACUUM…)
  // — needs writes enabled AND an explicit confirmation.
  const isWrite = statementType !== 'select';
  if (isWrite && !project.allow_writes) {
    return json({ error: `${project.name} is read-only. Turn on "Allow writes" for it on the Projects page first.` }, 403);
  }
  if (isWrite && !confirmed && !preview) {
    return json({ error: "This change wasn't confirmed." }, 403);
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

  let pat: string | null;
  try {
    pat = await projectAccessToken(admin, project);
  } catch (e) {
    const message = (e as Error)?.message ?? 'Could not get access to this project.';
    await logResult('failed', message);
    return json({ rows: null, row_count: null, error: message });
  }
  if (!pat) {
    await logResult('failed', 'No token saved for this project.');
    return json({ rows: null, row_count: null, error: 'No token saved for this project.' });
  }

  if (preview) {
    if (!['insert', 'update', 'delete'].includes(statementType)) {
      return json({ preview: null }); // DDL etc.: no row preview, the confirm dialog still warns
    }
    try {
      await managementQuery(pat, project.project_ref, previewSql(sql));
      return json({ preview: null }); // the block always raises — getting here means no preview
    } catch (e) {
      const p = parsePreview((e as Error)?.message ?? '');
      if (p) return json({ preview: p });
      // A real error (bad column, constraint…) — the change would fail too, so say so now.
      return json({ preview: null, error: (e as Error)?.message ?? 'This change would fail.' });
    }
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
