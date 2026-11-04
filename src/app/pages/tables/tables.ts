import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import {
  ConnectedProject,
  DbFunctionInfo,
  EdgeFunctionInfo,
  Explanation,
  ExplainKind,
  PolicyInfo,
  ProjectInfo,
  QueryResult,
  SupabaseService,
  TableInfo,
  TriggerInfo,
} from '../../core/supabase.service';
import { ToastService } from '../../core/toast.service';
import { friendlyHeader, ResultTable } from '../../shared/result-table';

const LAST_PROJECT_KEY = 'dbbot-last-project';
const BROWSE_LIMIT = 50;
const num = new Intl.NumberFormat('en-IN');

type Tab = 'tables' | 'functions' | 'triggers' | 'policies' | 'edge';

interface Selection {
  kind: ExplainKind;
  /** For policies: "table.policy". */
  key: string;
}

interface ListItem {
  key: string;
  title: string;
  sub: string;
  badge?: string;
  warn?: boolean;
}

/** Everything in a project — tables, functions, triggers, security rules, edge functions — linked and explained. */
@Component({
  selector: 'app-tables',
  imports: [FormsModule, RouterLink, LucideAngularModule, ResultTable, DatePipe],
  template: `
    <h1 class="section-title text-xl">Database</h1>
    <p class="mt-1 text-sm text-slate-500">
      Tables, functions, triggers, security rules and edge functions — with plain-English explanations. No Supabase dashboard needed.
    </p>

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
          <label class="label" for="t-search">Search</label>
          <div class="relative">
            <lucide-icon name="search" class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input id="t-search" class="input pl-9" placeholder="e.g. walk, bill, payment" [ngModel]="search()" (ngModelChange)="search.set($event)" />
          </div>
        </div>
        <button class="btn-ghost shrink-0" (click)="load(true)" [disabled]="loading() || !projectId()" title="Read the project again">
          <lucide-icon name="refresh-cw" class="size-4" [class.animate-spin]="loading()" /> Refresh
        </button>
      </div>

      @if (loading() && !info()) {
        <div class="card mt-4 flex items-center gap-3 p-6 text-sm text-slate-500"><lucide-icon name="refresh-cw" class="size-4 animate-spin" /> Reading the project…</div>
      } @else if (info(); as i) {
        <!-- Tabs -->
        <div class="mt-4 flex gap-1 overflow-x-auto rounded-2xl bg-slate-100/80 p-1">
          @for (t of tabs; track t.id) {
            <button
              class="flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition"
              [class]="tab() === t.id ? 'bg-white text-brand shadow-sm' : 'text-slate-500 hover:text-slate-700'"
              (click)="setTab(t.id)"
            >
              {{ t.label }}
              <span class="rounded-full bg-slate-200/70 px-1.5 text-[10px] text-slate-500 tabular-nums">{{ tabCount(t.id) }}</span>
            </button>
          }
        </div>
        <p class="mt-2 mb-2 text-xs text-slate-400">As of {{ i.updated_at | date: 'MMM d, h:mm a' }}</p>

        <div class="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <!-- List -->
          <div class="card max-h-[70vh] overflow-y-auto p-2">
            @if (tab() === 'edge' && i.edge_functions === null) {
              <p class="p-4 text-sm text-amber-700">{{ i.edge_functions_note }}</p>
            }
            @for (it of items(); track it.key) {
              <button
                class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50"
                [class]="sel()?.key === it.key && sel()?.kind === kindOf(tab()) ? '!bg-brand/10' : ''"
                (click)="select(kindOf(tab()), it.key)"
              >
                <lucide-icon [name]="tabIcon(tab())" class="size-4 shrink-0" [class]="sel()?.key === it.key ? 'text-brand' : 'text-slate-400'" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-semibold text-slate-700">{{ it.title }}</span>
                  <span class="block truncate font-mono text-[11px] text-slate-400">{{ it.sub }}</span>
                </span>
                @if (it.badge) {
                  <span class="shrink-0 text-[11px] tabular-nums" [class]="it.warn ? 'font-semibold text-amber-600' : 'text-slate-400'">{{ it.badge }}</span>
                }
              </button>
            } @empty {
              @if (!(tab() === 'edge' && i.edge_functions === null)) {
                <p class="p-4 text-center text-sm text-slate-400">{{ search() ? 'Nothing matches “' + search() + '”.' : 'None in this project.' }}</p>
              }
            }
          </div>

          <!-- Detail -->
          <div class="card min-w-0 p-5">
            @if (sel(); as s) {
              <!-- Header + actions -->
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{{ kindLabel[s.kind] }}</p>
                  <h2 class="truncate text-base font-bold text-slate-800">{{ selTitle() }}</h2>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button class="btn-ghost" (click)="explainSel()" [disabled]="explaining()">
                    <lucide-icon [name]="explaining() ? 'refresh-cw' : 'sparkles'" class="size-4" [class.animate-spin]="explaining()" />
                    {{ explanation() ? 'Explained' : 'Explain in plain English' }}
                  </button>
                  @if (s.kind === 'table' || s.kind === 'function') {
                    <button class="btn-primary" (click)="askAbout()"><lucide-icon name="bot" class="size-4" /> Ask about this</button>
                  }
                </div>
              </div>

              @if (explanation(); as ex) {
                <div class="mt-4 rounded-xl border border-brand/15 bg-brand/5 p-4">
                  <p class="flex items-center gap-1.5 text-xs font-semibold text-brand"><lucide-icon name="sparkles" class="size-3.5" /> In plain English</p>
                  <p class="mt-1.5 text-sm text-slate-700">{{ ex.summary }}</p>
                  @if (ex.points.length) {
                    <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                      @for (p of ex.points; track $index) {
                        <li>{{ p }}</li>
                      }
                    </ul>
                  }
                </div>
              }

              <!-- TABLE -->
              @if (selTable(); as t) {
                <div class="mt-4 flex flex-wrap gap-2 text-xs">
                  <span class="pill border-slate-200 bg-slate-50 text-slate-600">{{ t.kind === 'view' ? 'View' : count(t.rows) + ' rows' }}</span>
                  <span class="pill border-slate-200 bg-slate-50 text-slate-600">{{ t.columns.length }} columns</span>
                  @if (t.kind === 'table') {
                    <span class="pill" [class]="t.rls ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'">
                      <lucide-icon [name]="t.rls ? 'shield-check' : 'triangle-alert'" class="size-3.5" />
                      {{ t.rls ? 'Security rules ON' : 'Security rules OFF' }}
                    </span>
                  }
                </div>
                @if (t.kind === 'table' && !t.rls) {
                  <p class="mt-2 text-xs text-amber-700">With security rules off, anyone holding this project's public app key may be able to read or change every row.</p>
                }

                <div class="mt-4 grid gap-3 sm:grid-cols-3">
                  <div>
                    <p class="mb-1.5 text-xs font-semibold text-slate-400">Triggers on it</p>
                    @for (tr of tableTriggers(t.name); track tr.name) {
                      <button class="chip" (click)="select('trigger', tr.name)">{{ tr.name }}</button>
                    } @empty {
                      <p class="text-xs text-slate-400">None</p>
                    }
                  </div>
                  <div>
                    <p class="mb-1.5 text-xs font-semibold text-slate-400">Functions that use it</p>
                    @for (f of tableFunctions(t.name); track f.name) {
                      <button class="chip" (click)="select('function', f.name)">{{ f.name }}</button>
                    } @empty {
                      <p class="text-xs text-slate-400">None</p>
                    }
                  </div>
                  <div>
                    <p class="mb-1.5 text-xs font-semibold text-slate-400">Security rules</p>
                    @for (p of tablePolicies(t.name); track p.name) {
                      <button class="chip" (click)="select('policy', p.table + '.' + p.name)">{{ p.name }}</button>
                    } @empty {
                      <p class="text-xs text-slate-400">None</p>
                    }
                  </div>
                </div>

                <details class="mt-4">
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
                  <p class="mb-2 text-xs font-semibold text-slate-400">Latest {{ browseLimit }} rows</p>
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
              }

              <!-- FUNCTION -->
              @if (selFunction(); as f) {
                <p class="mt-3 font-mono text-xs break-all text-slate-500">{{ f.name }}({{ f.args }}) → {{ f.returns }}</p>
                <div class="mt-3 flex flex-wrap gap-2 text-xs">
                  <span class="pill border-slate-200 bg-slate-50 text-slate-600">{{ f.language }}</span>
                  @if (f.security_definer) {
                    <span class="pill border-amber-200 bg-amber-50 text-amber-700" title="Runs with its owner's rights, so it can bypass security rules">
                      <lucide-icon name="triangle-alert" class="size-3.5" /> Runs as owner
                    </span>
                  }
                </div>
                <div class="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p class="mb-1.5 text-xs font-semibold text-slate-400">Tables it uses</p>
                    @for (tn of f.tables; track tn) {
                      <button class="chip" (click)="select('table', tn)">{{ tn }}</button>
                    } @empty {
                      <p class="text-xs text-slate-400">None found</p>
                    }
                  </div>
                  <div>
                    <p class="mb-1.5 text-xs font-semibold text-slate-400">Run automatically by triggers</p>
                    @for (tr of functionTriggers(f.name); track tr.name) {
                      <button class="chip" (click)="select('trigger', tr.name)">{{ tr.name }} · {{ tr.table }}</button>
                    } @empty {
                      <p class="text-xs text-slate-400">None — called directly (e.g. from the app)</p>
                    }
                  </div>
                </div>
                <p class="mt-4 mb-1.5 text-xs font-semibold text-slate-400">Code</p>
                <pre class="max-h-[28rem] overflow-auto rounded-xl bg-slate-900 p-3.5 text-[11px] leading-relaxed text-emerald-300">{{ f.definition }}</pre>
              }

              <!-- TRIGGER -->
              @if (selTrigger(); as tr) {
                <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span class="text-slate-400">On table</span><button class="chip !mb-0" (click)="select('table', tr.table)">{{ tr.table }}</button>
                  <span class="text-slate-400">runs</span><button class="chip !mb-0" (click)="select('function', tr.function)">{{ tr.function }}</button>
                  @if (!tr.enabled) {
                    <span class="pill border-slate-200 bg-slate-100 text-slate-500">Disabled</span>
                  }
                </div>
                <p class="mt-4 mb-1.5 text-xs font-semibold text-slate-400">Definition</p>
                <pre class="overflow-x-auto rounded-xl bg-slate-900 p-3.5 text-[11px] leading-relaxed whitespace-pre-wrap text-emerald-300">{{ tr.definition }}</pre>
              }

              <!-- POLICY -->
              @if (selPolicy(); as p) {
                <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span class="text-slate-400">On table</span><button class="chip !mb-0" (click)="select('table', p.table)">{{ p.table }}</button>
                  <span class="pill border-slate-200 bg-slate-50 text-slate-600">{{ p.command }}</span>
                  <span class="pill border-slate-200 bg-slate-50 text-slate-600">for {{ p.roles }}</span>
                </div>
                <p class="mt-4 mb-1.5 text-xs font-semibold text-slate-400">Which rows it allows (USING)</p>
                <pre class="overflow-x-auto rounded-xl bg-slate-900 p-3.5 text-[11px] whitespace-pre-wrap text-emerald-300">{{ p.using || '—' }}</pre>
                <p class="mt-3 mb-1.5 text-xs font-semibold text-slate-400">What new/changed rows must satisfy (WITH CHECK)</p>
                <pre class="overflow-x-auto rounded-xl bg-slate-900 p-3.5 text-[11px] whitespace-pre-wrap text-emerald-300">{{ p.check || '—' }}</pre>
              }

              <!-- EDGE FUNCTION -->
              @if (selEdge(); as e) {
                <div class="mt-3 flex flex-wrap gap-2 text-xs">
                  <span class="pill border-slate-200 bg-slate-50 text-slate-600">{{ e.status }}</span>
                  <span class="pill border-slate-200 bg-slate-50 text-slate-600">version {{ e.version ?? '?' }}</span>
                  @if (e.verify_jwt === false) {
                    <span class="pill border-amber-200 bg-amber-50 text-amber-700"><lucide-icon name="triangle-alert" class="size-3.5" /> Callable without login</span>
                  } @else {
                    <span class="pill border-emerald-200 bg-emerald-50 text-emerald-700"><lucide-icon name="lock" class="size-3.5" /> Needs login</span>
                  }
                </div>
                @if (e.updated_at) {
                  <p class="mt-3 text-xs text-slate-400">Last deployed {{ e.updated_at | date: 'MMM d, y, h:mm a' }}</p>
                }
                <p class="mt-3 text-sm text-slate-500">
                  Edge functions are server code that runs outside the database, so their code isn't readable here.
                  <a class="font-semibold text-brand hover:underline" [href]="edgeUrl(e)" target="_blank" rel="noopener">Open it in Supabase</a> to see the code and logs.
                </p>
              }
            } @else {
              <p class="py-10 text-center text-sm text-slate-400">Pick something on the left to see it here.</p>
            }
          </div>
        </div>
      }
    }
  `,
  styles: `
    .chip {
      margin: 0 0.375rem 0.375rem 0;
      display: inline-flex;
      max-width: 100%;
      border-radius: 0.5rem;
      background: rgb(99 102 241 / 0.08);
      padding: 0.25rem 0.5rem;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      color: rgb(79 70 229);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip:hover {
      background: rgb(99 102 241 / 0.16);
    }
  `,
})
export class Tables implements OnInit {
  private readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly browseLimit = BROWSE_LIMIT;
  protected readonly tabs: { id: Tab; label: string }[] = [
    { id: 'tables', label: 'Tables' },
    { id: 'functions', label: 'Functions' },
    { id: 'triggers', label: 'Triggers' },
    { id: 'policies', label: 'Security rules' },
    { id: 'edge', label: 'Edge functions' },
  ];
  protected readonly kindLabel: Record<ExplainKind, string> = {
    table: 'Table',
    function: 'Database function',
    trigger: 'Trigger',
    policy: 'Security rule',
    edge_function: 'Edge function',
  };

  protected readonly projects = signal<ConnectedProject[]>([]);
  protected readonly loadingProjects = signal(true);
  protected readonly projectId = signal('');
  protected readonly info = signal<ProjectInfo | null>(null);
  protected readonly loading = signal(false);
  protected readonly search = signal('');
  protected readonly tab = signal<Tab>('tables');
  protected readonly sel = signal<Selection | null>(null);
  protected readonly rows = signal<QueryResult | null>(null);
  protected readonly browsing = signal(false);
  protected readonly explaining = signal(false);
  /** Explanations fetched this session, by "kind:key". */
  private readonly explanations = signal<Record<string, Explanation>>({});

  protected readonly selTable = computed(() => (this.sel()?.kind === 'table' ? this.findTable(this.sel()!.key) : null));
  protected readonly selFunction = computed(() => (this.sel()?.kind === 'function' ? (this.info()?.functions.find((f) => f.name === this.sel()!.key) ?? null) : null));
  protected readonly selTrigger = computed(() => (this.sel()?.kind === 'trigger' ? (this.info()?.triggers.find((t) => t.name === this.sel()!.key) ?? null) : null));
  protected readonly selPolicy = computed(() => (this.sel()?.kind === 'policy' ? (this.info()?.policies.find((p) => `${p.table}.${p.name}` === this.sel()!.key) ?? null) : null));
  protected readonly selEdge = computed(() => (this.sel()?.kind === 'edge_function' ? (this.info()?.edge_functions?.find((e) => e.slug === this.sel()!.key) ?? null) : null));
  protected readonly selTitle = computed(() => {
    const s = this.sel();
    if (!s) return '';
    if (s.kind === 'table') return friendlyHeader(s.key);
    if (s.kind === 'policy') return this.selPolicy()?.name ?? s.key;
    return s.key;
  });
  protected readonly explanation = computed(() => {
    const s = this.sel();
    return s ? (this.explanations()[`${s.kind}:${s.key}`] ?? null) : null;
  });

  protected readonly items = computed<ListItem[]>(() => {
    const i = this.info();
    if (!i) return [];
    const q = this.search().trim().toLowerCase();
    const match = (...xs: string[]) => !q || xs.some((x) => x.toLowerCase().includes(q) || x.toLowerCase().includes(q.replace(/\s+/g, '_')));
    switch (this.tab()) {
      case 'tables':
        return i.tables
          .filter((t) => match(t.name))
          .map((t) => ({
            key: t.name,
            title: friendlyHeader(t.name),
            sub: t.name,
            badge: t.kind === 'view' ? 'view' : t.rls ? this.count(t.rows) : `${this.count(t.rows)} · no RLS`,
            warn: t.kind === 'table' && !t.rls,
          }));
      case 'functions':
        return i.functions
          .filter((f) => match(f.name, f.definition))
          .map((f) => ({ key: f.name, title: f.name, sub: `${f.language}${f.tables.length ? ' · ' + f.tables.join(', ') : ''}`, badge: f.security_definer ? 'as owner' : undefined, warn: f.security_definer }));
      case 'triggers':
        return i.triggers
          .filter((t) => match(t.name, t.table, t.function))
          .map((t) => ({ key: t.name, title: t.name, sub: `${t.table} → ${t.function}`, badge: t.enabled ? undefined : 'off' }));
      case 'policies':
        return i.policies.filter((p) => match(p.name, p.table)).map((p) => ({ key: `${p.table}.${p.name}`, title: p.name, sub: `${p.table} · ${p.command}` }));
      case 'edge':
        return (i.edge_functions ?? [])
          .filter((e) => match(e.slug, e.name))
          .map((e) => ({ key: e.slug, title: e.name, sub: e.slug, badge: e.verify_jwt === false ? 'no login' : undefined, warn: e.verify_jwt === false }));
    }
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
    this.sel.set(null);
    this.rows.set(null);
    this.explanations.set({});
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
    } catch (e) {
      this.toast.fail(e, 'Could not read this project.');
    } finally {
      this.loading.set(false);
    }
  }

  setTab(t: Tab) {
    this.tab.set(t);
  }

  kindOf(t: Tab): ExplainKind {
    return ({ tables: 'table', functions: 'function', triggers: 'trigger', policies: 'policy', edge: 'edge_function' } as const)[t];
  }

  private tabFor(k: ExplainKind): Tab {
    return ({ table: 'tables', function: 'functions', trigger: 'triggers', policy: 'policies', edge_function: 'edge' } as const)[k];
  }

  tabIcon(t: Tab) {
    return ({ tables: 'table-2', functions: 'database', triggers: 'refresh-cw', policies: 'shield-check', edge: 'send' } as const)[t];
  }

  tabCount(t: Tab): string {
    const i = this.info();
    if (!i) return '0';
    if (t === 'edge') return i.edge_functions === null ? '—' : String(i.edge_functions.length);
    return String({ tables: i.tables, functions: i.functions, triggers: i.triggers, policies: i.policies }[t].length);
  }

  count(n: number | null) {
    return n === null ? '—' : num.format(n);
  }

  private findTable(name: string): TableInfo | null {
    return this.info()?.tables.find((t) => t.name === name) ?? null;
  }

  tableTriggers(table: string): TriggerInfo[] {
    return this.info()?.triggers.filter((t) => t.table === table) ?? [];
  }

  tableFunctions(table: string): DbFunctionInfo[] {
    return this.info()?.functions.filter((f) => f.tables.includes(table)) ?? [];
  }

  tablePolicies(table: string): PolicyInfo[] {
    return this.info()?.policies.filter((p) => p.table === table) ?? [];
  }

  functionTriggers(fn: string): TriggerInfo[] {
    return this.info()?.triggers.filter((t) => t.function === fn) ?? [];
  }

  edgeUrl(e: EdgeFunctionInfo) {
    const ref = this.projects().find((p) => p.id === this.projectId())?.project_ref;
    return `https://supabase.com/dashboard/project/${ref}/functions/${e.slug}`;
  }

  /** Opens an item — also used by the linked chips, switching tab as needed. */
  select(kind: ExplainKind, key: string) {
    this.tab.set(this.tabFor(kind));
    this.sel.set({ kind, key });
    this.rows.set(null);
    if (kind === 'table') {
      const t = this.findTable(key);
      if (t) this.browse(t);
    }
    // Show a saved explanation straight away (costs no AI quota).
    if (this.info()?.explained?.includes(`${kind}:${key}`) && !this.explanations()[`${kind}:${key}`]) this.explainSel();
  }

  async explainSel() {
    const s = this.sel();
    if (!s || this.explanation()) return;
    this.explaining.set(true);
    try {
      const ex = await this.supabase.explain(this.projectId(), s.kind, s.key);
      this.explanations.update((m) => ({ ...m, [`${s.kind}:${s.key}`]: ex }));
    } catch (e) {
      this.toast.fail(e, 'Could not explain this right now.');
    } finally {
      this.explaining.set(false);
    }
  }

  private async browse(t: TableInfo) {
    this.browsing.set(true);
    const cols = t.columns.map((c) => c.name);
    const orderCol =
      ['created_at', 'updated_at', 'inserted_at'].find((c) => cols.includes(c)) ??
      t.columns.find((c) => /timestamp|date/.test(c.type))?.name ??
      (cols.includes('id') ? 'id' : null);
    const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const sql = `select * from public.${ident(t.name)}${orderCol ? ` order by ${ident(orderCol)} desc nulls last` : ''} limit ${BROWSE_LIMIT}`;
    try {
      const r = await this.supabase.runQuery(this.projectId(), sql, 'select', `Browse ${t.name}`, false);
      if (this.sel()?.key === t.name) this.rows.set(r);
    } catch (e) {
      this.toast.fail(e, 'Could not load rows.');
    } finally {
      this.browsing.set(false);
    }
  }

  askAbout() {
    const s = this.sel();
    if (!s) return;
    const prompt = s.kind === 'table' ? `${s.key.replace(/_/g, ' ')} ` : `show the code of function ${s.key}`;
    this.router.navigate(['/query'], { queryParams: { project: this.projectId(), prompt } });
  }
}
