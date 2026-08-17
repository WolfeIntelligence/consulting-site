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
    // Onboarding records are written by the owner console and read back here.
    // A client only ever sees their own; the filter is server-side because the
    // client holds a token, not a trustworthy claim about who they are.
    let onb = [];
    if (kvReady()) { try { onb = JSON.parse((await kv('get/onboarding')) || '[]'); } catch (e) {} }
    let leads = [];
    if (kvReady()) { try { leads = JSON.parse((await kv('get/leads')) || '[]'); } catch (e) {} }
    return res.json({
      role: ses.r,
      deployments: ses.r === 'owner' ? all : all.filter((d) => d.to === ses.e),
      // The record carries the full intake so the console works from any
      // machine. A client must never receive it — strip it here rather than
      // trusting the front end to hide it.
      onboarding: ses.r === 'owner'
        ? onb
        : onb.filter((o) => o.email === ses.e).map(({ intake, ...safe }) => safe),
      // A client sees their own leads; the owner sees every client's.
      leads: ses.r === 'owner' ? leads : leads.filter((l) => l.to === ses.e),
    });
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
  if (b.action === 'onboarding') {
    // Upsert one client's engagement record. The console sends the whole
    // record each time — simpler than patching, and these are small.
    const rec = b.record || {};
    const email = String(rec.email || '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(400).json({ error: 'bad-input' });
    const clean = {
      email,
      businessName: String(rec.businessName || '').slice(0, 120),
      route: String(rec.route || '').slice(0, 120),
      phase: String(rec.phase || '').slice(0, 120),
      nextAction: String(rec.nextAction || '').slice(0, 240),
      steps: (Array.isArray(rec.steps) ? rec.steps : []).slice(0, 40).map((s) => ({
        label: String(s && s.label || '').slice(0, 120),
        done: !!(s && s.done),
        date: String(s && s.date || '').slice(0, 10),
        // Whose turn the step is, so the client's portal can say so plainly.
        owner: ['you', 'wolfe', 'google'].includes(s && s.owner) ? s.owner : 'wolfe',
      })),
      updatedAt: new Date().toISOString(),
    };
    // Owner-only working notes. Bounded so one record cannot crowd out the rest.
    if (rec.intake && typeof rec.intake === 'object' && !Array.isArray(rec.intake)) {
      const trimmed = {};
      for (const k of Object.keys(rec.intake).slice(0, 60)) {
        trimmed[String(k).slice(0, 40)] = String(rec.intake[k] == null ? '' : rec.intake[k]).slice(0, 2000);
      }
      clean.intake = trimmed;
    }
    let all = [];
    try { all = JSON.parse((await kv('get/onboarding')) || '[]'); } catch (e) {}
    all = all.filter((o) => o.email !== email);
    all.push(clean);
    await kv('set/onboarding/' + encodeURIComponent(JSON.stringify(all).slice(0, 200000)));
    return res.json({ ok: true, record: clean });
  }
  if (b.action === 'onboarding-remove') {
    const email = String(b.email || '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(400).json({ error: 'bad-input' });
    let all = [];
    try { all = JSON.parse((await kv('get/onboarding')) || '[]'); } catch (e) {}
    all = all.filter((o) => o.email !== email);
    await kv('set/onboarding/' + encodeURIComponent(JSON.stringify(all).slice(0, 200000)));
    return res.json({ ok: true });
  }
  if (b.action === 'lead-add' || b.action === 'lead-update') {
    // The operator's own entry point: a lead that arrived by phone, by text, or
    // through the Local Services Ads inbox, plus the booked/won outcome that
    // only they can know.
    const l = b.lead || {};
    const id = String(l.id || '').slice(0, 40);
    const to = String(l.to || '').trim().toLowerCase();
    if (!to.includes('@')) return res.status(400).json({ error: 'bad-target' });
    let all = [];
    try { all = JSON.parse((await kv('get/leads')) || '[]'); } catch (e) {}
    const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const clean = {
      id: id || 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      to,
      at: str(l.at, 40) || new Date().toISOString(),
      name: str(l.name, 120),
      phone: str(l.phone, 40),
      email: str(l.email, 160),
      service: str(l.service, 200),
      address: str(l.address, 200),
      notes: str(l.notes, 1000),
      gclid: str(l.gclid, 200),
      source: str(l.source, 60),
      booked: str(l.booked, 20),
      won: str(l.won, 20),
      contract: str(l.contract, 30),
      perVisit: str(l.perVisit, 20),
      visitsPerYear: str(l.visitsPerYear, 20),
    };
    all = all.filter((x) => x.id !== clean.id);
    all.push(clean);
    if (all.length > 2000) all = all.slice(-2000);
    await kv('set/leads/' + encodeURIComponent(JSON.stringify(all).slice(0, 900000)));
    return res.json({ ok: true, lead: clean });
  }
  if (b.action === 'lead-remove') {
    const id = String(b.id || '').slice(0, 40);
    let all = [];
    try { all = JSON.parse((await kv('get/leads')) || '[]'); } catch (e) {}
    all = all.filter((x) => x.id !== id);
    await kv('set/leads/' + encodeURIComponent(JSON.stringify(all).slice(0, 900000)));
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: 'unknown-action' });
};
