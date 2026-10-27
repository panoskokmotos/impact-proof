// WhatsApp Cloud API on graph.facebook.com. Use the Graph version your app dashboard shows.
export type WhatsAppConfig = {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  appSecret: string;
  verifyToken: string;
};

export type WhatsApp = {
  sendText(to: string, body: string): Promise<{ messageId: string }>;
  downloadMedia(mediaId: string): Promise<{ bytes: Buffer; mime: string }>;
};

const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/wav'];

export function cloudWhatsApp(cfg: WhatsAppConfig): WhatsApp {
  const graph = `https://graph.facebook.com/${cfg.graphVersion}`;
  const auth = { Authorization: `Bearer ${cfg.token}` };
  return {
    async sendText(to, body) {
      const res = await fetch(`${graph}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { messages?: { id: string }[]; error?: { message: string } };
      if (!res.ok) throw new Error(`WhatsApp send ${res.status}: ${json.error?.message ?? 'unknown error'}`);
      return { messageId: json.messages?.[0]?.id ?? '' };
    },
    async downloadMedia(mediaId) {
      // Resolve the media ID to a short-lived URL, then fetch it with the same token.
      // The URL needs auth, so it is never handed to a model; we pass bytes instead.
      const meta = await fetch(`${graph}/${mediaId}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
      if (!meta.ok) throw new Error(`Media lookup ${meta.status}`);
      const info = (await meta.json()) as { url: string; mime_type: string; file_size?: number };
      if (info.file_size && info.file_size > MAX_MEDIA_BYTES) throw new Error('Media too large');
      const file = await fetch(info.url, { headers: auth, signal: AbortSignal.timeout(30_000) });
      if (!file.ok) throw new Error(`Media download ${file.status}`);
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length > MAX_MEDIA_BYTES) throw new Error('Media too large');
      const mime = info.mime_type.split(';')[0].trim();
      if (!ALLOWED_MIME.includes(mime)) throw new Error(`Media type ${mime} not accepted`);
      return { bytes, mime };
    },
  };
}
