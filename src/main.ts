import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { transcribeWav, type MetaConfig } from './meta/client.ts';
import { ffmpegAvailable, toWav, videoFrames } from './meta/audio.ts';
import { metaExtractor } from './meta/extract.ts';
import { createApp, type Reviewer } from './server.ts';
import { openDb } from './store.ts';
import { cloudWhatsApp } from './whatsapp/cloud.ts';
import { startWorker } from './worker.ts';

const env = (k: string, d = '') => process.env[k]?.trim() || d;

const meta: MetaConfig = {
  apiKey: env('META_API_KEY'),
  baseUrl: env('META_BASE_URL', 'https://api.meta.ai/v1'),
  textModel: env('META_TEXT_MODEL', 'muse-spark-1.3'),
  transcribeModel: env('META_TRANSCRIBE_MODEL', 'muse-voice-transcribe-1.0'),
  maxCallsPerDay: Number(env('META_MAX_CALLS_PER_DAY', '200')),
  disabled: env('META_DISABLED') === '1',
};

const wa = {
  token: env('WHATSAPP_TOKEN'),
  phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
  graphVersion: env('WHATSAPP_GRAPH_VERSION'),
  appSecret: env('WHATSAPP_APP_SECRET'),
  verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
};
const waReady = Boolean(wa.token && wa.phoneNumberId && wa.graphVersion);

const sessionSecret = env('SESSION_SECRET');
if (!sessionSecret || sessionSecret.length < 32) throw new Error('Set SESSION_SECRET to 32+ random characters (openssl rand -hex 32)');

// Demo tenants. TENANTS="t1:Demo Food Bank (fictional),t2:Other NGO (fictional)"
const tenants = Object.fromEntries(env('TENANTS', 't1:Demo Food Bank (fictional),t2:Other NGO (fictional)').split(',').map((s) => s.split(':') as [string, string]));
// REVIEWERS="ana@demo-foodbank.org:t1,guest@other-ngo.org:t2"
const reviewers: Reviewer[] = env('REVIEWERS', 'ana@demo-foodbank.org:t1,guest@other-ngo.org:t2').split(',').map((s) => {
  const [email, tenantId] = s.split(':');
  return { email, tenantId };
});

const dataDir = env('DATA_DIR', join(process.cwd(), 'data'));
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'impact-proof.db'));

// REPORTERS="306900000000:t1:Field worker A" — phone numbers in WhatsApp's format, no "+".
for (const s of env('REPORTERS').split(',').filter(Boolean)) {
  const [phone, tenantId, label] = s.split(':');
  db.prepare('INSERT INTO reporters (phone, tenant_id, label) VALUES (?,?,?) ON CONFLICT(phone) DO UPDATE SET tenant_id=excluded.tenant_id, label=excluded.label')
    .run(phone.replace(/\D/g, ''), tenantId, label ?? 'Field worker');
}

const hasFfmpeg = ffmpegAvailable();
const deps = {
  db,
  dataDir,
  extract: metaExtractor(meta),
  transcribe: async (audio: Buffer) => {
    if (!hasFfmpeg) throw new Error('ffmpeg is not installed, so voice notes cannot be converted to WAV');
    const t0 = Date.now();
    const { text } = await transcribeWav(meta, await toWav(audio));
    return { text, model: meta.transcribeModel, ms: Date.now() - t0 };
  },
  frames: videoFrames,
  whatsapp: waReady ? cloudWhatsApp(wa) : null,
  caseWindowMinutes: Number(env('CASE_WINDOW_MINUTES', '30')),
  retentionDays: Number(env('RETENTION_DAYS', '14')),
  log: (m: string) => console.log(new Date().toISOString(), m),
};

const app = createApp(deps, {
  appSecret: wa.appSecret,
  verifyToken: wa.verifyToken,
  sessionSecret,
  passcode: env('REVIEWER_PASSCODE'),
  reviewers,
  tenants,
  status: () => ({
    model: meta.apiKey && !meta.disabled ? { mode: 'live', text: meta.textModel, transcribe: meta.transcribeModel } : { mode: 'off', reason: meta.disabled ? 'META_DISABLED' : 'no META_API_KEY' },
    whatsapp: { receive: Boolean(wa.appSecret), send: waReady },
    voice: hasFfmpeg ? 'ready' : 'unavailable: install ffmpeg',
    reviewerLogin: Boolean(env('REVIEWER_PASSCODE')),
  }),
});

startWorker(deps);
const port = Number(env('PORT', '3000'));
createServer(app).listen(port, () => {
  console.log(`Impact Proof on http://localhost:${port} (status: /health)`);
});
