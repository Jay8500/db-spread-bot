import { Component, computed, effect, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { environment } from '../../environments/environment';
import { DialogService, DialogTone } from '../core/dialog.service';

const TONES: Record<DialogTone, { icon: string; badge: string; button: string }> = {
  primary: { icon: 'info', badge: 'bg-brand/10 text-brand', button: 'bg-brand hover:brightness-110 shadow-brand/25' },
  danger: { icon: 'triangle-alert', badge: 'bg-rose-50 text-rose-600', button: 'bg-rose-600 hover:bg-rose-700 shadow-rose-600/25' },
  warning: { icon: 'triangle-alert', badge: 'bg-amber-50 text-amber-600', button: 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/25' },
  success: { icon: 'circle-check', badge: 'bg-emerald-50 text-emerald-600', button: 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-500/25' },
};

/** Branded confirm / prompt dialog — replaces window.confirm / window.prompt everywhere. */
@Component({
  selector: 'app-dialog-host',
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (dialog.current(); as d) {
      @let t = tone();
      <div class="animate-fade-in fixed inset-0 z-[90] bg-slate-900/40 backdrop-blur-[3px]" (click)="cancel()"></div>
      <div class="pointer-events-none fixed inset-0 z-[91] flex items-end justify-center p-0 sm:items-center sm:p-6">
        <div
          class="animate-fade-up pointer-events-auto w-full max-w-md overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
          role="alertdialog"
          aria-modal="true"
          [attr.aria-labelledby]="'dlg-title'"
        >
          <div class="flex items-center gap-2.5 border-b border-slate-100 bg-slate-50/70 px-5 py-3">
            <img [src]="brand.productLogo" alt="" class="size-7 rounded-lg" />
            <span class="truncate text-sm font-bold text-slate-700">{{ brand.name }} {{ brand.product }}</span>
          </div>

          <form class="px-5 pt-5 pb-5 sm:px-6" (ngSubmit)="ok()" novalidate>
            <div class="flex items-start gap-4">
              <span class="grid size-11 shrink-0 place-items-center rounded-2xl {{ t.badge }}">
                <lucide-icon [name]="d.icon || t.icon" class="size-5" />
              </span>
              <div class="min-w-0 flex-1 pt-0.5">
                <h2 id="dlg-title" class="text-base font-bold text-slate-900">{{ d.title }}</h2>
                @if (d.message) {
                  <p class="mt-1 text-sm leading-relaxed whitespace-pre-line text-slate-500">{{ d.message }}</p>
                }
                @if (d.details?.length) {
                  <ul class="mt-2 space-y-1 text-sm text-slate-600">
                    @for (x of d.details; track $index) {
                      <li class="flex gap-2"><span class="mt-2 size-1.5 shrink-0 rounded-full bg-slate-300"></span>{{ x }}</li>
                    }
                  </ul>
                }
              </div>
            </div>

            @if (d.kind === 'prompt') {
              <div class="mt-4" [class.field-invalid]="!!error()">
                <label class="label" for="dlg-input">{{ d.label }}</label>
                <input
                  #field
                  id="dlg-input"
                  class="input"
                  [class.font-mono]="d.mono"
                  [type]="d.type || 'text'"
                  name="v"
                  [ngModel]="value()"
                  (ngModelChange)="value.set($event); touched.set(true)"
                  [placeholder]="d.placeholder || ''"
                  autocomplete="off"
                />
                @if (error()) {
                  <p class="animate-fade-in mt-1.5 flex items-start gap-1.5 text-xs font-medium text-rose-600" role="alert">
                    <lucide-icon name="circle-x" class="mt-px size-3.5 shrink-0" /> {{ error() }}
                  </p>
                } @else if (d.hint) {
                  <p class="mt-1.5 text-xs text-slate-400">{{ d.hint }}</p>
                }
              </div>
            }

            <div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" class="btn-ghost" (click)="cancel()">{{ d.cancelText || 'Cancel' }}</button>
              <button type="submit" class="btn text-white shadow-sm {{ t.button }}" [disabled]="blocked()">
                {{ d.confirmText || 'Confirm' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
})
export class DialogHost {
  protected readonly dialog = inject(DialogService);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  protected readonly value = signal('');
  protected readonly touched = signal(false);
  private readonly submitted = signal(false);

  protected readonly brand = environment.brand;
  protected readonly tone = computed(() => TONES[this.dialog.current()?.tone ?? 'primary']);

  private readonly rawError = computed(() => {
    const d = this.dialog.current();
    if (!d || d.kind !== 'prompt') return null;
    const v = this.value().trim();
    if (d.requireMatch !== undefined) return v === d.requireMatch ? null : `Type ${d.requireMatch} exactly to confirm.`;
    return d.validate ? d.validate(v) : null;
  });
  protected readonly error = computed(() => (this.touched() || this.submitted() ? this.rawError() : null));
  protected readonly blocked = computed(() => {
    const d = this.dialog.current();
    return !!d?.requireMatch && this.value().trim() !== d.requireMatch;
  });

  constructor() {
    effect(() => {
      const d = this.dialog.current();
      if (!d) return;
      this.value.set(d.value ?? '');
      this.touched.set(false);
      this.submitted.set(false);
      setTimeout(() => this.field()?.nativeElement.focus(), 50);
    });
  }

  @HostListener('document:keydown.escape')
  cancel() {
    const d = this.dialog.current();
    if (d) this.dialog.close(d.kind === 'confirm' ? false : null);
  }

  ok() {
    const d = this.dialog.current();
    if (!d) return;
    if (d.kind === 'confirm') return this.dialog.close(true);
    this.submitted.set(true);
    if (this.rawError()) return;
    this.dialog.close(this.value().trim());
  }
}
