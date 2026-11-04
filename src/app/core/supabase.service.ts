import { Injectable, signal } from '@angular/core';
import { createClient, Session, SupabaseClient, User } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

export interface ConnectedProject {
  id: string;
  owner_id: string;
  name: string;
  project_ref: string;
  project_url: string;
  allow_writes: boolean;
  created_at: string;
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
  readonly client: SupabaseClient = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

  readonly session = signal<Session | null>(null);
  readonly user = signal<User | null>(null);
  readonly ready = signal(false);

  async init(): Promise<void> {
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

  // ── Plain-English querying (both run server-side via edge functions) ──
  async generateSql(projectId: string, prompt: string): Promise<GeneratedSql> {
    const { data, error } = await this.client.functions.invoke('nl-to-sql', { body: { project_id: projectId, prompt } });
    if (error) throw error;
    return data as GeneratedSql;
  }

  async runQuery(projectId: string, sql: string, statementType: StatementType, prompt: string, confirmed: boolean): Promise<QueryResult> {
    const { data, error } = await this.client.functions.invoke('run-query', {
      body: { project_id: projectId, sql, statement_type: statementType, prompt, confirmed },
    });
    if (error) throw error;
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
