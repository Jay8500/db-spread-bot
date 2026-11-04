import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SupabaseService } from './core/supabase.service';
import { DialogHost } from './shared/dialog-host';
import { ToastHost } from './shared/toast-host';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastHost, DialogHost],
  templateUrl: './app.html',
})
export class App {
  protected readonly supabase = inject(SupabaseService);
}
