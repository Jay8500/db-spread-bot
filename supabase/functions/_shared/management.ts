// Thin wrapper around the Supabase Management API — this is how every
// connected project is queried. No direct Postgres connection is opened
// from here, so a free-tier target project's own connection pool is never
// touched by this tool.
const MGMT_BASE = 'https://api.supabase.com/v1';

export interface MgmtRow {
  [key: string]: unknown;
}

export async function managementQuery(pat: string, projectRef: string, sql: string): Promise<MgmtRow[]> {
  const res = await fetch(`${MGMT_BASE}/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Management API error ${res.status}`;
    throw new Error(String(msg));
  }
  return Array.isArray(data) ? (data as MgmtRow[]) : [];
}

/** information_schema snapshot of the public schema, grounded for the model. */
export async function fetchSchema(pat: string, projectRef: string): Promise<{ table: string; columns: string }[]> {
  const sql = `
    select table_name,
           string_agg(column_name || ' ' || data_type || case when is_nullable = 'NO' then ' not null' else '' end, ', ' order by ordinal_position) as columns
    from information_schema.columns
    where table_schema = 'public'
    group by table_name
    order by table_name;
  `;
  const rows = await managementQuery(pat, projectRef, sql);
  return rows.map((r) => ({ table: String(r['table_name']), columns: String(r['columns']) }));
}
