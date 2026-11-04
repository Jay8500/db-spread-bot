import { Component, input } from '@angular/core';
import { environment } from '../../environments/environment';

/** Spread Apps "powered by" mark. */
@Component({
  selector: 'app-brand-mark',
  template: `
    <a
      [href]="brand.website"
      target="_blank"
      rel="noopener"
      class="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 transition hover:text-slate-600"
    >
      @if (prefix()) {
        <span>{{ prefix() }}</span>
      }
      <img [src]="brand.logo" alt="" class="size-4" />
      <span class="font-semibold text-slate-500">{{ brand.name }}™</span>
    </a>
  `,
})
export class BrandMark {
  readonly prefix = input('Powered by');
  protected readonly brand = environment.brand;
}
