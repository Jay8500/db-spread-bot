import { ApplicationConfig, importProvidersFrom, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling, withNavigationErrorHandler } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import { routes } from './app.routes';
import { SupabaseService } from './core/supabase.service';
import { APP_ICONS } from './icons';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
      // After a Netlify deploy, a tab left open still points at the old
      // hashed lazy chunks, which no longer exist — clicking a not-yet-visited
      // page then fails silently. Do a full load of that URL instead.
      withNavigationErrorHandler((e) => {
        const msg = String((e.error as Error)?.message ?? e.error ?? '');
        if (!/dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i.test(msg)) return;
        // Reload at most once per minute so a genuinely missing chunk can't loop.
        const KEY = 'chunk-reload-at';
        let lastAt = 0;
        try {
          lastAt = Number(sessionStorage.getItem(KEY) ?? 0);
          sessionStorage.setItem(KEY, String(Date.now()));
        } catch {
          /* storage blocked — still reload once */
        }
        if (Date.now() - lastAt > 60_000) window.location.assign(e.url);
      }),
    ),
    importProvidersFrom(LucideAngularModule.pick(APP_ICONS)),
    provideAppInitializer(() => inject(SupabaseService).init()),
  ],
};
