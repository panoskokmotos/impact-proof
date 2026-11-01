import { type Assertion, type FactField, ITEM_FIELDS, REQUIRED_FIELDS } from './types.ts';

// Units we treat as the same thing when comparing two sources. Anything else is compared as written.
const UNIT_ALIASES: Record<string, string> = {
  box: 'boxes', boxes: 'boxes', κουτί: 'boxes', κουτιά: 'boxes', κιβώτιο: 'boxes', κιβώτια: 'boxes',
  carton: 'cartons', cartons: 'cartons', χαρτοκιβώτιο: 'cartons', χαρτοκιβώτια: 'cartons',
  bag: 'bags', bags: 'bags', σακούλα: 'bags', σακούλες: 'bags',
  piece: 'pieces', pieces: 'pieces', item: 'pieces', items: 'pieces', τεμάχιο: 'pieces', τεμάχια: 'pieces',
};

export const isItemField = (field: FactField) => ITEM_FIELDS.includes(field);
export const lineOf = (a: Assertion) => a.line ?? 1;

/** The item lines a case has, in order. A case with no item facts yet has line 1. */
export function itemLines(assertions: Assertion[]): number[] {
  const lines = [...new Set(assertions.filter((a) => isItemField(a.field)).map(lineOf))].sort((a, b) => a - b);
  return lines.length ? lines : [1];
}

/**
 * Spelling-only key for comparing words: no accents, Greek letters that sound the same written
 * the same (η, υ, ει, οι → ι; ω → ο), and a word said twice in a row counted once. Voice
 * transcripts slip on exactly these ("κηβώτια", "Κιψέλης"), and that alone is not a disagreement.
 */
export function spellingKey(value: string): string {
  const plain = value.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ς/g, 'σ');
  const sounds = plain.replace(/ει|οι/g, 'ι').replace(/[ηυ]/g, 'ι').replace(/ω/g, 'ο');
  const words = sounds.split(/\s+/).filter(Boolean);
  return words.filter((w, i) => w !== words[i - 1]).join(' ');
}

const UNIT_ALIASES_BY_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(UNIT_ALIASES).map(([k, v]) => [spellingKey(k), v]),
);

export function normalize(field: FactField, value: string): string {
  const v = value.trim().toLowerCase();
  if (field === 'unit') return UNIT_ALIASES[v] ?? v;
  if (field === 'quantity') {
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? String(n) : v;
  }
  return v;
}

/** How two sources' values are compared: like normalize, but a spelling-only difference is no difference. */
function compareKey(field: FactField, value: string): string {
  if (field === 'unit') return UNIT_ALIASES[value.trim().toLowerCase()] ?? UNIT_ALIASES_BY_KEY[spellingKey(value)] ?? spellingKey(value);
  if (field === 'item' || field === 'place') return spellingKey(value);
  return normalize(field, value);
}

/**
 * The value a field currently has: the latest reviewer value wins, otherwise the latest reported/observed one.
 * Item fields are read for one item line; delivery fields ignore the line.
 */
export function currentValue(assertions: Assertion[], field: FactField, line = 1): Assertion | null {
  const forField = assertions.filter((a) => a.field === field && (!isItemField(field) || lineOf(a) === line));
  const reviewed = forField.filter((a) => a.kind === 'reviewer_confirmed');
  if (reviewed.length) return reviewed[reviewed.length - 1];
  const reported = forField.filter((a) => a.kind === 'reported');
  if (reported.length) return reported[reported.length - 1];
  return forField[forField.length - 1] ?? null;
}

/** Required facts still missing on any item line or on the delivery. */
export function missingFields(assertions: Assertion[]): FactField[] {
  const lines = itemLines(assertions);
  return REQUIRED_FIELDS.filter((f) => (isItemField(f) ? lines.some((l) => !currentValue(assertions, f, l)) : !currentValue(assertions, f)));
}

/**
 * Two field-worker sources disagreeing is a contradiction a human must settle.
 * A photo's visible count is not the total by default, so an observed quantity that is
 * lower than the reported one is flagged too, but never overrides it.
 */
export function contradictions(assertions: Assertion[]): string[] {
  const out: string[] = [];
  const lines = itemLines(assertions);
  const groups: { label: string; sources: Assertion[]; field: FactField }[] = [];
  for (const field of ['item', 'quantity', 'unit'] as FactField[]) {
    for (const l of lines) {
      groups.push({ field, label: lines.length > 1 ? `${field} (item ${l})` : field, sources: assertions.filter((a) => a.field === field && lineOf(a) === l) });
    }
  }
  for (const field of ['place', 'delivery_status'] as FactField[]) groups.push({ field, label: field, sources: assertions.filter((a) => a.field === field) });
  for (const g of groups) {
    const sources = g.sources.filter((a) => a.kind !== 'reviewer_confirmed');
    const values = [...new Set(sources.map((a) => compareKey(g.field, a.value)))];
    if (values.length > 1) {
      const detail = sources.map((a) => `${a.kind} "${a.value}"${a.evidenceId ? ` (${a.evidenceId})` : ''}`).join(' vs ');
      out.push(`${g.label}: ${detail}`);
    }
  }
  return out;
}
