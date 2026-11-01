export const FACT_FIELDS = ['item', 'quantity', 'unit', 'place', 'time', 'delivery_status'] as const;
export type FactField = (typeof FACT_FIELDS)[number];

// Facts a case needs before a reviewer is asked to look at it.
export const REQUIRED_FIELDS: FactField[] = ['item', 'quantity', 'unit', 'delivery_status'];

export const DELIVERY_STATUSES = ['delivered', 'not_yet_delivered', 'unclear'] as const;

// observed: visible in a photo. reported: said or written by the field worker.
// reviewer_confirmed: set by an authorized nonprofit reviewer. Only the reviewer can create this kind.
export type AssertionKind = 'observed' | 'reported' | 'reviewer_confirmed';

// One delivery can hold several items. item, quantity and unit belong to an item line (1, 2, ...);
// place, time and delivery_status belong to the whole delivery. A fact without a line is line 1.
export const ITEM_FIELDS: FactField[] = ['item', 'quantity', 'unit'];

export type Assertion = {
  field: FactField;
  value: string;
  kind: AssertionKind;
  evidenceId: string | null; // null only for reviewer_confirmed
  quote: string;
  line?: number;
};

export type CaseStatus = 'received' | 'needs_clarification' | 'ready_for_review' | 'confirmed' | 'disputed';

export type Role = 'system' | 'reporter' | 'reviewer';
export type Actor = { role: Role; id: string; tenantId: string };

export type Case = {
  id: string;
  tenantId: string;
  status: CaseStatus;
  version: number;
  assertions: Assertion[];
  missing: FactField[];
  contradictions: string[];
  flags: string[];
  question: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReviewInput = {
  decision: 'confirm' | 'dispute';
  reason: string;
  // Keyed by field ("place") or, for item lines, field and line ("quantity_2"). A plain item field is line 1.
  corrections: Record<string, string>;
  publishPlace: boolean;
};
