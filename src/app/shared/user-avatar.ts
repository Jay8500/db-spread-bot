import { Component, computed, inject, input, signal } from '@angular/core';
import { SupabaseService } from '../core/supabase.service';

/** The signed-in user's picture, or their initials on a brand-coloured circle. */
@Component({
  selector: 'app-user-avatar',
  template: `
    @if (src() && !broken()) {
      <img [src]="src()" alt="" class="size-full rounded-full object-cover" (error)="broken.set(true)" (load)="broken.set(false)" />
    } @else {
      <span class="grid size-full place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 font-bold text-white" [style.font-size.px]="fontPx()">
        {{ initials() }}
      </span>
    }
  `,
  host: { class: 'inline-block shrink-0 overflow-hidden rounded-full', '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
})
export class UserAvatar {
  private readonly supabase = inject(SupabaseService);
  readonly size = input(36);
  /** Optional override, e.g. a local preview while an upload is in flight. */
  readonly preview = input<string | null>(null);

  protected readonly broken = signal(false);
  protected readonly src = computed(() => this.preview() || this.supabase.avatarUrl());
  protected readonly fontPx = computed(() => Math.round(this.size() * 0.4));
  protected readonly initials = computed(() => {
    const parts = this.supabase.displayName().split(/[\s._-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  });
}
