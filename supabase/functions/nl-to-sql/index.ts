// Turns a plain-English prompt into SQL for one connected project.
// Generates ONLY — never executes, never logged. The browser never sees the
// project's PAT; this function loads it from Vault, asks the real schema,
// then asks Gemini (free tier — no card needed), and hands back
// { sql, explanation, statement_type }.
// Body: { project_id: string, prompt: string }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cors, json as baseJson } from '../_shared/http.ts';
import { fetchSchema } from '../_shared/management.ts';
import { projectAccessToken } from '../_shared/tokens.ts';
import { geminiJson, type GeminiTurn } from '../_shared/gemini.ts';

function system(schema: { table: string; columns: string }[]): string {
  const tables = schema.map((t) => `- ${t.table}(${t.columns})`).join('\n');
  return `You translate a request into one PostgreSQL statement for a Supabase (Postgres) database.

The people asking are non-technical business owners and staff. They type short, casual, often ungrammatical English — typos, missing words, Indian-English or Hinglish phrasing ("today walkins", "pending payments list", "kitne patients aaye aaj", "show me last week sales"). Your job is to work out what they most likely mean and answer it — not to demand precision.

Schema (public tables unqualified; auth.users is Supabase's built-in user table):
${tables || '(no tables found)'}

How to interpret:
- Always pick the single most sensible reading and go with it. Do not refuse because the request is vague, informal, misspelled or incomplete.
- Match words to tables/columns loosely: singular/plural, synonyms and domain words (customer≈client≈patient≈user, sales≈orders≈invoices≈bills, staff≈employees≈doctors, walkin≈visit≈appointment, amount≈total≈price), abbreviations and typos.
- "today", "yesterday", "this week/month/year", "last 7 days" → filter on the most relevant date/timestamp column (created_at if nothing better), in the Asia/Kolkata time zone, e.g. (created_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date.
- "show / list / give / get / see" with no count → return the useful columns (skip raw ids/json blobs unless asked), newest first, limit 100.
- "how many / count / total / kitne" → a count; "total amount / revenue / sum" → sum of the money-like column. "top / most / highest / best" → order by that measure desc, limit 10.
- Show human-readable names instead of ids where a join to a name/title/email column is obvious.
- Only return sql: "" when the data genuinely isn't in the schema at all (e.g. they ask about inventory and no table relates to it) — then explain in one friendly sentence what's missing and which tables do exist.

Rules:
- For questions about users / people / sign-ups / who someone is, use auth.users (always write it schema-qualified as auth.users). Display names are usually in raw_user_meta_data->>'full_name' or raw_user_meta_data->>'name' — use coalesce over both, falling back to email. Join public tables to it via their user id / owner_id columns.
- Never insert/update/delete anything in auth.users — it is read-only here.
- Questions about the database's own structure (how many tables, list tables/columns, table sizes, row counts per table, indexes) → query information_schema or pg_catalog (e.g. information_schema.tables, information_schema.columns, pg_stat_user_tables), limited to table_schema = 'public' unless another schema is asked for.
- Output ONLY a JSON object: {"sql": string, "explanation": string, "statement_type": "select"|"insert"|"update"|"delete"|"ddl"|"other"}
- "sql" is exactly ONE statement, valid PostgreSQL, using only the tables/columns listed above (or the system catalogs for structure questions). Never invent a table or column.
- "explanation" is one short plain-English sentence describing exactly what the statement does, for someone who doesn't read SQL.
- Prefer a SELECT whenever the request is just "show me" / "how many" / "what is" — never write/change data unless the request clearly asks for a change.
- "explanation" must be in simple English even if the question was in Hinglish.
- If earlier turns exist, a short request like "only unpaid ones", "now last week", "sort by amount", "add phone number" is a FOLLOW-UP: start from the previous SQL and change just what was asked. A request that clearly names a different subject is a fresh question.
- Never use semicolons inside the statement; never return more than one statement.`;
}

type Generated = { sql?: string; explanation?: string; statement_type?: string };

const SQL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sql: { type: 'STRING' },
    explanation: { type: 'STRING' },
    statement_type: { type: 'STRING', enum: ['select', 'insert', 'update', 'delete', 'ddl', 'other'] },
  },
  required: ['sql', 'explanation', 'statement_type'],
  propertyOrdering: ['sql', 'explanation', 'statement_type'],
};

/** Earlier questions in this conversation, so "only unpaid ones" / "now last week" build on the last query. */
type Turn = { prompt: string; sql: string };

function askGemini(apiKey: string, sys: string, prompt: string, history: Turn[]): Promise<Generated> {
  const turns: GeminiTurn[] = [];
  for (const h of history) {
    turns.push({ role: 'user', text: h.prompt });
    turns.push({ role: 'model', text: JSON.stringify({ sql: h.sql, explanation: '', statement_type: 'select' }) });
  }
  turns.push({ role: 'user', text: prompt });
  return geminiJson<Generated>(apiKey, sys, turns, SQL_SCHEMA);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  // Per-step timings, sent as a Server-Timing header (DevTools → request →
  // Timing tab) and logged, so slowness can be pinned to auth/schema/AI.
  const marks: [string, number][] = [];
  let last = performance.now();
  const mark = (name: string) => {
    const now = performance.now();
    marks.push([name, now - last]);
    last = now;
  };
  const json = (b: unknown, status = 200) => {
    const timing = marks.map(([n, d]) => `${n};dur=${d.toFixed(0)}`).join(', ');
    console.log('nl-to-sql timing', status, timing);
    const res = baseJson(b, status);
    if (timing) {
      res.headers.set('Server-Timing', timing);
      res.headers.set('Timing-Allow-Origin', '*');
    }
    return res;
  };
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: u } = await admin.auth.getUser(jwt);
    mark('auth');
    if (!u?.user) return json({ error: 'Not signed in' }, 401);

    const body = await req.json().catch(() => ({}));
    const projectId = String(body.project_id ?? '');
    const prompt = String(body.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const history: Turn[] = (Array.isArray(body.history) ? body.history : [])
      .slice(-3)
      .map((h: { prompt?: unknown; sql?: unknown }) => ({ prompt: String(h?.prompt ?? '').slice(0, 500), sql: String(h?.sql ?? '').slice(0, 4000) }))
      .filter((h: Turn) => h.prompt && h.sql);
    if (!projectId || prompt.length < 3) return json({ error: 'Pick a project and type a question.' }, 400);

    const { data: project } = await admin
      .from('connected_projects')
      .select('id, project_ref, owner_id, connection_id')
      .eq('id', projectId)
      .eq('owner_id', u.user.id)
      .single();
    if (!project) return json({ error: 'Project not found.' }, 404);

    const pat = await projectAccessToken(admin, project);
    mark('project_and_token');
    if (!pat) return json({ error: 'No token saved for this project yet.' }, 400);

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) return json({ error: 'AI is not configured yet.' }, 500);

    const schema = await fetchSchema(pat, project.project_ref);
    mark('schema');
    const parsed = await askGemini(apiKey, system(schema), prompt, history);
    mark('ai');

    // Trailing semicolon is harmless but run-query wraps reads in a subquery.
    const sql = String(parsed.sql ?? '').trim().replace(/;\s*$/, '');
    if (!sql) return json({ error: parsed.explanation || 'Could not turn that into a query with the known tables.' }, 400);

    const allowedTypes = new Set(['select', 'insert', 'update', 'delete', 'ddl', 'other']);
    const statementType = allowedTypes.has(String(parsed.statement_type)) ? parsed.statement_type : 'other';

    return json({ sql, explanation: parsed.explanation || '', statement_type: statementType });
  } catch (e) {
    mark('failed_step');
    console.error('nl-to-sql failed', e);
    const m = (e as Error)?.message ?? '';
    return json({ error: m.length < 150 ? m : 'Could not generate that query right now.' }, 400);
  }
});
