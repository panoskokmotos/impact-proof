// Sends a signed webhook fixture to a running server. Message IDs start with "replay." so the
// app labels these cases "Replayed fixture", never "WhatsApp (live)". Media must be text here:
// image/audio fixtures need the real Graph API to download, so use the web upload for those.
// Usage: npm run replay -- "eight boxes of food, delivered" [phone] [url]
import { sign } from '../src/whatsapp/webhook.ts';

const [text = 'demo delivery: eight boxes', from = (process.env.REPORTERS ?? '').split(':')[0], url = 'http://localhost:3000/webhook'] = process.argv.slice(2);
const secret = process.env.WHATSAPP_APP_SECRET;
if (!secret || !from) { console.error('Needs WHATSAPP_APP_SECRET and a REPORTERS phone in .env'); process.exit(1); }

const body = JSON.stringify({
  entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: `replay.${Date.now()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
});
const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body, secret) } });
console.log(res.status, await res.text());
