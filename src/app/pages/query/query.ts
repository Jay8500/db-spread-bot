import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { DialogService } from '../../core/dialog.service';
import { ConnectedProject, GeneratedSql, QueryResult, StatementType, SupabaseService } from '../../core/supabase.service';
import { ToastService } from '../../core/toast.service';

const WRITE_TYPES = new Set<StatementType>(['insert', 'update', 'delete', 'ddl']);
const DANGER_RE = /\b(drop|truncate|alter)\b/i;

const STATEMENT_LABEL: Record<StatementType, string> = {
  select: 'Read',
  insert: 'Insert',
  update: 'Update',
  delete: 'Delete',
  ddl: 'Schema change',
  other: 'Other',
};

@Component({
  selector: 'app-query',
  imports: [FormsModule, RouterLink, LucideAngularModule],
  template: `
    <h1 class="section-title text-xl">Ask in plain English</h1>
    <p class="mt-1 text-sm text-slate-500">Pick a project, type what you need. Reads show results right away; changes wait for your confirmation.</p>

    @if (!loadingProjects() && !projects().length) {
      <div class="card mt-5 flex items-center justify-between gap-3 p-5">
        <p class="text-sm text-slate-600">No projects connected yet.</p>
        <a routerLink="/projects" class="btn-primary shrink-0">Connect a project</a>
      </div>
    } @else {
      <div class="card mt-5 space-y-4 p-5">
        <div>
          <label class="label" for="proj">Project</label>
          <select id="proj" class="input" [ngModel]="projectId()" (ngModelChange)="projectId.set($event)">
            <option value="" disabled>Choose a project…</option>
            @for (p of projects(); track p.id) {
              <option [value]="p.id">{{ p.name }} {{ p.allow_writes ? '' : '· read-only' }}</option>
            }
          </select>
        </div>

        <div>
          <label class="label" for="prompt">What do you need?</label>
          <div class="flex gap-2">
            <input
              id="prompt"
              class="input"
              [ngModel]="prompt()"
              (ngModelChange)="prompt.set($event)"
              name="prompt"
              placeholder="e.g. show me today's walkins"
              (keydown.enter)="ask()"
            />
            <button class="btn-primary shrink-0" (click)="ask()" [disabled]="asking() || !projectId() || !prompt().trim()">
              @if (asking()) {
                <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
              } @else {
                <lucide-icon name="send" class="size-4" />
              }
              Ask
            </button>
          </div>
        </div>
      </div>
    }

    @if (generated(); as g) {
      <div class="card mt-4 space-y-3 p-5">
        <div class="flex flex-wrap items-center gap-2">
          <span class="pill" [class]="isWrite(g.statement_type) ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'">
            {{ statementLabel[g.statement_type] }}
          </span>
          @if (isDanger(g.sql)) {
            <span class="pill border-rose-200 bg-rose-50 text-rose-700"><lucide-icon name="triangle-alert" class="size-3.5" /> Danger zone</span>
          }
        </div>
        <p class="text-sm text-slate-600">{{ g.explanation }}</p>
        <pre class="overflow-x-auto rounded-xl bg-slate-900 p-3.5 text-xs leading-relaxed text-emerald-300">{{ g.sql }}</pre>

        <div class="flex gap-2">
          <button class="btn-primary" (click)="run(g)" [disabled]="running()">
            @if (running()) {
              <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
            } @else {
              <lucide-icon name="play" class="size-4" />
            }
            {{ isWrite(g.statement_type) ? 'Confirm & Run' : result() ? 'Run again' : 'Run' }}
          </button>
          <button class="btn-ghost" (click)="generated.set(null); result.set(null)">{{ result() ? 'Clear' : 'Discard' }}</button>
        </div>
      </div>
    }

    @if (result(); as r) {
      <div class="card mt-4 p-5">
        @if (r.error) {
          <p class="text-sm font-semibold text-rose-600">{{ r.error }}</p>
        } @else if (!r.rows?.length) {
          <p class="text-sm text-slate-400">Ran successfully — no rows returned.</p>
        } @else {
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead>
                <tr class="border-b border-slate-100 text-slate-400">
                  @for (col of columns(r); track col) {
                    <th class="px-2.5 py-2 font-semibold whitespace-nowrap">{{ col }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of r.rows; track $index) {
                  <tr class="border-b border-slate-50">
                    @for (col of columns(r); track col) {
                      <td class="px-2.5 py-2 whitespace-nowrap text-slate-700">{{ cell(row, col) }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-xs text-slate-400">{{ r.row_count }} row(s).</p>
        }
      </div>
    }
  `,
})
export class Query implements OnInit {
  private readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);
  private readonly dialog = inject(DialogService);

  protected readonly statementLabel = STATEMENT_LABEL;
  protected readonly projects = signal<ConnectedProject[]>([]);
  protected readonly loadingProjects = signal(true);
  protected readonly projectId = signal('');
  protected readonly prompt = signal('');
  protected readonly asking = signal(false);
  protected readonly running = signal(false);
  protected readonly generated = signal<GeneratedSql | null>(null);
  protected readonly result = signal<QueryResult | null>(null);

  async ngOnInit() {
    try {
      this.projects.set(await this.supabase.listProjects());
    } catch (e) {
      this.toast.fail(e, 'Could not load projects.');
    } finally {
      this.loadingProjects.set(false);
    }
  }

  isWrite(t: StatementType) {
    return WRITE_TYPES.has(t);
  }

  isDanger(sql: string) {
    return DANGER_RE.test(sql);
  }

  columns(r: QueryResult): string[] {
    return r.rows?.length ? Object.keys(r.rows[0]) : [];
  }

  cell(row: Record<string, unknown>, col: string): string {
    const v = row[col];
    if (v === null || v === undefined) return '—';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  async ask() {
    if (!this.projectId() || !this.prompt().trim()) return;
    this.asking.set(true);
    this.generated.set(null);
    this.result.set(null);
    try {
      const g = await this.supabase.generateSql(this.projectId(), this.prompt().trim());
      this.generated.set(g);
      // One click for reads: run straight away. The server forces reads to be
      // structurally read-only, so this can't change data. Anything else
      // still waits for an explicit Confirm & Run.
      if (this.isAutoRun(g)) {
        this.asking.set(false);
        await this.run(g, true);
      }
    } catch (e) {
      this.toast.fail(e, 'Could not turn that into a query.');
    } finally {
      this.asking.set(false);
    }
  }

  isAutoRun(g: GeneratedSql): boolean {
    return g.statement_type === 'select' && /^\s*(select|with)\b/i.test(g.sql) && !this.isDanger(g.sql);
  }

  async run(g: GeneratedSql, auto = false) {
    const project = this.projects().find((p) => p.id === this.projectId());
    if (!project) return;

    if (this.isWrite(g.statement_type) && !project.allow_writes) {
      this.toast.warn(`${project.name} is read-only. Turn on "Allow writes" on the Projects page first.`);
      return;
    }

    if (this.isDanger(g.sql)) {
      const typed = await this.dialog.prompt({
        title: 'This changes the structure of the database',
        message: 'DROP, TRUNCATE and ALTER can delete data or break existing features permanently.',
        label: `Type DANGER to confirm running this on ${project.name}`,
        requireMatch: 'DANGER',
        tone: 'danger',
        confirmText: 'Run it',
      });
      if (typed !== 'DANGER') return;
    } else if (this.isWrite(g.statement_type)) {
      const ok = await this.dialog.confirm({
        title: `Run this on ${project.name}?`,
        message: 'This will change data in the connected project.',
        tone: 'warning',
        confirmText: 'Confirm & Run',
      });
      if (!ok) return;
    }

    this.running.set(true);
    try {
      const r = await this.supabase.runQuery(project.id, g.sql, g.statement_type, this.prompt().trim(), true);
      this.result.set(r);
      if (r.error) this.toast.error(r.error);
      else if (!auto) this.toast.success('Done.');
    } catch (e) {
      this.toast.fail(e, 'Could not run that query.');
    } finally {
      this.running.set(false);
    }
  }
}
