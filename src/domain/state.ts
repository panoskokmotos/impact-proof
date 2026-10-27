import { contradictions, missingFields, currentValue } from './facts.ts';
import type { Actor, Assertion, Case, CaseStatus, FactField, ReviewInput } from './types.ts';
import { DELIVERY_STATUSES, FACT_FIELDS } from './types.ts';

export class TransitionError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

// Flags that keep a case in clarification until a person has looked at it.
const HOLDING_FLAGS = ['possible_duplicate', 'instruction_in_evidence', 'model_unavailable', 'extraction_failed'];

/** Status the system may set after new evidence. It never reaches confirmed or disputed. */
export function triage(c: Pick<Case, 'assertions' | 'flags'>): {
  status: CaseStatus;
  missing: FactField[];
  contradictions: string[];
} {
  const missing = missingFields(c.assertions);
  const conflicts = contradictions(c.assertions);
  const delivered = currentValue(c.assertions, 'delivery_status')?.value === 'delivered';
  const held = c.flags.some((f) => HOLDING_FLAGS.includes(f));
  const clear = missing.length === 0 && conflicts.length === 0 && delivered && !held;
  return { status: clear ? 'ready_for_review' : 'needs_clarification', missing, contradictions: conflicts };
}

/** Applies new evidence to an open case. Confirmed and disputed cases stay as the reviewer left them. */
export function applyEvidence(c: Case, actor: Actor, added: Assertion[], flags: string[]): Case {
  if (actor.role !== 'system') throw new TransitionError('Only the extraction worker adds evidence to a case');
  if (actor.tenantId !== c.tenantId) throw new TransitionError('Wrong tenant', 404);
  if (added.some((a) => a.kind === 'reviewer_confirmed')) {
    throw new TransitionError('Extracted facts can never be reviewer confirmed');
  }
  const next = { ...c, assertions: [...c.assertions, ...added], flags: [...new Set([...c.flags, ...flags])] };
  if (c.status === 'confirmed' || c.status === 'disputed') {
    // Late evidence on a closed case is kept for the reviewer but changes nothing they decided.
    return { ...next, flags: [...new Set([...next.flags, 'evidence_after_review'])] };
  }
  const t = triage(next);
  return { ...next, ...t };
}

/**
 * The only way a case becomes confirmed or disputed. Corrections after confirmation
 * create a new version, which supersedes any report made from the old one.
 */
export function review(c: Case, actor: Actor, input: ReviewInput, allowedReviewers: Set<string>): Case {
  if (actor.role !== 'reviewer' || !allowedReviewers.has(actor.id)) {
    throw new TransitionError('Only an authorized nonprofit reviewer can confirm or dispute');
  }
  if (actor.tenantId !== c.tenantId) throw new TransitionError('Case not found', 404);
  if (c.status === 'received') throw new TransitionError('Evidence is still being processed', 409);
  if (!input.reason.trim() && input.decision === 'dispute') throw new TransitionError('A dispute needs a reason', 400);

  const corrected: Assertion[] = [];
  for (const [field, raw] of Object.entries(input.corrections)) {
    if (!FACT_FIELDS.includes(field as FactField)) throw new TransitionError(`Unknown field ${field}`, 400);
    const value = (raw ?? '').trim();
    if (!value) continue;
    if (field === 'quantity' && !(Number(value) > 0)) throw new TransitionError('Quantity must be a positive number', 400);
    if (field === 'delivery_status' && !DELIVERY_STATUSES.includes(value as never)) {
      throw new TransitionError('Unknown delivery status', 400);
    }
    corrected.push({ field: field as FactField, value, kind: 'reviewer_confirmed', evidenceId: null, quote: `Set by ${actor.id}` });
  }

  const assertions = [...c.assertions, ...corrected];
  if (input.decision === 'confirm') {
    // Confirming means the reviewer stands behind every required fact. Fill unchanged ones from the current value.
    for (const field of ['item', 'quantity', 'unit', 'delivery_status', 'time', 'place'] as FactField[]) {
      if (assertions.some((a) => a.field === field && a.kind === 'reviewer_confirmed')) continue;
      const cur = currentValue(assertions, field);
      if (!cur) continue;
      if (field === 'place' && !input.publishPlace) continue;
      assertions.push({ field, value: cur.value, kind: 'reviewer_confirmed', evidenceId: cur.evidenceId, quote: `Accepted by ${actor.id}` });
    }
    const stillMissing = missingFields(assertions.filter((a) => a.kind === 'reviewer_confirmed'));
    if (stillMissing.length) throw new TransitionError(`Fill in before confirming: ${stillMissing.join(', ')}`, 400);
    if (currentValue(assertions, 'delivery_status')?.value !== 'delivered') {
      throw new TransitionError('Only a delivered case can be confirmed. Dispute it or wait for delivery.', 400);
    }
  }

  return {
    ...c,
    assertions,
    status: input.decision === 'confirm' ? 'confirmed' : 'disputed',
    version: c.version + 1,
    question: null,
  };
}
