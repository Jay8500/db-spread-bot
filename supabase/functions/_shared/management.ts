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

// auth.users holds who the app's users are (email, name in metadata) — the
// most common thing asked about — so expose a safe subset of it. Password
// hashes, tokens and other internals are deliberately left out.
const AUTH_USER_COLUMNS = [
  'id', 'email', 'phone', 'created_at', 'updated_at', 'last_sign_in_at',
  'email_confirmed_at', 'raw_user_meta_data', 'raw_app_meta_data', 'banned_until', 'deleted_at',
];

/** information_schema snapshot (public schema + auth.users subset), grounded for the model. */
export async function fetchSchema(pat: string, projectRef: string): Promise<{ table: string; columns: string }[]> {
  const authCols = AUTH_USER_COLUMNS.map((c) => `'${c}'`).join(', ');
  const sql = `
    select case when table_schema = 'public' then table_name else table_schema || '.' || table_name end as table_name,
           string_agg(column_name || ' ' || data_type || case when is_nullable = 'NO' then ' not null' else '' end, ', ' order by ordinal_position) as columns
    from information_schema.columns
    where table_schema = 'public'
       or (table_schema = 'auth' and table_name = 'users' and column_name in (${authCols}))
    group by table_schema, table_name
    order by table_schema desc, table_name;
  `;
  const rows = await managementQuery(pat, projectRef, sql);
  return rows.map((r) => ({ table: String(r['table_name']), columns: String(r['columns']) }));
}
