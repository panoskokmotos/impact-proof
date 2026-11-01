import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEvidence, triage } from './domain/state.ts';
import type { Actor, FactField } from './domain/types.ts';
import { ModelUnavailable } from './meta/client.ts';
import { PROMPT_VERSION, type EvidenceForModel, type Extractor } from './meta/extract.ts';
import * as store from './store.ts';
import type { WhatsApp } from './whatsapp/cloud.ts';
import type { InboundMessage } from './whatsapp/webhook.ts';

export type Deps = {
  db: store.Db;
  dataDir: string;
  extract: Extractor;
  transcribe: (audio: Buffer) => Promise<{ text: string; model: string; ms: number }>;
  whatsapp: WhatsApp | null;
  caseWindowMinutes: number;
  retentionDays: number;
  log: (msg: string) => void;
};

// Channel 'whatsapp' is live. 'replay' is a signed fixture through the same webhook. 'web' is the upload fallback.
export type StoredEvent = InboundMessage & { channel: 'whatsapp' | 'replay' | 'web'; localFile?: string };

const MAX_ATTEMPTS = 3;
const SYSTEM = (tenantId: string): Actor => ({ role: 'system', id: 'worker', tenantId });

class Retryable extends Error {}

function isTransient(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  const name = (e as Error).name;
  return name === 'TimeoutError' || name === 'AbortError' || status === 429 || (status !== undefined && status >= 500) || (e as Error).message?.includes('fetch failed');
}

const LABELS: Record<FactField, [string, string]> = {
  item: ['what was delivered', 'τι παραδόθηκε'],
  quantity: ['how many', 'πόσα'],
  unit: ['the unit (boxes, bags...)', 'τη μονάδα (κιβώτια, σακούλες...)'],
  delivery_status: ['whether it has been delivered', 'αν έχει παραδοθεί'],
  place: ['where', 'πού'],
  time: ['when', 'πότε'],
};

export const isGreek = (text: string | null | undefined) => /[Ͱ-Ͽ]/.test(text ?? '');

/** The reply a field worker gets for every message, in the language they wrote or spoke in. */
export function receivedLine(caseId: string, greek: boolean): string {
  return greek ? `Το λάβαμε ως υπόθεση ${caseId}. Δεν έχει επιβεβαιωθεί ακόμη.` : `Received as case ${caseId}; not yet confirmed.`;
}

export function retakeTip(greek: boolean): string {
  return greek
    ? 'Η φωτογραφία δεν δείχνει καθαρά τα είδη. Βγάλτε μία φωτογραφία με όλα μαζί, από μπροστά και στο φως.'
    : "The photo doesn't clearly show the items. Take one photo with everything together, from the front, in good light.";
}

/** Added to the reply on someone's very first message: the fastest way to send a delivery. */
export function firstTimeTip(greek: boolean): string {
  return greek
    ? 'Συμβουλή: ο πιο γρήγορος τρόπος είναι ένα φωνητικό μήνυμα: τι παραδώσατε και πόσα. Μία φωτογραφία με όλα μαζί βοηθά.'
    : 'Tip: the fastest way is a voice note: what you delivered and how many. One photo with everything together helps.';
}

export function fallbackQuestion(missing: FactField[], greek: boolean): string | null {
  if (!missing.length) return null;
  const parts = missing.map((f) => LABELS[f][greek ? 1 : 0]).join(', ');
  return greek ? `Μπορείτε να στείλετε ${parts};` : `Could you send ${parts}?`;
}

async function handleMessage(d: Deps, messageId: string) {
  const row = d.db.prepare('SELECT payload FROM inbound_events WHERE message_id=?').get(messageId) as { payload: string } | undefined;
  if (!row) return;
  const ev = JSON.parse(row.payload) as StoredEvent;

  const reporter = d.db.prepare('SELECT tenant_id FROM reporters WHERE phone=?').get(ev.from) as { tenant_id: string } | undefined;
  if (!reporter) { d.log(`ignored message ${messageId}: sender not on the allowlist`); return; }

  // Reuse the evidence row on a retry so a case is created once per message.
  let evidence = d.db.prepare('SELECT * FROM evidence WHERE message_id=?').get(messageId) as Record<string, any> | undefined;
  let c = evidence ? store.getCase(d.db, evidence.case_id)! : null;
  if (!c) {
    const forceNew = ev.type === 'text' && /^\s*(new|νέο|νεο)\s*$/i.test(ev.text ?? '');
    const open = forceNew ? null : store.openCaseFor(d.db, ev.from, d.caseWindowMinutes);
    c = open ?? store.createCase(d.db, reporter.tenant_id, ev.from);
    if (!open) store.audit(d.db, c.id, 'system', 'case_created', null, 'received', 1, { channel: ev.channel });
    if (forceNew) { await enqueueReply(d, c.id, ev, `New case ${c.id} started. Send a photo or voice note.`); return; }
    const id = store.newId('ev');
    const kind = ev.type === 'image' ? 'image' : ev.type === 'audio' ? 'audio' : 'text';
    d.db.prepare('INSERT INTO evidence (id, case_id, message_id, channel, kind, mime, text, received_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, c.id, messageId, ev.channel, kind, ev.mime, ev.type === 'text' ? ev.text : null, store.now());
    evidence = d.db.prepare('SELECT * FROM evidence WHERE id=?').get(id) as Record<string, any>;
  }

  // Media: fetch once, validate, keep private bytes under the evidence ID.
  if ((evidence.kind === 'image' || evidence.kind === 'audio') && !evidence.path) {
    try {
      let bytes: Buffer;
      let mime = ev.mime ?? 'application/octet-stream';
      if (ev.localFile) bytes = readFileSync(ev.localFile);
      else if (d.whatsapp && ev.mediaId) ({ bytes, mime } = await d.whatsapp.downloadMedia(ev.mediaId));
      else throw new Error('No way to fetch this media');
      const sha = createHash('sha256').update(bytes).digest('hex');
      mkdirSync(join(d.dataDir, 'evidence'), { recursive: true });
      const path = join(d.dataDir, 'evidence', `${evidence.id}.bin`);
      writeFileSync(path, bytes, { mode: 0o600 });
      d.db.prepare('UPDATE evidence SET path=?, sha256=?, mime=? WHERE id=?').run(path, sha, mime, evidence.id);
      Object.assign(evidence, { path, sha256: sha, mime });
    } catch (e) {
      if (isTransient(e)) throw new Retryable((e as Error).message);
      d.db.prepare('UPDATE evidence SET error=? WHERE id=?').run(`Media: ${(e as Error).message}`, evidence.id);
    }
  }

  // Voice: transcribe once. If voice is unavailable the case still proceeds on the other evidence.
  if (evidence.kind === 'audio' && evidence.path && evidence.text === null) {
    try {
      const t = await d.transcribe(readFileSync(evidence.path));
      d.db.prepare('UPDATE evidence SET text=?, error=NULL WHERE id=?').run(t.text, evidence.id);
      d.db.prepare('INSERT INTO model_runs (case_id, step, model, prompt_version, ms, created_at) VALUES (?,?,?,?,?,?)')
        .run(c.id, 'transcribe', t.model, null, t.ms, store.now());
    } catch (e) {
      if (isTransient(e)) throw new Retryable((e as Error).message);
      d.db.prepare('UPDATE evidence SET error=? WHERE id=?').run(`Voice unavailable: ${(e as Error).message}`, evidence.id);
      d.db.prepare('INSERT INTO model_runs (case_id, step, error, created_at) VALUES (?,?,?,?)').run(c.id, 'transcribe', (e as Error).message, store.now());
    }
  }

  await extractCase(d, c.id);
  const after = store.getCase(d.db, c.id)!;
  const texts = d.db.prepare('SELECT text FROM evidence WHERE case_id=?').all(c.id) as { text: string | null }[];
  const greek = texts.some((r) => isGreek(r.text));
  const firstMessage = (d.db.prepare('SELECT COUNT(*) AS n FROM inbound_events WHERE from_phone=?').get(ev.from) as { n: number }).n === 1;
  const body = [receivedLine(after.id, greek), after.question, firstMessage ? firstTimeTip(greek) : null].filter(Boolean).join('\n');
  await enqueueReply(d, after.id, ev, body);
}

/** Re-reads every piece of evidence on the case and replaces the model's draft facts. Reviewer facts are kept. */
export async function extractCase(d: Deps, caseId: string) {
  const c = store.getCase(d.db, caseId)!;
  const rows = d.db.prepare('SELECT * FROM evidence WHERE case_id=? ORDER BY received_at').all(caseId) as Record<string, any>[];

  const flags = c.flags.filter((f) => !['possible_duplicate', 'model_unavailable', 'extraction_failed', 'instruction_in_evidence'].includes(f));
  for (const r of rows) {
    if (!r.sha256) continue;
    const dup = d.db.prepare('SELECT case_id FROM evidence WHERE sha256=? AND message_id<>? LIMIT 1').get(r.sha256, r.message_id) as { case_id: string } | undefined;
    if (dup) flags.push('possible_duplicate');
  }

  const forModel: EvidenceForModel[] = [];
  for (const r of rows) {
    if (r.kind === 'image' && r.path) forModel.push({ id: r.id, kind: 'image', mime: r.mime, base64: readFileSync(r.path).toString('base64') });
    else if (r.kind === 'audio' && r.text) forModel.push({ id: r.id, kind: 'transcript', text: r.text });
    else if (r.kind === 'text' && r.text) forModel.push({ id: r.id, kind: 'text', text: r.text });
  }
  const greek = rows.some((r) => isGreek(r.text));
  const base = { ...c, assertions: c.assertions.filter((a) => a.kind === 'reviewer_confirmed') };

  let processing = { state: 'done', error: null as string | null };
  let added: typeof c.assertions = [];
  let question: string | null = null;
  if (forModel.length) {
    try {
      const out = await d.extract(forModel);
      added = out.extraction.assertions;
      question = out.extraction.question;
      if (out.extraction.suspiciousInstructions.length) flags.push('instruction_in_evidence');
      d.db.prepare('INSERT INTO model_runs (case_id, step, model, prompt_version, ms, usage, dropped, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(caseId, 'extract', out.model, PROMPT_VERSION, out.ms, JSON.stringify(out.usage),
          JSON.stringify({ dropped: out.extraction.dropped, suspicious: out.extraction.suspiciousInstructions }), store.now());
    } catch (e) {
      if (isTransient(e)) throw new Retryable((e as Error).message);
      processing = { state: e instanceof ModelUnavailable ? 'unavailable' : 'failed', error: (e as Error).message };
      flags.push(e instanceof ModelUnavailable ? 'model_unavailable' : 'extraction_failed');
      d.db.prepare('INSERT INTO model_runs (case_id, step, prompt_version, error, created_at) VALUES (?,?,?,?,?)').run(caseId, 'extract', PROMPT_VERSION, (e as Error).message, store.now());
    }
  }

  const next = applyEvidence({ ...base, flags: [] }, SYSTEM(c.tenantId), added, flags);
  // A photo the model could read nothing from gets a retake tip, not a vague question.
  const unreadablePhoto = processing.state === 'done' && forModel.some((e) => e.kind === 'image') && !added.some((a) => a.kind === 'observed');
  if (next.status === 'needs_clarification') {
    next.question = question ?? (unreadablePhoto ? retakeTip(greek) : null) ?? fallbackQuestion(next.missing, greek) ?? (greek ? 'Οι πηγές διαφέρουν. Μπορείτε να επιβεβαιώσετε;' : 'The sources disagree. Can you confirm?');
  } else next.question = null;
  store.saveCase(d.db, next, processing);
  store.audit(d.db, caseId, 'system', 'extracted', c.status, next.status, next.version, { evidence: rows.length, facts: added.length, flags: next.flags, processing: processing.state });
}

async function enqueueReply(d: Deps, caseId: string, ev: StoredEvent, body: string) {
  store.enqueue(d.db, 'reply', `reply:${ev.messageId}`, { caseId, to: ev.from, inReplyTo: ev.messageId, channel: ev.channel, body });
}

async function handleReply(d: Deps, p: { caseId: string; to: string; inReplyTo: string; channel: string; body: string }) {
  d.db.prepare('INSERT OR IGNORE INTO outbound (case_id, in_reply_to, to_phone, body) VALUES (?,?,?,?)').run(p.caseId, p.inReplyTo, p.to, p.body);
  const row = d.db.prepare('SELECT wa_message_id FROM outbound WHERE in_reply_to=?').get(p.inReplyTo) as { wa_message_id: string | null };
  if (row.wa_message_id) return;
  if (p.channel !== 'whatsapp' || !d.whatsapp) {
    d.db.prepare('UPDATE outbound SET wa_status=? WHERE in_reply_to=?').run(p.channel === 'whatsapp' ? 'not_sent_no_credentials' : `not_sent_${p.channel}`, p.inReplyTo);
    return;
  }
  try {
    const { messageId } = await d.whatsapp.sendText(p.to, p.body);
    d.db.prepare("UPDATE outbound SET wa_message_id=?, wa_status='accepted', error=NULL WHERE in_reply_to=?").run(messageId, p.inReplyTo);
  } catch (e) {
    d.db.prepare('UPDATE outbound SET error=? WHERE in_reply_to=?').run((e as Error).message, p.inReplyTo);
    throw new Retryable((e as Error).message);
  }
}

export async function runOneJob(d: Deps): Promise<boolean> {
  const job = store.claimJob(d.db);
  if (!job) return false;
  const payload = JSON.parse(job.payload);
  try {
    if (job.type === 'message') await handleMessage(d, payload.messageId);
    else if (job.type === 'reply') await handleReply(d, payload);
    else if (job.type === 'extract') await extractCase(d, payload.caseId);
    store.finishJob(d.db, job.id, null, null);
  } catch (e) {
    const msg = (e as Error).message;
    const retry = e instanceof Retryable && job.attempts < MAX_ATTEMPTS ? 2000 * job.attempts ** 2 : null;
    store.finishJob(d.db, job.id, msg, retry);
    d.log(`job ${job.type}#${job.id} ${retry ? `retry in ${retry}ms` : 'failed'}: ${msg}`);
    if (!retry && (job.type === 'message' || job.type === 'extract')) markFailed(d, job.type === 'message' ? payload.messageId : null, payload.caseId);
  }
  return true;
}

/** After the last retry the case shows as failed, with a manual retry. Nothing is marked complete. */
function markFailed(d: Deps, messageId: string | null, caseId?: string) {
  const id = caseId ?? (d.db.prepare('SELECT case_id FROM evidence WHERE message_id=?').get(messageId) as { case_id: string } | undefined)?.case_id;
  if (!id) return;
  const c = store.getCase(d.db, id)!;
  if (c.status === 'confirmed' || c.status === 'disputed') return;
  const t = triage(c);
  store.saveCase(d.db, { ...c, ...t, flags: [...new Set([...c.flags, 'extraction_failed'])] }, { state: 'failed', error: 'Processing failed after retries' });
}

export function purgeExpired(d: Deps) {
  const before = new Date(Date.now() - d.retentionDays * 86_400_000).toISOString();
  for (const { id } of d.db.prepare('SELECT id FROM cases WHERE created_at < ?').all(before) as { id: string }[]) {
    for (const p of store.deleteCase(d.db, id)) rmSync(p, { force: true });
  }
}

export function startWorker(d: Deps): () => void {
  store.requeueStale(d.db);
  let busy = false;
  const tick = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { while (await runOneJob(d)); } finally { busy = false; }
  }, 500);
  const purge = setInterval(() => purgeExpired(d), 3_600_000);
  purgeExpired(d);
  return () => { clearInterval(tick); clearInterval(purge); };
}
