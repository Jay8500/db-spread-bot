import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { environment } from '../../../environments/environment';
import { SupabaseService } from '../../core/supabase.service';
import { ToastService } from '../../core/toast.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, LucideAngularModule],
  template: `
    <div class="grid min-h-dvh bg-slate-50 lg:grid-cols-[1.05fr_1fr]">
      <aside class="relative hidden overflow-hidden lg:block">
        <div class="absolute inset-0 bg-gradient-to-br from-brand via-brand/90 to-accent"></div>
        <div class="absolute -top-20 -left-20 size-96 rounded-full bg-white/10 blur-2xl"></div>
        <div class="absolute right-0 bottom-0 size-[28rem] translate-x-1/3 translate-y-1/3 rounded-full bg-white/10 blur-3xl"></div>
        <div class="relative flex h-full flex-col justify-between p-10 text-white">
          <div class="flex items-center gap-3">
            <img [src]="brand.productLogo" alt="" class="size-11 rounded-xl ring-2 ring-white/30" />
            <span class="text-lg font-bold">{{ brand.product }}</span>
          </div>
          <div class="max-w-md">
            <h2 class="text-3xl leading-tight font-extrabold">Ask your databases in plain English.</h2>
            <p class="mt-2 text-sm text-white/80">No SQL to remember — connect a Supabase project, type what you need, confirm before anything runs.</p>
            <div class="mt-6 grid grid-cols-3 gap-3 text-sm">
              <div class="rounded-2xl bg-white/15 p-3 backdrop-blur"><lucide-icon name="bot" class="size-4" /><p class="mt-2 font-semibold">Plain English</p></div>
              <div class="rounded-2xl bg-white/15 p-3 backdrop-blur"><lucide-icon name="shield-check" class="size-4" /><p class="mt-2 font-semibold">Confirm before run</p></div>
              <div class="rounded-2xl bg-white/15 p-3 backdrop-blur"><lucide-icon name="database" class="size-4" /><p class="mt-2 font-semibold">Every project, one place</p></div>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="inline-flex items-center gap-2.5 rounded-2xl bg-white/95 py-2 pr-4 pl-2.5 shadow-lg shadow-slate-900/10">
              <img [src]="brand.logo" alt="" class="size-7" />
              <span class="leading-tight">
                <span class="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase">Powered by</span>
                <span class="block text-sm font-extrabold tracking-tight text-slate-800">{{ brand.name }}</span>
              </span>
            </div>
            <p class="flex items-center gap-1.5 text-xs text-white/80"><lucide-icon name="lock" class="size-3.5" /> Encrypted &amp; secured</p>
          </div>
        </div>
      </aside>

      <main class="flex flex-col px-5 py-8 sm:px-10">
        <div class="flex items-center gap-2.5 lg:hidden">
          <img [src]="brand.productLogo" alt="" class="size-9 rounded-xl" />
          <span class="font-bold text-slate-800">{{ brand.product }}</span>
        </div>

        <div class="my-auto w-full max-w-sm self-center py-10">
          <h1 class="text-2xl font-extrabold tracking-tight text-slate-900">{{ signingUp() ? 'Create your account' : 'Sign in' }}</h1>
          <p class="mt-1.5 text-sm text-slate-500">
            {{ signingUp() ? 'Free to start. Connect your Supabase projects right after.' : 'Welcome back — ask your databases in plain English.' }}
          </p>

          @if (checkEmail()) {
            <div class="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              <p class="font-semibold">Check your inbox</p>
              <p class="mt-1">We sent a confirmation link to <strong>{{ email() }}</strong>. Open it, then sign in here.</p>
            </div>
          }

          <form class="mt-6 space-y-4" (ngSubmit)="submit()" novalidate>
            <div>
              <label class="label" for="email">Email</label>
              <input
                id="email"
                class="input"
                type="email"
                name="email"
                [ngModel]="email()"
                (ngModelChange)="email.set($event)"
                autocomplete="email"
                required
              />
            </div>
            <div>
              <label class="label" for="password">Password</label>
              <div class="relative">
                <input
                  id="password"
                  class="input pr-10"
                  [type]="showPassword() ? 'text' : 'password'"
                  name="password"
                  [ngModel]="password()"
                  (ngModelChange)="password.set($event)"
                  [attr.autocomplete]="signingUp() ? 'new-password' : 'current-password'"
                  required
                />
                <button
                  type="button"
                  class="absolute top-1/2 right-3 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  (click)="showPassword.set(!showPassword())"
                  [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
                >
                  <lucide-icon [name]="showPassword() ? 'eye-off' : 'eye'" class="size-4" />
                </button>
              </div>
            </div>
            <button type="submit" class="btn-primary w-full" [disabled]="loading()">
              @if (loading()) {
                <lucide-icon name="refresh-cw" class="size-4 animate-spin" />
              }
              {{ signingUp() ? 'Create account' : 'Sign in' }}
            </button>
          </form>

          <p class="mt-5 text-center text-sm text-slate-500">
            {{ signingUp() ? 'Already have an account?' : 'New here?' }}
            <button type="button" class="font-semibold text-brand hover:underline" (click)="toggleMode()">
              {{ signingUp() ? 'Sign in' : 'Create an account' }}
            </button>
          </p>
        </div>
      </main>
    </div>
  `,
})
export class Login {
  private readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly brand = environment.brand;
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly showPassword = signal(false);
  protected readonly loading = signal(false);
  protected readonly signingUp = signal(false);
  protected readonly checkEmail = signal(false);

  toggleMode() {
    this.signingUp.set(!this.signingUp());
    this.checkEmail.set(false);
  }

  async submit() {
    if (!this.email().trim() || !this.password()) {
      this.toast.warn('Enter your email and password.');
      return;
    }
    if (this.signingUp() && this.password().length < 8) {
      this.toast.warn('Use at least 8 characters for your password.');
      return;
    }
    this.loading.set(true);
    try {
      if (this.signingUp()) {
        const mustConfirm = await this.supabase.signUp(this.email().trim(), this.password());
        if (mustConfirm) {
          this.checkEmail.set(true);
          this.signingUp.set(false);
          return;
        }
        // New users land on Projects — connecting Supabase is their first step.
        this.router.navigateByUrl('/projects');
        return;
      }
      await this.supabase.signIn(this.email().trim(), this.password());
      this.router.navigateByUrl('/query');
    } catch (e) {
      this.toast.fail(e, this.signingUp() ? 'Could not create the account.' : 'Could not sign in.');
    } finally {
      this.loading.set(false);
    }
  }
}
