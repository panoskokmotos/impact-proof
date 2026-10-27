// Meta Model API: https://dev.meta.ai/docs  (base URL https://api.meta.ai/v1)
export type MetaConfig = {
  apiKey: string;
  baseUrl: string;
  textModel: string;
  transcribeModel: string;
  maxCallsPerDay: number;
  disabled: boolean; // stop switch
};

export type Usage = Record<string, unknown> | null;

export class ModelUnavailable extends Error {}

let callsToday = 0;
let day = new Date().toISOString().slice(0, 10);

/** Hard ceiling on calls per process per day, plus a stop switch. A billing alert is not a cap. */
export function spendCall(cfg: MetaConfig) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; callsToday = 0; }
  if (cfg.disabled) throw new ModelUnavailable('Model calls are switched off (META_DISABLED=1)');
  if (!cfg.apiKey) throw new ModelUnavailable('META_API_KEY is not set');
  if (callsToday >= cfg.maxCallsPerDay) throw new ModelUnavailable(`Daily model call ceiling reached (${cfg.maxCallsPerDay})`);
  callsToday += 1;
}

async function withTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const err = new Error(`Meta API ${res.status}: ${body}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function chatJson(
  cfg: MetaConfig,
  messages: unknown[],
  schemaName: string,
  schema: object,
): Promise<{ content: string; usage: Usage; model: string }> {
  spendCall(cfg);
  const res = await withTimeout(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.textModel,
      messages,
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    }),
  }, 60_000);
  const json = (await res.json()) as { model?: string; usage?: Usage; choices: { message: { content: string } }[] };
  return { content: json.choices?.[0]?.message?.content ?? '', usage: json.usage ?? null, model: json.model ?? cfg.textModel };
}

/** Muse Voice Transcribe takes WAV only. Convert WhatsApp OGG/Opus first (see media.ts). */
export async function transcribeWav(cfg: MetaConfig, wav: Buffer): Promise<{ text: string; raw: unknown }> {
  spendCall(cfg);
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ model: cfg.transcribeModel, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' })], { type: 'application/json' }));
  form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'note.wav');
  const res = await withTimeout(`${cfg.baseUrl}/asr/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
    body: form,
  }, 90_000);
  const raw = (await res.json()) as Record<string, unknown>;
  return { text: pickTranscript(raw), raw };
}

// The TranscribeResponse field names are not in the public page we read, so accept the likely shapes
// and fail loudly instead of guessing when none match.
export function pickTranscript(raw: Record<string, unknown>): string {
  if (typeof raw.text === 'string') return raw.text;
  if (typeof raw.transcript === 'string') return raw.transcript;
  const turns = (raw.turns ?? raw.segments ?? raw.results) as unknown;
  if (Array.isArray(turns)) {
    const parts = turns.map((t) => (t as Record<string, unknown>).text ?? (t as Record<string, unknown>).transcript).filter((x) => typeof x === 'string');
    if (parts.length) return parts.join(' ');
  }
  throw new Error(`Unrecognised transcribe response keys: ${Object.keys(raw).join(', ')}`);
}
