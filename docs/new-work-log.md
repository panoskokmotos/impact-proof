# New-work log

## Baseline

- This repo was created on 27 Oct 2026 (Athens), after the Meta hackathon opened.
- It contains no application code from the author's earlier project, Verified Delivery Copilot (Nebius x NVIDIA hackathon, last commit `b59cc1e`, 27 Sep 2026). That project checks delivery photos for authenticity. This one turns WhatsApp evidence into reviewer-confirmed reports. They share a problem area, not code.
- One runtime dependency, `ffmpeg-static` (a prebuilt ffmpeg binary), added 28 Oct. Everything else uses Node built-ins (`node:http`, `node:sqlite`, `fetch`).

## Log

| Date | Work |
|---|---|
| 27 Oct | Domain rules (facts, state machine, report, totals), Meta client and extraction schema, WhatsApp webhook/send/media, durable worker, reviewer UI, donor report, 19 tests, probe and replay scripts |
| 28 Oct | Impact metric from the audit trail: median minutes from first message to confirmed report, and facts the reviewer changed vs drafted; audit records only real corrections |
| 28 Oct | Voice notes: ffmpeg-static fallback because Homebrew cannot build ffmpeg on macOS 12; Opus to 24 kHz mono 16-bit WAV checked |
| 1 Nov | Live Meta check passes: muse-spark-1.3, 9/9 runs schema-valid and factually correct (English, Greek self-correction + negation, prompt injection flagged every run); stray env files ignored |
| 1 Nov | First local end-to-end run (replayed Greek text + web-uploaded Greek voice note, transcribed by muse-voice-transcribe-1.0 in 3.3 s). Found transcript spelling slips («κηβώτια», «Κιψέλης», doubled word) flagged as contradictions; sources are now compared by a spelling key (accents, η/υ/ει/οι → ι, ω → ο, repeated words), stored values unchanged; test added (21) |
| 1 Nov | Live WhatsApp in: Meta app published, webhook subscribed to messages, test WhatsApp account linked to the app; a real Greek message arrived in ~10 s and the 7-vs-8 contradiction produced a Greek follow-up question. Replies out blocked by Meta (131031, business not verified); failed replies now store Meta's error code. Demo script updated |
| | |
