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
| | |
