import { currentValue, normalize } from './facts.ts';
import type { Case, FactField } from './types.ts';

export type ReportLine = { label: string; value: string; basis: 'nonprofit_confirmed' | 'reported_only' };

export type DonorReport = {
  caseId: string;
  caseVersion: number;
  lines: ReportLine[];
  limits: string[];
};

const LABELS: Partial<Record<FactField, string>> = {
  item: 'Item', quantity: 'Quantity', unit: 'Unit', time: 'Delivered on', place: 'Area',
};

/**
 * Donor-safe report. Built only from a confirmed case, and only from fields a reviewer confirmed.
 * Never includes phone numbers, photos, transcripts or exact addresses.
 */
export function buildReport(c: Case, ctx: { sources: string[]; modelDrafted: boolean } = { sources: [], modelDrafted: false }): DonorReport {
  if (c.status !== 'confirmed') throw new Error('A donor report needs a nonprofit-confirmed case');
  const lines: ReportLine[] = [];
  for (const field of ['item', 'quantity', 'unit', 'time', 'place'] as FactField[]) {
    const a = currentValue(c.assertions, field);
    if (!a || a.kind !== 'reviewer_confirmed') continue;
    lines.push({ label: LABELS[field]!, value: field === 'time' ? a.value.slice(0, 10) : a.value, basis: 'nonprofit_confirmed' });
  }
  return {
    caseId: c.id,
    caseVersion: c.version,
    lines,
    limits: [
      `Confirmed by the nonprofit${ctx.sources.length ? `, based on a field worker's ${listOf(ctx.sources)}` : ''}. This is the nonprofit's attestation, not independent proof of delivery.`,
      ctx.modelDrafted
        ? 'An AI model drafted the facts from the evidence. A person at the nonprofit checked and confirmed them.'
        : 'A person at the nonprofit entered and confirmed these facts.',
      'Evidence and exact locations stay private and are not shared in this report.',
    ],
  };
}

const SOURCE_NAMES: Record<string, string> = { image: 'photo', audio: 'voice note', text: 'message' };
function listOf(kinds: string[]) {
  const names = [...new Set(kinds.map((k) => SOURCE_NAMES[k] ?? k))];
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

/** Totals counted in code from confirmed cases only, grouped by item and unit. No unit conversion is inferred. */
export function totals(cases: Case[]): { item: string; unit: string; quantity: number; cases: number }[] {
  const groups = new Map<string, { item: string; unit: string; quantity: number; cases: number }>();
  for (const c of cases) {
    if (c.status !== 'confirmed') continue;
    const get = (f: FactField) => {
      const a = currentValue(c.assertions, f);
      return a?.kind === 'reviewer_confirmed' ? a.value : null;
    };
    const item = get('item');
    const unit = get('unit');
    const qty = Number(get('quantity'));
    if (!item || !unit || !(qty > 0)) continue;
    const key = `${normalize('item', item)}|${normalize('unit', unit)}`;
    const g = groups.get(key) ?? { item, unit: normalize('unit', unit), quantity: 0, cases: 0 };
    g.quantity += qty;
    g.cases += 1;
    groups.set(key, g);
  }
  return [...groups.values()];
}
