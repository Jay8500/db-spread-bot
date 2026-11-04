import { Injectable, signal } from '@angular/core';
import { createClient, Session, SupabaseClient, User } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import { UserFacingError } from './toast.service';

/** False until the real control-plane project URL/key replace the scaffold
 *  placeholders — createClient() throws on an invalid URL, which would
 *  otherwise blank the whole app at boot with no visible error. */
const IS_CONFIGURED = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(environment.supabaseUrl);

export interface ConnectedProject {
  id: string;
  owner_id: string;
  name: string;
  project_ref: string;
  project_url: string;
  allow_writes: boolean;
  /** Set when added via "Connect with Supabase"; null for token-added projects. */
  connection_id: string | null;
  created_at: string;
}

/** A project visible through a Supabase login connection. */
export interface SupabaseAccountProject {
  ref: string;
  name: string;
  region: string;
  status: string;
  organization_id: string;
  /** Already connected: via this kind of login ('token' ones can be switched to the Supabase login), or false. */
  connected: 'login' | 'token' | false;
}

export interface ConnectionProjects {
  connection_id: string;
  projects: SupabaseAccountProject[];
}

const OAUTH_STATE_KEY = 'dbbot-oauth';

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export type StatementType = 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other';

export interface GeneratedSql {
  sql: string;
  explanation: string;
  statement_type: StatementType;
}

export interface QueryResult {
  rows: Record<string, unknown>[] | null;
  row_count: number | null;
  error: string | null;
}

export interface ActivityRow {
  id: string;
  project_id: string;
  prompt: string;
  generated_sql: string;
  statement_type: StatementType;
  status: 'success' | 'failed';
  error: string | null;
  executed_at: string;
}

/** Talks to THIS app's own control-plane project only — never to a connected
 *  project's database directly. Connected-project SQL always goes through
 *  the nl-to-sql / run-query edge functions, so a target project's
 *  credentials never reach the browser. */
@Injectable({ providedIn: 'root' })
export class SupabaseService {
  readonly configured = IS_CONFIGURED;
  readonly client: SupabaseClient = createClient(
    IS_CONFIGURED ? environment.supabaseUrl : 'https://placeholder.supabase.co',
    IS_CONFIGURED ? environment.supabaseAnonKey : 'placeholder',
  );

  readonly session = signal<Session | null>(null);
  readonly user = signal<User | null>(null);
  readonly ready = signal(false);

  async init(): Promise<void> {
    if (!IS_CONFIGURED) {
      this.ready.set(true);
      return;
    }
    const { data } = await this.client.auth.getSession();
    this.session.set(data.session);
    this.user.set(data.session?.user ?? null);
    this.client.auth.onAuthStateChange((_event, session) => {
      this.session.set(session);
      this.user.set(session?.user ?? null);
    });
    this.ready.set(true);
  }

  async signIn(email: string, password: string) {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  /** Self sign-up. Returns true when the user must confirm their email before signing in. */
  async signUp(email: string, password: string): Promise<boolean> {
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${location.origin}/query` },
    });
    if (error) throw error;
    return !data.session;
  }

  async signOut() {
    await this.client.auth.signOut({ scope: 'local' });
  }

  // ── Connected projects ──
  async listProjects(): Promise<ConnectedProject[]> {
    const { data, error } = await this.client.from('connected_projects').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  /** `pat` is written straight into Vault by the `set_project_secret` RPC — never stored in a plain table. */
  async addProject(input: { name: string; project_ref: string; project_url: string; pat: string }): Promise<ConnectedProject> {
    const { data, error } = await this.client
      .from('connected_projects')
      .insert({ name: input.name, project_ref: input.project_ref, project_url: input.project_url })
      .select()
      .single();
    if (error) throw error;
    const { error: secretErr } = await this.client.rpc('set_project_secret', { p_project_id: data.id, p_pat: input.pat });
    if (secretErr) {
      await this.client.from('connected_projects').delete().eq('id', data.id);
      throw secretErr;
    }
    return data;
  }

  async updateProjectPat(projectId: string, pat: string) {
    const { error } = await this.client.rpc('set_project_secret', { p_project_id: projectId, p_pat: pat });
    if (error) throw error;
  }

  async setAllowWrites(projectId: string, allow: boolean) {
    const { error } = await this.client.from('connected_projects').update({ allow_writes: allow }).eq('id', projectId);
    if (error) throw error;
  }

  async renameProject(projectId: string, name: string) {
    const { error } = await this.client.from('connected_projects').update({ name }).eq('id', projectId);
    if (error) throw error;
  }

  async deleteProject(projectId: string) {
    const { error } = await this.client.from('connected_projects').delete().eq('id', projectId);
    if (error) throw error;
  }

  // ── "Connect with Supabase" (OAuth + PKCE) ──
  private get oauthRedirectUri() {
    return `${location.origin}/connect/callback`;
  }

  /** Sends the browser to Supabase's consent screen. Comes back to /connect/callback. */
  async startSupabaseConnect(): Promise<void> {
    const verifier = randomString(48);
    const state = randomString(16);
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    sessionStorage.setItem(OAUTH_STATE_KEY, JSON.stringify({ verifier, state }));
    const params = new URLSearchParams({
      client_id: environment.supabaseOAuthClientId,
      redirect_uri: this.oauthRedirectUri,
      response_type: 'code',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    location.assign(`https://api.supabase.com/v1/oauth/authorize?${params}`);
  }

  /** Called on /connect/callback: checks state, exchanges the code server-side, returns the account's projects. */
  async finishSupabaseConnect(code: string, state: string): Promise<ConnectionProjects> {
    let saved: { verifier?: string; state?: string } = {};
    try {
      saved = JSON.parse(sessionStorage.getItem(OAUTH_STATE_KEY) ?? '{}');
    } catch {
      /* treated as missing below */
    }
    sessionStorage.removeItem(OAUTH_STATE_KEY);
    if (!saved.verifier || saved.state !== state) {
      throw new UserFacingError('This sign-in link was already used or came from somewhere else — try connecting again.');
    }
    return this.connectCall<ConnectionProjects>({
      action: 'exchange',
      code,
      code_verifier: saved.verifier,
      redirect_uri: this.oauthRedirectUri,
    });
  }

  connectionProjects(connectionId: string): Promise<ConnectionProjects> {
    return this.connectCall({ action: 'projects', connection_id: connectionId });
  }

  addConnectionProjects(connectionId: string, refs: string[]): Promise<{ added: number }> {
    return this.connectCall({ action: 'add', connection_id: connectionId, refs });
  }

  private async connectCall<T>(body: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.functions.invoke('supabase-connect', { body });
    if (error) throw await unwrapFunctionError(error);
    return data as T;
  }

  // ── Plain-English querying (both run server-side via edge functions) ──
  async generateSql(projectId: string, prompt: string): Promise<GeneratedSql> {
    const { data, error } = await this.client.functions.invoke('nl-to-sql', { body: { project_id: projectId, prompt } });
    if (error) throw await unwrapFunctionError(error);
    return data as GeneratedSql;
  }

  async runQuery(projectId: string, sql: string, statementType: StatementType, prompt: string, confirmed: boolean): Promise<QueryResult> {
    const { data, error } = await this.client.functions.invoke('run-query', {
      body: { project_id: projectId, sql, statement_type: statementType, prompt, confirmed },
    });
    if (error) throw await unwrapFunctionError(error);
    return data as QueryResult;
  }

  // ── Activity log ──
  async listActivity(limit = 100): Promise<ActivityRow[]> {
    const { data, error } = await this.client
      .from('query_log')
      .select('*')
      .order('executed_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  }
}

/**
 * functions.invoke() reports any non-2xx as a generic "Edge Function returned
 * a non-2xx status code" — the function's own { error } message is only in
 * the response body (error.context). Surface that instead.
 */
async function unwrapFunctionError(error: unknown): Promise<Error> {
  const res = (error as { context?: Response })?.context;
  if (res && typeof res.json === 'function') {
    try {
      const body = await res.clone().json();
      // Our functions' { error } text is written for the user; 401s still go
      // through the normal mapping so they read as "session expired".
      if (body?.error) return res.status === 401 ? new Error(String(body.error)) : new UserFacingError(String(body.error));
      if (body?.message) return new Error(String(body.message));
    } catch {
      /* body wasn't JSON — fall through */
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
