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
//     site uses so the limit holds across serverless instances.
//
// It accepts cross-origin POSTs because the whole point is that it is called
// from a client's domain, not ours.

const { limit } = require('../lib/ratelimit');

const kvReady = () => process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;

async function kv(path) {
  const r = await fetch(process.env.KV_REST_API_URL + '/' + path, {
    headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN },
  });
  if (!r.ok) return null;
  return (await r.json()).result;
}

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

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
  if (!kvReady()) return res.status(501).json({ error: 'storage-not-configured' });

  // A quote form is not something one person submits twenty times a minute.
  const gate = await limit(req, 'lead', 20, 600);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'too-many-requests' });
  }

  const b = req.body || {};
  const to = str(b.to, 120).toLowerCase();
  const name = str(b.name, 120);
  const phone = str(b.phone, 40);
  const email = str(b.email, 160).toLowerCase();

  if (!to.includes('@')) return res.status(400).json({ error: 'bad-target' });
  if (!name) return res.status(400).json({ error: 'name-required' });
  if (!phone && !email) return res.status(400).json({ error: 'contact-required' });

  // Only accept leads for a business we are actually running an engagement for.
  let onb = [];
  try { onb = JSON.parse((await kv('get/onboarding')) || '[]'); } catch (e) {}
  if (!onb.some((o) => o.email === to)) return res.status(404).json({ error: 'unknown-client' });

  const lead = {
    id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    to,
    at: new Date().toISOString(),
    name,
    phone,
    email,
    service: str(b.service, 200),
    address: str(b.address, 200),
    notes: str(b.notes, 1000),
    // Captured at the click and carried through the form. Without it a won
    // customer can never be matched back to the ad that produced them, and it
    // cannot be recovered later.
    gclid: str(b.gclid, 200),
    source: str(b.source, 60) || 'website form',
    // Set by the operator afterwards.
    booked: '',
    won: '',
    contract: '',
    perVisit: '',
    visitsPerYear: '',
  };

  let all = [];
  try { all = JSON.parse((await kv('get/leads')) || '[]'); } catch (e) {}
  all.push(lead);
  // Newest kept if the list ever grows past what one key should hold.
  if (all.length > 2000) all = all.slice(-2000);
  await kv('set/leads/' + encodeURIComponent(JSON.stringify(all).slice(0, 900000)));

  return res.json({ ok: true, id: lead.id });
};
