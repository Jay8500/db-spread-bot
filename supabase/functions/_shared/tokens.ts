// How an edge function gets a Management API token for a connected project.
// Two kinds of project:
//  - connected via "Connect with Supabase" (connection_id set): OAuth access
//    token from Vault, refreshed automatically shortly before it expires;
//  - added manually with a personal access token (connection_id null): the
//    PAT from Vault, as before.
// Tokens never leave the server.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const OAUTH_TOKEN_URL = 'https://api.supabase.com/v1/oauth/token';
export const OAUTH_AUTHORIZE_URL = 'https://api.supabase.com/v1/oauth/authorize';

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  /** epoch ms */
  expires_at: number;
}

/** Thrown when a Supabase login connection can't be used any more (revoked / expired refresh token). */
export class ReconnectNeeded extends Error {
  constructor() {
    super('Your Supabase connection has expired or was removed — reconnect it on the Projects page.');
  }
}

function clientAuthHeader(): string {
  const id = Deno.env.get('DBBOT_OAUTH_CLIENT_ID');
  const secret = Deno.env.get('DBBOT_OAUTH_CLIENT_SECRET');
  if (!id || !secret) throw new Error('Supabase login is not configured on the server yet.');
  return 'Basic ' + btoa(`${id}:${secret}`);
}

async function tokenRequest(params: Record<string, string>): Promise<OAuthTokens> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: clientAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const msg = data?.message || data?.error_description || data?.error || `status ${res.status}`;
    console.error('oauth token request failed', params.grant_type, res.status, msg);
    const err = new Error(String(msg));
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? params.refresh_token,
    expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
}

export function exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthTokens> {
  return tokenRequest({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri });
}

async function readTokens(admin: SupabaseClient, connectionId: string): Promise<OAuthTokens | null> {
  const { data } = await admin.rpc('get_connection_tokens', { p_connection_id: connectionId });
  if (!data) return null;
  try {
    return JSON.parse(String(data)) as OAuthTokens;
  } catch {
    return null;
  }
}

export async function saveTokens(admin: SupabaseClient, connectionId: string, tokens: OAuthTokens): Promise<void> {
  const { error } = await admin.rpc('set_connection_tokens', { p_connection_id: connectionId, p_tokens: JSON.stringify(tokens) });
  if (error) throw error;
}

/** A valid OAuth access token for a connection, refreshing it if it expires within 2 minutes. */
export async function connectionAccessToken(admin: SupabaseClient, connectionId: string): Promise<string> {
  const tokens = await readTokens(admin, connectionId);
  if (!tokens) throw new ReconnectNeeded();
  if (tokens.expires_at - Date.now() > 120_000) return tokens.access_token;
  try {
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    await saveTokens(admin, connectionId, fresh);
    return fresh.access_token;
  } catch (e) {
    // A concurrent request may have refreshed (and rotated the refresh
    // token) a moment ago — use what it stored if that's valid.
    const again = await readTokens(admin, connectionId);
    if (again && again.access_token !== tokens.access_token && again.expires_at > Date.now()) return again.access_token;
    console.error('oauth refresh failed', connectionId, e);
    throw new ReconnectNeeded();
  }
}

/** Management API token for a connected project row, or null if none is stored. */
export async function projectAccessToken(
  admin: SupabaseClient,
  project: { id: string; connection_id: string | null },
): Promise<string | null> {
  if (project.connection_id) return connectionAccessToken(admin, project.connection_id);
  const { data: pat } = await admin.rpc('get_project_pat', { p_project_id: project.id });
  return (pat as string | null) ?? null;
}
