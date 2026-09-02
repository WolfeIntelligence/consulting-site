// Newsletter signup for Optical Alpha.
//
// The Substack does not exist yet, so the list lives here, in the same store
// as everything else, and the owner is emailed each time someone joins. When
// the publication goes live the list is exported and imported there; until
// then nobody who signs up is lost.
//
// Same posture as the lead endpoint: the only thing it can write is one
// bounded list; every field is length-capped; rate limited per IP across
// serverless instances; honeypot and dwell time catch the bots.

const { limit } = require('../lib/ratelimit');
const kv = require('../lib/kv');
const L = require('../lib/leads');

const KEY = 'subscribers';
const MAX = 20000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!kv.ready()) return res.status(501).json({ error: 'storage-not-configured' });

  const gate = await limit(req, 'subscribe', 10, 600);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'too-many-requests' });
  }

  const b = req.body || {};
  const str = L.str;

  // Bots fill the field a person never sees, and submit faster than a person
  // can type an address. Answer as if it worked; store nothing.
  if (str(b.website, 200)) return res.json({ ok: true });
  const dwell = parseInt(b.dwell, 10);
  if (isFinite(dwell) && dwell >= 0 && dwell < 1500) return res.json({ ok: true });

  const email = str(b.email, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'bad-email' });

  let list = [];
  try { list = JSON.parse((await kv.cmd('GET', KEY)) || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];

  if (list.some((s) => s && s.email === email)) return res.json({ ok: true, already: true });
  if (list.length >= MAX) return res.status(507).json({ error: 'list-full' });

  const sub = {
    email,
    at: new Date().toISOString(),
    landing: str(b.landing, 300),
    referrer: str(b.referrer, 300),
  };
  list.push(sub);

  let stored = true;
  try {
    await kv.cmd('SET', KEY, JSON.stringify(list));
  } catch (e) {
    stored = false;
    console.error('SUBSCRIBER STORAGE FAILED', email, (e && e.message) || e);
  }

  // Best effort, never fails the request: the address is already saved.
  let notified = false;
  const key = process.env.RESEND_API_KEY;
  if (key) {
    const owner = (process.env.OWNER_EMAIL || 'zachary@wolfeintelligence.com').toLowerCase();
    const from = process.env.LEAD_FROM || 'Wolfe Intelligence <leads@wolfeintelligence.com>';
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({
          from, to: [owner],
          subject: 'New Optical Alpha subscriber: ' + email,
          text: email + ' signed up for Optical Alpha at ' + sub.at + '.\n' +
            (sub.referrer ? 'Came from: ' + sub.referrer + '\n' : '') +
            'Subscribers on the list now: ' + list.length + '.',
        }),
      });
      notified = r.ok;
    } catch (e) { notified = false; }
  }

  return res.json({ ok: true, stored, notified, count: list.length });
};
