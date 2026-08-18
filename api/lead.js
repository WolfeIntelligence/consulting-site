// Public lead intake.
//
// This is the endpoint a client's own site (or a landing page we build for
// them) posts to when someone asks for a quote. It is deliberately the only
// public write in the API, so it is narrow on purpose:
//
//   - the target client must already exist as an onboarding record, so the
//     endpoint cannot be used to create arbitrary keys in storage;
//   - every field is length-capped and the stored list is bounded;
//   - it is rate limited per IP, backed by the same Redis the rest of the
//     site uses so the limit holds across serverless instances;
//   - a honeypot field catches the bots that fill every input.
//
// It accepts cross-origin POSTs because the whole point is that it is called
// from a client's domain, not ours.
//
// After the lead is stored the client (and the owner) are emailed, with
// signed one-tap links to record what happened next. Mail is best-effort:
// the lead is saved first and a mail failure never fails the request.

const { limit } = require('../lib/ratelimit');
const L = require('../lib/leads');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!L.kvReady()) return res.status(501).json({ error: 'storage-not-configured' });

  // A quote form is not something one person submits twenty times a minute.
  const gate = await limit(req, 'lead', 20, 600);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'too-many-requests' });
  }

  const b = req.body || {};
  const str = L.str;

  // Honeypot: a field real visitors never see. Bots fill it. Answer as if it
  // worked so they do not learn to skip it, and store nothing.
  if (str(b.website, 200)) return res.json({ ok: true, id: 'l0' });

  const to = str(b.to, 120).toLowerCase();
  const name = str(b.name, 120);
  const phone = str(b.phone, 40);
  const email = str(b.email, 160).toLowerCase();

  if (!to.includes('@')) return res.status(400).json({ error: 'bad-target' });
  if (!name) return res.status(400).json({ error: 'name-required' });
  if (!phone && !email) return res.status(400).json({ error: 'contact-required' });

  // Only accept leads for a business we are actually running an engagement for.
  const onb = await L.loadOnboarding();
  const client = onb.find((o) => o.email === to);
  if (!client) return res.status(404).json({ error: 'unknown-client' });

  const lead = {
    id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    to,
    at: new Date().toISOString(),
    name,
    phone,
    email,
    service: str(b.service, 200),
    address: str(b.address, 200),
    preferred: str(b.preferred, 120),
    notes: str(b.notes, 1000),
    // Captured at the click and carried through the form. Without it a won
    // customer can never be matched back to the ad that produced them, and it
    // cannot be recovered later. gbraid/wbraid are the iOS-privacy variants.
    gclid: str(b.gclid, 200),
    gbraid: str(b.gbraid, 200),
    wbraid: str(b.wbraid, 200),
    utm: {
      source: str(b.utm_source, 60),
      medium: str(b.utm_medium, 60),
      campaign: str(b.utm_campaign, 100),
    },
    landing: str(b.landing, 300),
    referrer: str(b.referrer, 300),
    source: L.deriveSource(b),
    // Set by the operator or the client afterwards.
    booked: '',
    won: '',
    contract: '',
    perVisit: '',
    visitsPerYear: '',
  };

  const all = await L.loadLeads();
  all.push(lead);
  await L.saveLeads(all);

  const notified = await L.notifyNewLead(lead, client);

  return res.json({ ok: true, id: lead.id, notified: notified === 'sent' });
};
