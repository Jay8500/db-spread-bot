// Turns a plain-English prompt into SQL for one connected project.
// Generates ONLY — never executes, never logged. The browser never sees the
// project's PAT; this function loads it from Vault, asks the real schema,
// then asks Gemini (free tier — no card needed), and hands back
// { sql, explanation, statement_type }.
// Body: { project_id: string, prompt: string }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cors, json } from '../_shared/http.ts';
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

Schema (public schema only):
${tables || '(no tables found)'}

Rules:
- Output ONLY a JSON object, no markdown fences, no prose outside it: {"sql": string, "explanation": string, "statement_type": "select"|"insert"|"update"|"delete"|"ddl"|"other"}
- "sql" is exactly ONE statement, valid PostgreSQL, using only the tables/columns listed above. Never invent a table or column.
- "explanation" is one short plain-English sentence describing exactly what the statement does, for someone who doesn't read SQL.
- Prefer a SELECT whenever the request is just "show me" / "how many" / "what is" — never write/change data unless the request clearly asks for a change.
- A request that can't be done with the schema above → sql: "", explanation: "<what's missing>", statement_type: "other".
- Never use semicolons inside the statement; never return more than one statement.`;
}

async function askGemini(apiKey: string, sys: string, prompt: string): Promise<string> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // Low thinking: one short SQL statement doesn't need deep reasoning, and
    // the default level roughly triples latency.
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, thinkingConfig: { thinkingLevel: 'low' } },
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
      return (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('').trim();
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
  throw new Error('The AI service is busy right now — try again in a minute.');
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
    if (!pat) return json({ error: 'No token saved for this project yet.' }, 400);

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) return json({ error: 'AI is not configured yet.' }, 500);

    const schema = await fetchSchema(pat, project.project_ref);
    const text = await askGemini(apiKey, system(schema), prompt);

    let parsed: { sql?: string; explanation?: string; statement_type?: string };
    try {
      parsed = JSON.parse(text.replace(/^```(json)?/i, '').replace(/```$/, '').trim());
    } catch {
      return json({ error: 'Could not understand that as a query — try rephrasing.' }, 400);
    }
    const sql = String(parsed.sql ?? '').trim();
    if (!sql) return json({ error: parsed.explanation || 'Could not turn that into a query with the known tables.' }, 400);

    const allowedTypes = new Set(['select', 'insert', 'update', 'delete', 'ddl', 'other']);
    const statementType = allowedTypes.has(String(parsed.statement_type)) ? parsed.statement_type : 'other';

    return json({ sql, explanation: parsed.explanation || '', statement_type: statementType });
  } catch (e) {
    console.error('nl-to-sql failed', e);
    const m = (e as Error)?.message ?? '';
    return json({ error: m.length < 150 ? m : 'Could not generate that query right now.' }, 400);
  }
});
