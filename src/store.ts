import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type { Case, CaseStatus } from './domain/types.ts';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS reporters (phone TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbound_events (
      message_id TEXT PRIMARY KEY, channel TEXT NOT NULL, from_phone TEXT NOT NULL,
      payload TEXT NOT NULL, received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, run_after INTEGER NOT NULL,
      last_error TEXT);
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reporter_phone TEXT NOT NULL, status TEXT NOT NULL,
      data TEXT NOT NULL, processing TEXT NOT NULL DEFAULT 'pending', processing_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, message_id TEXT NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL,
      mime TEXT, sha256 TEXT, path TEXT, text TEXT, error TEXT, received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, step TEXT NOT NULL, model TEXT, prompt_version TEXT,
      ms INTEGER, usage TEXT, error TEXT, dropped TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      from_status TEXT, to_status TEXT, version INTEGER, detail TEXT, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports (
      token TEXT PRIMARY KEY, case_id TEXT NOT NULL, case_version INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT, in_reply_to TEXT NOT NULL UNIQUE, to_phone TEXT NOT NULL,
      body TEXT NOT NULL, wa_message_id TEXT, wa_status TEXT NOT NULL DEFAULT 'pending', error TEXT);
  `);
  return db;
}

export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;

// ---- events & jobs ----

/** Returns false when this message ID was already stored: webhook retries and replays do nothing. */
export function recordInbound(db: Db, messageId: string, channel: string, from: string, payload: unknown): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO inbound_events (message_id, channel, from_phone, payload, received_at) VALUES (?,?,?,?,?)')
    .run(messageId, channel, from, JSON.stringify(payload), now());
  return r.changes === 1;
}

export function enqueue(db: Db, type: string, key: string, payload: unknown) {
  db.prepare('INSERT OR IGNORE INTO jobs (type, key, payload, run_after) VALUES (?,?,?,?)').run(type, key, JSON.stringify(payload), Date.now());
}

export type Job = { id: number; type: string; key: string; payload: string; attempts: number };

export function claimJob(db: Db): Job | null {
  const job = db.prepare("SELECT id, type, key, payload, attempts FROM jobs WHERE status='queued' AND run_after <= ? ORDER BY id LIMIT 1")
    .get(Date.now()) as Job | undefined;
  if (!job) return null;
  const r = db.prepare("UPDATE jobs SET status='running', attempts=attempts+1 WHERE id=? AND status='queued'").run(job.id);
  return r.changes === 1 ? { ...job, attempts: job.attempts + 1 } : null;
}

export function finishJob(db: Db, id: number, error: string | null, retryInMs: number | null) {
  if (!error) db.prepare("UPDATE jobs SET status='done', last_error=NULL WHERE id=?").run(id);
  else if (retryInMs !== null) db.prepare("UPDATE jobs SET status='queued', last_error=?, run_after=? WHERE id=?").run(error, Date.now() + retryInMs, id);
  else db.prepare("UPDATE jobs SET status='failed', last_error=? WHERE id=?").run(error, id);
}

/** Jobs left 'running' by a crash go back to the queue on start. */
export function requeueStale(db: Db) {
  db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run();
}

// ---- cases ----

type CaseRow = { id: string; tenant_id: string; reporter_phone: string; status: string; data: string; processing: string; processing_error: string | null; created_at: string; updated_at: string };

export type CaseRecord = Case & { reporterPhone: string; processing: string; processingError: string | null };

function fromRow(r: CaseRow): CaseRecord {
  const d = JSON.parse(r.data);
  return {
    id: r.id, tenantId: r.tenant_id, status: r.status as CaseStatus, version: d.version,
    assertions: d.assertions, missing: d.missing, contradictions: d.contradictions, flags: d.flags, question: d.question,
    createdAt: r.created_at, updatedAt: r.updated_at,
    reporterPhone: r.reporter_phone, processing: r.processing, processingError: r.processing_error,
  };
}

export function getCase(db: Db, id: string): CaseRecord | null {
  const r = db.prepare('SELECT * FROM cases WHERE id=?').get(id) as CaseRow | undefined;
  return r ? fromRow(r) : null;
}

export function listCases(db: Db, tenantId: string): CaseRecord[] {
  return (db.prepare('SELECT * FROM cases WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId) as CaseRow[]).map(fromRow);
}

export function createCase(db: Db, tenantId: string, reporterPhone: string): CaseRecord {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n + 1;
  const id = `DEMO-${String(n).padStart(3, '0')}`;
  const t = now();
  const c: Case = { id, tenantId, status: 'received', version: 1, assertions: [], missing: [], contradictions: [], flags: [], question: null, createdAt: t, updatedAt: t };
  db.prepare('INSERT INTO cases (id, tenant_id, reporter_phone, status, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, tenantId, reporterPhone, c.status, dataOf(c), t, t);
  return { ...c, reporterPhone, processing: 'pending', processingError: null };
}

const dataOf = (c: Case) => JSON.stringify({ version: c.version, assertions: c.assertions, missing: c.missing, contradictions: c.contradictions, flags: c.flags, question: c.question });

export function saveCase(db: Db, c: Case, processing?: { state: string; error: string | null }) {
  const t = now();
  db.prepare('UPDATE cases SET status=?, data=?, updated_at=? WHERE id=?').run(c.status, dataOf(c), t, c.id);
  if (processing) db.prepare('UPDATE cases SET processing=?, processing_error=? WHERE id=?').run(processing.state, processing.error, c.id);
}

/** The open case a new message from this reporter should join, if they sent one recently. */
export function openCaseFor(db: Db, phone: string, windowMinutes: number): CaseRecord | null {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const r = db.prepare("SELECT * FROM cases WHERE reporter_phone=? AND status IN ('received','needs_clarification','ready_for_review') AND updated_at >= ? ORDER BY created_at DESC LIMIT 1")
    .get(phone, since) as CaseRow | undefined;
  return r ? fromRow(r) : null;
}

export function audit(db: Db, caseId: string, actor: string, action: string, from: string | null, to: string | null, version: number | null, detail: unknown) {
  db.prepare('INSERT INTO audit (case_id, actor, action, from_status, to_status, version, detail, at) VALUES (?,?,?,?,?,?,?,?)')
    .run(caseId, actor, action, from, to, version, JSON.stringify(detail ?? null), now());
}

export type ImpactStats = { confirmed: number; medianMinutes: number | null; drafted: number; corrected: number };

/**
 * Measured from this tenant's own audit trail: minutes from the first message to the first
 * confirmation, and how many model-drafted facts the reviewer had to change.
 */
export function impactStats(db: Db, tenantId: string): ImpactStats {
  const rows = db.prepare(`
    SELECT c.id, MIN(CASE WHEN a.action='case_created' THEN a.at END) AS created,
           MIN(CASE WHEN a.action='confirmed' THEN a.at END) AS confirmed,
           (SELECT detail FROM audit WHERE case_id=c.id AND action='confirmed' ORDER BY id LIMIT 1) AS detail
    FROM cases c JOIN audit a ON a.case_id=c.id WHERE c.tenant_id=? GROUP BY c.id`).all(tenantId) as { created: string | null; confirmed: string | null; detail: string | null }[];
  const done = rows.filter((r) => r.created && r.confirmed);
  const minutes = done.map((r) => (Date.parse(r.confirmed!) - Date.parse(r.created!)) / 60_000).sort((a, b) => a - b);
  let drafted = 0;
  let corrected = 0;
  for (const r of done) {
    const d = JSON.parse(r.detail ?? 'null') as { drafted?: number; corrected?: string[] } | null;
    drafted += d?.drafted ?? 0;
    corrected += d?.corrected?.length ?? 0;
  }
  const mid = minutes.length ? (minutes.length % 2 ? minutes[(minutes.length - 1) / 2] : (minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2) : null;
  return { confirmed: done.length, medianMinutes: mid === null ? null : Math.round(mid * 10) / 10, drafted, corrected };
}

export function deleteCase(db: Db, id: string): string[] {
  const paths = (db.prepare('SELECT path FROM evidence WHERE case_id=? AND path IS NOT NULL').all(id) as { path: string }[]).map((r) => r.path);
  for (const t of ['evidence', 'model_runs', 'reports', 'audit']) db.prepare(`DELETE FROM ${t} WHERE case_id=?`).run(id);
  db.prepare('DELETE FROM cases WHERE id=?').run(id);
  return paths;
}
