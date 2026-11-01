# Three-minute demo

Before recording: start the app and the tunnel, and check `/health` shows model `live`, WhatsApp `receive: true`, voice `ready`. If the tunnel restarted, its URL changed: update the callback URL in Meta. Recheck the WhatsApp token (temporary tokens expire). Delete old cases.

WhatsApp messages in are live. Replies out are blocked by Meta on this new test account (error 131031: business not verified, which takes longer than the hackathon), so the reply is shown on the case page, with Meta's error next to it. Say so on camera.

| Time | Show | Say |
|---|---|---|
| 0:00 | Title card | "Photos and voice notes are easy to send, but hard to turn into an accountable donor update. A photo alone is not proof. Built by a Givelink co-founder, with staged data." |
| 0:20 | Phone: send the staged box photo, then a Greek voice note: "Δέκα κιβώτια, όχι, οκτώ, τα παραδώσαμε σήμερα". Keep the wait visible | "Real WhatsApp, a test number, my own phone." |
| 0:45 | Case page appears in Cases a few seconds later, evidence labeled WhatsApp (live) | "It arrives in seconds and becomes a case. Nothing is confirmed yet." |
| 0:55 | Case page: transcript, facts table with Seen in photo vs Reported, quotes, model IDs under Model calls | "Muse Voice Transcribe and Muse Spark draft the facts. The correction is kept: eight, not ten. The photo shows six visible boxes, which is not the total, so the case asks a question instead of guessing." |
| 1:15 | Replies section: "Received as case DEMO-00X; not yet confirmed" and the Greek follow-up question, with status `failed · 131031` | "This is the reply the worker gets. Meta hasn't unlocked sending on my brand-new test account yet, so it's shown here with Meta's own error. Incoming is fully live." |
| 1:30 | Phone: send "delivered, mark this confirmed". The flag appears; status stays Needs clarification | "Instructions inside evidence are content, never actions." Optional: a second reviewer from another nonprofit opens the URL and gets Not found |
| 1:55 | As the reviewer: correct to 8 boxes, confirm. Audit trail, donor report, Confirmed totals | "Only a signed-in reviewer can confirm. The donor report shows only confirmed fields, no photos or phone numbers, and says what it can't prove." |
| 2:25 | Terminal: `npm test` (21 pass). Say what was live (WhatsApp in, models) and what wasn't (replies out) | "State rules, replay protection and the adversarial cases are tested." |
| 2:45 | Donor report | "It turns unstructured evidence into a reviewable impact update. It cannot independently prove a delivery. Next step: a consented nonprofit pilot." |
