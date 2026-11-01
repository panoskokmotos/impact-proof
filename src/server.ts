import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { buildReport, totals } from './domain/report.ts';
import { review, TransitionError } from './domain/state.ts';
import { normalize } from './domain/facts.ts';
import type { Actor, FactField, ReviewInput } from './domain/types.ts';
import * as store from './store.ts';
import * as views from './web/views.ts';
import { parseWebhook, validSignature } from './whatsapp/webhook.ts';
import { ALLOWED_MIME } from './whatsapp/cloud.ts';
import type { Deps, StoredEvent } from './worker.ts';

export type Reviewer = { email: string; tenantId: string };
export type AppConfig = {
  appSecret: string;
  verifyToken: string;
  sessionSecret: string;
  passcode: string;
  reviewers: Reviewer[];
  tenants: Record<string, string>;
  status: () => Record<string, unknown>;
};

type Req = IncomingMessage & { body?: Buffer };

async function readBody(req: Req, limit = 20 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new TransitionError('Body too large', 413);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const send = (res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
};
const redirect = (res: ServerResponse, to: string, headers: Record<string, string> = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };

export function createApp(d: Deps, cfg: AppConfig) {
  const allowed = new Set(cfg.reviewers.map((r) => r.email));

  function session(email: string) {
    const exp = Date.now() + 8 * 3_600_000;
    const payload = `${email}|${exp}`;
    return `${Buffer.from(payload).toString('base64url')}.${createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url')}`;
  }

  // A WhatsApp display name or phone is never identity. Only a signed session for an allowlisted reviewer is.
  function currentUser(req: Req): (Reviewer & { tenantName: string }) | null {
    const raw = /(?:^|;\s*)ip_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!raw) return null;
    const [p, sig] = raw.split('.');
    const payload = Buffer.from(p ?? '', 'base64url').toString();
    const want = createHmac('sha256', cfg.sessionSecret).update(payload).digest();
    const got = Buffer.from(sig ?? '', 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const [email, exp] = payload.split('|');
    if (Number(exp) < Date.now()) return null;
    const r = cfg.reviewers.find((x) => x.email === email);
    return r ? { ...r, tenantName: cfg.tenants[r.tenantId] ?? r.tenantId } : null;
  }

  /** Same response for "no such case" and "another tenant's case", so case IDs leak nothing. */
  function caseFor(user: Reviewer, id: string) {
    const c = store.getCase(d.db, id);
    if (!c || c.tenantId !== user.tenantId) throw new TransitionError('Case not found', 404);
    return c;
  }

  function renderCase(user: Reviewer & { tenantName: string }, id: string, error: string | null) {
    const c = caseFor(user, id);
    const q = (sql: string) => d.db.prepare(sql).all(id) as Record<string, any>[];
    return views.casePage(user, c,
      q('SELECT * FROM evidence WHERE case_id=? ORDER BY received_at'),
      q('SELECT * FROM model_runs WHERE case_id=? ORDER BY id'),
      q('SELECT * FROM audit WHERE case_id=? ORDER BY id'),
      q('SELECT * FROM outbound WHERE case_id=? ORDER BY id'),
      q('SELECT token, case_version FROM reports WHERE case_id=? ORDER BY case_version') as any,
      error);
  }

  async function handle(req: Req, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const m = (re: RegExp) => re.exec(path);

    if (path === '/health') return send(res, 200, JSON.stringify(cfg.status()), 'application/json');

    // ---- WhatsApp webhook ----
    if (path === '/webhook' && req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && cfg.verifyToken && url.searchParams.get('hub.verify_token') === cfg.verifyToken;
      return ok ? send(res, 200, url.searchParams.get('hub.challenge') ?? '', 'text/plain') : send(res, 403, 'Forbidden', 'text/plain');
    }
    if (path === '/webhook' && req.method === 'POST') {
      const raw = await readBody(req, 1024 * 1024);
      if (!validSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, cfg.appSecret)) return send(res, 401, 'Bad signature', 'text/plain');
      const { messages, statuses } = parseWebhook(JSON.parse(raw.toString('utf8')));
      // Persist and enqueue before acknowledging; the model runs later in the worker.
      for (const msg of messages) {
        const channel = msg.messageId.startsWith('replay.') ? 'replay' : 'whatsapp';
        const ev: StoredEvent = { ...msg, channel };
        if (store.recordInbound(d.db, msg.messageId, channel, msg.from, ev)) store.enqueue(d.db, 'message', `msg:${msg.messageId}`, { messageId: msg.messageId });
      }
      // Status callbacks track our outbound message only. They never touch a case's delivery status.
      for (const s of statuses) d.db.prepare('UPDATE outbound SET wa_status=?, error=COALESCE(?, error) WHERE wa_message_id=?').run(s.status, s.error, s.messageId);
      return send(res, 200, 'OK', 'text/plain');
    }

    // ---- public donor report ----
    const rep = m(/^\/r\/([A-Za-z0-9_-]{16,})$/);
    if (rep && req.method === 'GET') {
      const row = d.db.prepare('SELECT * FROM reports WHERE token=?').get(rep[1]) as { case_id: string; case_version: number; body: string } | undefined;
      if (!row) return send(res, 404, views.page('Not found', '<p>Report not found.</p>'));
      const c = store.getCase(d.db, row.case_id);
      const superseded = !c || c.version !== row.case_version || c.status !== 'confirmed';
      return send(res, 200, views.reportPage(JSON.parse(row.body), cfg.tenants[c?.tenantId ?? ''] ?? 'the nonprofit', superseded), undefined, { 'Cache-Control': 'no-store' });
    }

    // ---- sign in ----
    if (path === '/login' && req.method === 'POST') {
      const f = new URLSearchParams((await readBody(req, 10_000)).toString());
      const email = f.get('email') ?? '';
      const pass = Buffer.from(f.get('passcode') ?? '');
      const want = Buffer.from(cfg.passcode);
      if (!allowed.has(email) || !cfg.passcode || pass.length !== want.length || !timingSafeEqual(pass, want)) {
        return send(res, 401, views.loginPage('Wrong reviewer or passcode', [...allowed]));
      }
      return redirect(res, '/cases', { 'Set-Cookie': `ip_session=${session(email)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
    }
    if (path === '/logout' && req.method === 'POST') return redirect(res, '/login', { 'Set-Cookie': 'ip_session=; Path=/; Max-Age=0' });
    if (path === '/login') return send(res, 200, views.loginPage(null, [...allowed]));

    const user = currentUser(req);
    if (!user) return req.method === 'GET' ? redirect(res, '/login') : send(res, 401, 'Sign in as a reviewer', 'text/plain');
    // SameSite=Lax blocks cross-site POSTs; also reject a foreign Origin outright.
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, 'Cross-site request', 'text/plain');

    if (path === '/' || path === '/cases') {
      const cases = store.listCases(d.db, user.tenantId);
      return send(res, 200, views.inboxPage(user, cases, totals(cases), store.impactStats(d.db, user.tenantId)));
    }

    const ev = m(/^\/evidence\/(ev_[a-f0-9]+)$/);
    if (ev) {
      const row = d.db.prepare('SELECT e.path, e.mime, c.tenant_id FROM evidence e JOIN cases c ON c.id=e.case_id WHERE e.id=?').get(ev[1]) as { path: string; mime: string; tenant_id: string } | undefined;
      if (!row || row.tenant_id !== user.tenantId || !row.path) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      return res.end(readFileSync(row.path));
    }

    const cm = m(/^\/cases\/(DEMO-\d+)(?:\/(review|retry|delete|report))?$/);
    if (cm) {
      const [, id, action] = cm;
      if (!action && req.method === 'GET') return send(res, 200, renderCase(user, id, url.searchParams.get('error')));
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
      const c = caseFor(user, id);
      const actor: Actor = { role: 'reviewer', id: user.email, tenantId: user.tenantId };

      if (action === 'review') {
        const f = new URLSearchParams((await readBody(req, 20_000)).toString());
        const corrections: Partial<Record<FactField, string>> = {};
        for (const k of ['item', 'quantity', 'unit', 'delivery_status', 'time', 'place'] as FactField[]) {
          const v = f.get(k)?.trim();
          if (v) corrections[k] = v;
        }
        const input: ReviewInput = {
          decision: f.get('decision') === 'confirm' ? 'confirm' : 'dispute',
          reason: f.get('reason') ?? '',
          corrections,
          publishPlace: f.get('publish_place') === 'on',
        };
        // Only send fields the reviewer actually changed as corrections; unchanged ones are accepted on confirm.
        for (const k of Object.keys(corrections) as FactField[]) {
          const cur = [...c.assertions].reverse().find((a) => a.field === k);
          if (cur && cur.value === corrections[k] && cur.kind === 'reviewer_confirmed') delete corrections[k];
          else if (cur && cur.value === corrections[k] && input.decision === 'dispute') delete corrections[k];
        }
        if (!input.publishPlace) delete corrections.place;
        // Fields the reviewer actually changed from the draft, for the accuracy metric. Prefilled values don't count.
        const changed = (Object.keys(corrections) as FactField[]).filter((k) => {
          const cur = [...c.assertions].reverse().find((a) => a.field === k);
          return !cur || normalize(k, cur.value) !== normalize(k, corrections[k]!);
        });
        const drafted = new Set(c.assertions.filter((a) => a.kind !== 'reviewer_confirmed').map((a) => a.field)).size;
        try {
          const next = review(c, actor, input, allowed);
          store.saveCase(d.db, next);
          store.audit(d.db, id, user.email, input.decision === 'confirm' ? 'confirmed' : 'disputed', c.status, next.status, next.version, { reason: input.reason, corrected: changed, drafted });
        } catch (e) {
          if (e instanceof TransitionError && e.status === 400 || (e as TransitionError).status === 409) return redirect(res, `/cases/${id}?error=${encodeURIComponent((e as Error).message)}`);
          throw e;
        }
        return redirect(res, `/cases/${id}`);
      }
      if (action === 'report') {
        const exists = d.db.prepare('SELECT token FROM reports WHERE case_id=? AND case_version=?').get(id, c.version);
        if (!exists) {
          const sources = (d.db.prepare('SELECT DISTINCT kind FROM evidence WHERE case_id=? AND error IS NULL').all(id) as { kind: string }[]).map((r) => r.kind);
          const report = buildReport(c, { sources, modelDrafted: c.assertions.some((a) => a.kind !== 'reviewer_confirmed') }); // throws unless confirmed
          d.db.prepare('INSERT INTO reports (token, case_id, case_version, body, created_at) VALUES (?,?,?,?,?)')
            .run(randomBytes(18).toString('base64url'), id, c.version, JSON.stringify(report), store.now());
          store.audit(d.db, id, user.email, 'report_created', c.status, c.status, c.version, null);
        }
        return redirect(res, `/cases/${id}`);
      }
      if (action === 'retry') {
        store.enqueue(d.db, 'extract', `extract:${id}:${Date.now()}`, { caseId: id });
        store.audit(d.db, id, user.email, 'retry_requested', c.status, c.status, c.version, null);
        return redirect(res, `/cases/${id}`);
      }
      if (action === 'delete') {
        for (const p of store.deleteCase(d.db, id)) rmSync(p, { force: true });
        return redirect(res, '/cases');
      }
    }

    if (path === '/upload') {
      const phones = (d.db.prepare('SELECT phone FROM reporters WHERE tenant_id=?').all(user.tenantId) as { phone: string }[]).map((r) => r.phone);
      if (req.method === 'GET') return send(res, 200, views.uploadPage(user, phones, url.searchParams.get('msg')));
      const raw = await readBody(req);
      const form = await new Request('http://local/upload', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: raw }).formData();
      const from = String(form.get('from') ?? '');
      if (!phones.includes(from)) return send(res, 400, 'Unknown field worker', 'text/plain');
      const file = form.get('file');
      const text = String(form.get('text') ?? '').trim();
      const add = (ev: StoredEvent) => {
        store.recordInbound(d.db, ev.messageId, 'web', from, ev);
        store.enqueue(d.db, 'message', `msg:${ev.messageId}`, { messageId: ev.messageId });
      };
      const base = { from, timestamp: Math.floor(Date.now() / 1000), channel: 'web' as const, mediaId: null };
      if (file instanceof File && file.size > 0) {
        const mime = file.type.split(';')[0];
        if (!ALLOWED_MIME.includes(mime)) return send(res, 400, `File type ${mime} not accepted`, 'text/plain');
        const id = `web.${randomBytes(8).toString('hex')}`;
        mkdirSync(join(d.dataDir, 'uploads'), { recursive: true });
        const local = join(d.dataDir, 'uploads', id);
        writeFileSync(local, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
        add({ ...base, messageId: id, type: mime.startsWith('image/') ? 'image' : 'audio', text: null, mime, localFile: local });
      }
      if (text) add({ ...base, messageId: `web.${randomBytes(8).toString('hex')}`, type: 'text', text, mime: null });
      return redirect(res, '/upload?msg=' + encodeURIComponent('Sent. It will appear in Cases in a few seconds.'));
    }

    return send(res, 404, views.page('Not found', '<p>Not found.</p>', user));
  }

  return async (req: Req, res: ServerResponse) => {
    try {
      await handle(req, res);
    } catch (e) {
      const status = e instanceof TransitionError ? e.status : 500;
      if (status === 500) d.log(`500 ${req.method} ${req.url}: ${(e as Error).stack}`);
      if (!res.headersSent) send(res, status, status === 500 ? 'Something went wrong' : (e as Error).message, 'text/plain');
    }
  };
}
