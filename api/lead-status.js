// One-tap outcome recording from the new-lead email.
//
// The email carries links to /lead-status?t=<signed token>&set=<outcome>.
// That page calls GET here to show which enquiry it is about, and POST when
// the person taps confirm. The token names one lead and one client and
// expires; nothing else can be reached with it. The confirmation step exists
// because mail scanners prefetch links — a bare GET that changed state would
// mark enquiries booked before anyone read the email.

const { limit } = require('../lib/ratelimit');
const L = require('../lib/leads');

const PUBLIC = (l, biz) => ({
  id: l.id, name: l.name, service: l.service, at: l.at, phone: l.phone,
  booked: l.booked, won: l.won, business: biz,
});

module.exports = async (req, res) => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return res.status(503).json({ error: 'auth-not-configured' });
  if (!L.kvReady()) return res.status(501).json({ error: 'storage-not-configured' });

  const gate = await limit(req, 'lead-status', 60, 600);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'too-many-requests' });
  }

  const q = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const p = L.verifyStatus(q.t, secret);
  if (!p) return res.status(401).json({ error: 'bad-or-expired-link' });

  const all = await L.loadLeads();
  const lead = all.find((l) => l.id === p.i && l.to === p.c);
  if (!lead) return res.status(404).json({ error: 'not-found' });

  const onb = await L.loadOnboarding();
  const client = onb.find((o) => o.email === lead.to);
  const biz = (client && client.businessName) || '';

  if (req.method === 'GET') return res.json({ ok: true, lead: PUBLIC(lead, biz) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const set = String(q.set || '');
  if (set === 'booked') { lead.booked = 'Yes'; if (lead.won === 'No') lead.won = ''; }
  else if (set === 'won') { lead.won = 'Yes'; if (!lead.booked) lead.booked = 'Yes'; }
  else if (set === 'lost') { lead.won = 'No'; }
  else return res.status(400).json({ error: 'bad-outcome' });
  L.stampOutcomes(lead);

  await L.saveLeads(all);
  return res.json({ ok: true, lead: PUBLIC(lead, biz) });
};
