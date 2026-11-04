import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { ConnectionProjects, SupabaseService } from '../../core/supabase.service';
import { friendlyError, ToastService, UserFacingError } from '../../core/toast.service';

/** Supabase sends the user back here after they approve access. */
@Component({
  selector: 'app-connect-callback',
  imports: [LucideAngularModule, RouterLink],
  template: `
    <h1 class="section-title text-xl">
      Connect Supabase projects
      @if (result()?.organization_name; as org) {
        <span class="font-normal text-slate-400">· {{ org }}</span>
      }
    </h1>
    <p class="mt-1 text-sm text-slate-500">Pick the projects you want to ask questions about. Each one starts read-only.</p>

    @if (loading()) {
      <div class="card mt-5 flex items-center gap-3 p-6 text-sm text-slate-500">
        <lucide-icon name="refresh-cw" class="size-4 animate-spin" /> Finishing the Supabase sign-in…
      </div>
    } @else if (error()) {
      <div class="card mt-5 space-y-4 p-6">
        <p class="text-sm font-semibold text-rose-600">{{ error() }}</p>
        <div class="flex gap-2">
          <button class="btn-primary" (click)="retry()"><lucide-icon name="refresh-cw" class="size-4" /> Try again</button>
          <a routerLink="/projects" class="btn-ghost">Back to projects</a>
        </div>
      </div>
    } @else if (result(); as r) {
      <div class="card mt-5 p-5">
        @if (!r.projects.length) {
          <p class="text-sm text-slate-500">This Supabase organization has no projects yet.</p>
        } @else {
          <div class="mb-3 flex items-center justify-between gap-3">
            <p class="text-sm font-semibold text-slate-700">{{ r.projects.length }} project{{ r.projects.length === 1 ? '' : 's' }} found</p>
            @if (selectable().length > 1) {
              <button class="text-xs font-semibold text-brand hover:underline" (click)="toggleAll()">
                {{ selected().size === selectable().length ? 'Clear all' : 'Select all' }}
              </button>
            }
          </div>
          <div class="divide-y divide-slate-100 rounded-xl border border-slate-100">
            @for (p of r.projects; track p.ref) {
              <label class="flex items-center gap-3 px-4 py-3" [class]="p.connected === 'login' ? 'opacity-60' : 'cursor-pointer hover:bg-slate-50'">
                <input
                  type="checkbox"
                  class="size-4 accent-[var(--brand)]"
                  [checked]="p.connected === 'login' || selected().has(p.ref)"
                  [disabled]="p.connected === 'login'"
                  (change)="toggle(p.ref)"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-bold text-slate-800">{{ p.name }}</span>
                  <span class="block truncate font-mono text-xs text-slate-400">{{ p.ref }} · {{ p.region }}</span>
                </span>
                @if (p.connected === 'login') {
                  <span class="pill border-emerald-200 bg-emerald-50 text-emerald-700">Already added</span>
                } @else if (p.connected === 'token') {
                  <span class="pill border-sky-200 bg-sky-50 text-sky-700" title="Added earlier with a personal token — tick to switch it to this Supabase login">
                    Added with token · switch?
                  </span>
                } @else if (p.status && p.status !== 'ACTIVE_HEALTHY') {
                  <span class="pill border-amber-200 bg-amber-50 text-amber-700">{{ statusLabel(p.status) }}</span>
                }
              </label>
            }
          </div>
        }
        <div class="mt-4 flex gap-2">
          <button class="btn-primary" (click)="add()" [disabled]="adding() || !selected().size">
            @if (adding()) {
              <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
            } @else {
              <lucide-icon name="plus" class="size-4" />
            }
            {{ addLabel() }}
          </button>
          <a routerLink="/projects" class="btn-ghost">{{ selected().size ? 'Cancel' : 'Done' }}</a>
        </div>
      </div>
    }
  `,
})
export class ConnectCallback implements OnInit {
  private readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly loading = signal(true);
  protected readonly adding = signal(false);
  protected readonly error = signal('');
  protected readonly result = signal<ConnectionProjects | null>(null);
  protected readonly selected = signal<Set<string>>(new Set());

  async ngOnInit() {
    const q = this.route.snapshot.queryParamMap;
    // Strip ?code=… from the address bar so a refresh can't replay it.
    history.replaceState(null, '', '/connect/callback');
    try {
      if (q.get('error')) {
        throw new UserFacingError(q.get('error') === 'access_denied' ? 'You cancelled the Supabase sign-in.' : 'Supabase did not complete the sign-in.');
      }
      // "Add more projects" from an account that's already connected — no new sign-in needed.
      const existing = q.get('connection');
      let r;
      if (existing) {
        r = await this.supabase.connectionProjects(existing);
      } else {
        const code = q.get('code');
        const state = q.get('state');
        if (!code || !state) throw new UserFacingError('Nothing to finish here — start from "Connect Supabase" on the Projects page.');
        r = await this.supabase.finishSupabaseConnect(code, state);
      }
      this.result.set(r);
      // Pre-select everything not yet added — the common case is "add them all".
      // Token-added ones are offered but not ticked, so switching them is a deliberate choice.
      // Paused projects can't answer queries, so they're offered but not pre-ticked.
      this.selected.set(new Set(r.projects.filter((p) => !p.connected && !this.isPaused(p.status)).map((p) => p.ref)));
    } catch (e) {
      this.error.set(friendlyError(e, 'Could not finish connecting to Supabase.'));
    } finally {
      this.loading.set(false);
    }
  }

  selectable() {
    return (this.result()?.projects ?? []).filter((p) => p.connected !== 'login');
  }

  addLabel(): string {
    const picked = (this.result()?.projects ?? []).filter((p) => this.selected().has(p.ref));
    const switching = picked.filter((p) => p.connected === 'token').length;
    const adding = picked.length - switching;
    if (!picked.length) return 'Add projects';
    if (!adding) return `Switch ${switching} to Supabase login`;
    return `Add ${adding} project${adding === 1 ? '' : 's'}${switching ? ` + switch ${switching}` : ''}`;
  }

  toggle(ref: string) {
    this.selected.update((s) => {
      const next = new Set(s);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  toggleAll() {
    const all = this.selectable().map((p) => p.ref);
    this.selected.set(this.selected().size === all.length ? new Set() : new Set(all));
  }

  isPaused(status: string) {
    return /pause|inactive/i.test(status);
  }

  statusLabel(status: string) {
    return this.isPaused(status) ? 'Paused — restore it in Supabase first' : status.replace(/_/g, ' ').toLowerCase();
  }

  retry() {
    this.supabase.startSupabaseConnect();
  }

  async add() {
    const r = this.result();
    if (!r || !this.selected().size) return;
    this.adding.set(true);
    try {
      const { added } = await this.supabase.addConnectionProjects(r.connection_id, [...this.selected()]);
      this.toast.success(`${added} project${added === 1 ? '' : 's'} now connected with your Supabase login.`);
      this.router.navigateByUrl('/projects');
    } catch (e) {
      this.toast.fail(e, 'Could not add those projects.');
    } finally {
      this.adding.set(false);
    }
  }
}
