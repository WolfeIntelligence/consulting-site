// Site-visit counter for client sites.
//
// The page sends one beacon per landing: which client, and enough about the
// arrival to bucket the source (paid / gbp / organic / referral / direct).
// Nothing about the visitor is stored — no IP, no cookie, no id — only a count
// per client per day per bucket, which is all the funnel needs to say
// "84 visits from ads, 6 asked for an estimate, 3 booked".
//
// Public and cross-origin like /api/lead, and rate limited the same way.

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

  const gate = await limit(req, 'visit', 60, 600);
  if (!gate.allowed) return res.status(429).json({ error: 'too-many-requests' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  const to = L.str(b.to, 120).toLowerCase();
  if (!to.includes('@')) return res.status(400).json({ error: 'bad-target' });

  const onb = await L.loadOnboarding();
  if (!onb.some((o) => o.email === to)) return res.status(404).json({ error: 'unknown-client' });

  // The page says whether a click id was present rather than sending it: the
  // id itself belongs with a lead, not with a page view.
  const source = L.deriveSource({
    gclid: b.paid ? 'x' : '',
    utm_source: b.utm_source, utm_medium: b.utm_medium, referrer: b.referrer,
  });
  await L.countVisit(to, L.sourceBucket(source));
  return res.status(204).end();
};
