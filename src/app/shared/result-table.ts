import { Component, computed, input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

type Row = Record<string, unknown>;

const MONEY_COL = /(amount|price|total|fee|fees|balance|due|cost|revenue|collection|salary|charge|refund|discount|tax|mrp)/i;
const NOT_MONEY_COL = /(count|qty|quantity|number|_no$|^no_|patients|visits|items|rows|_id$|^id$|percent|pct|rate)/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 4 });
const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** patient_name → "Patient name", createdAt → "Created at", mobile_no → "Mobile no". */
export function friendlyHeader(col: string): string {
  const s = col
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (s === 'id') return 'ID';
  return s.replace(/\bid\b/g, 'ID').replace(/\bupi\b/g, 'UPI').replace(/^./, (c) => c.toUpperCase());
}

function isNumeric(v: unknown): v is number | string {
  return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim()));
}

/** Display text for one cell: ₹ for money columns, readable dates, Yes/No, grouped numbers. */
export function formatCell(col: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (isNumeric(v)) {
    const n = Number(v);
    if (MONEY_COL.test(col) && !NOT_MONEY_COL.test(col)) return inr.format(n);
    // Phone numbers, pincodes, long ids: keep exactly as stored (but counts/totals get grouping).
    if (typeof v === 'string' && /^\d{6,}$/.test(v) && !/(count|total|sum|qty|rows|number_of)/i.test(col)) return v;
    if (/(_no$|^no_|phone|mobile|pin|zip|code|year)/i.test(col)) return String(v);
    return num.format(n);
  }
  if (typeof v === 'string') {
    if (DATE_ONLY.test(v)) {
      const d = new Date(`${v}T00:00:00`);
      return isNaN(+d) ? v : dateFmt.format(d);
    }
    if (DATE_TIME.test(v)) {
      const d = new Date(v);
      return isNaN(+d) ? v : dateTimeFmt.format(d);
    }
    return v;
  }
  return JSON.stringify(v);
}

/** A results table that reads like a report, with CSV download. */
@Component({
  selector: 'app-result-table',
  imports: [LucideAngularModule],
  template: `
    @if (!rows().length) {
      <p class="text-sm text-slate-400">{{ emptyText() }}</p>
    } @else {
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-slate-500">
          <strong class="text-slate-700">{{ shownLabel() }}</strong>
          @if (truncated()) {
            <span> · showing the first {{ rows().length }}</span>
          }
        </p>
        <button class="btn-ghost !px-3 !py-1.5 text-xs" (click)="downloadCsv()">
          <lucide-icon name="download" class="size-3.5" /> Download CSV
        </button>
      </div>
      <div class="overflow-x-auto rounded-xl border border-slate-100">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-50">
            <tr class="text-slate-500">
              @for (col of columns(); track col) {
                <th class="px-3 py-2.5 font-semibold whitespace-nowrap" [class.text-right]="numericCol(col)">{{ header(col) }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track $index) {
              <tr class="border-t border-slate-100 hover:bg-slate-50/60">
                @for (col of columns(); track col) {
                  <td
                    class="max-w-[22rem] truncate px-3 py-2 whitespace-nowrap text-slate-700"
                    [class.text-right]="numericCol(col)"
                    [class.tabular-nums]="numericCol(col)"
                    [title]="raw(row, col)"
                  >
                    {{ cell(row, col) }}
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class ResultTable {
  readonly rows = input<Row[]>([]);
  /** Total rows the query returned (may exceed what's shown). */
  readonly total = input<number | null>(null);
  readonly fileName = input('db-spread-bot-results');
  readonly emptyText = input('Ran successfully — no rows returned.');

  protected readonly columns = computed(() => {
    const seen = new Set<string>();
    for (const r of this.rows().slice(0, 50)) for (const k of Object.keys(r)) seen.add(k);
    return [...seen];
  });
  protected readonly truncated = computed(() => (this.total() ?? 0) > this.rows().length);
  protected readonly shownLabel = computed(() => {
    const n = this.truncated() ? `${this.rows().length}+` : String(this.rows().length);
    return `${n} row${this.rows().length === 1 ? '' : 's'}`;
  });

  protected header = friendlyHeader;
  protected cell(row: Row, col: string) {
    return formatCell(col, row[col]);
  }
  protected raw(row: Row, col: string) {
    const v = row[col];
    return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  protected numericCol(col: string) {
    const sample = this.rows().find((r) => r[col] !== null && r[col] !== undefined)?.[col];
    return isNumeric(sample) && !/(_no$|phone|mobile|pin|zip|code|year)/i.test(col) && !(typeof sample === 'string' && /^\d{6,}$/.test(sample));
  }

  downloadCsv() {
    const cols = this.columns();
    const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [cols.map((c) => esc(friendlyHeader(c))).join(',')];
    for (const r of this.rows()) lines.push(cols.map((c) => esc(this.raw(r, c))).join(','));
    // BOM so Excel opens UTF-8 (₹, Indian names) correctly.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.fileName().replace(/[^\w-]+/g, '-').slice(0, 60)}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
