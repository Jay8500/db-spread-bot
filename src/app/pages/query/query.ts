import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { DialogService } from '../../core/dialog.service';
import { ConnectedProject, GeneratedSql, QueryResult, StatementType, SupabaseService } from '../../core/supabase.service';
import { ToastService } from '../../core/toast.service';
import { ResultTable } from '../../shared/result-table';

const WRITE_TYPES = new Set<StatementType>(['insert', 'update', 'delete', 'ddl', 'other']);
const PREVIEWABLE = new Set<StatementType>(['insert', 'update', 'delete']);
const DANGER_RE = /\b(drop|truncate|alter)\b/i;
const LAST_PROJECT_KEY = 'dbbot-last-project';

const STATEMENT_LABEL: Record<StatementType, string> = {
  select: 'Read',
  insert: 'Add data',
  update: 'Change data',
  delete: 'Delete data',
  ddl: 'Structure change',
  other: 'Other',
};

interface Turn {
  prompt: string;
  sql: string;
}

interface PreviewState {
  loading: boolean;
  count?: number;
  rows?: Record<string, unknown>[];
  error?: string;
}

@Component({
  selector: 'app-query',
  imports: [FormsModule, RouterLink, LucideAngularModule, ResultTable],
  template: `
    <h1 class="section-title text-xl">Ask in plain English</h1>
    <p class="mt-1 text-sm text-slate-500">Look things up, follow up, and fix data — reads show right away; changes show a preview and wait for your OK.</p>

    @if (!loadingProjects() && !projects().length) {
      <div class="card mt-5 flex items-center justify-between gap-3 p-5">
        <p class="text-sm text-slate-600">No projects connected yet.</p>
        <a routerLink="/projects" class="btn-primary shrink-0">Connect a project</a>
      </div>
    } @else {
      <div class="card mt-5 space-y-4 p-5">
        <div>
          <label class="label" for="proj">Project</label>
          <select id="proj" class="input" [ngModel]="projectId()" (ngModelChange)="selectProject($event)">
            <option value="" disabled>Choose a project…</option>
            @for (p of projects(); track p.id) {
              <option [value]="p.id">{{ p.name }} {{ p.allow_writes ? '' : '· read-only' }}</option>
            }
          </select>
        </div>

        <div>
          <div class="mb-1.5 flex items-center justify-between gap-2">
            <label class="label !mb-0" for="prompt">{{ history().length ? 'Follow up, or ask something new' : 'What do you need?' }}</label>
            @if (history().length) {
              <button class="text-xs font-semibold text-brand hover:underline" (click)="newQuestion()">
                <lucide-icon name="plus" class="inline size-3.5" /> New question
              </button>
            }
          </div>
          <div class="flex gap-2">
            <input
              id="prompt"
              class="input"
              [ngModel]="prompt()"
              (ngModelChange)="prompt.set($event)"
              name="prompt"
              [placeholder]="history().length ? 'e.g. only unpaid ones · now last week · add phone number' : 'e.g. show me today\\'s walk-ins'"
              (keydown.enter)="ask()"
            />
            <button class="btn-primary shrink-0" (click)="ask()" [disabled]="asking() || running() || !projectId() || !prompt().trim()">
              @if (asking()) {
                <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
              } @else {
                <lucide-icon name="send" class="size-4" />
              }
              Ask
            </button>
          </div>
          @if (history().length) {
            <p class="mt-1.5 truncate text-xs text-slate-400">
              <lucide-icon name="corner-down-right" class="inline size-3.5" /> Following up on: “{{ history()[history().length - 1].prompt }}”
            </p>
          }
        </div>

        @if (!history().length && suggestions().length) {
          <div>
            <p class="mb-1.5 flex items-center gap-1 text-xs font-semibold text-slate-400"><lucide-icon name="sparkles" class="size-3.5" /> Try asking</p>
            <div class="flex flex-wrap gap-2">
              @for (s of suggestions(); track s) {
                <button
                  class="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-brand/40 hover:bg-brand/5 hover:text-brand"
                  (click)="askSuggestion(s)"
                  [disabled]="asking() || running()"
                >
                  {{ s }}
                </button>
              }
            </div>
          </div>
        }
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
        <details class="group" [open]="isWrite(g.statement_type)">
          <summary class="cursor-pointer text-xs font-semibold text-slate-400 select-none hover:text-slate-600">SQL</summary>
          <pre class="mt-2 overflow-x-auto rounded-xl bg-slate-900 p-3.5 text-xs leading-relaxed text-emerald-300">{{ g.sql }}</pre>
        </details>

        <!-- Changes: read-only notice, or a dry-run preview before Confirm -->
        @if (isWrite(g.statement_type)) {
          @if (!currentProject()?.allow_writes) {
            <div class="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-800">
              <strong>{{ currentProject()?.name }}</strong> is read-only, so this change can't run.
              <a routerLink="/projects" class="font-semibold underline">Allow writes on the Projects page</a> if you mean to change data.
            </div>
          } @else if (preview(); as pv) {
            <div class="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5">
              @if (pv.loading) {
                <p class="flex items-center gap-2 text-sm text-amber-800"><lucide-icon name="refresh-cw" class="size-4 animate-spin" /> Checking what this would change…</p>
              } @else if (pv.error) {
                <p class="text-sm font-semibold text-rose-600">This change would fail: {{ pv.error }}</p>
              } @else if (pv.count !== undefined) {
                <p class="text-sm font-semibold text-amber-900">
                  @if (pv.count === 0) {
                    This would change nothing — no rows match.
                  } @else {
                    This will {{ g.statement_type === 'delete' ? 'delete' : g.statement_type === 'insert' ? 'add' : 'change' }}
                    {{ pv.count }} row{{ pv.count === 1 ? '' : 's' }}.
                    @if (pv.rows?.length && g.statement_type !== 'delete') {
                      <span class="font-normal">Here's how {{ pv.count === 1 ? 'it' : 'they' }} will look:</span>
                    } @else if (pv.rows?.length) {
                      <span class="font-normal">These will be removed:</span>
                    }
                  }
                </p>
                @if (pv.rows?.length) {
                  <div class="mt-3"><app-result-table [rows]="pv.rows!" [total]="pv.count!" fileName="change-preview" /></div>
                }
                <p class="mt-2 text-xs text-amber-700">Nothing has been saved yet.</p>
              }
            </div>
          }
        }

        <div class="flex flex-wrap gap-2">
          @if (!isWrite(g.statement_type) || currentProject()?.allow_writes) {
            <button class="btn-primary" (click)="run(g)" [disabled]="running() || preview()?.loading || (preview()?.count === 0)">
              @if (running()) {
                <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
              } @else {
                <lucide-icon name="play" class="size-4" />
              }
              {{ isWrite(g.statement_type) ? 'Confirm & save change' : result() ? 'Run again' : 'Run' }}
            </button>
          }
          <button class="btn-ghost" (click)="clear()">{{ result() ? 'Clear' : 'Discard' }}</button>
        </div>
      </div>
    }

    @if (result(); as r) {
      <div class="card mt-4 p-5">
        @if (r.error) {
          <p class="text-sm font-semibold text-rose-600">{{ r.error }}</p>
        } @else {
          <app-result-table [rows]="r.rows ?? []" [total]="r.row_count" [fileName]="prompt() || 'results'" />
        }
      </div>
    }
  `,
})
export class Query implements OnInit {
  private readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);
  private readonly dialog = inject(DialogService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly statementLabel = STATEMENT_LABEL;
  protected readonly projects = signal<ConnectedProject[]>([]);
  protected readonly loadingProjects = signal(true);
  protected readonly projectId = signal('');
  protected readonly prompt = signal('');
  protected readonly asking = signal(false);
  protected readonly running = signal(false);
  protected readonly generated = signal<GeneratedSql | null>(null);
  protected readonly result = signal<QueryResult | null>(null);
  protected readonly preview = signal<PreviewState | null>(null);
  /** Earlier reads in this conversation — sent along so follow-ups build on them. */
  protected readonly history = signal<Turn[]>([]);
  protected readonly suggestions = signal<string[]>([]);

  protected readonly currentProject = computed(() => this.projects().find((p) => p.id === this.projectId()) ?? null);

  async ngOnInit() {
    try {
      this.projects.set(await this.supabase.listProjects());
    } catch (e) {
      this.toast.fail(e, 'Could not load projects.');
    } finally {
      this.loadingProjects.set(false);
    }

    // Deep links from Activity ("Ask again") and Tables ("Ask about this table").
    const q = this.route.snapshot.queryParamMap;
    const fromLink = q.get('project');
    let remembered = '';
    try {
      remembered = localStorage.getItem(LAST_PROJECT_KEY) ?? '';
    } catch {
      /* storage blocked */
    }
    const pick = [fromLink, remembered].find((id) => id && this.projects().some((p) => p.id === id)) ?? (this.projects().length === 1 ? this.projects()[0].id : '');
    if (pick) this.selectProject(pick);
    if (q.get('prompt')) {
      this.prompt.set(q.get('prompt')!);
      this.router.navigate([], { queryParams: {}, replaceUrl: true });
      if (q.get('run') === '1' && pick) this.ask();
    }
  }

  selectProject(id: string) {
    if (id === this.projectId()) return;
    this.projectId.set(id);
    this.newQuestion();
    try {
      localStorage.setItem(LAST_PROJECT_KEY, id);
    } catch {
      /* storage blocked */
    }
    this.loadSuggestions(id);
  }

  private async loadSuggestions(id: string) {
    this.suggestions.set([]);
    try {
      const info = await this.supabase.projectInfo(id);
      if (this.projectId() === id) this.suggestions.set(info.suggestions ?? []);
    } catch {
      /* suggestions are a nice-to-have — stay quiet */
    }
  }

  isWrite(t: StatementType) {
    return WRITE_TYPES.has(t);
  }

  isDanger(sql: string) {
    return DANGER_RE.test(sql);
  }

  newQuestion() {
    this.history.set([]);
    this.clear();
  }

  clear() {
    this.generated.set(null);
    this.result.set(null);
    this.preview.set(null);
  }

  askSuggestion(s: string) {
    this.prompt.set(s);
    this.ask();
  }

  async ask() {
    if (!this.projectId() || !this.prompt().trim()) return;
    const question = this.prompt().trim();
    this.asking.set(true);
    this.clear();
    try {
      const g = await this.supabase.generateSql(this.projectId(), question, this.history().slice(-3));
      this.generated.set(g);
      if (g.statement_type === 'select') this.history.update((h) => [...h, { prompt: question, sql: g.sql }].slice(-3));
      if (this.isAutoRun(g)) {
        // One click for reads: run straight away. The server forces reads to be
        // structurally read-only, so this can't change data.
        this.asking.set(false);
        await this.run(g, true);
      } else if (PREVIEWABLE.has(g.statement_type) && this.currentProject()?.allow_writes) {
        this.asking.set(false);
        await this.loadPreview(g);
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

  private async loadPreview(g: GeneratedSql) {
    this.preview.set({ loading: true });
    try {
      const r = await this.supabase.previewChange(this.projectId(), g.sql);
      if (this.generated() !== g) return; // user moved on
      if (r.error) this.preview.set({ loading: false, error: r.error });
      else if (r.preview) this.preview.set({ loading: false, count: r.preview.count, rows: r.preview.rows });
      else this.preview.set(null);
    } catch (e) {
      this.preview.set({ loading: false, error: (e as Error)?.message || 'Could not preview this change.' });
    }
  }

  async run(g: GeneratedSql, auto = false) {
    const project = this.currentProject();
    if (!project) return;

    if (this.isWrite(g.statement_type) && !project.allow_writes) {
      this.toast.warn(`${project.name} is read-only. Turn on "Allow writes" on the Projects page first.`);
      return;
    }

    const count = this.preview()?.count;
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
        title: count !== undefined ? `Save this change to ${count} row${count === 1 ? '' : 's'}?` : `Run this on ${project.name}?`,
        message: `This changes data in ${project.name}. It can't be undone from here.`,
        tone: 'warning',
        confirmText: 'Save change',
      });
      if (!ok) return;
    }

    this.running.set(true);
    try {
      const r = await this.supabase.runQuery(project.id, g.sql, g.statement_type, this.prompt().trim(), true);
      this.result.set(r);
      if (r.error) this.toast.error(r.error);
      else if (this.isWrite(g.statement_type)) {
        this.toast.success(count !== undefined ? `Saved — ${count} row${count === 1 ? '' : 's'} changed.` : 'Done.');
        this.preview.set(null);
      } else if (!auto) this.toast.success('Done.');
    } catch (e) {
      this.toast.fail(e, 'Could not run that query.');
    } finally {
      this.running.set(false);
    }
  }
}
