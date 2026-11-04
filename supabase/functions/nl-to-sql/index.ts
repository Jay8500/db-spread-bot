// Turns a plain-English prompt into SQL for one connected project.
// Generates ONLY — never executes, never logged. The browser never sees the
// project's PAT; this function loads it from Vault, asks the real schema,
// then asks Gemini (free tier — no card needed), and hands back
// { sql, explanation, statement_type }.
// Body: { project_id: string, prompt: string }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cors, json as baseJson } from '../_shared/http.ts';
import { fetchSchema } from '../_shared/management.ts';

// Tried in order. Google retires older models for new keys and the newest one
// often returns 503 "high demand" on the free tier, so fall through on
// 404/429/503 rather than failing the request.
// gemini-3.8-flash is left out: on the free tier it often hangs 40s+ before
// failing. 3.5-flash with low thinking answers in ~1.5s (measured Nov 2026).
const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const PER_MODEL_TIMEOUT_MS = 15_000;

function system(schema: { table: string; columns: string }[]): string {
  const tables = schema.map((t) => `- ${t.table}(${t.columns})`).join('\n');
  return `You translate a plain-English request into one PostgreSQL statement for a Supabase (Postgres) database.

Schema (public tables unqualified; auth.users is Supabase's built-in user table):
${tables || '(no tables found)'}

Rules:
- For questions about users / people / sign-ups / who someone is, use auth.users (always write it schema-qualified as auth.users). Display names are usually in raw_user_meta_data->>'full_name' or raw_user_meta_data->>'name' — use coalesce over both, falling back to email. Join public tables to it via their user id / owner_id columns.
- Never insert/update/delete anything in auth.users — it is read-only here.
- Questions about the database's own structure (how many tables, list tables/columns, table sizes, row counts per table, indexes) → query information_schema or pg_catalog (e.g. information_schema.tables, information_schema.columns, pg_stat_user_tables), limited to table_schema = 'public' unless another schema is asked for.
- Output ONLY a JSON object: {"sql": string, "explanation": string, "statement_type": "select"|"insert"|"update"|"delete"|"ddl"|"other"}
- "sql" is exactly ONE statement, valid PostgreSQL, using only the tables/columns listed above (or the system catalogs for structure questions). Never invent a table or column.
- "explanation" is one short plain-English sentence describing exactly what the statement does, for someone who doesn't read SQL.
- Prefer a SELECT whenever the request is just "show me" / "how many" / "what is" — never write/change data unless the request clearly asks for a change.
- A request that can't be done with the schema above → sql: "", explanation: "<what's missing>", statement_type: "other".
- Never use semicolons inside the statement; never return more than one statement.`;
}

type Generated = { sql?: string; explanation?: string; statement_type?: string };

/** Pulls the JSON object out of the model text, tolerating fences or stray prose around it. */
function parseGenerated(text: string): Generated | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' ? (v as Generated) : null;
  } catch {
    return null;
  }
}

async function askGemini(apiKey: string, sys: string, prompt: string): Promise<Generated> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      // Structured output: Gemini is constrained to exactly this shape, so
      // the reply always parses (free-form JSON mode occasionally didn't).
      responseSchema: {
        type: 'OBJECT',
        properties: {
          sql: { type: 'STRING' },
          explanation: { type: 'STRING' },
          statement_type: { type: 'STRING', enum: ['select', 'insert', 'update', 'delete', 'ddl', 'other'] },
        },
        required: ['sql', 'explanation', 'statement_type'],
        propertyOrdering: ['sql', 'explanation', 'statement_type'],
      },
      temperature: 0.1,
      // Low thinking: one short SQL statement doesn't need deep reasoning, and
      // the default level roughly triples latency.
      thinkingConfig: { thinkingLevel: 'low' },
    },
  });
  let lastStatus = 0;
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(PER_MODEL_TIMEOUT_MS),
      });
    } catch (e) {
      console.error('Gemini timeout/network', model, e);
      lastStatus = 503;
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? [])
        .filter((p: { thought?: boolean }) => !p.thought)
        .map((p: { text?: string }) => p.text ?? '')
        .join('')
        .trim();
      const parsed = parseGenerated(text);
      if (parsed) return parsed;
      // Unparseable (empty, cut off, blocked…) — log what came back, try the next model.
      console.error('Gemini unparseable', model, cand?.finishReason, text.slice(0, 500));
      lastStatus = 422;
      continue;
    }
    lastStatus = res.status;
    const detail = await res.json().then((d) => d?.error?.message as string | undefined).catch(() => undefined);
    console.error('Gemini error', model, res.status, detail);
    if (/api key/i.test(detail ?? '')) throw new Error('The AI key on the server is not valid — reset GEMINI_API_KEY.');
    if (![404, 429, 503].includes(res.status)) {
      throw new Error(`AI request failed (${res.status})${detail ? `: ${detail.slice(0, 100)}` : ''}`);
    }
  }
  if (lastStatus === 429) throw new Error('Free AI quota hit for the moment — wait a minute and try again.');
  if (lastStatus === 422) throw new Error('Could not understand that as a query — try rephrasing.');
  throw new Error('The AI service is busy right now — try again in a minute.');
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
    if (!projectId || prompt.length < 3) return json({ error: 'Pick a project and type a question.' }, 400);

    const { data: project } = await admin
      .from('connected_projects')
      .select('id, project_ref, owner_id')
      .eq('id', projectId)
      .eq('owner_id', u.user.id)
      .single();
    if (!project) return json({ error: 'Project not found.' }, 404);

    const { data: pat } = await admin.rpc('get_project_pat', { p_project_id: projectId });
    mark('project_and_token');
    if (!pat) return json({ error: 'No token saved for this project yet.' }, 400);

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) return json({ error: 'AI is not configured yet.' }, 500);

    const schema = await fetchSchema(pat, project.project_ref);
    mark('schema');
    const parsed = await askGemini(apiKey, system(schema), prompt);
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
