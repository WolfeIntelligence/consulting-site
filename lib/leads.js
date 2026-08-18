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

async function saveLeads(all) {
  // Newest kept if the list ever grows past what one key should hold.
  if (all.length > 2000) all = all.slice(-2000);
  await kv('set/leads/' + encodeURIComponent(JSON.stringify(all).slice(0, 900000)));
  return all;
}

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// The fields the operator or the client sets after the fact. Everything else
// on a lead is fixed at capture.
const OUTCOME_FIELDS = ['booked', 'won', 'contract', 'perVisit', 'visitsPerYear'];

/* Record when an outcome was first reached. Google's offline conversion
   import needs a conversion time, and "when the estimate was booked" is a
   different moment from "when they enquired". Stamped once; clearing and
   re-setting an outcome keeps the original time. */
function stampOutcomes(lead) {
  const now = new Date().toISOString();
  if (lead.booked === 'Yes' && !lead.bookedAt) lead.bookedAt = now;
  if (lead.won === 'Yes' && !lead.wonAt) lead.wonAt = now;
  return lead;
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
const STATUS_TTL_MS = 120 * 86400000; // customers are won weeks after the enquiry

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
    ['Came from', lead.source],
  ].filter((r) => r[1]);

  const links = secret ? (() => {
    const t = encodeURIComponent(signStatus(lead, secret));
    const u = (set) => base() + '/lead-status?t=' + t + '&set=' + set;
    return { booked: u('booked'), won: u('won'), lost: u('lost') };
  })() : null;

  const text = [
    'New enquiry for ' + biz + ':', '',
    ...rows.map((r) => r[0] + ': ' + r[1]), '',
    lead.phone ? 'Call back soon — the first business to reply usually gets the job.\n' : '',
    links ? 'When you know what happened, tap one:\n' +
      '  Estimate booked:      ' + links.booked + '\n' +
      '  Became a customer:    ' + links.won + '\n' +
      '  Did not go ahead:     ' + links.lost + '\n' : '',
    'Sent by Wolfe Intelligence. Enquiries also appear in your portal at ' + base() + '/portal',
  ].join('\n');

  const btn = (href, label, bg) =>
    '<a href="' + esc(href) + '" style="display:inline-block;margin:6px 8px 6px 0;padding:11px 16px;background:' + bg + ';color:#1b1713;text-decoration:none;font:600 14px Helvetica,Arial,sans-serif;border-radius:3px;">' + esc(label) + '</a>';
  const html =
    '<div style="font:15px/1.5 Helvetica,Arial,sans-serif;color:#1b1713;max-width:560px;">' +
    '<p style="font-size:18px;margin:0 0 14px;"><b>New enquiry for ' + esc(biz) + '</b></p>' +
    '<table style="border-collapse:collapse;">' +
    rows.map((r) => '<tr><td style="padding:4px 14px 4px 0;color:#6f6459;white-space:nowrap;vertical-align:top;">' + esc(r[0]) + '</td><td style="padding:4px 0;">' + esc(r[1]) + '</td></tr>').join('') +
    '</table>' +
    (lead.phone ? '<p style="margin:16px 0 0;">Call back soon — the first business to reply usually gets the job.' +
      ' <a href="tel:' + esc(lead.phone.replace(/[^\d+]/g, '')) + '">' + esc(lead.phone) + '</a></p>' : '') +
    (links ? '<p style="margin:22px 0 4px;color:#6f6459;">When you know what happened, tap one:</p>' +
      btn(links.booked, 'Estimate booked', '#e9c98d') + btn(links.won, 'Became a customer', '#b9d29a') + btn(links.lost, 'Did not go ahead', '#e0d8c8') : '') +
    '<p style="margin:26px 0 0;font-size:12.5px;color:#8c8072;">Sent by Wolfe Intelligence. Enquiries also appear in <a href="' + esc(base()) + '/portal" style="color:#8c8072;">your portal</a>.</p>' +
    '</div>';

  const to = [notifyTo];
  if (owner && owner !== notifyTo) to.push(owner);
  const payload = {
    from, to,
    subject: 'New enquiry: ' + (lead.name || 'someone') + (lead.service ? ' — ' + lead.service : ''),
    text, html,
  };
  if (lead.email && lead.email.includes('@')) payload.reply_to = lead.email;

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

module.exports = {
  kvReady, kv, loadLeads, loadOnboarding, saveLeads, str, OUTCOME_FIELDS, stampOutcomes,
  deriveSource, signStatus, verifyStatus, notifyNewLead, base,
};
