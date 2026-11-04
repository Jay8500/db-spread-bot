import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { DialogService } from '../../core/dialog.service';
import { ConnectedProject, SupabaseService } from '../../core/supabase.service';
import { ToastService } from '../../core/toast.service';

@Component({
  selector: 'app-projects',
  imports: [FormsModule, LucideAngularModule],
  template: `
    <div class="flex items-center justify-between gap-3">
      <div>
        <h1 class="section-title text-xl">Connected projects</h1>
        <p class="mt-1 text-sm text-slate-500">Every project here starts read-only. Switch on writes only when you mean to change data.</p>
      </div>
      @if (!showForm()) {
        <button class="btn-primary shrink-0" (click)="openForm()"><lucide-icon name="plus" class="size-4" /> Add project</button>
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

    <div class="mt-5 space-y-3">
      @for (p of projects(); track p.id) {
        <div class="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex min-w-0 items-center gap-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand"><lucide-icon name="database" class="size-5" /></span>
            <div class="min-w-0">
              <p class="truncate text-sm font-bold text-slate-800">{{ p.name }}</p>
              <p class="truncate font-mono text-xs text-slate-400">{{ p.project_ref }}</p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="pill" [class]="p.allow_writes ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'">
              <lucide-icon [name]="p.allow_writes ? 'shield-check' : 'lock'" class="size-3.5" />
              {{ p.allow_writes ? 'Writes allowed' : 'Read-only' }}
            </span>
            <button class="btn-ghost" (click)="toggleWrites(p)">{{ p.allow_writes ? 'Make read-only' : 'Allow writes' }}</button>
            <button class="btn-ghost" (click)="updateToken(p)" title="Update token"><lucide-icon name="key-round" class="size-4" /></button>
            <button class="btn-danger" (click)="remove(p)" title="Remove"><lucide-icon name="trash-2" class="size-4" /></button>
          </div>
        </div>
      } @empty {
        @if (!showForm()) {
          <div class="card p-8 text-center text-sm text-slate-400">No projects connected yet. Add one to start asking questions in plain English.</div>
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

  async ngOnInit() {
    await this.load();
  }

  async load() {
    try {
      this.projects.set(await this.supabase.listProjects());
    } catch (e) {
      this.toast.fail(e, 'Could not load projects.');
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

  async remove(p: ConnectedProject) {
    const ok = await this.dialog.confirm({
      title: `Remove ${p.name}?`,
      message: 'Its stored token is deleted too. You can reconnect it later with a fresh token.',
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
