import { createHmac, timingSafeEqual } from 'node:crypto';

/** X-Hub-Signature-256 is "sha256=<hex HMAC of the raw body with the app secret>". */
export function validSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=') || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function sign(rawBody: Buffer | string, appSecret: string): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

export type InboundMessage = {
  messageId: string;
  from: string;
  timestamp: number;
  type: 'text' | 'image' | 'audio' | 'other';
  text: string | null;
  mediaId: string | null;
  mime: string | null;
};

export type StatusUpdate = { messageId: string; status: string };

/** Splits a webhook payload into user messages and outbound-message status callbacks. */
export function parseWebhook(body: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: { field?: string; value?: Record<string, unknown> }[] }[]) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages' || !change.value) continue;
      for (const m of (change.value.messages ?? []) as Record<string, any>[]) {
        const type = m.type === 'text' || m.type === 'image' || m.type === 'audio' ? m.type : 'other';
        messages.push({
          messageId: String(m.id),
          from: String(m.from),
          timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
          type,
          text: type === 'text' ? String(m.text?.body ?? '') : type === 'image' ? (m.image?.caption ?? null) : null,
          mediaId: m.image?.id ?? m.audio?.id ?? null,
          mime: m.image?.mime_type ?? m.audio?.mime_type ?? null,
        });
      }
      for (const s of (change.value.statuses ?? []) as Record<string, any>[]) {
        statuses.push({ messageId: String(s.id), status: String(s.status) });
      }
    }
  }
  return { messages, statuses };
}
