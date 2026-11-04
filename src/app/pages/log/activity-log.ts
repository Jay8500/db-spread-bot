import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { RouterLink } from '@angular/router';
import { ActivityRow, ConnectedProject, SupabaseService } from '../../core/supabase.service';
import { ToastService } from '../../core/toast.service';

@Component({
  selector: 'app-activity-log',
  imports: [LucideAngularModule, DatePipe, RouterLink],
  template: `
    <h1 class="section-title text-xl">Activity</h1>
    <p class="mt-1 text-sm text-slate-500">Every query that actually ran, across every connected project.</p>

    <div class="mt-5 space-y-2.5">
      @for (row of rows(); track row.id) {
        <div class="card p-4">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="pill" [class]="row.status === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'">
              <lucide-icon [name]="row.status === 'success' ? 'circle-check' : 'circle-x'" class="size-3.5" />
              {{ row.status === 'success' ? 'Success' : 'Failed' }}
            </span>
            <span class="font-semibold text-slate-500">{{ projectName(row.project_id) }}</span>
            <span class="text-slate-400">{{ row.executed_at | date: 'MMM d, h:mm a' }}</span>
            @if (!row.prompt.startsWith('Browse ')) {
              <a
                class="ml-auto inline-flex items-center gap-1 font-semibold text-brand hover:underline"
                routerLink="/query"
                [queryParams]="{ project: row.project_id, prompt: row.prompt, run: row.statement_type === 'select' ? '1' : null }"
              >
                <lucide-icon name="refresh-cw" class="size-3.5" /> Ask again
              </a>
            }
          </div>
          <p class="mt-2 text-sm font-medium text-slate-700">{{ row.prompt }}</p>
          <pre class="mt-2 overflow-x-auto rounded-xl bg-slate-900 p-3 text-[11px] leading-relaxed text-emerald-300">{{ row.generated_sql }}</pre>
          @if (row.error) {
            <p class="mt-2 text-xs font-semibold text-rose-600">{{ row.error }}</p>
          }
        </div>
      } @empty {
        <div class="card p-8 text-center text-sm text-slate-400">Nothing run yet.</div>
      }
    </div>
  `,
})
export class ActivityLog implements OnInit {
  private readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);

  protected readonly rows = signal<ActivityRow[]>([]);
  private readonly projects = signal<ConnectedProject[]>([]);

  async ngOnInit() {
    try {
      const [rows, projects] = await Promise.all([this.supabase.listActivity(), this.supabase.listProjects()]);
      this.rows.set(rows);
      this.projects.set(projects);
    } catch (e) {
      this.toast.fail(e, 'Could not load activity.');
    }
  }

  projectName(id: string): string {
    return this.projects().find((p) => p.id === id)?.name || 'Unknown project';
  }
}
