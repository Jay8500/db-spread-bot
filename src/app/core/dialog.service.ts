import { Injectable, signal } from '@angular/core';

export type DialogTone = 'primary' | 'danger' | 'warning' | 'success';

export interface ConfirmOptions {
  title: string;
  message?: string;
  details?: string[];
  confirmText?: string;
  cancelText?: string;
  tone?: DialogTone;
  icon?: string;
}

export interface PromptOptions extends ConfirmOptions {
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'email' | 'password';
  mono?: boolean;
  validate?: (value: string) => string | null;
  requireMatch?: string;
}

export interface DialogState extends PromptOptions {
  kind: 'confirm' | 'prompt';
  resolve: (value: string | boolean | null) => void;
}

/** In-app replacement for window.confirm / window.prompt, rendered by <app-dialog-host>. */
@Injectable({ providedIn: 'root' })
export class DialogService {
  readonly current = signal<DialogState | null>(null);

  confirm(o: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      this.current()?.resolve(this.current()!.kind === 'confirm' ? false : null);
      this.current.set({ label: '', ...o, kind: 'confirm', resolve: (v) => resolve(v === true) });
    });
  }

  prompt(o: PromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
      this.current()?.resolve(this.current()!.kind === 'confirm' ? false : null);
      this.current.set({ ...o, kind: 'prompt', resolve: (v) => resolve(typeof v === 'string' ? v : null) });
    });
  }

  close(value: string | boolean | null) {
    const d = this.current();
    if (!d) return;
    this.current.set(null);
    d.resolve(value);
  }
}
