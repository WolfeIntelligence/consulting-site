const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sign = (payload, secret) => {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', secret).update(b).digest('base64url');
};
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  if (!url || !tok) return null;
  const r = await fetch(url + '/get/' + encodeURIComponent(key), { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) return null;
  return (await r.json()).result;
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const secret = process.env.SESSION_SECRET, ownerCode = process.env.OWNER_CODE;
  if (!secret || !ownerCode) return res.status(503).json({ error: 'auth-not-configured' });
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  if (!email || !code) return res.status(400).json({ error: 'missing' });
  const owner = (process.env.OWNER_EMAIL || 'zachary@wolfeintelligence.com').toLowerCase();
  const issue = (role) => res.json({ token: sign({ e: email, r: role, x: Date.now() + 86400000 }, secret), role, email });
  if (email === owner) return code === ownerCode ? issue('owner') : res.status(401).json({ error: 'bad-credentials' });
  // Clients: env CLIENT_ACCOUNTS="a@b.com:code1,c@d.com:code2" and/or KV client:<email> = sha256(code)
  for (const pair of String(process.env.CLIENT_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(':');
    if (i > 0 && pair.slice(0, i).toLowerCase() === email && pair.slice(i + 1) === code) return issue('client');
  }
  const stored = await kvGet('client:' + email);
  if (stored && stored === sha(code)) return issue('client');
  return res.status(401).json({ error: 'bad-credentials' });
};
