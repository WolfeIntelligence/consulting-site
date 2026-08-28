// Shared lead helpers: storage, the signed one-tap status token, source
// derivation, and the new-lead notification.
//
// Lives in lib/ on purpose — anything under api/ becomes a public route.

const crypto = require('crypto');

const kvReady = () => !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

async function kv(path) {
  const r = await fetch(process.env.KV_REST_API_URL + '/' + path, {
    headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN },
  });
  if (!r.ok) return null;
  return (await r.json()).result;
}

async function loadJson(key) {
  try { return JSON.parse((await kv('get/' + key)) || '[]'); } catch (e) { return []; }
}

async function loadLeads() { return loadJson('leads'); }
async function loadOnboarding() { return loadJson('onboarding'); }

/* Writes put the value in the request body, never in the URL path.

   The old form serialized the whole array into the path and truncated it at
   900,000 characters. Two things were wrong with that. A URL that long is
   rejected by the proxy well before the cap is reached, and the truncation
   itself produced invalid JSON — which loadJson caught and turned back into an
   empty array. Between them, a write could fail and take every stored lead
   with it while the endpoint still answered ok. Throws, so the caller decides
   what to do about it; a lost lead is never something to shrug off. */
async function kvSet(key, value) {
  const r = await fetch(process.env.KV_REST_API_URL + '/set/' + encodeURIComponent(key), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN },
    body: value,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error('kv set ' + key + ' failed: ' + r.status + ' ' + detail.slice(0, 200));
  }
  return true;
}

async function saveLeads(all) {
  // Newest kept if the list ever grows past what one key should hold.
  if (all.length > 2000) all = all.slice(-2000);
  await kvSet('leads', JSON.stringify(all));
  return all;
}

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// The fields the operator or the client sets after the fact. Everything else
// on a lead is fixed at capture.
const OUTCOME_FIELDS = ['contacted', 'booked', 'won', 'contract', 'perVisit', 'visitsPerYear'];

/* Record when an outcome was first reached. Google's offline conversion
   import needs a conversion time, and "when the estimate was booked" is a
   different moment from "when they inquired". Stamped once; clearing and
   re-setting an outcome keeps the original time. contactedAt is the
   speed-to-lead clock: minutes from inquiry to first call back. */
function stampOutcomes(lead) {
  const now = new Date().toISOString();
  if (lead.contacted === 'Yes' && !lead.contactedAt) lead.contactedAt = now;
  if (lead.booked === 'Yes' && !lead.bookedAt) lead.bookedAt = now;
  if (lead.won === 'Yes' && !lead.wonAt) lead.wonAt = now;
  return lead;
}

/* Normalization and hashing for enhanced conversions. Google's rules: email
   lowercased and trimmed (gmail dots removed), phone in E.164, then SHA-256
   hex. Ten US digits are assumed to be +1 — every client so far is in the
   US; make this a per-client setting the day one is not. */
function normEmail(e) {
  let s = String(e || '').trim().toLowerCase();
  if (!s.includes('@')) return '';
  const [local, domain] = s.split('@');
  if (domain === 'gmail.com' || domain === 'googlemail.com') s = local.replace(/\./g, '') + '@' + domain;
  return s;
}
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (String(p).trim().startsWith('+') && d.length >= 8) return '+' + d;
  return '';
}
const sha256 = (s) => (s ? crypto.createHash('sha256').update(s).digest('hex') : '');
function hashIds(lead) {
  lead.emailHash = sha256(normEmail(lead.email));
  lead.phoneHash = sha256(normPhone(lead.phone));
  return lead;
}

/* The same person asking twice within a month is one lead, not two. Match on
   normalized phone or email for the same client; the earlier lead wins. */
function findDuplicate(lead, all, days) {
  const cutoff = Date.now() - (days || 30) * 86400000;
  const ph = normPhone(lead.phone), em = normEmail(lead.email);
  for (let i = all.length - 1; i >= 0; i--) {
    const l = all[i];
    if (l.to !== lead.to || l.id === lead.id) continue;
    if (new Date(l.at).getTime() < cutoff) continue;
    if ((ph && normPhone(l.phone) === ph) || (em && normEmail(l.email) === em)) return l.duplicateOf ? l.duplicateOf : l.id;
  }
  return '';
}

/* Where a visit or a lead came from — the buckets the funnel reports on. */
function sourceBucket(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'google ads' || s.endsWith(' ads')) return 'paid';
  if (s === 'google business profile') return 'gbp';
  if (s === 'google search' || s === 'bing search') return 'organic';
  if (s === 'phone' || s === 'lsa') return 'phone';
  if (!s || s === 'website form' || s === 'direct') return 'direct';
  return 'referral';
}

/* Site visits: one Redis hash per client, field "<yyyy-mm-dd>|<bucket>", value
   a count. No cookies, no IPs, no per-visitor record — a number per day per
   source is all the funnel needs. */
async function countVisit(to, bucket) {
  const day = new Date().toISOString().slice(0, 10);
  const field = day + '|' + (bucket || 'direct');
  try { await kv('hincrby/' + encodeURIComponent('visits:' + to) + '/' + encodeURIComponent(field) + '/1'); } catch (e) {}
}
async function loadVisits(to, days) {
  let raw = null;
  try { raw = await kv('hgetall/' + encodeURIComponent('visits:' + to)); } catch (e) {}
  // Upstash returns a flat [field, value, field, value] array.
  const out = {};
  const cutoff = new Date(Date.now() - (days || 30) * 86400000).toISOString().slice(0, 10);
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const [day, bucket] = String(raw[i]).split('|');
      if (day < cutoff) continue;
      out[bucket] = (out[bucket] || 0) + (parseInt(raw[i + 1], 10) || 0);
    }
  }
  return out;
}

/* Where the lead came from, worked out from what the form carried rather
   than trusted from a free-text field. A Google click id means paid search;
   UTM parameters name the channel; a bare referrer from google.com is the
   Business Profile or organic. */
function deriveSource(b) {
  const explicit = str(b.source, 60).toLowerCase();
  const gclid = str(b.gclid, 200), gbraid = str(b.gbraid, 200), wbraid = str(b.wbraid, 200);
  const us = str(b.utm_source, 60).toLowerCase(), um = str(b.utm_medium, 60).toLowerCase();
  if (gclid || gbraid || wbraid) return 'google ads';
  if (us === 'gbp' || us === 'google business' || us === 'google-business' || um === 'gbp') return 'google business profile';
  if (us && um === 'cpc') return us + ' ads';
  if (us) return us + (um ? ' ' + um : '');
  if (explicit && explicit !== 'website form') return explicit;
  const ref = str(b.referrer, 300).toLowerCase();
  if (/(^|\.)google\./.test(ref) || ref.includes('google.com')) return 'google search';
  if (ref) { try { return new URL(ref).hostname.replace(/^www\./, ''); } catch (e) {} }
  return explicit || 'website form';
}

/* One-tap status links. The token names the lead and the client it belongs
   to and expires; the link opens a confirmation page, so a mail scanner
   prefetching it changes nothing. */
const STATUS_TTL_MS = 120 * 86400000; // customers are won weeks after the inquiry

function signStatus(lead, secret) {
  const b = Buffer.from(JSON.stringify({ i: lead.id, c: lead.to, x: Date.now() + STATUS_TTL_MS })).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', secret).update(b).digest('base64url');
}

function verifyStatus(token, secret) {
  const t = String(token || '');
  const i = t.lastIndexOf('.');
  if (i < 1) return null;
  const b = t.slice(0, i), sig = t.slice(i + 1);
  const good = crypto.createHmac('sha256', secret).update(b).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p && p.i && p.c && p.x > Date.now() ? p : null;
  } catch (e) { return null; }
}

const base = () => (process.env.PUBLIC_BASE || 'https://www.wolfeintelligence.com').replace(/\/$/, '');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Send the new-lead email through Resend. Returns 'sent', 'unconfigured' or
   'failed'. Never throws: the lead is already saved and a mail outage must
   not turn a captured lead into a 500 for the form. */
async function notifyNewLead(lead, client) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return 'unconfigured';
  const from = process.env.LEAD_FROM || 'Wolfe Intelligence <leads@wolfeintelligence.com>';
  const owner = (process.env.OWNER_EMAIL || 'zachary@wolfeintelligence.com').toLowerCase();
  const secret = process.env.SESSION_SECRET;
  const biz = (client && client.businessName) || lead.to;
  const notifyTo = (client && client.notifyEmail) || lead.to;

  const rows = [
    ['Name', lead.name], ['Phone', lead.phone], ['Email', lead.email],
    ['Wants', lead.service], ['Address', lead.address],
    ['Preferred time for the estimate', lead.preferred], ['Notes', lead.notes],
    ['OK to text them', lead.smsOk === 'Yes' ? 'Yes — they ticked the box' : (lead.phone ? 'Not given — call, do not text marketing' : '')],
    ['Came from', lead.source],
    ['Note', lead.duplicateOf ? 'They have inquired before in the last 30 days — this is a repeat.' : ''],
  ].filter((r) => r[1]);

  const links = secret ? (() => {
    const t = encodeURIComponent(signStatus(lead, secret));
    const u = (set) => base() + '/lead-status?t=' + t + '&set=' + set;
    return { contacted: u('contacted'), booked: u('booked'), won: u('won'), lost: u('lost') };
  })() : null;

  const head = (lead.duplicateOf ? 'Repeat inquiry for ' : 'New inquiry for ') + biz;
  const text = [
    head + ':', '',
    ...rows.map((r) => r[0] + ': ' + r[1]), '',
    lead.phone ? 'Call back now if you can — the first business to reply usually gets the job.\n' : '',
    links ? 'Then tap one so the numbers stay honest:\n' +
      '  I called them back:   ' + links.contacted + '\n' +
      '  Estimate booked:      ' + links.booked + '\n' +
      '  Became a customer:    ' + links.won + '\n' +
      '  Did not go ahead:     ' + links.lost + '\n' : '',
    'Sent by Wolfe Intelligence. Inquiries also appear in your portal at ' + base() + '/portal',
  ].join('\n');

  const btn = (href, label, bg) =>
    '<a href="' + esc(href) + '" style="display:inline-block;margin:6px 8px 6px 0;padding:11px 16px;background:' + bg + ';color:#1b1713;text-decoration:none;font:600 14px Helvetica,Arial,sans-serif;border-radius:3px;">' + esc(label) + '</a>';
  const html =
    '<div style="font:15px/1.5 Helvetica,Arial,sans-serif;color:#1b1713;max-width:560px;">' +
    '<p style="font-size:18px;margin:0 0 14px;"><b>' + esc(head) + '</b></p>' +
    '<table style="border-collapse:collapse;">' +
    rows.map((r) => '<tr><td style="padding:4px 14px 4px 0;color:#6f6459;white-space:nowrap;vertical-align:top;">' + esc(r[0]) + '</td><td style="padding:4px 0;">' + esc(r[1]) + '</td></tr>').join('') +
    '</table>' +
    (lead.phone ? '<p style="margin:16px 0 0;">Call back now if you can — the first business to reply usually gets the job.' +
      ' <a href="tel:' + esc(lead.phone.replace(/[^\d+]/g, '')) + '" style="font-weight:700;">' + esc(lead.phone) + '</a></p>' : '') +
    (links ? '<p style="margin:22px 0 4px;color:#6f6459;">Then tap one so the numbers stay honest:</p>' +
      btn(links.contacted, 'I called them back', '#cfe3f5') + btn(links.booked, 'Estimate booked', '#e9c98d') + btn(links.won, 'Became a customer', '#b9d29a') + btn(links.lost, 'Did not go ahead', '#e0d8c8') : '') +
    '<p style="margin:26px 0 0;font-size:12.5px;color:#8c8072;">Sent by Wolfe Intelligence. Inquiries also appear in <a href="' + esc(base()) + '/portal" style="color:#8c8072;">your portal</a>.</p>' +
    '</div>';

  const to = [notifyTo];
  if (owner && owner !== notifyTo) to.push(owner);
  const payload = {
    from, to,
    subject: (lead.duplicateOf ? 'Repeat inquiry: ' : 'New inquiry: ') + (lead.name || 'someone') + (lead.service ? ' — ' + lead.service : ''),
    text, html,
  };
  if (lead.email && lead.email.includes('@')) payload.reply_to = lead.email;

  return sendResend(key, payload);
}

async function sendResend(key, payload) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.ok ? 'sent' : 'failed';
  } catch (e) {
    return 'failed';
  }
}

/* Confirmation to the person who asked, when they left an email. Sets the
   expectation and hands them the phone number; replies go to the business. */
async function autoReplyLead(lead, client) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !lead.email || !lead.email.includes('@')) return 'skipped';
  const from = process.env.LEAD_FROM || 'Wolfe Intelligence <leads@wolfeintelligence.com>';
  const biz = (client && client.businessName) || 'the business';
  const phone = client && client.intake && client.intake.phone ? String(client.intake.phone) : '';
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
  const text = [
    'Hi ' + first + ',', '',
    'Thanks — ' + biz + ' has your request' + (lead.service ? ' for ' + lead.service.toLowerCase() : '') + '.',
    (lead.phone ? 'They will call or text ' + lead.phone : 'They will email you') + ' to set up your free estimate' + (lead.preferred ? ' (' + lead.preferred.toLowerCase() + ' noted)' : '') + '.',
    phone ? '\nIn a hurry? Call ' + biz + ' on ' + phone + '.' : '',
    '', 'Reply to this email if anything changes.',
  ].join('\n');
  const html = '<div style="font:15px/1.55 Helvetica,Arial,sans-serif;color:#1b1713;max-width:560px;">' +
    text.split('\n').map((l) => l ? '<p style="margin:0 0 10px;">' + esc(l) + '</p>' : '').join('') + '</div>';
  const payload = { from, to: [lead.email], subject: biz + ' — got your estimate request', text, html };
  const replyTo = (client && (client.notifyEmail || client.email)) || '';
  if (replyTo && replyTo.includes('@')) payload.reply_to = replyTo;
  return sendResend(key, payload);
}

module.exports = {
  kvReady, kv, kvSet, loadLeads, loadOnboarding, saveLeads, str, OUTCOME_FIELDS, stampOutcomes,
  normEmail, normPhone, sha256, hashIds, findDuplicate, sourceBucket, countVisit, loadVisits,
  deriveSource, signStatus, verifyStatus, notifyNewLead, autoReplyLead, base,
};
