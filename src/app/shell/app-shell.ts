import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { environment } from '../../environments/environment';
import { SupabaseService } from '../core/supabase.service';
import { BrandMark } from '../shared/brand-mark';
import { NavItem, Sidebar, SidebarState } from '../shared/sidebar';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideAngularModule, Sidebar, BrandMark],
  template: `
    @let mini = sidebar.compact();
    <app-sidebar [items]="nav()">
      <a sidebar-brand routerLink="/query" class="flex min-w-0 items-center gap-2.5">
        <img [src]="brand.logo" alt="" class="size-9 shrink-0 rounded-xl bg-white object-contain ring-1 ring-slate-100" />
        <span class="min-w-0 leading-tight">
          <span class="block truncate text-[15px] font-bold text-slate-800">{{ brand.product }}</span>
          <span class="block truncate text-[11px] text-slate-400">{{ brand.name }}</span>
        </span>
      </a>
      <img sidebar-mark [src]="brand.logo" alt="" class="size-9 rounded-xl bg-white object-contain ring-1 ring-slate-100" />

      <div sidebar-footer class="space-y-3">
        <button
          class="nav-link w-full bg-rose-50 text-rose-600 ring-1 ring-rose-100 hover:bg-rose-500 hover:text-white hover:ring-rose-500"
          [class]="{ 'md:justify-center': mini, 'md:px-0': mini }"
          (click)="signOut()"
          title="Sign out"
          aria-label="Sign out"
        >
          <lucide-icon name="log-out" class="size-[18px] shrink-0" />
          <span [class]="{ 'md:hidden': mini }">Sign out</span>
        </button>
        @if (!mini) {
          <div class="flex justify-center pt-1"><app-brand-mark /></div>
        }
      </div>
    </app-sidebar>

    <div class="min-h-dvh bg-slate-50/50 pb-24 transition-[padding] duration-300 md:pb-10" [class]="sidebar.collapsed() ? 'md:pl-[76px]' : 'md:pl-64'">
      <!-- Mobile top bar -->
      <header class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-100 bg-white/90 px-4 backdrop-blur md:hidden">
        <button class="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" (click)="sidebar.drawer.set(true)" aria-label="Open menu">
          <lucide-icon name="menu" class="size-5" />
        </button>
        <img [src]="brand.logo" alt="" class="size-6 rounded-md" />
        <span class="truncate text-sm font-bold text-slate-800">{{ brand.product }}</span>
      </header>

      <main class="mx-auto max-w-6xl px-4 pt-5 sm:px-6 sm:pt-7">
        <router-outlet />
      </main>

      <!-- Mobile: bottom navigation -->
      <nav class="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-slate-100 bg-white/95 backdrop-blur md:hidden">
        <div class="grid grid-cols-3 px-2 pt-1.5 pb-1.5">
          <a
            routerLink="/query"
            routerLinkActive="!text-brand"
            class="flex flex-col items-center gap-0.5 py-1 text-[11px] font-semibold text-slate-400"
          >
            <lucide-icon name="bot" class="size-5" /> Ask
          </a>
          <a
            routerLink="/projects"
            routerLinkActive="!text-brand"
            class="flex flex-col items-center gap-0.5 py-1 text-[11px] font-semibold text-slate-400"
          >
            <lucide-icon name="database" class="size-5" /> Projects
          </a>
          <a
            routerLink="/activity"
            routerLinkActive="!text-brand"
            class="flex flex-col items-center gap-0.5 py-1 text-[11px] font-semibold text-slate-400"
          >
            <lucide-icon name="history" class="size-5" /> Activity
          </a>
        </div>
      </nav>
    </div>
  `,
})
export class AppShell {
  private readonly supabase = inject(SupabaseService);
  private readonly router = inject(Router);
  protected readonly sidebar = SidebarState;
  protected readonly brand = environment.brand;

  protected readonly nav = computed<NavItem[]>(() => [
    { path: '/query', label: 'Ask', icon: 'bot', exact: true },
    { path: '/projects', label: 'Projects', icon: 'database' },
    { path: '/activity', label: 'Activity', icon: 'history' },
  ]);

  async signOut() {
    await this.supabase.signOut();
    this.router.navigateByUrl('/login');
  }
}
