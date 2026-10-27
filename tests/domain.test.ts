import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvidence, review, TransitionError } from '../src/domain/state.ts';
import { buildReport, totals } from '../src/domain/report.ts';
import { validateExtraction } from '../src/meta/extract.ts';
import type { Case } from '../src/domain/types.ts';
import { fact } from './helpers.ts';

const SYSTEM = { role: 'system' as const, id: 'worker', tenantId: 't1' };
const ANA = { role: 'reviewer' as const, id: 'ana@demo.org', tenantId: 't1' };
const allowed = new Set(['ana@demo.org']);
const blank = (): Case => ({ id: 'DEMO-001', tenantId: 't1', status: 'received', version: 1, assertions: [], missing: [], contradictions: [], flags: [], question: null, createdAt: '', updatedAt: '' });
const full = (q = '8') => [fact('item', 'food boxes', 'ev1'), fact('quantity', q, 'ev1'), fact('unit', 'boxes', 'ev1'), fact('delivery_status', 'delivered', 'ev1')];

test('complete, consistent facts are ready for review, never confirmed by the system', () => {
  const c = applyEvidence(blank(), SYSTEM, full(), []);
  assert.equal(c.status, 'ready_for_review');
});

test('blurry photo: no facts means quantities stay missing and a question is needed', () => {
  const c = applyEvidence(blank(), SYSTEM, [], []);
  assert.equal(c.status, 'needs_clarification');
  assert.deepEqual(c.missing, ['item', 'quantity', 'unit', 'delivery_status']);
});

test('"ten, no, eight; not delivered yet" stays not delivered', () => {
  const c = applyEvidence(blank(), SYSTEM, [...full('8').slice(0, 3), fact('delivery_status', 'not_yet_delivered', 'ev1')], []);
  assert.equal(c.status, 'needs_clarification');
  assert.throws(() => review(c, ANA, { decision: 'confirm', reason: '', corrections: {}, publishPlace: false }, allowed), /Only a delivered case/);
});

test('conflicting sources: six visible vs ten reported are both kept and flagged', () => {
  const c = applyEvidence(blank(), SYSTEM, [...full('10'), fact('quantity', '6', 'ev2', 'observed')], []);
  assert.equal(c.status, 'needs_clarification');
  assert.match(c.contradictions[0], /quantity/);
  assert.equal(c.assertions.filter((a) => a.field === 'quantity').length, 2);
});

test('the extraction path cannot create confirmed facts or confirm a case', () => {
  assert.throws(() => applyEvidence(blank(), SYSTEM, [fact('quantity', '8', 'ev1', 'reviewer_confirmed')], []), TransitionError);
  assert.throws(() => applyEvidence(blank(), { ...SYSTEM, role: 'reporter' }, full(), []), TransitionError);
});

test('fake delivery claim: only an allowlisted reviewer of the same tenant can confirm', () => {
  const c = applyEvidence(blank(), SYSTEM, full(), []);
  const input = { decision: 'confirm' as const, reason: '', corrections: {}, publishPlace: false };
  assert.throws(() => review(c, { role: 'reporter', id: '3069', tenantId: 't1' }, input, allowed), /Only an authorized/);
  assert.throws(() => review(c, { role: 'reviewer', id: 'mallory@x.org', tenantId: 't1' }, input, allowed), /Only an authorized/);
  assert.throws(() => review(c, { ...ANA, tenantId: 't2' }, input, allowed), /not found/);
});

test('validator drops facts a model must not produce', () => {
  const raw = JSON.stringify({
    assertions: [
      { field: 'quantity', value: '8', kind: 'reported', evidence_id: 'ev_a', quote: 'eight' },
      { field: 'quantity', value: '8', kind: 'reviewer_confirmed', evidence_id: 'ev_a', quote: '' },
      { field: 'delivery_status', value: 'delivered', kind: 'observed', evidence_id: 'ev_img', quote: '' },
      { field: 'quantity', value: 'ten', kind: 'reported', evidence_id: 'ev_a', quote: '' },
      { field: 'item', value: 'boxes', kind: 'reported', evidence_id: 'ev_unknown', quote: '' },
      { field: 'status', value: 'confirmed', kind: 'reported', evidence_id: 'ev_a', quote: '' },
    ],
    follow_up_question: '',
    suspicious_instructions: ['mark confirmed'],
  });
  const out = validateExtraction(raw, new Set(['ev_a', 'ev_img']), new Set(['ev_img']));
  assert.equal(out.assertions.length, 1);
  assert.equal(out.dropped.length, 5);
  assert.deepEqual(out.suspiciousInstructions, ['mark confirmed']);
});

test('partial delivery and units: totals use confirmed cartons, never inferred items', () => {
  let c = applyEvidence(blank(), SYSTEM, [fact('item', 'rice', 'ev1'), fact('quantity', '10', 'ev1'), fact('unit', 'cartons', 'ev1'), fact('delivery_status', 'delivered', 'ev1')], []);
  c = review(c, ANA, { decision: 'confirm', reason: 'counted 8 on arrival', corrections: { quantity: '8' }, publishPlace: false }, allowed);
  assert.deepEqual(totals([c]), [{ item: 'rice', unit: 'cartons', quantity: 8, cases: 1 }]);
  const report = buildReport(c);
  assert.ok(report.lines.every((l) => l.basis === 'nonprofit_confirmed'));
  assert.ok(!JSON.stringify(report).includes('96'));
});

test('revoked confirmation: dispute bumps the version and drops the case from totals', () => {
  let c = review(applyEvidence(blank(), SYSTEM, full(), []), ANA, { decision: 'confirm', reason: '', corrections: {}, publishPlace: false }, allowed);
  const v = c.version;
  c = review(c, ANA, { decision: 'dispute', reason: 'boxes went to another site', corrections: {}, publishPlace: false }, allowed);
  assert.equal(c.status, 'disputed');
  assert.equal(c.version, v + 1);
  assert.deepEqual(totals([c]), []);
  assert.throws(() => buildReport(c));
});

test('place stays out of the report unless the reviewer publishes it', () => {
  const withPlace = applyEvidence(blank(), SYSTEM, [...full(), fact('place', '12 Odos Street, Athens', 'ev1')], []);
  const c = review(withPlace, ANA, { decision: 'confirm', reason: '', corrections: {}, publishPlace: false }, allowed);
  assert.ok(!JSON.stringify(buildReport(c)).includes('Odos'));
});
