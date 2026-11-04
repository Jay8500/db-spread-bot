import { Component, inject } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { environment } from '../../environments/environment';
import { ToastKind, ToastService } from '../core/toast.service';

const STYLE: Record<ToastKind, { icon: string; box: string; badge: string }> = {
  success: { icon: 'circle-check', box: 'border-emerald-200 bg-emerald-50 text-emerald-800', badge: 'bg-emerald-500' },
  error: { icon: 'circle-x', box: 'border-rose-200 bg-rose-50 text-rose-800', badge: 'bg-rose-500' },
  warning: { icon: 'triangle-alert', box: 'border-amber-200 bg-amber-50 text-amber-800', badge: 'bg-amber-500' },
  info: { icon: 'info', box: 'border-indigo-200 bg-indigo-50 text-indigo-800', badge: 'bg-indigo-500' },
};

@Component({
  selector: 'app-toast-host',
  imports: [LucideAngularModule],
  template: `
    <div
      class="pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-4 sm:top-auto sm:right-6 sm:bottom-6 sm:left-auto sm:items-end"
      aria-live="polite"
    >
      @for (t of toasts.toasts(); track t.id) {
        @let s = style[t.kind];
        <div
          class="animate-fade-up pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl border py-2.5 pr-2.5 pl-3 text-sm font-medium shadow-lg shadow-slate-900/5 {{ s.box }}"
          [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
        >
          <span class="grid size-6 shrink-0 place-items-center rounded-full text-white {{ s.badge }}">
            <lucide-icon [name]="s.icon" class="size-3.5" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase opacity-60">
              <img [src]="brand.logo" alt="" class="size-3.5 rounded-sm bg-white object-contain" /> {{ brand.product }}
            </span>
            <span class="block">{{ t.text }}</span>
          </span>
          <button class="rounded-lg p-1 opacity-60 transition hover:bg-black/5 hover:opacity-100" (click)="toasts.dismiss(t.id)" aria-label="Dismiss">
            <lucide-icon name="x" class="size-4" />
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastHost {
  protected readonly toasts = inject(ToastService);
  protected readonly brand = environment.brand;
  protected readonly style = STYLE;
}
