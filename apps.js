const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function verify(token, secret) {
  const i = String(token).lastIndexOf('.');
  if (i < 1) return null;
  const b = token.slice(0, i), sig = token.slice(i + 1);
  const good = crypto.createHmac('sha256', secret).update(b).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p && p.x > Date.now() ? p : null;
  } catch (e) { return null; }
}
const kvReady = () => process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
async function kv(path) {
  const r = await fetch(process.env.KV_REST_API_URL + '/' + path, { headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN } });
  if (!r.ok) return null;
  return (await r.json()).result;
}
module.exports = async (req, res) => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return res.status(503).json({ error: 'auth-not-configured' });
  const ses = verify(String(req.headers.authorization || '').replace(/^Bearer /, ''), secret);
  if (!ses) return res.status(401).json({ error: 'unauthorized' });
  if (req.method === 'GET') {
    let all = [];
    if (kvReady()) { try { all = JSON.parse((await kv('get/deployments')) || '[]'); } catch (e) {} }
    return res.json({ role: ses.r, deployments: ses.r === 'owner' ? all : all.filter((d) => d.to === ses.e) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (ses.r !== 'owner') return res.status(403).json({ error: 'owner-only' });
  if (!kvReady()) return res.status(501).json({ error: 'storage-not-configured' });
  const b = req.body || {};
  if (b.action === 'provision') {
    const email = String(b.email || '').trim().toLowerCase(), code = String(b.code || '').trim();
    if (!email.includes('@') || code.length < 6) return res.status(400).json({ error: 'bad-input' });
    await kv('set/' + encodeURIComponent('client:' + email) + '/' + encodeURIComponent(sha(code)));
    return res.json({ ok: true });
  }
  if (b.action === 'deploy') {
    const to = String(b.to || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 80);
    if (!to.includes('@') || !name) return res.status(400).json({ error: 'bad-input' });
    let all = [];
    try { all = JSON.parse((await kv('get/deployments')) || '[]'); } catch (e) {}
    all.push({ name, to, by: ses.e, at: new Date().toISOString() });
    await kv('set/deployments/' + encodeURIComponent(JSON.stringify(all).slice(0, 100000)));
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: 'unknown-action' });
};
