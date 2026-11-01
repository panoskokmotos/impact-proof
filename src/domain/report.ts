import { currentValue, itemLines, normalize } from './facts.ts';
import type { Case, FactField } from './types.ts';

export type ReportLine = { label: string; value: string; basis: 'nonprofit_confirmed' | 'reported_only' };
export type ReportItem = { item: string; quantity: string; unit: string };

export type DonorReport = {
  caseId: string;
  caseVersion: number;
  items: ReportItem[];
  lines: ReportLine[];
  limits: string[];
};

const LABELS: Partial<Record<FactField, string>> = { time: 'Delivered on', place: 'Area' };

/** Each item line where the reviewer confirmed item, quantity and unit. */
function confirmedItems(c: Case): ReportItem[] {
  const out: ReportItem[] = [];
  for (const line of itemLines(c.assertions)) {
    const get = (f: FactField) => {
      const a = currentValue(c.assertions, f, line);
      return a?.kind === 'reviewer_confirmed' ? a.value : null;
    };
    const item = get('item');
    const quantity = get('quantity');
    const unit = get('unit');
    if (item && quantity && unit) out.push({ item, quantity, unit });
  }
  return out;
}

/**
 * Donor-safe report. Built only from a confirmed case, and only from fields a reviewer confirmed.
 * Never includes phone numbers, photos, transcripts or exact addresses.
 */
export function buildReport(c: Case, ctx: { sources: string[]; modelDrafted: boolean } = { sources: [], modelDrafted: false }): DonorReport {
  if (c.status !== 'confirmed') throw new Error('A donor report needs a nonprofit-confirmed case');
  const lines: ReportLine[] = [];
  for (const field of ['time', 'place'] as FactField[]) {
    const a = currentValue(c.assertions, field);
    if (!a || a.kind !== 'reviewer_confirmed') continue;
    lines.push({ label: LABELS[field]!, value: field === 'time' ? a.value.slice(0, 10) : a.value, basis: 'nonprofit_confirmed' });
  }
  return {
    caseId: c.id,
    caseVersion: c.version,
    items: confirmedItems(c),
    lines,
    limits: [
      `Confirmed by the nonprofit${ctx.sources.length ? `, based on a ${listOf(ctx.sources)} from the nonprofit's team` : ''}. This is the nonprofit's attestation, not independent proof of delivery.`,
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
    for (const { item, unit, quantity } of confirmedItems(c)) {
      const qty = Number(quantity);
      if (!(qty > 0)) continue;
      const key = `${normalize('item', item)}|${normalize('unit', unit)}`;
      const g = groups.get(key) ?? { item, unit: normalize('unit', unit), quantity: 0, cases: 0 };
      g.quantity += qty;
      g.cases += 1;
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}
