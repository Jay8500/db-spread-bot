import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { DialogService } from '../../core/dialog.service';
import { Router } from '@angular/router';
import { ConnectedProject, SupabaseConnection, SupabaseService } from '../../core/supabase.service';
import { ToastService } from '../../core/toast.service';

@Component({
  selector: 'app-projects',
  imports: [FormsModule, LucideAngularModule, DatePipe],
  template: `
    <div class="flex items-center justify-between gap-3">
      <div>
        <h1 class="section-title text-xl">Connected projects</h1>
        <p class="mt-1 text-sm text-slate-500">Every project here starts read-only. Switch on writes only when you mean to change data.</p>
      </div>
      @if (!showForm()) {
        <div class="flex shrink-0 flex-wrap gap-2">
          <button class="btn-primary" (click)="connectSupabase()" [disabled]="connecting()">
            @if (connecting()) {
              <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
            } @else {
              <lucide-icon name="plus" class="size-4" />
            }
            Connect Supabase
          </button>
          <button class="btn-ghost" (click)="openForm()" title="Add a project with a personal access token instead">
            <lucide-icon name="key-round" class="size-4" /> Use a token
          </button>
        </div>
      }
    </div>

    @if (showForm()) {
      <form class="card mt-4 space-y-4 p-5" (ngSubmit)="save()" novalidate>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="label" for="p-name">Name</label>
            <input id="p-name" class="input" [ngModel]="name()" (ngModelChange)="name.set($event)" name="name" placeholder="e.g. KHIMS" required />
          </div>
          <div>
            <label class="label" for="p-ref">Project ref</label>
            <input
              id="p-ref"
              class="input font-mono"
              [ngModel]="projectRef()"
              (ngModelChange)="projectRef.set($event)"
              name="ref"
              placeholder="abcdefghijklmno"
              required
            />
          </div>
        </div>
        <div>
          <label class="label" for="p-url">Project URL</label>
          <input
            id="p-url"
            class="input font-mono"
            [ngModel]="projectUrl()"
            (ngModelChange)="projectUrl.set($event)"
            name="url"
            placeholder="https://abcdefghijklmno.supabase.co"
            required
          />
        </div>
        <div>
          <label class="label" for="p-pat">Management API personal access token</label>
          <div class="relative">
            <input
              id="p-pat"
              class="input pr-10 font-mono"
              [type]="showPat() ? 'text' : 'password'"
              [ngModel]="pat()"
              (ngModelChange)="pat.set($event)"
              name="pat"
              placeholder="sbp_..."
              required
            />
            <button
              type="button"
              class="absolute top-1/2 right-3 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              (click)="showPat.set(!showPat())"
              [attr.aria-label]="showPat() ? 'Hide token' : 'Show token'"
            >
              <lucide-icon [name]="showPat() ? 'eye-off' : 'eye'" class="size-4" />
            </button>
          </div>
          <p class="mt-1.5 text-xs text-slate-400">Create one at supabase.com → Account → Access Tokens. Stored encrypted — never shown again after save.</p>
        </div>
        <div class="flex gap-2">
          <button type="submit" class="btn-primary" [disabled]="saving()">
            @if (saving()) {
              <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
            }
            Save project
          </button>
          <button type="button" class="btn-ghost" (click)="closeForm()">Cancel</button>
        </div>
      </form>
    }

    <!-- Supabase accounts (one card per approved organization) -->
    @if (connections().length) {
      <div class="mt-5">
        <div class="mb-2 flex items-center justify-between gap-3">
          <h2 class="text-sm font-bold text-slate-700">Supabase accounts</h2>
          <button class="text-xs font-semibold text-brand hover:underline" (click)="showAccountHint.set(!showAccountHint())">
            <lucide-icon name="plus" class="inline size-3.5" /> Connect another account
          </button>
        </div>
        @if (showAccountHint()) {
          <div class="card mb-3 space-y-3 border-brand/20 bg-brand/5 p-4 text-sm text-slate-600">
            <p>
              <strong>Another organization in the same Supabase login?</strong> Click Connect and pick it on Supabase's screen.
            </p>
            <p>
              <strong>A different Supabase email?</strong> First log out on
              <a href="https://supabase.com/dashboard" target="_blank" rel="noopener" class="font-semibold text-brand underline">supabase.com</a>
              (or open this app in a private window), then click Connect and sign in with that email. Accounts you already connected keep working.
            </p>
            <button class="btn-primary" (click)="connectSupabase()" [disabled]="connecting()">
              <lucide-icon name="plus" class="size-4" /> Connect Supabase
            </button>
          </div>
        }
        <div class="grid gap-3 sm:grid-cols-2">
          @for (c of connections(); track c.id) {
            <div class="card p-4">
              <div class="flex items-start gap-3">
                <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><lucide-icon name="database" class="size-5" /></span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-bold text-slate-800">{{ c.organization_name || 'Supabase organization' }}</p>
                  <button class="group flex max-w-full items-center gap-1 text-left text-xs text-slate-400 hover:text-slate-600" (click)="renameConnection(c)" title="Edit label">
                    <span class="truncate">{{ c.label || 'Add a label, e.g. the account email' }}</span>
                    <lucide-icon name="pencil" class="size-3 shrink-0 opacity-60 group-hover:opacity-100" />
                  </button>
                  <p class="mt-1 text-xs text-slate-400">
                    {{ projectCount(c.id) }} project{{ projectCount(c.id) === 1 ? '' : 's' }} · connected {{ c.created_at | date: 'MMM d, y' }}
                  </p>
                </div>
              </div>
              <div class="mt-3 flex flex-wrap gap-2">
                <button class="btn-ghost" (click)="addFrom(c)"><lucide-icon name="plus" class="size-4" /> Add projects</button>
                <button class="btn-ghost" (click)="connectSupabase()" title="Sign in to this organization again"><lucide-icon name="refresh-cw" class="size-4" /> Reconnect</button>
                <button class="btn-danger" (click)="removeConnection(c)" title="Remove this account"><lucide-icon name="trash-2" class="size-4" /></button>
              </div>
            </div>
          }
        </div>
      </div>
      <h2 class="mt-6 text-sm font-bold text-slate-700">Projects</h2>
    }

    <div class="mt-3 space-y-3">
      @for (p of projects(); track p.id) {
        <div class="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex min-w-0 items-center gap-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand"><lucide-icon name="database" class="size-5" /></span>
            <div class="min-w-0">
              <p class="truncate text-sm font-bold text-slate-800">{{ p.name }}</p>
              <p class="truncate font-mono text-xs text-slate-400">
                {{ p.project_ref }} · <span class="font-sans">{{ p.connection_id ? accountName(p.connection_id) : 'Access token' }}</span>
              </p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="pill" [class]="p.allow_writes ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'">
              <lucide-icon [name]="p.allow_writes ? 'shield-check' : 'lock'" class="size-3.5" />
              {{ p.allow_writes ? 'Writes allowed' : 'Read-only' }}
            </span>
            <button class="btn-ghost" (click)="toggleWrites(p)">{{ p.allow_writes ? 'Make read-only' : 'Allow writes' }}</button>
            @if (p.connection_id) {
              <button class="btn-ghost" (click)="connectSupabase()" title="Reconnect Supabase"><lucide-icon name="refresh-cw" class="size-4" /></button>
            } @else {
              <button class="btn-ghost" (click)="updateToken(p)" title="Update token"><lucide-icon name="key-round" class="size-4" /></button>
            }
            <button class="btn-danger" (click)="remove(p)" title="Remove"><lucide-icon name="trash-2" class="size-4" /></button>
          </div>
        </div>
      } @empty {
        @if (!showForm()) {
          <div class="card space-y-3 p-8 text-center">
            <p class="text-sm text-slate-500">No projects connected yet.</p>
            <p class="text-xs text-slate-400">Click <strong>Connect Supabase</strong>, sign in to your Supabase account and pick your projects — about 30 seconds, nothing to copy.</p>
          </div>
        }
      }
    </div>
  `,
})
export class Projects implements OnInit {
  private readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);
  private readonly dialog = inject(DialogService);

  protected readonly projects = signal<ConnectedProject[]>([]);
  protected readonly showForm = signal(false);
  protected readonly saving = signal(false);
  protected readonly name = signal('');
  protected readonly projectRef = signal('');
  protected readonly projectUrl = signal('');
  protected readonly pat = signal('');
  protected readonly showPat = signal(false);
  protected readonly connecting = signal(false);
  protected readonly connections = signal<SupabaseConnection[]>([]);
  protected readonly showAccountHint = signal(false);
  private readonly router = inject(Router);

  async ngOnInit() {
    await this.load();
  }

  async load() {
    try {
      const [projects, connections] = await Promise.all([this.supabase.listProjects(), this.supabase.listConnections()]);
      this.projects.set(projects);
      this.connections.set(connections);
    } catch (e) {
      this.toast.fail(e, 'Could not load projects.');
    }
  }

  async connectSupabase() {
    this.connecting.set(true);
    try {
      await this.supabase.startSupabaseConnect(); // navigates away to Supabase
    } catch (e) {
      this.connecting.set(false);
      this.toast.fail(e, 'Could not start the Supabase sign-in.');
    }
  }

  openForm() {
    this.name.set('');
    this.projectRef.set('');
    this.projectUrl.set('');
    this.pat.set('');
    this.showPat.set(false);
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
  }

  async save() {
    if (!this.name().trim() || !this.projectRef().trim() || !this.projectUrl().trim() || !this.pat().trim()) {
      this.toast.warn('Fill in every field.');
      return;
    }
    this.saving.set(true);
    try {
      const created = await this.supabase.addProject({
        name: this.name().trim(),
        project_ref: this.projectRef().trim(),
        project_url: this.projectUrl().trim(),
        pat: this.pat().trim(),
      });
      this.projects.update((list) => [...list, created]);
      this.toast.success(`${created.name} connected.`);
      this.closeForm();
    } catch (e) {
      this.toast.fail(e, 'Could not save project.');
    } finally {
      this.saving.set(false);
    }
  }

  async toggleWrites(p: ConnectedProject) {
    const turningOn = !p.allow_writes;
    if (turningOn) {
      const ok = await this.dialog.confirm({
        title: `Allow writes on ${p.name}?`,
        message: 'Prompts against this project can then change or delete data after you confirm each one. It stays read-only until you turn this on.',
        tone: 'warning',
        confirmText: 'Allow writes',
      });
      if (!ok) return;
    }
    try {
      await this.supabase.setAllowWrites(p.id, turningOn);
      this.projects.update((list) => list.map((x) => (x.id === p.id ? { ...x, allow_writes: turningOn } : x)));
      this.toast.success(turningOn ? `${p.name} can now be written to.` : `${p.name} is read-only again.`);
    } catch (e) {
      this.toast.fail(e, 'Could not update that project.');
    }
  }

  async updateToken(p: ConnectedProject) {
    const token = await this.dialog.prompt({
      title: `Update token for ${p.name}`,
      label: 'New Management API personal access token',
      placeholder: 'sbp_...',
      mono: true,
      confirmText: 'Save token',
    });
    if (!token?.trim()) return;
    try {
      await this.supabase.updateProjectPat(p.id, token.trim());
      this.toast.success('Token updated.');
    } catch (e) {
      this.toast.fail(e, 'Could not update the token.');
    }
  }

  projectCount(connectionId: string) {
    return this.projects().filter((p) => p.connection_id === connectionId).length;
  }

  accountName(connectionId: string) {
    const c = this.connections().find((x) => x.id === connectionId);
    return c?.label || c?.organization_name || 'Supabase login';
  }

  addFrom(c: SupabaseConnection) {
    this.router.navigate(['/connect/callback'], { queryParams: { connection: c.id } });
  }

  async renameConnection(c: SupabaseConnection) {
    const label = await this.dialog.prompt({
      title: `Label for ${c.organization_name || 'this account'}`,
      label: 'Label (e.g. the Supabase account email)',
      placeholder: 'name@example.com',
      value: c.label ?? '',
      confirmText: 'Save',
    });
    if (label === null || label === undefined) return;
    try {
      await this.supabase.renameConnection(c.id, label.trim().slice(0, 120));
      this.connections.update((list) => list.map((x) => (x.id === c.id ? { ...x, label: label.trim() || null } : x)));
    } catch (e) {
      this.toast.fail(e, 'Could not save the label.');
    }
  }

  async removeConnection(c: SupabaseConnection) {
    const n = this.projectCount(c.id);
    const ok = await this.dialog.confirm({
      title: `Remove ${c.label || c.organization_name || 'this account'}?`,
      message: `Its ${n} project${n === 1 ? '' : 's'} will be removed from this app too. Nothing changes in Supabase itself — you can connect it again any time.`,
      tone: 'danger',
      confirmText: 'Remove',
    });
    if (!ok) return;
    try {
      await this.supabase.deleteConnection(c.id);
      this.connections.update((list) => list.filter((x) => x.id !== c.id));
      this.projects.update((list) => list.filter((p) => p.connection_id !== c.id));
      this.toast.success('Account removed.');
    } catch (e) {
      this.toast.fail(e, 'Could not remove that account.');
    }
  }

  async remove(p: ConnectedProject) {
    const ok = await this.dialog.confirm({
      title: `Remove ${p.name}?`,
      message: p.connection_id
        ? 'It is removed from this app only — nothing changes in your Supabase project. You can add it again with Connect Supabase.'
        : 'Its stored token is deleted too. You can reconnect it later with a fresh token.',
      tone: 'danger',
      confirmText: 'Remove',
    });
    if (!ok) return;
    try {
      await this.supabase.deleteProject(p.id);
      this.projects.update((list) => list.filter((x) => x.id !== p.id));
      this.toast.success(`${p.name} removed.`);
    } catch (e) {
      this.toast.fail(e, 'Could not remove that project.');
    }
  }
}
