import type { CaseRecord, ImpactStats } from '../store.ts';
import type { DonorReport } from '../domain/report.ts';
import type { Assertion } from '../domain/types.ts';
import { currentValue, isItemField, itemLines, lineOf } from '../domain/facts.ts';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const STATUS_LABEL: Record<string, string> = {
  received: 'Received', needs_clarification: 'Needs clarification', ready_for_review: 'Ready for review',
  confirmed: 'Nonprofit confirmed', disputed: 'Disputed',
};

const FLAG_LABEL: Record<string, string> = {
  possible_duplicate: 'Possible duplicate: the same photo was sent before',
  instruction_in_evidence: 'The evidence contains an instruction. It was treated as content, not acted on',
  model_unavailable: 'Model unavailable: enter the facts by hand',
  extraction_failed: 'Extraction failed after retries: use Retry',
  evidence_after_review: 'New evidence arrived after the review',
};

export const statusPill = (s: string) => `<span class="pill s-${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`;

export function page(title: string, body: string, user?: { email: string; tenantName: string } | null) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Impact Proof</title><style>${CSS}</style></head><body>
<header><a class="brand" href="/cases">Impact Proof</a>
${user ? `<span class="who">${esc(user.email)} · ${esc(user.tenantName)} <form method="post" action="/logout"><button class="link">Sign out</button></form></span>` : ''}
</header><main>${body}</main>
<footer>Staged demo data. Built by a Givelink co-founder for the Meta hackathon; not deployed with Givelink or any partner nonprofit.</footer>
</body></html>`;
}

export function loginPage(error: string | null, emails: string[]) {
  return page('Sign in', `<h1>Reviewer sign in</h1>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/login" class="card stack">
<label>Reviewer<select name="email">${emails.map((e) => `<option>${esc(e)}</option>`).join('')}</select></label>
<label>Passcode<input type="password" name="passcode" required autocomplete="current-password"></label>
<button>Sign in</button></form>`);
}

export function inboxPage(user: { email: string; tenantName: string }, cases: CaseRecord[], totals: { item: string; unit: string; quantity: number; cases: number }[], stats: ImpactStats) {
  const rows = cases.map((c) => `<tr><td><a href="/cases/${esc(c.id)}">${esc(c.id)}</a></td><td>${statusPill(c.status)}</td>
<td>${esc(summary(c.assertions))}</td><td>${c.flags.length ? `⚠ ${c.flags.length}` : ''}</td><td class="muted">${esc(c.updatedAt.slice(0, 16).replace('T', ' '))}</td></tr>`).join('');
  return page('Cases', `<h1>Delivery cases</h1>
<section class="card"><h2>Confirmed totals</h2>
${totals.length ? `<ul>${totals.map((t) => `<li><b>${t.quantity} ${esc(t.unit)}</b> of ${esc(t.item)} <span class="muted">(${t.cases} case${t.cases > 1 ? 's' : ''})</span></li>`).join('')}</ul>` : '<p class="muted">No confirmed cases yet.</p>'}
<p class="muted small">Counted in code from nonprofit-confirmed cases only. Disputed and unreviewed cases are not counted.</p></section>
<section class="card"><h2>Measured on these cases</h2>
${stats.confirmed ? `<ul><li>Median <b>${stats.medianMinutes} min</b> from the first WhatsApp message to a confirmed report (${stats.confirmed} case${stats.confirmed > 1 ? 's' : ''})</li>
<li>The model drafted <b>${stats.drafted}</b> facts. The reviewer changed or added <b>${stats.corrected}</b>.</li></ul>` : '<p class="muted">Shown once a case is confirmed.</p>'}
<p class="muted small">From this nonprofit's own audit trail. Elapsed time includes waiting for the reviewer, not only work time.</p></section>
<div class="scroll"><table><thead><tr><th>Case</th><th>Status</th><th>Facts</th><th>Flags</th><th>Updated</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No cases yet. Send a WhatsApp message from an allowlisted phone, or use <a href="/upload">web upload</a>.</td></tr>'}</tbody></table></div>
<p><a href="/upload">Web upload fallback</a></p>`, user);
}

function summary(a: Assertion[]) {
  const latest = (f: string) => [...a].reverse().find((x) => x.field === f)?.value;
  return [latest('quantity'), latest('unit'), latest('item')].filter(Boolean).join(' ') || '—';
}

const KIND_LABEL = { observed: 'Seen in photo', reported: 'Reported', reviewer_confirmed: 'Nonprofit confirmed' } as const;
const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp (live)', replay: 'Replayed fixture', web: 'Web upload' };

export function casePage(
  user: { email: string; tenantName: string },
  c: CaseRecord,
  evidence: Record<string, any>[],
  runs: Record<string, any>[],
  auditRows: Record<string, any>[],
  outbound: Record<string, any>[],
  reports: { token: string; case_version: number }[],
  error: string | null,
) {
  const facts = c.assertions.map((a) => `<tr class="k-${a.kind}"><td>${esc(a.field)}${isItemField(a.field) ? ` <span class="muted small">#${lineOf(a)}</span>` : ''}</td><td><b>${esc(a.value)}</b></td><td>${esc(KIND_LABEL[a.kind])}</td><td>${esc(a.evidenceId ?? '')}</td><td class="muted">${esc(a.quote)}</td></tr>`).join('');
  const ev = evidence.map((e) => `<div class="ev"><div class="muted small">${esc(e.id)} · ${esc(e.kind)} · ${esc(CHANNEL_LABEL[e.channel] ?? e.channel)} · ${esc(String(e.received_at).slice(11, 19))}</div>
${e.kind === 'image' && e.path ? `<img src="/evidence/${esc(e.id)}" alt="Delivery photo ${esc(e.id)}">` : ''}
${e.kind === 'audio' && e.path ? `<audio controls src="/evidence/${esc(e.id)}"></audio>` : ''}
${e.kind === 'video' && e.path ? `<video controls preload="metadata" src="/evidence/${esc(e.id)}"></video>` : ''}
${e.text ? `<blockquote>${esc(e.text)}</blockquote>` : ''}
${e.error ? `<p class="err small">${esc(e.error)}</p>` : ''}</div>`).join('');
  const last = (k: Assertion['field'], line = 1) => currentValue(c.assertions, k, line)?.value ?? '';
  const lines = itemLines(c.assertions);
  // One row per item, plus an empty row so the reviewer can add an item the evidence missed.
  const itemRows = [...lines, Math.max(...lines) + 1].map((l) => `<div class="row">
<label>Item ${l}<input name="item_${l}" value="${esc(last('item', l))}"></label>
<label>Quantity<input name="quantity_${l}" inputmode="numeric" value="${esc(last('quantity', l))}"></label>
<label>Unit<input name="unit_${l}" value="${esc(last('unit', l))}"></label></div>`).join('');
  const closed = c.status === 'confirmed' || c.status === 'disputed';
  const current = reports.find((r) => r.case_version === c.version);
  return page(c.id, `<p><a href="/cases">← All cases</a></p>
<h1>${esc(c.id)} ${statusPill(c.status)} <span class="muted small">v${c.version}</span></h1>
${error ? `<p class="err">${esc(error)}</p>` : ''}
${c.processing !== 'done' ? `<p class="warn">Processing: ${esc(c.processing)}${c.processingError ? ` · ${esc(c.processingError)}` : ''}</p>` : ''}
${c.flags.map((f) => `<p class="warn">⚠ ${esc(FLAG_LABEL[f] ?? f)}</p>`).join('')}
${c.missing.length ? `<p class="warn">Missing: ${esc(c.missing.join(', '))}</p>` : ''}
${c.contradictions.map((x) => `<p class="warn">Sources disagree on ${esc(x)}</p>`).join('')}
${c.question ? `<p>Follow-up question for the sender: <i>${esc(c.question)}</i> <span class="muted small">(see WhatsApp replies for whether it was sent)</span></p>` : ''}
<div class="grid"><section class="card"><h2>Evidence</h2>${ev || '<p class="muted">None</p>'}</section>
<section class="card"><h2>Facts and where they came from</h2><div class="scroll"><table><thead><tr><th>Field</th><th>Value</th><th>Basis</th><th>Source</th><th>Quote</th></tr></thead><tbody>${facts || '<tr><td colspan="5" class="muted">No facts yet</td></tr>'}</tbody></table></div>
<p class="muted small">The model drafts facts. Only a nonprofit reviewer can confirm them.</p></section></div>

<section class="card"><h2>${closed ? 'Correct or change the review' : 'Review'}</h2>
<form method="post" action="/cases/${esc(c.id)}/review" class="stack">
${itemRows}
<div class="row">
<label>Delivery<select name="delivery_status"><option value="">— choose —</option>${['delivered', 'not_yet_delivered', 'unclear'].map((s) => `<option ${last('delivery_status') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
<label>Date<input name="time" value="${esc(last('time'))}" placeholder="2026-11-02"></label>
<label>Area<input name="place" value="${esc(last('place'))}"></label></div>
<label class="inline"><input type="checkbox" name="publish_place"> Show the area in the donor report (never an exact address)</label>
<label>Reason / note<input name="reason" placeholder="Required to dispute"></label>
<div class="row"><button name="decision" value="confirm">Confirm facts</button><button name="decision" value="dispute" class="secondary">Dispute</button></div>
</form></section>

<section class="card"><h2>Donor report</h2>
${c.status === 'confirmed'
    ? current ? `<p><a href="/r/${esc(current.token)}">Open donor report for v${c.version}</a></p>` : `<form method="post" action="/cases/${esc(c.id)}/report"><button>Create donor report</button></form>`
    : '<p class="muted">Available once the nonprofit confirms the case.</p>'}
${reports.filter((r) => r.case_version !== c.version).map((r) => `<p class="muted small">Superseded: <a href="/r/${esc(r.token)}">report for v${r.case_version}</a></p>`).join('')}
</section>

<section class="card"><h2>WhatsApp replies</h2><p class="muted small">"accepted/delivered" here means the WhatsApp message arrived, not the supplies.</p>
<ul>${outbound.map((o) => `<li>${esc(o.body)} <span class="muted small">· ${esc(o.wa_status)}${o.error ? ` · ${esc(o.error)}` : ''}</span></li>`).join('') || '<li class="muted">None</li>'}</ul></section>

<section class="card"><h2>Model calls</h2><ul>${runs.map((r) => `<li>${esc(r.step)} · ${esc(r.model ?? '—')} · ${esc(r.prompt_version ?? '')} · ${r.ms ?? '—'} ms${r.error ? ` · <span class="err">${esc(r.error)}</span>` : ''}${r.dropped && r.dropped !== '{"dropped":[],"suspicious":[]}' ? `<div class="muted small">${esc(r.dropped)}</div>` : ''}</li>`).join('') || '<li class="muted">None</li>'}</ul></section>

<section class="card"><h2>Audit trail</h2><ul>${auditRows.map((a) => `<li>${esc(String(a.at).slice(0, 19).replace('T', ' '))} · <b>${esc(a.actor)}</b> ${esc(a.action)} ${a.from_status ? `${esc(a.from_status)} → ` : ''}${esc(a.to_status ?? '')} ${a.version ? `v${a.version}` : ''} <span class="muted small">${esc(a.detail)}</span></li>`).join('')}</ul></section>

<form method="post" action="/cases/${esc(c.id)}/retry" class="inline-form"><button class="secondary">Retry extraction</button></form>
<form method="post" action="/cases/${esc(c.id)}/delete" class="inline-form"><button class="danger">Delete case and media</button></form>`, user);
}

export function reportPage(r: DonorReport, orgName: string, superseded: boolean) {
  return page(`Delivery update ${r.caseId}`, `<article class="card report">
${superseded ? '<p class="warn">This report was superseded: the nonprofit corrected or disputed the case after it was made. Do not share it.</p>' : ''}
<p class="muted small">Delivery update from ${esc(orgName)} · case ${esc(r.caseId)} v${r.caseVersion}</p>
<h1>${superseded ? '<s>' : ''}${esc(reportItems(r).map((i) => itemText(i)).join(', '))}${superseded ? '</s>' : ''}</h1>
<table>${reportItems(r).map((i) => `<tr><th>Item</th><td>${esc(itemText(i))}</td><td class="muted small">Confirmed by the nonprofit</td></tr>`).join('')}${r.lines.filter((l) => !['Item', 'Quantity', 'Unit'].includes(l.label)).map((l) => `<tr><th>${esc(l.label)}</th><td>${esc(l.value)}</td><td class="muted small">${l.basis === 'nonprofit_confirmed' ? 'Confirmed by the nonprofit' : 'Reported, not confirmed'}</td></tr>`).join('')}</table>
<h2>What this does and does not show</h2><ul>${r.limits.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></article>`);
}

export function uploadPage(user: { email: string; tenantName: string }, phones: string[], msg: string | null) {
  return page('Web upload', `<h1>Web upload fallback</h1>
<p class="warn">This is not WhatsApp. Use it only when the WhatsApp channel is down. Cases made here are labeled "Web upload".</p>
${msg ? `<p>${esc(msg)}</p>` : ''}
<form method="post" action="/upload" enctype="multipart/form-data" class="card stack">
<label>Sender<select name="from">${phones.map((p) => `<option value="${esc(p)}">…${esc(p.slice(-4))}</option>`).join('')}</select></label>
<label>Photo, video or voice note<input type="file" name="file" accept="image/jpeg,image/png,image/webp,audio/*,video/mp4,video/quicktime,video/3gpp"></label>
<label>Text<textarea name="text" rows="3"></textarea></label>
<button>Send</button></form>`, user);
}

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1c1c1a;--muted:#6b6b66;--line:#e3e2dc;--accent:#1f5f4a;--warn:#8a5a00;--warnbg:#fff6e0;--err:#a01c1c}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#6fc2a2;--warn:#f0c46c;--warnbg:#2c2615;--err:#ff8a8a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;padding:.8rem 1rem;border-bottom:1px solid var(--line);background:var(--card)}
.brand{font-weight:700;color:var(--accent);text-decoration:none}.who{display:flex;gap:.5rem;align-items:center;font-size:.85rem;color:var(--muted)}
main{max-width:1100px;margin:0 auto;padding:1rem}footer{max-width:1100px;margin:2rem auto;padding:0 1rem;color:var(--muted);font-size:.8rem}
h1{font-size:1.4rem}h2{font-size:1rem;margin:0 0 .6rem}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem;margin:0 0 1rem}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:1rem}@media(max-width:760px){.grid{grid-template-columns:1fr}}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
.k-reviewer_confirmed td{background:color-mix(in srgb,var(--accent) 10%,transparent)}
.pill{display:inline-block;font-size:.75rem;padding:.1rem .5rem;border-radius:99px;border:1px solid var(--line);vertical-align:middle}
.s-confirmed{background:var(--accent);color:var(--card)}.s-disputed{background:var(--err);color:#fff}.s-needs_clarification{background:var(--warnbg);color:var(--warn)}
.muted{color:var(--muted)}.small{font-size:.8rem}.err{color:var(--err)}.warn{background:var(--warnbg);color:var(--warn);padding:.4rem .6rem;border-radius:6px}
.ev{border-bottom:1px solid var(--line);padding:.5rem 0}.ev img,.ev video{max-width:100%;border-radius:6px}blockquote{margin:.3rem 0;padding-left:.7rem;border-left:3px solid var(--line)}
.stack{display:flex;flex-direction:column;gap:.7rem}.row{display:flex;gap:.7rem;flex-wrap:wrap}.row label{flex:1 1 150px}
label{display:flex;flex-direction:column;gap:.2rem;font-size:.85rem;color:var(--muted)}label.inline{flex-direction:row;align-items:center}
input,select,textarea{font:inherit;padding:.45rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
button{font:inherit;padding:.5rem 1rem;border:0;border-radius:6px;background:var(--accent);color:var(--card);cursor:pointer}
button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}button.danger{background:transparent;color:var(--err);border:1px solid var(--err)}
button.link{background:none;color:var(--accent);padding:0}.inline-form{display:inline-block;margin-right:.5rem}
.report h1{font-size:1.6rem}`;

/** Reports saved before multi-item support kept item, quantity and unit as lines. */
function reportItems(r: DonorReport) {
  if (r.items?.length) return r.items;
  const get = (label: string) => r.lines.find((l) => l.label === label)?.value ?? '';
  return get('Item') ? [{ item: get('Item'), quantity: get('Quantity'), unit: get('Unit') }] : [];
}

// Singular for a quantity of 1, so "σακίδιο: 1 τεμάχιο", not "1 τεμάχια".
const SINGULAR: Record<string, string> = { τεμάχια: 'τεμάχιο', κιβώτια: 'κιβώτιο', κουτιά: 'κουτί', σακούλες: 'σακούλα', pieces: 'piece', boxes: 'box', bags: 'bag', cartons: 'carton' };

/** One item for a donor, worded the same in any language: "σακίδιο: 1 τεμάχιο". */
function itemText(i: { item: string; quantity: string; unit: string }) {
  const unit = Number(i.quantity) === 1 ? SINGULAR[i.unit.toLowerCase()] ?? i.unit : i.unit;
  return `${i.item}: ${i.quantity} ${unit}`;
}
