import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { ConnectedProject, ProjectInfo, QueryResult, SupabaseService, TableInfo } from '../../core/supabase.service';
import { ToastService } from '../../core/toast.service';
import { friendlyHeader, ResultTable } from '../../shared/result-table';

const LAST_PROJECT_KEY = 'dbbot-last-project';
const BROWSE_LIMIT = 50;
const num = new Intl.NumberFormat('en-IN');

/** Every table in a project at a glance — no Supabase dashboard needed. */
@Component({
  selector: 'app-tables',
  imports: [FormsModule, RouterLink, LucideAngularModule, ResultTable, DatePipe],
  template: `
    <h1 class="section-title text-xl">Tables</h1>
    <p class="mt-1 text-sm text-slate-500">See what's in each project and peek at the latest rows — no SQL, no Supabase dashboard.</p>

    @if (!loadingProjects() && !projects().length) {
      <div class="card mt-5 flex items-center justify-between gap-3 p-5">
        <p class="text-sm text-slate-600">No projects connected yet.</p>
        <a routerLink="/projects" class="btn-primary shrink-0">Connect a project</a>
      </div>
    } @else {
      <div class="card mt-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <div class="flex-1">
          <label class="label" for="t-proj">Project</label>
          <select id="t-proj" class="input" [ngModel]="projectId()" (ngModelChange)="selectProject($event)">
            <option value="" disabled>Choose a project…</option>
            @for (p of projects(); track p.id) {
              <option [value]="p.id">{{ p.name }}</option>
            }
          </select>
        </div>
        <div class="flex-1">
          <label class="label" for="t-search">Find a table</label>
          <div class="relative">
            <lucide-icon name="search" class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input id="t-search" class="input pl-9" placeholder="e.g. walk, bill, patient" [ngModel]="search()" (ngModelChange)="search.set($event)" />
          </div>
        </div>
        <button class="btn-ghost shrink-0" (click)="load(true)" [disabled]="loading() || !projectId()" title="Recount rows">
          <lucide-icon name="refresh-cw" class="size-4" [class.animate-spin]="loading()" /> Refresh
        </button>
      </div>

      @if (loading() && !info()) {
        <div class="card mt-4 flex items-center gap-3 p-6 text-sm text-slate-500"><lucide-icon name="refresh-cw" class="size-4 animate-spin" /> Reading tables…</div>
      } @else if (info(); as i) {
        <p class="mt-4 mb-2 text-xs text-slate-400">
          {{ i.tables.length }} table{{ i.tables.length === 1 ? '' : 's' }} · row counts as of {{ i.updated_at | date: 'MMM d, h:mm a' }}
        </p>
        <div class="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <!-- Table list -->
          <div class="card max-h-[70vh] overflow-y-auto p-2">
            @for (t of filtered(); track t.name) {
              <button
                class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50"
                [class]="selected()?.name === t.name ? '!bg-brand/10' : ''"
                (click)="open(t)"
              >
                <lucide-icon name="table-2" class="size-4 shrink-0" [class]="selected()?.name === t.name ? 'text-brand' : 'text-slate-400'" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-semibold text-slate-700">{{ title(t.name) }}</span>
                  <span class="block truncate font-mono text-[11px] text-slate-400">{{ t.name }}</span>
                </span>
                <span class="shrink-0 text-xs text-slate-400 tabular-nums">{{ t.kind === 'view' ? 'view' : count(t.rows) }}</span>
              </button>
            } @empty {
              <p class="p-4 text-center text-sm text-slate-400">No tables match “{{ search() }}”.</p>
            }
          </div>

          <!-- Selected table -->
          <div class="card min-w-0 p-5">
            @if (selected(); as t) {
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <h2 class="truncate text-base font-bold text-slate-800">{{ title(t.name) }}</h2>
                  <p class="text-xs text-slate-400">
                    {{ t.kind === 'view' ? 'View' : count(t.rows) + ' rows' }} · {{ t.columns.length }} columns · latest {{ browseLimit }} shown
                  </p>
                </div>
                <button class="btn-primary" (click)="askAbout(t)"><lucide-icon name="bot" class="size-4" /> Ask about this table</button>
              </div>

              <details class="mt-3">
                <summary class="cursor-pointer text-xs font-semibold text-slate-400 select-none hover:text-slate-600">Columns</summary>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  @for (c of t.columns; track c.name) {
                    <span class="rounded-lg bg-slate-50 px-2 py-1 text-[11px] text-slate-600 ring-1 ring-slate-100">
                      {{ c.name }} <span class="text-slate-400">{{ c.type }}</span>
                    </span>
                  }
                </div>
              </details>

              <div class="mt-4">
                @if (browsing()) {
                  <p class="flex items-center gap-2 text-sm text-slate-500"><lucide-icon name="refresh-cw" class="size-4 animate-spin" /> Loading rows…</p>
                } @else if (rows(); as r) {
                  @if (r.error) {
                    <p class="text-sm font-semibold text-rose-600">{{ r.error }}</p>
                  } @else {
                    <app-result-table [rows]="r.rows ?? []" [total]="r.row_count" [fileName]="t.name" emptyText="This table is empty." />
                  }
                }
              </div>
            } @else {
              <p class="py-10 text-center text-sm text-slate-400">Pick a table to see its latest rows.</p>
            }
          </div>
        </div>
      }
    }
  `,
})
export class Tables implements OnInit {
  private readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly browseLimit = BROWSE_LIMIT;
  protected readonly projects = signal<ConnectedProject[]>([]);
  protected readonly loadingProjects = signal(true);
  protected readonly projectId = signal('');
  protected readonly info = signal<ProjectInfo | null>(null);
  protected readonly loading = signal(false);
  protected readonly search = signal('');
  protected readonly selected = signal<TableInfo | null>(null);
  protected readonly rows = signal<QueryResult | null>(null);
  protected readonly browsing = signal(false);

  protected readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase().replace(/\s+/g, '_');
    const all = this.info()?.tables ?? [];
    return q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all;
  });

  async ngOnInit() {
    try {
      this.projects.set(await this.supabase.listProjects());
    } catch (e) {
      this.toast.fail(e, 'Could not load projects.');
    } finally {
      this.loadingProjects.set(false);
    }
    let remembered = '';
    try {
      remembered = localStorage.getItem(LAST_PROJECT_KEY) ?? '';
    } catch {
      /* storage blocked */
    }
    const pick = this.projects().find((p) => p.id === remembered)?.id ?? this.projects()[0]?.id;
    if (pick) this.selectProject(pick);
  }

  selectProject(id: string) {
    this.projectId.set(id);
    this.info.set(null);
    this.selected.set(null);
    this.rows.set(null);
    try {
      localStorage.setItem(LAST_PROJECT_KEY, id);
    } catch {
      /* storage blocked */
    }
    this.load(false);
  }

  async load(refresh: boolean) {
    const id = this.projectId();
    if (!id) return;
    this.loading.set(true);
    try {
      const info = await this.supabase.projectInfo(id, refresh);
      if (this.projectId() !== id) return;
      this.info.set(info);
      // Keep the open table in sync with fresh counts.
      const open = this.selected();
      if (open) this.selected.set(info.tables.find((t) => t.name === open.name) ?? null);
    } catch (e) {
      this.toast.fail(e, 'Could not read the tables of this project.');
    } finally {
      this.loading.set(false);
    }
  }

  title(name: string) {
    return friendlyHeader(name);
  }

  count(n: number | null) {
    return n === null ? '—' : num.format(n);
  }

  async open(t: TableInfo) {
    this.selected.set(t);
    this.rows.set(null);
    this.browsing.set(true);
    // Newest first when the table has an obvious timestamp/id column.
    const cols = t.columns.map((c) => c.name);
    const orderCol =
      ['created_at', 'updated_at', 'inserted_at'].find((c) => cols.includes(c)) ??
      t.columns.find((c) => /timestamp|date/.test(c.type))?.name ??
      (cols.includes('id') ? 'id' : null);
    const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const sql = `select * from public.${ident(t.name)}${orderCol ? ` order by ${ident(orderCol)} desc nulls last` : ''} limit ${BROWSE_LIMIT}`;
    try {
      const r = await this.supabase.runQuery(this.projectId(), sql, 'select', `Browse ${t.name}`, false);
      if (this.selected()?.name === t.name) this.rows.set(r);
    } catch (e) {
      this.toast.fail(e, 'Could not load rows.');
    } finally {
      this.browsing.set(false);
    }
  }

  askAbout(t: TableInfo) {
    this.router.navigate(['/query'], { queryParams: { project: this.projectId(), prompt: `${t.name.replace(/_/g, ' ')} ` } });
  }
}
