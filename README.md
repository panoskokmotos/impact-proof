# Impact Proof

Someone at the nonprofit, staff or a field worker, sends a WhatsApp photo, video or voice note, the fastest way being a 5-second voice note or a short narrated video. A Meta Muse model drafts a delivery case with every fact linked to its source. An authorized nonprofit reviewer confirms, corrects or disputes it. The donor sees a report that says what was confirmed, by whom, and what it cannot prove.

Built solo by a Givelink co-founder for the Meta Global AI Developer Hackathon, with staged demo data. Not deployed with Givelink or any partner nonprofit.

## What it does

1. **WhatsApp in.** The webhook checks `X-Hub-Signature-256`, stores the message under its unique ID and queues it before answering. Retries and replays create nothing new.
2. **Evidence.** Photos and voice notes are downloaded with server auth, checked for type and size, hashed and kept private. Voice notes are converted to 24 kHz mono WAV and transcribed with `muse-voice-transcribe-1.0`.
3. **Draft facts.** `muse-spark-1.3` extracts item, quantity, unit, place, time and delivery status as structured output. Each fact says whether it was **seen in a photo** or **reported**, and quotes its source. Unknown facts are left out, never guessed.
4. **Rules in code, not in the model.** Missing facts, conflicting sources, duplicate photos and instructions hidden in the evidence keep a case in *needs clarification*. The worker gets one follow-up question in their language and a reply: "Received as case DEMO-001; not yet confirmed."
5. **Human review.** Only a signed-in, allowlisted reviewer of the same nonprofit can confirm or dispute. Every change is an audit event. A correction creates a new version and supersedes older donor reports.
6. **Donor report.** Built only from reviewer-confirmed fields. No phone numbers, photos, transcripts or exact addresses. Totals are summed in code from confirmed cases, by item and unit, with no inferred conversions.

## Run it

Needs Node 24 (no build step). `npm install` adds one dependency, `ffmpeg-static`, a prebuilt ffmpeg for converting voice notes. A system `ffmpeg` or `FFMPEG_PATH` is used first if present.

```bash
npm install
cp .env.example .env    # fill in the values below
npm test                # 29 tests: the adversarial pack's rules and the full webhook-to-report flow
npm run probe -- photo.jpg voice.ogg   # first-hour check of your Meta account, 3 runs per fixture
npm start               # http://localhost:3000, status at /health
```

| Variable | What it is |
|---|---|
| `META_API_KEY` | Meta Model API key. Without it the app runs, but marks every case "Model unavailable" for manual entry |
| `META_MAX_CALLS_PER_DAY`, `META_DISABLED` | Hard call ceiling and stop switch |
| `WHATSAPP_*` | From your own Meta developer test app. Use the Graph version your dashboard shows |
| `SESSION_SECRET`, `REVIEWER_PASSCODE` | Reviewer sign-in |
| `REPORTERS` | Allowlisted field-worker phones. Anyone else is ignored |

WhatsApp needs a public HTTPS URL for the webhook (`/webhook`, subscribe to `messages`). For local testing, a tunnel works: `brew install cloudflared && cloudflared tunnel --url http://localhost:3000`.

## Honest labels

- Every evidence item shows its channel: **WhatsApp (live)**, **Replayed fixture** (`npm run replay`, message IDs start with `replay.`) or **Web upload** (fallback form).
- A WhatsApp "delivered" status means our reply reached the phone. It never changes a case.
- "Nonprofit confirmed" is the nonprofit's attestation, not independent proof that supplies arrived.

## Layout

```
src/domain/    facts, state machine, report and totals (no I/O)
src/meta/      Meta Model API client, extraction prompt + schema + validator, audio conversion
src/whatsapp/  signature check, webhook parsing, send, media download
src/worker.ts  durable job queue: media, transcription, extraction, replies, bounded retries
src/server.ts  webhook, reviewer auth, case pages, donor report
tests/         domain rules and end-to-end flow (model replaced by a scripted double)
scripts/       probe-models (live Meta check), replay (signed fixture)
docs/          new-work log, demo script
```

## License

MIT
