import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.ts';
import { openDb } from '../src/store.ts';
import type { Assertion } from '../src/domain/types.ts';
import type { EvidenceForModel, Extraction } from '../src/meta/extract.ts';
import { runOneJob, type Deps } from '../src/worker.ts';
import { sign } from '../src/whatsapp/webhook.ts';

export const APP_SECRET = 'test-app-secret';
export const PHONE = '306900000001';

/**
 * A test double for the model: given the evidence, returns the facts a script says it should.
 * It stands in for Meta only in tests; the live evals in scripts/ call the real API.
 */
export type Script = (e: EvidenceForModel[]) => Partial<Extraction> & { assertions: Assertion[] };

export async function startTestApp(script: Script) {
  const dir = mkdtempSync(join(tmpdir(), 'ip-'));
  const db = openDb(join(dir, 'db.sqlite'));
  db.prepare('INSERT INTO reporters (phone, tenant_id, label) VALUES (?,?,?)').run(PHONE, 't1', 'Worker A');
  const sent: { to: string; body: string }[] = [];
  const deps: Deps = {
    db,
    dataDir: dir,
    extract: async (ev) => ({ extraction: { question: null, suspiciousInstructions: [], dropped: [], ...script(ev) }, model: 'test-double', usage: null, ms: 1 }),
    transcribe: async (audio) => ({ text: audio.toString('utf8'), model: 'test-double', ms: 1 }),
    whatsapp: {
      async sendText(to, body) { sent.push({ to, body }); return { messageId: `wamid.out${sent.length}` }; },
      async downloadMedia(id) { return { bytes: Buffer.from(`media:${id}`), mime: id.startsWith('aud') ? 'audio/ogg' : 'image/jpeg' }; },
    },
    caseWindowMinutes: 30,
    retentionDays: 14,
    log: () => {},
  };
  const app = createApp(deps, {
    appSecret: APP_SECRET, verifyToken: 'vt', sessionSecret: 'x'.repeat(40), passcode: 'pass',
    reviewers: [{ email: 'ana@demo.org', tenantId: 't1' }, { email: 'eve@other.org', tenantId: 't2' }],
    tenants: { t1: 'Demo Food Bank', t2: 'Other NGO' },
    status: () => ({}),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as { port: number }).port}`;

  const drain = async () => { while (await runOneJob(deps)); };

  const webhook = (messages: object[], extra: { statuses?: object[] } = {}, secret = APP_SECRET) => {
    const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages, ...extra } }] }] });
    return fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body, secret) } });
  };

  const login = async (email: string) => {
    const r = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ email, passcode: 'pass' }) });
    return r.headers.get('set-cookie')!.split(';')[0];
  };

  const post = (path: string, cookie: string, form: Record<string, string>) =>
    fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { cookie }, body: new URLSearchParams(form) });

  return { db, deps, base, sent, drain, webhook, login, post, close: () => server.close() };
}

export const text = (id: string, body: string, from = PHONE) => ({ id, from, timestamp: '1793000000', type: 'text', text: { body } });
export const image = (id: string, mediaId: string, from = PHONE) => ({ id, from, timestamp: '1793000000', type: 'image', image: { id: mediaId, mime_type: 'image/jpeg' } });

export const fact = (field: Assertion['field'], value: string, evidenceId: string, kind: Assertion['kind'] = 'reported'): Assertion =>
  ({ field, value, kind, evidenceId, quote: value });

/** Facts for every text/transcript the script recognizes, keyed by a phrase in the evidence. */
export const byPhrase = (table: Record<string, [Assertion['field'], string][]>): Script => (ev) => {
  const assertions: Assertion[] = [];
  for (const e of ev) {
    const content = e.kind === 'image' ? Buffer.from(e.base64, 'base64').toString() : e.text;
    for (const [phrase, facts] of Object.entries(table)) {
      if (!content.includes(phrase)) continue;
      for (const [f, v] of facts) assertions.push(fact(f, v, e.id, e.kind === 'image' ? 'observed' : 'reported'));
    }
  }
  return { assertions };
};
