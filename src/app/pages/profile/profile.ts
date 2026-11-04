import { Component, inject, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { SupabaseService } from '../../core/supabase.service';
import { ToastService } from '../../core/toast.service';
import { UserAvatar } from '../../shared/user-avatar';

@Component({
  selector: 'app-profile',
  imports: [FormsModule, LucideAngularModule, UserAvatar],
  template: `
    <h1 class="section-title text-xl">Profile</h1>
    <p class="mt-1 text-sm text-slate-500">How you appear in DB Spread Bot.</p>

    <!-- Picture + name -->
    <div class="card mt-5 p-5">
      <div class="flex flex-col gap-5 sm:flex-row sm:items-center">
        <button
          type="button"
          class="group relative size-24 shrink-0 self-start rounded-full ring-4 ring-brand/10"
          (click)="fileInput.click()"
          [disabled]="uploading()"
          aria-label="Change profile picture"
        >
          <app-user-avatar [size]="96" [preview]="preview()" />
          <span
            class="absolute inset-0 grid place-items-center rounded-full bg-slate-900/45 text-white opacity-0 transition group-hover:opacity-100"
            [class.!opacity-100]="uploading()"
          >
            <lucide-icon [name]="uploading() ? 'refresh-cw' : 'camera'" class="size-6" [class.animate-spin]="uploading()" />
          </span>
        </button>
        <input #fileInput type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden" (change)="onFile($event)" />

        <div class="min-w-0 flex-1">
          <p class="truncate text-lg font-bold text-slate-800">{{ supabase.displayName() }}</p>
          <p class="truncate text-sm text-slate-400">{{ supabase.user()?.email }}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button class="btn-ghost" (click)="fileInput.click()" [disabled]="uploading()">
              <lucide-icon name="camera" class="size-4" /> {{ supabase.avatarUrl() ? 'Change picture' : 'Add picture' }}
            </button>
            @if (supabase.avatarUrl()) {
              <button class="btn-ghost text-rose-600" (click)="removePicture()" [disabled]="uploading()">Remove</button>
            }
          </div>
          <p class="mt-1.5 text-xs text-slate-400">PNG, JPG, WebP or GIF, up to 2 MB.</p>
        </div>
      </div>

      <form class="mt-6 border-t border-slate-100 pt-5" (ngSubmit)="saveName()" novalidate>
        <label class="label" for="full-name">Your name</label>
        <div class="flex gap-2">
          <input id="full-name" class="input" name="fullName" [ngModel]="name()" (ngModelChange)="name.set($event)" placeholder="e.g. Jay Lakkoju" maxlength="80" />
          <button type="submit" class="btn-primary shrink-0" [disabled]="savingName() || name().trim() === currentName()">
            @if (savingName()) {
              <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
            }
            Save
          </button>
        </div>
      </form>
    </div>

    <!-- Password -->
    <form class="card mt-4 space-y-4 p-5" (ngSubmit)="savePassword()" novalidate>
      <div>
        <p class="text-sm font-bold text-slate-800">Change password</p>
        <p class="mt-0.5 text-xs text-slate-400">At least 8 characters.</p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <input class="input" type="password" name="pw1" autocomplete="new-password" placeholder="New password" [ngModel]="pw1()" (ngModelChange)="pw1.set($event)" />
        <input class="input" type="password" name="pw2" autocomplete="new-password" placeholder="Type it again" [ngModel]="pw2()" (ngModelChange)="pw2.set($event)" />
      </div>
      <button type="submit" class="btn-primary" [disabled]="savingPw() || !pw1()">
        @if (savingPw()) {
          <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
        }
        Update password
      </button>
    </form>

    <!-- Account -->
    <div class="card mt-4 flex flex-wrap items-center justify-between gap-3 p-5">
      <div>
        <p class="text-sm font-bold text-slate-800">Sign out</p>
        <p class="mt-0.5 text-xs text-slate-400">Signs you out on this device only.</p>
      </div>
      <button class="btn-danger" (click)="signOut()"><lucide-icon name="log-out" class="size-4" /> Sign out</button>
    </div>
  `,
})
export class Profile implements OnDestroy {
  protected readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly currentName = () => String(this.supabase.user()?.user_metadata?.['full_name'] ?? '').trim();
  protected readonly name = signal(this.currentName());
  protected readonly savingName = signal(false);
  protected readonly uploading = signal(false);
  protected readonly preview = signal<string | null>(null);
  protected readonly pw1 = signal('');
  protected readonly pw2 = signal('');
  protected readonly savingPw = signal(false);

  ngOnDestroy() {
    this.clearPreview();
  }

  private clearPreview() {
    const p = this.preview();
    if (p) URL.revokeObjectURL(p);
    this.preview.set(null);
  }

  async onFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow picking the same file again
    if (!file) return;
    // Show the picked image immediately while it uploads.
    this.clearPreview();
    this.preview.set(URL.createObjectURL(file));
    this.uploading.set(true);
    try {
      await this.supabase.uploadAvatar(file);
      this.toast.success('Profile picture updated.');
    } catch (e) {
      this.toast.fail(e, 'Could not upload that picture.');
    } finally {
      this.clearPreview();
      this.uploading.set(false);
    }
  }

  async removePicture() {
    this.uploading.set(true);
    try {
      await this.supabase.removeAvatar();
      this.toast.success('Picture removed.');
    } catch (e) {
      this.toast.fail(e, 'Could not remove the picture.');
    } finally {
      this.uploading.set(false);
    }
  }

  async saveName() {
    const n = this.name().trim();
    if (n === this.currentName()) return;
    this.savingName.set(true);
    try {
      await this.supabase.updateProfile({ full_name: n });
      this.toast.success('Name saved.');
    } catch (e) {
      this.toast.fail(e, 'Could not save your name.');
    } finally {
      this.savingName.set(false);
    }
  }

  async savePassword() {
    if (this.pw1().length < 8) {
      this.toast.warn('Use at least 8 characters.');
      return;
    }
    if (this.pw1() !== this.pw2()) {
      this.toast.warn('The two passwords do not match.');
      return;
    }
    this.savingPw.set(true);
    try {
      await this.supabase.changePassword(this.pw1());
      this.pw1.set('');
      this.pw2.set('');
      this.toast.success('Password updated.');
    } catch (e) {
      this.toast.fail(e, 'Could not update your password.');
    } finally {
      this.savingPw.set(false);
    }
  }

  async signOut() {
    await this.supabase.signOut();
    this.router.navigateByUrl('/login');
  }
}
