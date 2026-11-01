import { type Assertion, type FactField, REQUIRED_FIELDS } from './types.ts';

// Units we treat as the same thing when comparing two sources. Anything else is compared as written.
const UNIT_ALIASES: Record<string, string> = {
  box: 'boxes', boxes: 'boxes', κουτί: 'boxes', κουτιά: 'boxes', κιβώτιο: 'boxes', κιβώτια: 'boxes',
  carton: 'cartons', cartons: 'cartons', χαρτοκιβώτιο: 'cartons', χαρτοκιβώτια: 'cartons',
  bag: 'bags', bags: 'bags', σακούλα: 'bags', σακούλες: 'bags',
};

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

/** The value a field currently has: the latest reviewer value wins, otherwise the latest reported/observed one. */
export function currentValue(assertions: Assertion[], field: FactField): Assertion | null {
  const forField = assertions.filter((a) => a.field === field);
  const reviewed = forField.filter((a) => a.kind === 'reviewer_confirmed');
  if (reviewed.length) return reviewed[reviewed.length - 1];
  const reported = forField.filter((a) => a.kind === 'reported');
  if (reported.length) return reported[reported.length - 1];
  return forField[forField.length - 1] ?? null;
}

export function missingFields(assertions: Assertion[]): FactField[] {
  return REQUIRED_FIELDS.filter((f) => !currentValue(assertions, f));
}

/**
 * Two field-worker sources disagreeing is a contradiction a human must settle.
 * A photo's visible count is not the total by default, so an observed quantity that is
 * lower than the reported one is flagged too, but never overrides it.
 */
export function contradictions(assertions: Assertion[]): string[] {
  const out: string[] = [];
  const fields: FactField[] = ['item', 'quantity', 'unit', 'place', 'delivery_status'];
  for (const field of fields) {
    const sources = assertions.filter((a) => a.field === field && a.kind !== 'reviewer_confirmed');
    const values = [...new Set(sources.map((a) => compareKey(field, a.value)))];
    if (values.length > 1) {
      const detail = sources.map((a) => `${a.kind} "${a.value}"${a.evidenceId ? ` (${a.evidenceId})` : ''}`).join(' vs ');
      out.push(`${field}: ${detail}`);
    }
  }
  return out;
}
