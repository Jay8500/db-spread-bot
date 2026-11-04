import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

/** Known backend / network messages → short, human text. First match wins. */
const FRIENDLY: [RegExp, string][] = [
  [/failed to fetch|networkerror|network request failed|load failed|fetch failed/i, 'No internet connection. Please try again.'],
  [/jwt expired|invalid jwt|refresh token|not signed in|auth session missing/i, 'Your session expired. Please sign in again.'],
  [/invalid login credentials|wrong email or password/i, 'Wrong email or password.'],
  [/email not confirmed/i, 'Please confirm your email first.'],
  [/rate limit|too many requests|\b429\b/i, 'Too many attempts. Please wait a minute.'],
  [/row-level security|permission denied|forbidden|not allowed|42501|\b403\b/i, "You don't have permission to do that."],
  [/duplicate key|already exists|already registered|already has an account|23505/i, 'This already exists.'],
  [/violates foreign key|23503/i, 'This is linked to other records and cannot be changed.'],
  [/violates check constraint|invalid input|23514|22p02/i, 'Some values are not valid.'],
  [/null value|not-null|23502/i, 'A required field is missing.'],
  [/project.*(paused|inactive)|waking up/i, 'That project is paused (free-tier idle) — it should wake up in a few seconds. Try again shortly.'],
  [/timeout|timed out/i, 'The server took too long. Please try again.'],
  [/edge function|non-2xx|\b50[0234]\b|internal server error/i, 'Something went wrong on our side. Please try again.'],
];

/** Words that mean the message is technical and should never be shown as-is. */
const TECHNICAL = /violates|constraint|relation|column|syntax|pgrst|sql|postgres|supabase|function|undefined|null|exception|stack|uuid|\bcode\b|json|token/i;

/** An error whose message was written for the user (by our own edge functions). */
export class UserFacingError extends Error {}

/** Turns any error into a short message that is safe to show to users. */
export function friendlyError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw =
    typeof e === 'string' ? e : (e as { message?: string; error_description?: string })?.message ?? (e as { error_description?: string })?.error_description ?? '';
  if (!raw) return fallback;
  // Our edge functions write their { error } text for the user on purpose
  // (e.g. "The schema has no column for names") — show it as-is.
  if (e instanceof UserFacingError) return raw.length <= 300 ? raw : raw.slice(0, 297) + '…';
  for (const [re, msg] of FRIENDLY) if (re.test(raw)) return msg;
  // Our own messages are already short and plain — pass those through.
  if (raw.length <= 90 && !TECHNICAL.test(raw)) return raw;
  return fallback;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  show(text: string, kind: ToastKind = 'info', ms = 3200): void {
    if (this.toasts().some((t) => t.text === text && t.kind === kind)) return;
    const id = ++this.seq;
    this.toasts.update((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }

  success(text: string) {
    this.show(text, 'success');
  }
  warn(text: string) {
    this.show(text, 'warning', 3800);
  }
  info(text: string) {
    this.show(text, 'info');
  }
  error(text: string) {
    this.show(text, 'error', 4500);
  }
  fail(e: unknown, fallback?: string) {
    if (e) console.error(e);
    const text = friendlyError(e, fallback);
    // Longer messages (e.g. the AI explaining what's missing) need time to read.
    this.show(text, 'error', Math.max(4500, text.length * 60));
  }

  dismiss(id: number) {
    this.toasts.update((t) => t.filter((x) => x.id !== id));
  }
}
