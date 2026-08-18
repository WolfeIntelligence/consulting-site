// API tests against a mocked KV (Upstash REST shape) and a mocked Resend.
// Run: node tests/run.js
//
// No network, no real storage. Each block below states what it proves.

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.SESSION_SECRET = 'test-secret';
process.env.OWNER_CODE = 'owner-code';
process.env.OWNER_EMAIL = 'owner@wolfe.test';
process.env.PUBLIC_BASE = 'https://www.wolfeintelligence.com';

// ---- mocks -----------------------------------------------------------------
const store = new Map();
const mails = [];
let resendOk = true;
global.fetch = async (url, opt) => {
  const u = String(url);
  if (u.startsWith('https://api.resend.com/emails')) {
    mails.push(JSON.parse(opt.body));
    return { ok: resendOk, status: resendOk ? 200 : 500, json: async () => ({ id: 'm1' }) };
  }
  if (!u.startsWith('https://kv.test/')) throw new Error('unexpected fetch ' + u);
  const parts = u.slice('https://kv.test/'.length).split('/').map(decodeURIComponent);
  const cmd = parts[0];
  let result = null;
  if (cmd === 'get') result = store.has(parts[1]) ? store.get(parts[1]) : null;
  else if (cmd === 'set') { store.set(parts[1], parts[2]); result = 'OK'; }
  else if (cmd === 'incr') { const n = (parseInt(store.get(parts[1]) || '0', 10) || 0) + 1; store.set(parts[1], String(n)); result = n; }
  else if (cmd === 'hincrby') {
    const h = store.get(parts[1]) instanceof Map ? store.get(parts[1]) : new Map();
    h.set(parts[2], (h.get(parts[2]) || 0) + parseInt(parts[3], 10)); store.set(parts[1], h); result = h.get(parts[2]);
  }
  else if (cmd === 'exists') result = store.has(parts[1]) ? 1 : 0;
  else if (cmd === 'del') { result = store.delete(parts[1]) ? 1 : 0; }
  else if (cmd === 'hgetall') { const h = store.get(parts[1]); result = h instanceof Map ? [].concat(...[...h.entries()].map(([k, v]) => [k, String(v)])) : []; }
  else if (cmd === 'expire') result = 1;
  else if (cmd === 'ttl') result = 600;
  return { ok: true, status: 200, json: async () => ({ result }) };
};

const lead = require(path.join(__dirname, '..', 'api', 'lead.js'));
const visit = require(path.join(__dirname, '..', 'api', 'visit.js'));
const leadStatus = require(path.join(__dirname, '..', 'api', 'lead-status.js'));
const apps = require(path.join(__dirname, '..', 'api', 'apps.js'));
const L = require(path.join(__dirname, '..', 'lib', 'leads.js'));

function res() {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
let ipN = 0;
function req(method, body, extra) {
  return Object.assign({ method, body, query: {}, headers: { 'x-forwarded-for': '10.0.0.' + (++ipN % 250) }, socket: {} }, extra || {});
}
const sign = (payload) => {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', process.env.SESSION_SECRET).update(b).digest('base64url');
};
const ownerTok = sign({ e: 'owner@wolfe.test', r: 'owner', x: Date.now() + 1e7 });
const clientTok = sign({ e: 'lawn@client.test', r: 'client', x: Date.now() + 1e7 });
const otherTok = sign({ e: 'other@client.test', r: 'client', x: Date.now() + 1e7 });
const auth = (t) => ({ headers: { authorization: 'Bearer ' + t, 'x-forwarded-for': '10.1.0.' + (++ipN % 250) } });

const leads = () => JSON.parse(store.get('leads') || '[]');
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); }, (e) => { console.log('FAIL  ' + name + '\n      ' + (e && e.message)); process.exitCode = 1; });

(async () => {
  store.set('onboarding', JSON.stringify([
    { email: 'lawn@client.test', businessName: 'Green Lawns' },
    { email: 'other@client.test', businessName: 'Other Co' },
  ]));

  console.log('api/lead');
  await ok('rejects a client we do not run', async () => {
    const r = res(); await lead(req('POST', { to: 'nobody@x.test', name: 'A', phone: '1' }), r);
    assert.strictEqual(r.code, 404); assert.strictEqual(r.body.error, 'unknown-client');
  });
  await ok('requires a name and some contact', async () => {
    let r = res(); await lead(req('POST', { to: 'lawn@client.test', phone: '1' }), r); assert.strictEqual(r.code, 400);
    r = res(); await lead(req('POST', { to: 'lawn@client.test', name: 'A' }), r); assert.strictEqual(r.code, 400);
  });
  await ok('honeypot: answers ok, stores nothing', async () => {
    const r = res(); await lead(req('POST', { to: 'lawn@client.test', name: 'Bot', phone: '1', website: 'http://spam' }), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.ok, true); assert.strictEqual(leads().length, 0);
  });
  await ok('no mail key: lead stored, notified=false, no crash', async () => {
    delete process.env.RESEND_API_KEY;
    const r = res(); await lead(req('POST', { to: 'lawn@client.test', name: 'Quiet', phone: '555' }), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.notified, false); assert.strictEqual(leads().length, 1);
    assert.strictEqual(mails.length, 0);
  });
  let tracked;
  await ok('paid click: gclid kept, source derived, all capture fields stored', async () => {
    process.env.RESEND_API_KEY = 'rk';
    const r = res();
    await lead(req('POST', {
      to: 'lawn@client.test', name: 'Jane Doe', phone: '336-555-0100', email: 'jane@x.test',
      service: 'Weekly mowing', address: '12 Elm St', preferred: 'weekday mornings', notes: 'back gate sticks',
      gclid: 'Cj0KCQ_TEST', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'spring',
      landing: 'https://lawn.example/?gclid=Cj0KCQ_TEST', referrer: 'https://www.google.com/',
      source: 'whatever the form said',
    }), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.notified, true);
    tracked = leads().find((l) => l.name === 'Jane Doe');
    assert.strictEqual(tracked.gclid, 'Cj0KCQ_TEST');
    assert.strictEqual(tracked.source, 'google ads');
    assert.strictEqual(tracked.preferred, 'weekday mornings');
    assert.strictEqual(tracked.utm.campaign, 'spring');
    assert.strictEqual(tracked.booked, '');
  });
  await ok('mail: goes to client and owner, replies to the lead, carries the four signed links; lead gets an auto-reply', async () => {
    const m = mails[mails.length - 2];
    assert.deepStrictEqual(m.to.sort(), ['lawn@client.test', 'owner@wolfe.test']);
    assert.strictEqual(m.reply_to, 'jane@x.test');
    assert.ok(m.subject.includes('Jane Doe'));
    assert.ok(m.text.includes('Green Lawns'));
    ['contacted', 'booked', 'won', 'lost'].forEach((s) => {
      assert.ok(m.text.includes('/lead-status?t=') && m.text.includes('&set=' + s), 'text link ' + s);
      assert.ok(m.html.includes('&amp;set=' + s), 'html link ' + s + ' (escaped)');
    });
    assert.ok(!m.html.includes('<script'));
    const auto = mails[mails.length - 1];
    assert.deepStrictEqual(auto.to, ['jane@x.test']);
    assert.strictEqual(auto.reply_to, 'lawn@client.test');
    assert.ok(auto.text.includes('Green Lawns') && auto.text.includes('336-555-0100'));
  });
  await ok('hashes: normalized email/phone SHA-256 stored; plaintext untouched', async () => {
    assert.strictEqual(tracked.emailHash, crypto.createHash('sha256').update('jane@x.test').digest('hex'));
    assert.strictEqual(tracked.phoneHash, crypto.createHash('sha256').update('+13365550100').digest('hex'));
    assert.strictEqual(L.normEmail('  Jo.Hn.Doe@Gmail.com '), 'johndoe@gmail.com');
    assert.strictEqual(L.normPhone('(336) 555-0100'), '+13365550100');
    assert.strictEqual(L.normPhone('1 336 555 0100'), '+13365550100');
    assert.strictEqual(L.normPhone('12345'), '');
  });
  await ok('repeat inquiry within 30 days is flagged, not double-counted; mail says so', async () => {
    const r = res();
    await lead(req('POST', { to: 'lawn@client.test', name: 'Jane Again', phone: '(336) 555 0100' }), r);
    assert.strictEqual(r.code, 200);
    const dup = leads().find((l) => l.name === 'Jane Again');
    assert.strictEqual(dup.duplicateOf, tracked.id);
    assert.ok(mails[mails.length - 1].subject.startsWith('Repeat inquiry:'));
    const other = res();
    await lead(req('POST', { to: 'other@client.test', name: 'Jane Elsewhere', phone: '(336) 555 0100' }), other);
    assert.strictEqual(leads().find((l) => l.name === 'Jane Elsewhere').duplicateOf, '', 'another client is not a repeat');
  });
  await ok('dwell under 1.5s is treated like the honeypot; sms consent recorded only when ticked', async () => {
    let r = res(); await lead(req('POST', { to: 'lawn@client.test', name: 'Fast Bot', phone: '5550001', dwell: 300 }), r);
    assert.strictEqual(r.body.id, 'l0'); assert.ok(!leads().some((l) => l.name === 'Fast Bot'));
    r = res(); await lead(req('POST', { to: 'lawn@client.test', name: 'Texter', phone: '5550002', dwell: 9000, smsOk: true }), r);
    assert.strictEqual(leads().find((l) => l.name === 'Texter').smsOk, 'Yes');
    r = res(); await lead(req('POST', { to: 'lawn@client.test', name: 'No Text', phone: '5550003', dwell: 9000 }), r);
    assert.strictEqual(leads().find((l) => l.name === 'No Text').smsOk, '');
  });

  console.log('api/visit');
  await ok('counts a visit per client per source bucket; unknown client refused; no PII stored', async () => {
    let r = res(); await visit(req('POST', { to: 'nobody@x.test' }), r); assert.strictEqual(r.code, 404);
    r = res(); await visit(req('POST', { to: 'lawn@client.test', paid: true }), r); assert.strictEqual(r.code, 204);
    r = res(); await visit(req('POST', { to: 'lawn@client.test', paid: true }), r);
    r = res(); await visit(req('POST', { to: 'lawn@client.test', utm_source: 'gbp' }), r);
    r = res(); await visit(req('POST', { to: 'lawn@client.test', referrer: 'https://www.google.com/' }), r);
    r = res(); await visit(req('POST', JSON.stringify({ to: 'lawn@client.test' })), r); // sendBeacon-style string body
    assert.strictEqual(r.code, 204);
    const v = await L.loadVisits('lawn@client.test', 30);
    assert.deepStrictEqual(v, { paid: 2, gbp: 1, organic: 1, direct: 1 });
    const h = store.get('visits:lawn@client.test');
    for (const k of h.keys()) assert.ok(/^\d{4}-\d{2}-\d{2}\|\w+$/.test(k), 'field is day|bucket only: ' + k);
  });
  await ok('mail failure does not fail the capture', async () => {
    resendOk = false;
    const r = res(); await lead(req('POST', { to: 'lawn@client.test', name: 'Mail Down', phone: '1' }), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.notified, false);
    assert.ok(leads().some((l) => l.name === 'Mail Down'));
    resendOk = true;
  });
  await ok('source derivation: gbp, meta cpc, google referrer, plain form', async () => {
    assert.strictEqual(L.deriveSource({ utm_source: 'gbp' }), 'google business profile');
    assert.strictEqual(L.deriveSource({ utm_source: 'facebook', utm_medium: 'cpc' }), 'facebook ads');
    assert.strictEqual(L.deriveSource({ referrer: 'https://www.google.com/' }), 'google search');
    assert.strictEqual(L.deriveSource({}), 'website form');
    assert.strictEqual(L.deriveSource({ wbraid: 'x' }), 'google ads');
  });
  await ok('rate limit: 21st post from one IP is refused', async () => {
    const h = { headers: { 'x-forwarded-for': '9.9.9.9' }, socket: {} };
    let last;
    for (let i = 0; i < 21; i++) { last = res(); await lead(Object.assign(req('POST', { to: 'lawn@client.test', name: 'R' + i, phone: '1' }), h), last); }
    assert.strictEqual(last.code, 429);
  });

  console.log('api/lead-status');
  const good = L.signStatus(tracked, process.env.SESSION_SECRET);
  await ok('bad or missing token is refused', async () => {
    let r = res(); await leadStatus(req('GET', null, { query: { t: 'nope' } }), r); assert.strictEqual(r.code, 401);
    r = res(); await leadStatus(req('GET', null, { query: {} }), r); assert.strictEqual(r.code, 401);
  });
  await ok('GET shows the inquiry, nothing more', async () => {
    const r = res(); await leadStatus(req('GET', null, { query: { t: good } }), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.lead.name, 'Jane Doe'); assert.strictEqual(r.body.lead.business, 'Green Lawns');
    assert.strictEqual(r.body.lead.gclid, undefined); assert.strictEqual(r.body.lead.to, undefined);
    assert.strictEqual(leads().find((l) => l.id === tracked.id).booked, '', 'GET must not change anything');
  });
  await ok('POST contacted stamps contactedAt; booked stamps bookedAt; won stamps wonAt and implies booked; lost sets won=No', async () => {
    let r = res(); await leadStatus(req('POST', { t: good, set: 'contacted' }), r);
    let l = leads().find((x) => x.id === tracked.id);
    assert.strictEqual(l.contacted, 'Yes'); assert.ok(l.contactedAt); assert.strictEqual(l.booked, '');
    r = res(); await leadStatus(req('POST', { t: good, set: 'booked' }), r);
    l = leads().find((x) => x.id === tracked.id);
    assert.strictEqual(l.booked, 'Yes'); assert.ok(l.bookedAt);
    r = res(); await leadStatus(req('POST', { t: good, set: 'won' }), r);
    l = leads().find((x) => x.id === tracked.id);
    assert.strictEqual(l.won, 'Yes'); assert.ok(l.wonAt);
    r = res(); await leadStatus(req('POST', { t: good, set: 'lost' }), r);
    l = leads().find((x) => x.id === tracked.id);
    assert.strictEqual(l.won, 'No'); assert.ok(l.wonAt, 'first-won time is kept');
    r = res(); await leadStatus(req('POST', { t: good, set: 'delete' }), r); assert.strictEqual(r.code, 400);
  });
  await ok('token bound to another client, or expired, is refused', async () => {
    const wrong = L.signStatus({ id: tracked.id, to: 'other@client.test' }, process.env.SESSION_SECRET);
    let r = res(); await leadStatus(req('GET', null, { query: { t: wrong } }), r); assert.strictEqual(r.code, 404);
    const b = Buffer.from(JSON.stringify({ i: tracked.id, c: tracked.to, x: Date.now() - 1 })).toString('base64url');
    const expired = b + '.' + crypto.createHmac('sha256', process.env.SESSION_SECRET).update(b).digest('base64url');
    r = res(); await leadStatus(req('GET', null, { query: { t: expired } }), r); assert.strictEqual(r.code, 401);
    const forged = good.slice(0, -2) + 'xx';
    r = res(); await leadStatus(req('GET', null, { query: { t: forged } }), r); assert.strictEqual(r.code, 401);
  });

  console.log('api/apps (lead permissions)');
  await ok('client GET: only own leads, no config; owner GET: all leads plus config', async () => {
    let r = res(); await apps(req('GET', null, auth(clientTok)), r);
    assert.ok(r.body.leads.length > 0); assert.ok(r.body.leads.every((l) => l.to === 'lawn@client.test'));
    assert.strictEqual(r.body.config, undefined);
    assert.deepStrictEqual(Object.keys(r.body.visits), ['lawn@client.test'], 'client sees only own visits');
    assert.strictEqual(r.body.visits['lawn@client.test'].paid, 2);
    r = res(); await apps(req('GET', null, auth(ownerTok)), r);
    assert.strictEqual(typeof r.body.config.notify, 'boolean');
    assert.ok(r.body.visits['lawn@client.test'] && r.body.visits['other@client.test'], 'owner sees every client');
    assert.strictEqual(r.body.access['lawn@client.test'], false, 'no access code yet');
    const p = res(); await apps(req('POST', { action: 'provision', email: 'lawn@client.test', code: 'secret-code' }, auth(ownerTok)), p);
    assert.strictEqual(p.code, 200);
    r = res(); await apps(req('GET', null, auth(ownerTok)), r);
    assert.strictEqual(r.body.access['lawn@client.test'], true, 'access shows once provisioned');
    r = res(); await apps(req('GET', null, auth(clientTok)), r);
    assert.strictEqual(r.body.access, undefined, 'clients never see the access map');
    // Removing the engagement revokes the login and drops the visit counts.
    const before = JSON.parse(store.get('onboarding'));
    r = res(); await apps(req('POST', { action: 'onboarding-remove', email: 'lawn@client.test' }, auth(ownerTok)), r);
    assert.strictEqual(r.code, 200);
    assert.ok(!store.has('client:lawn@client.test'), 'access code deleted'); assert.ok(!store.has('visits:lawn@client.test'), 'visits deleted');
    assert.ok(leads().some((l) => l.to === 'lawn@client.test'), 'leads kept as the record');
    store.set('onboarding', JSON.stringify(before)); // restore for the tests below
  });
  await ok('client updates own outcome only; unsent fields and the click id survive', async () => {
    const before = leads().find((x) => x.id === tracked.id);
    const r = res();
    await apps(req('POST', { action: 'lead-update', lead: { id: tracked.id, booked: 'Yes', won: '', gclid: 'HACKED', name: 'Renamed', to: 'other@client.test' } }, auth(clientTok)), r);
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const after = leads().find((x) => x.id === tracked.id);
    assert.strictEqual(after.gclid, before.gclid); assert.strictEqual(after.name, before.name); assert.strictEqual(after.to, before.to);
    assert.strictEqual(after.booked, 'Yes'); assert.strictEqual(after.won, '');
    assert.strictEqual(after.preferred, before.preferred, 'unsent outcome/capture fields untouched');
    assert.strictEqual(after.contract, before.contract);
  });
  await ok('client cannot touch another client’s lead, remove leads, or write onboarding', async () => {
    let r = res(); await apps(req('POST', { action: 'lead-update', lead: { id: tracked.id, booked: 'Yes' } }, auth(otherTok)), r);
    assert.ok(r.code === 403 || r.code === 404, 'got ' + r.code);
    r = res(); await apps(req('POST', { action: 'lead-remove', id: tracked.id }, auth(clientTok)), r); assert.strictEqual(r.code, 403);
    r = res(); await apps(req('POST', { action: 'onboarding', record: { email: 'lawn@client.test' } }, auth(clientTok)), r); assert.strictEqual(r.code, 403);
    r = res(); await apps(req('POST', { action: 'lead-update', lead: { id: 'does-not-exist', booked: 'Yes' } }, auth(clientTok)), r); assert.strictEqual(r.code, 404);
  });
  await ok('client logs a call: forced to their business, source phone, click ids stripped', async () => {
    const r = res();
    await apps(req('POST', { action: 'lead-add', lead: { name: 'Caller', phone: '111', to: 'other@client.test', gclid: 'X', source: '' } }, auth(clientTok)), r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.lead.to, 'lawn@client.test'); assert.strictEqual(r.body.lead.source, 'phone'); assert.strictEqual(r.body.lead.gclid, '');
    assert.ok(leads().some((l) => l.name === 'Caller'));
  });
  await ok('owner partial update patches only what it sends', async () => {
    const before = leads().find((x) => x.id === tracked.id);
    const r = res();
    await apps(req('POST', { action: 'lead-update', lead: { id: tracked.id, to: before.to, contract: 'Weekly', perVisit: '45', visitsPerYear: '30', won: 'Yes' } }, auth(ownerTok)), r);
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const after = leads().find((x) => x.id === tracked.id);
    assert.strictEqual(after.contract, 'Weekly'); assert.strictEqual(after.won, 'Yes');
    assert.strictEqual(after.preferred, before.preferred); assert.strictEqual(after.utm.campaign, 'spring'); assert.strictEqual(after.gclid, before.gclid);
    assert.strictEqual(after.wonAt, before.wonAt, 'first-won time kept');
  });
  await ok('owner logs a lead with a source of their choosing', async () => {
    const r = res();
    await apps(req('POST', { action: 'lead-add', lead: { name: 'LSA lead', phone: '222', to: 'lawn@client.test', source: 'lsa' } }, auth(ownerTok)), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.lead.source, 'lsa'); assert.ok(r.body.lead.id);
  });

  console.log('\n' + pass + ' passed' + (process.exitCode ? ', with failures' : ''));
})();
