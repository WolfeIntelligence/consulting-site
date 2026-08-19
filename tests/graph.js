/* Tests for the workspace/ontology layer. Run: node tests/graph.js
 *
 * No network, no real storage. Each block states what it proves.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeKv } = require(path.join(__dirname, 'kvmock.js'));

process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.SESSION_SECRET = 'test-secret';
delete process.env.BLOB_READ_WRITE_TOKEN;   // the inline backend is what this build has

const mock = makeKv('kv.test');
global.fetch = mock.handle;

const kv = require(path.join(__dirname, '..', 'lib', 'kv.js'));
const T = require(path.join(__dirname, '..', 'lib', 'tenancy.js'));
const types = require(path.join(__dirname, '..', 'lib', 'types.js'));
const S = require(path.join(__dirname, '..', 'lib', 'schema.js'));
const O = require(path.join(__dirname, '..', 'lib', 'ontology.js'));
const A = require(path.join(__dirname, '..', 'lib', 'actions.js'));
const authority = require(path.join(__dirname, '..', 'lib', 'authority.js'));
const trail = require(path.join(__dirname, '..', 'lib', 'audit.js'));
const docs = require(path.join(__dirname, '..', 'lib', 'files.js'));
const templates = require(path.join(__dirname, '..', 'lib', 'templates.js'));
const graphApi = require(path.join(__dirname, '..', 'api', 'graph.js'));

let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ok  ' + name); },
  (e) => { console.log('FAIL  ' + name + '\n      ' + (e && e.message)); process.exitCode = 1; }
);

/* A refusal, asserted on rather than merely allowed to happen. Returns the
 * error so a caller can say more about it. */
async function refused(fn, code, messageIncludes) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a refusal, but the call succeeded');
  if (code) assert.strictEqual(err.code, code, 'refused with "' + err.code + '": ' + err.message);
  if (messageIncludes) {
    assert.ok(String(err.message).includes(messageIncludes), 'message was: ' + err.message);
  }
  return err;
}

/* A controllable clock. Stamps are the whole point of several tests below and
 * "did it move?" cannot be asked of a value the test did not choose. Only
 * `new Date()` with no arguments and `Date.now()` are affected, and only inside
 * an `at()` block. */
const RealDate = Date;
let clock = null;
class TestDate extends RealDate {
  constructor(...a) { if (!a.length && clock != null) super(clock); else super(...a); }
  static now() { return clock == null ? RealDate.now() : clock; }
}
global.Date = TestDate;
async function at(iso, fn) {
  const prev = clock;
  clock = RealDate.parse(iso);
  try { return await fn(); } finally { clock = prev; }
}

/* ------------------------------------------------------------------ fixtures */

/* One workspace shape used by the ontology, action, file and API sections. It
 * is deliberately its own schema rather than a template: these tests are about
 * what the engine does with a shape, not about which shapes ship. */
function testSchema() {
  return {
    types: {
      customer: {
        label: 'Customer',
        titleProp: 'name',
        properties: [
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'email', label: 'Email', type: 'email' },
          { key: 'tier', label: 'Tier', type: 'select', options: [{ value: 'gold', label: 'Gold' }, { value: 'basic', label: 'Basic' }] },
        ],
        rules: [{ id: 'must-be-filled', property: 'name', blocks: 'save' }],
      },
      job: {
        label: 'Job',
        titleProp: 'title',
        properties: [
          { key: 'title', label: 'Title', type: 'text', required: true },
          { key: 'value', label: 'Deal size', type: 'money' },
          { key: 'stage', label: 'Stage', type: 'select', options: [{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }] },
          { key: 'wonAt', label: 'Won at', type: 'datetime' },
          { key: 'note', label: 'Note', type: 'text' },
        ],
        links: [
          { key: 'customer', label: 'Customer', to: 'customer', cardinality: 'one', inverse: 'jobs' },
        ],
        actions: [
          { key: 'mark-won', label: 'Mark won', effect: 'mutate', risk: 'medium', sets: { stage: 'won' }, stamps: ['wonAt'], when: { stage: 'open' }, whenFails: 'Only an open job can be won.' },
          { key: 'approve', label: 'Approve', effect: 'mutate', risk: 'high', requiresOwner: true, sets: { stage: 'won' } },
          { key: 'touch', label: 'Touch', effect: 'mutate', risk: 'low', stamps: ['wonAt'], inputs: [{ key: 'note', label: 'Note' }] },
          { key: 'log-note', label: 'Log a note', effect: 'mutate', risk: 'low', inputs: [{ key: 'note', label: 'Note', required: true }] },
        ],
        rules: [{ id: 'number-at-most', property: 'value', threshold: 10000, blocks: 'save' }],
      },
      /* The shape lib/files.js actually writes. */
      document: {
        label: 'Document',
        titleProp: 'name',
        properties: [
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'contentType', label: 'Kind', type: 'text' },
          { key: 'size', label: 'Size', type: 'number' },
          { key: 'backend', label: 'Stored in', type: 'text' },
          { key: 'checksum', label: 'Checksum', type: 'text' },
          { key: 'uploadedAt', label: 'Uploaded at', type: 'datetime' },
          { key: 'uploadedBy', label: 'Uploaded by', type: 'email' },
          { key: 'note', label: 'Note', type: 'textarea' },
        ],
      },
    },
  };
}

const operator = { email: 'owner@wolfe.test', role: 'owner', wsRole: 'operator' };
const staff = { email: 'staff@client.test', role: 'client', wsRole: 'member' };
const onlooker = { email: 'eyes@client.test', role: 'client', wsRole: 'viewer' };

/* --------------------------------------------------------------- API plumbing */

function res() {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
let ipN = 0;
function apiReq(body, token) {
  const headers = { 'x-forwarded-for': '10.7.' + Math.floor(ipN / 250) + '.' + (++ipN % 250) };
  if (token) headers.authorization = 'Bearer ' + token;
  return { method: 'POST', body, query: {}, headers, socket: {} };
}
function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', process.env.SESSION_SECRET).update(b).digest('base64url');
}
async function call(body, token) {
  const r = res();
  await graphApi(apiReq(body, token), r);
  return r;
}

(async () => {
  console.log('\nlib/kv.js — values travel in the body, not the URL');
  await ok('a value larger than any sane URL round-trips', async () => {
    const big = 'x'.repeat(200000);
    await kv.setJson('big', { big });
    const back = await kv.getJson('big');
    assert.strictEqual(back.big.length, 200000);
  });
  await ok('a value with slashes and unicode round-trips unmangled', async () => {
    const v = { note: 'a/b/c ünïcode "quoted" \ back', n: 3 };
    await kv.setJson('odd', v);
    assert.deepStrictEqual(await kv.getJson('odd'), v);
  });
  await ok('getJson returns the fallback for a missing or corrupt key', async () => {
    assert.deepStrictEqual(await kv.getJson('nope', []), []);
    await kv.cmd('SET', 'corrupt', '{not json');
    assert.deepStrictEqual(await kv.getJson('corrupt', { safe: true }), { safe: true });
  });
  await ok('a pipeline runs every command in order, in one round trip', async () => {
    let calls = 0;
    const inner = mock.handle;
    global.fetch = async (u, o) => { calls++; return inner(u, o); };
    const out = await kv.pipe([['SET', 'p1', 'a'], ['SET', 'p2', 'b'], ['MGET', 'p1', 'p2']]);
    global.fetch = inner;
    assert.strictEqual(calls, 1, 'expected exactly one HTTP call, saw ' + calls);
    assert.deepStrictEqual(out[2], ['a', 'b']);
  });
  await ok('mgetJson parses a whole set of records at once', async () => {
    await kv.pipe([['SET', 'r:1', '{"n":1}'], ['SET', 'r:2', '{"n":2}']]);
    assert.deepStrictEqual(await kv.mgetJson(['r:1', 'r:2', 'r:missing']), [{ n: 1 }, { n: 2 }, null]);
  });
  await ok('push keeps newest first and caps the list', async () => {
    for (let i = 1; i <= 5; i++) await kv.push('log', { i }, 3);
    const got = await kv.range('log', 0, -1);
    assert.deepStrictEqual(got.map((x) => x.i), [5, 4, 3], 'newest first, capped at 3');
  });

  console.log('\nlib/tenancy.js — one workspace per client, isolated by key layout');
  const owner = { email: 'owner@wolfe.test', role: 'owner' };
  const clientA = { email: 'lawn@client.test', role: 'client' };
  const clientB = { email: 'other@client.test', role: 'client' };
  let wsA, wsB;

  await ok('creating a workspace gives it a readable id and indexes it', async () => {
    wsA = await T.create({ name: 'Green Lawn & Landscape, LLC', kind: 'local-service', by: owner.email });
    assert.ok(/^ws_green_lawn_landscape_llc_[0-9a-f]{6}$/.test(wsA.id), 'unexpected id: ' + wsA.id);
    assert.strictEqual((await T.get(wsA.id)).name, 'Green Lawn & Landscape, LLC');
  });
  await ok('two workspaces with the same name do not collide', async () => {
    const dup = await T.create({ name: 'Green Lawn & Landscape, LLC', by: owner.email });
    assert.notStrictEqual(dup.id, wsA.id);
    assert.strictEqual((await T.list()).length, 2);
    await kv.cmd('SREM', 'ws:index', dup.id);
  });
  await ok('a client sees only workspaces they were added to', async () => {
    wsB = await T.create({ name: 'Second Client', by: owner.email });
    await T.addMember(wsA.id, clientA.email, 'admin', owner.email);
    const seenA = await T.visibleTo(clientA);
    assert.deepStrictEqual(seenA.map((w) => w.id), [wsA.id]);
    assert.deepStrictEqual(await T.visibleTo(clientB), [], 'a stranger sees nothing');
  });
  await ok('the operator sees every workspace', async () => {
    const seen = await T.visibleTo(owner);
    assert.ok(seen.length >= 2 && seen.some((w) => w.id === wsB.id));
  });
  await ok('roleIn returns the membership role, or null for no access', async () => {
    assert.strictEqual(await T.roleIn(clientA, wsA.id), 'admin');
    assert.strictEqual(await T.roleIn(clientA, wsB.id), null, 'no membership means no role');
    assert.strictEqual(await T.roleIn(owner, wsB.id), 'operator');
  });
  await ok('removing a member revokes access from both directions', async () => {
    await T.addMember(wsA.id, clientB.email, 'viewer', owner.email);
    assert.strictEqual(await T.roleIn(clientB, wsA.id), 'viewer');
    await T.removeMember(wsA.id, clientB.email);
    assert.strictEqual(await T.roleIn(clientB, wsA.id), null);
    assert.deepStrictEqual(await T.visibleTo(clientB), []);
    assert.ok(!(await T.members(wsA.id)).some((m) => m.email === clientB.email));
  });
  await ok('a viewer may read and nothing else', async () => {
    for (const c of ['object.read', 'file.read', 'schema.read', 'member.read']) {
      assert.strictEqual(authority.resolve('viewer', c).state, authority.ALLOWED, 'viewer must ' + c);
    }
    for (const c of ['object.write', 'object.create', 'object.archive', 'action.run', 'file.upload', 'schema.write', 'member.grant']) {
      assert.strictEqual(authority.resolve('viewer', c).state, authority.FORBIDDEN, 'viewer must not ' + c);
    }
  });
  await ok('only the operator may change the schema; an admin may ask', async () => {
    assert.strictEqual(authority.resolve('operator', 'schema.write').state, authority.ALLOWED);
    // Approval-required is its own answer: the admin is told to ask, not told no,
    // and neither of those is "allowed".
    assert.strictEqual(authority.resolve('admin', 'schema.write').state, authority.APPROVAL);
    for (const r of ['admin', 'member', 'viewer']) {
      assert.notStrictEqual(authority.resolve(r, 'schema.write').state, authority.ALLOWED, r + ' must not change the schema');
    }
  });
  await ok('an unknown role has no capabilities at all', async () => {
    for (const c of ['object.read', 'object.write', 'action.run']) {
      assert.strictEqual(authority.resolve(null, c).state, authority.FORBIDDEN);
      assert.strictEqual(authority.resolve('made-up', c).state, authority.FORBIDDEN);
    }
  });

  console.log('\nlib/types.js — one place decides what a value means');
  await ok('each type coerces its raw input into what it stores', async () => {
    const c = (type, raw, opts) => types.coerce(Object.assign({ key: 'k', label: 'K', type }, opts || {}), raw);
    assert.strictEqual(c('money', '$1,250.50'), 1250.5, 'money reads a typed-in price');
    assert.strictEqual(c('money', 1250.5), 1250.5);
    assert.strictEqual(c('number', '1,024 units'), 1024);
    assert.strictEqual(c('percent', '12.5%'), 12.5);
    assert.strictEqual(c('number', ''), null, 'an empty number is absent, not zero');
    assert.strictEqual(c('number', 'nonsense'), null);
    assert.strictEqual(c('email', '  Zach@Example.COM '), 'zach@example.com');
    assert.strictEqual(c('date', '2026-03-04T11:00:00.000Z'), '2026-03-04');
    assert.strictEqual(c('datetime', '2026-03-04T05:06:07Z'), '2026-03-04T05:06:07.000Z');
    assert.strictEqual(c('date', 'not a date'), null);
    assert.deepStrictEqual(c('multiselect', 'a, b ,,c'), ['a', 'b', 'c'], 'a comma list becomes an array');
    assert.deepStrictEqual(c('refs', null), [], 'an absent array type is empty, not null');
    assert.strictEqual(c('text', 'x'.repeat(600)).length, 500, 'text is capped');
    assert.strictEqual(c('textarea', 'x'.repeat(9000)).length, 8000);
    assert.strictEqual(c('bool', 'yes'), true);
    assert.strictEqual(c('bool', 'no'), false);
    assert.strictEqual(c('bool', 'on'), true);
  });
  await ok('false is an answer, not a blank', async () => {
    const p = { key: 'done', label: 'Done', type: 'bool', required: true };
    assert.strictEqual(types.coerce(p, false), false);
    assert.strictEqual(types.isEmpty(p, false), false, 'false must not read as empty');
    assert.strictEqual(types.validate(p, false), '', 'a required bool answered No is answered');
    assert.strictEqual(types.format(p, false), 'No');
    // The contrast: a text field with nothing in it really is blank.
    assert.strictEqual(types.isEmpty({ key: 't', label: 'T', type: 'text' }, ''), true);
    assert.strictEqual(types.validate({ key: 't', label: 'T', type: 'text', required: true }, ''), 'T is required');
  });
  await ok('a select refuses a value that is not one of its choices', async () => {
    const p = types.property(['tier', 'Tier', 'select:gold=Gold|basic=Basic', 'pick one']);
    assert.strictEqual(types.validate(p, 'gold'), '');
    assert.strictEqual(types.validate(p, 'platinum'), 'Not one of the choices for Tier');
    assert.strictEqual(types.validate(p, ''), '', 'unanswered is not the same as wrong');
    const m = types.property({ key: 'tags', label: 'Tags', type: 'multiselect', options: [{ value: 'a', label: 'A' }] });
    assert.strictEqual(types.validate(m, ['a']), '');
    assert.strictEqual(types.validate(m, ['a', 'z']), 'Not one of the choices for Tags');
  });
  await ok("the console's inline 'select:a=A|b=B' string parses into real options", async () => {
    const p = types.property(['tier', 'Tier', 'select:a=A|b=B', 'hint here']);
    assert.strictEqual(p.key, 'tier');
    assert.strictEqual(p.label, 'Tier');
    assert.strictEqual(p.type, 'select');
    assert.strictEqual(p.hint, 'hint here');
    assert.deepStrictEqual(p.options, [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]);
    assert.strictEqual(types.format(p, 'b'), 'B', 'the label is what a person reads');
    // The form os.js actually writes: a leading choice with an empty value is
    // the "not answered yet" option, and it survives parsing.
    const real = types.property(['verified', 'Profile verified', 'select:=—|yes=Verified|no=Not yet', '']);
    assert.deepStrictEqual(real.options[0], { value: '', label: '—' });
    assert.strictEqual(real.options.length, 3);
    // The object form accepts the same inline string.
    assert.strictEqual(types.property({ key: 'r', label: 'R', type: 'select:x=X' }).options[0].value, 'x');
  });
  await ok('an unrecognised type reads as text rather than as nothing', async () => {
    assert.strictEqual(types.property(['k', 'K', 'wobble']).type, 'text');
    assert.strictEqual(types.property({ key: 'k', label: 'K', type: 'wobble' }).type, 'text');
    assert.strictEqual(types.isType('money'), true);
    assert.strictEqual(types.isType('wobble'), false);
  });

  console.log('\nlib/schema.js — a closed metamodel that reports rather than throws');
  const codesFor = (mutate) => {
    const s = testSchema();
    mutate(s);
    return S.validateSchema(s).map((v) => v.code);
  };
  await ok('a valid schema has no violations at all', async () => {
    assert.deepStrictEqual(S.validateSchema(testSchema()), []);
    assert.deepStrictEqual(S.validateSchema({ types: {} }).map((v) => v.code), ['no-types']);
  });
  await ok('a structural defect names itself: duplicate property, dangling link, missing inverse', async () => {
    assert.deepStrictEqual(
      codesFor((s) => s.types.job.properties.push({ key: 'title', label: 'Title again', type: 'text' })),
      ['property-duplicate']
    );
    assert.deepStrictEqual(codesFor((s) => { s.types.job.links[0].to = 'ghost'; }), ['link-dangling']);
    assert.deepStrictEqual(codesFor((s) => { delete s.types.job.links[0].inverse; }), ['link-no-inverse']);
    assert.deepStrictEqual(codesFor((s) => { s.types.job.links[0].cardinality = 'some'; }), ['link-cardinality']);
  });
  await ok('a rule defect names itself: unknown, wrong kind, missing or spare threshold, self-comparison', async () => {
    assert.deepStrictEqual(
      codesFor((s) => s.types.job.rules.push({ id: 'must-be-purple', property: 'title' })),
      ['rule-unknown'], 'the registry is closed: an invented rule is reported, not stored quietly'
    );
    assert.deepStrictEqual(
      codesFor((s) => s.types.job.rules.push({ id: 'number-at-least', property: 'title', threshold: 5 })),
      ['rule-wrong-kind'], 'a number rule cannot judge a text property'
    );
    assert.deepStrictEqual(
      codesFor((s) => s.types.job.rules.push({ id: 'number-at-least', property: 'value' })),
      ['rule-no-threshold']
    );
    assert.deepStrictEqual(
      codesFor((s) => s.types.job.rules.push({ id: 'must-be-filled', property: 'title', threshold: 3 })),
      ['rule-extra-threshold'], 'a number handed to a rule that ignores it is a mistake worth saying'
    );
    assert.deepStrictEqual(
      codesFor((s) => s.types.job.rules.push({ id: 'number-below-field', property: 'value', otherProperty: 'value' })),
      ['rule-self-compare']
    );
    assert.deepStrictEqual(
      codesFor((s) => s.types.job.rules.push({ id: 'number-below-field', property: 'value', otherProperty: 'gone' })),
      ['rule-no-other']
    );
    assert.deepStrictEqual(
      codesFor((s) => s.types.job.rules.push({ id: 'rule-that-does-not-exist', property: 'title' })).length, 1
    );
  });
  await ok('an unreadable stored rule refuses the write rather than passing it', async () => {
    // A check compiled by a later build and read by this one. Passing it would
    // silently drop a rule the client believes is protecting them.
    const orphan = [{ id: 'from-the-future:x', ruleId: 'not-in-this-build', property: 'x', propertyLabel: 'X', requirement: 'X must be blessed.', blocks: 'save' }];
    const r = S.firstRefusal(orphan, { x: 1 }, {});
    assert.ok(r, 'an unreadable check must not pass');
    assert.ok(r.message.includes('cannot read'), r && r.message);
  });
  await ok('compileChecks freezes the property label into the requirement text', async () => {
    const s = {
      types: {
        deal: {
          label: 'Deal',
          properties: [{ key: 'size', label: 'Deal size', type: 'money' }],
          rules: [{ id: 'must-be-filled', property: 'size', blocks: 'save' }],
        },
      },
    };
    const compiled = S.compileChecks(s);
    assert.strictEqual(compiled.deal[0].requirement, 'Deal size must be filled in.');

    // Rename the property today. Yesterday's compiled check must still say what
    // it said yesterday.
    s.types.deal.properties[0].label = 'Contract value';
    assert.strictEqual(compiled.deal[0].propertyLabel, 'Deal size');
    const byKey = { size: types.property(s.types.deal.properties[0]) };
    assert.strictEqual(S.firstRefusal(compiled.deal, {}, byKey).message, 'Deal size must be filled in.');
    // Recompiling is how the new wording gets in — never by the rename alone.
    assert.strictEqual(S.compileChecks(s).deal[0].requirement, 'Contract value must be filled in.');
  });
  await ok('a rule that cannot be compiled is left out rather than half-built', async () => {
    const s = testSchema();
    s.types.job.rules.push({ id: 'number-at-least', property: 'value' });   // no threshold
    s.types.job.rules.push({ id: 'must-be-purple', property: 'title' });    // unknown rule
    const compiled = S.compileChecks(s);
    assert.strictEqual(compiled.job.length, 1, 'only the one good rule compiles');
    assert.strictEqual(compiled.job[0].ruleId, 'number-at-most');
    assert.deepStrictEqual(Object.keys(compiled).sort(), ['customer', 'document', 'job']);
  });
  await ok('revisionOf is stable across key order and moves when the shape moves', async () => {
    const a = { types: { t: { label: 'T', titleProp: 'k', properties: [{ key: 'k', label: 'K', type: 'text' }] } } };
    const b = { types: { t: { properties: [{ type: 'text', label: 'K', key: 'k' }], titleProp: 'k', label: 'T' } } };
    assert.strictEqual(S.revisionOf(a), S.revisionOf(b), 'same shape, different key order, same revision');
    const c = JSON.parse(JSON.stringify(a));
    c.types.t.properties[0].label = 'K2';
    assert.notStrictEqual(S.revisionOf(a), S.revisionOf(c), 'a changed label is a changed schema');
    const d = JSON.parse(JSON.stringify(a));
    d.types.t2 = { label: 'T2', properties: [] };
    assert.notStrictEqual(S.revisionOf(a), S.revisionOf(d));
  });
  await ok('describe() reports the metamodel as data, not as prose', async () => {
    const d = S.describe();
    assert.deepStrictEqual(d.cardinalities, S.CARDINALITIES);
    assert.deepStrictEqual(d.rules.map((r) => r.id).sort(), S.RULE_IDS.slice().sort());
    assert.ok(d.propertyTypes.includes('money') && d.propertyTypes.includes('refs'));
    const atLeast = d.rules.find((r) => r.id === 'number-at-least');
    assert.strictEqual(atLeast.needsThreshold, true);
    assert.deepStrictEqual(atLeast.appliesTo, ['number', 'money', 'percent']);
  });

  console.log('\nlib/authority.js — four states, and the fourth is the point');
  await ok('all four states are reachable and distinct', async () => {
    assert.strictEqual(authority.resolve('operator', 'object.write').state, authority.ALLOWED);
    assert.strictEqual(authority.resolve('admin', 'member.grant').state, authority.APPROVAL);
    assert.strictEqual(authority.resolve('viewer', 'action.run').state, authority.FORBIDDEN);
    assert.strictEqual(authority.resolve('viewer', 'workspace.create').state, authority.UNCLASSIFIED);
    assert.strictEqual(new Set([authority.ALLOWED, authority.APPROVAL, authority.FORBIDDEN, authority.UNCLASSIFIED]).size, 4);
    // Only ALLOWED is silent; every other state owes the person a sentence.
    assert.strictEqual(authority.resolve('operator', 'object.write').reason, '');
    for (const [role, cap] of [['admin', 'member.grant'], ['viewer', 'action.run'], ['viewer', 'workspace.create']]) {
      assert.ok(authority.resolve(role, cap).reason.length > 10, role + '/' + cap + ' gave no reason');
    }
  });
  await ok('a capability nobody classified escalates and is never allowed', async () => {
    for (const role of Object.keys(authority.POLICY)) {
      const d = authority.resolve(role, 'invoice.send');
      assert.strictEqual(d.state, authority.UNCLASSIFIED, role + ' got ' + d.state);
      assert.notStrictEqual(d.state, authority.ALLOWED);
      assert.ok(d.reason.includes('invoice.send') && d.reason.includes(role));
    }
    assert.strictEqual(authority.isAllowed('operator', 'invoice.send'), false, 'unclassified collapses to "not now"');
  });
  await ok('a null or unknown role is forbidden, and the listed effects are forbidden to everyone', async () => {
    for (const role of [null, undefined, '', 'superuser', 'operator ']) {
      const d = authority.resolve(role, 'object.read');
      assert.strictEqual(d.state, authority.FORBIDDEN, String(role) + ' got ' + d.state);
      assert.strictEqual(d.reason, 'No access to this workspace.');
    }
    for (const cap of authority.FORBIDDEN_EFFECTS) {
      for (const role of Object.keys(authority.POLICY)) {
        assert.strictEqual(authority.resolve(role, cap).state, authority.FORBIDDEN, role + ' reached ' + cap);
      }
    }
  });
  await ok('every capability in the table resolves for every role without throwing', async () => {
    const states = [authority.ALLOWED, authority.APPROVAL, authority.FORBIDDEN, authority.UNCLASSIFIED];
    assert.ok(authority.CAPABILITIES.length >= 15, 'expected a real table, saw ' + authority.CAPABILITIES.length);
    for (const role of Object.keys(authority.POLICY)) {
      for (const cap of authority.CAPABILITIES) {
        const d = authority.resolve(role, cap);
        assert.ok(states.includes(d.state), role + '/' + cap + ' -> ' + d.state);
        assert.strictEqual(typeof d.reason, 'string');
      }
    }
    // And no role reaches a write capability it was never granted.
    assert.strictEqual(authority.isAllowed('viewer', 'object.write'), false);
    assert.strictEqual(authority.isAllowed('member', 'schema.write'), false);
  });

  console.log('\nlib/audit.js — append-only by construction, not by convention');
  const probe = 'ws_audit_probe';
  await ok('entries come back oldest-first', async () => {
    for (const n of ['first', 'second', 'third']) {
      await trail.append(probe, { event: 'object.created', actor: 'operator', by: 'owner@wolfe.test', role: 'operator', outcome: 'ok', label: n });
    }
    const rows = await trail.list(probe, { limit: 50 });
    assert.deepStrictEqual(rows.map((r) => r.label), ['first', 'second', 'third'], 'a trail read backwards is not a trail');
  });
  await ok('the module exports no way to change or remove an entry', async () => {
    const exported = Object.keys(trail).sort();
    assert.deepStrictEqual(exported, ['ACTORS', 'EVENTS', 'OUTCOMES', 'append', 'changes', 'list']);
    for (const k of exported) {
      assert.ok(!/update|delete|remove|edit|rewrite|clear|set/i.test(k), 'audit exports a mutator: ' + k);
    }
  });
  await ok('a per-object trail contains only that object entries', async () => {
    await trail.append(probe, { event: 'object.updated', actor: 'client', by: 'a@b.test', role: 'admin', outcome: 'ok', objectId: 'obj_one', label: 'one A' });
    await trail.append(probe, { event: 'object.updated', actor: 'client', by: 'a@b.test', role: 'admin', outcome: 'ok', objectId: 'obj_two', label: 'two A' });
    await trail.append(probe, { event: 'object.updated', actor: 'client', by: 'a@b.test', role: 'admin', outcome: 'ok', objectId: 'obj_one', label: 'one B' });
    const one = await trail.list(probe, { objectId: 'obj_one', limit: 50 });
    assert.deepStrictEqual(one.map((r) => r.label), ['one A', 'one B']);
    assert.ok(one.every((r) => r.objectId === 'obj_one'));
    assert.deepStrictEqual((await trail.list(probe, { objectId: 'obj_two', limit: 50 })).map((r) => r.label), ['two A']);
    // The workspace trail still has everything.
    assert.strictEqual((await trail.list(probe, { limit: 50 })).length, 6);
  });
  await ok('an unlisted event or outcome is normalised rather than stored as typed', async () => {
    await trail.append(probe, { event: 'something.invented', actor: 'hacker', outcome: 'maybe', by: 'X@Y.TEST', objectId: 'obj_norm' });
    const [row] = await trail.list(probe, { objectId: 'obj_norm', limit: 5 });
    assert.strictEqual(row.event, 'action.run', 'a free-text event would make the trail uncountable');
    assert.strictEqual(row.actor, 'system');
    assert.strictEqual(row.outcome, 'ok');
    assert.strictEqual(row.by, 'x@y.test');
    assert.ok(row.receipt.startsWith('r_'));
  });
  await ok('changes() reports the fields that moved, and only those', async () => {
    assert.deepStrictEqual(trail.changes({ a: 1, b: 2 }, { a: 1, b: 3 }), [{ field: 'b', from: 2, to: 3 }]);
    assert.deepStrictEqual(trail.changes({}, { a: 'new' }), [{ field: 'a', from: null, to: 'new' }]);
    assert.deepStrictEqual(trail.changes({ a: [1, 2] }, { a: [1, 2] }), [], 'a re-save of the same value is not a change');
  });

  console.log('\nlib/ontology.js — records, links, history and referential integrity');
  const wsG = (await T.create({ name: 'Ontology Fixture', by: operator.email })).id;
  let cust1, cust2, job1;

  await ok('a schema saves, compiles its checks, and comes back with a revision', async () => {
    const saved = await O.saveSchema(wsG, testSchema(), operator);
    assert.strictEqual(saved.revision, S.revisionOf(testSchema()));
    assert.strictEqual(saved.version, S.SCHEMA_VERSION);
    const checks = await O.getChecks(wsG);
    assert.strictEqual(checks.job[0].requirement, 'Deal size must be at most 10000.');
    assert.strictEqual(checks.customer[0].requirement, 'Name must be filled in.');
  });
  await ok('an invalid schema is refused and the stored one is untouched', async () => {
    const before = await O.getSchema(wsG);
    const broken = testSchema();
    broken.types.job.links[0].to = 'ghost';
    await refused(() => O.saveSchema(wsG, broken, operator), 'schema-invalid', 'which is not a type here');
    assert.deepStrictEqual(await O.getSchema(wsG), before);
  });
  await ok('create then read returns the record with its type, revision and author', async () => {
    const made = await O.create(wsG, operator, 'customer', { name: 'Acme', tier: 'basic' });
    cust1 = made.object.id;
    assert.ok(made.receipt.startsWith('r_'));
    const got = await O.get(wsG, cust1);
    assert.strictEqual(got.type, 'customer');
    assert.strictEqual(got.props.name, 'Acme');
    assert.strictEqual(got.props.tier, 'basic');
    assert.strictEqual(got.rev, 1);
    assert.strictEqual(got.by, operator.email);
    assert.strictEqual(got.archived, false);
    assert.ok((await O.listByType(wsG, 'customer')).some((r) => r.id === cust1));
  });
  await ok('an unknown property is refused and nothing is written', async () => {
    const before = await O.get(wsG, cust1);
    await refused(() => O.update(wsG, operator, cust1, { favouriteColour: 'blue' }), 'unknown-property', 'does not have a "favouriteColour" field');
    assert.deepStrictEqual(await O.get(wsG, cust1), before, 'the record moved');
    await refused(() => O.create(wsG, operator, 'customer', { name: 'X', nope: 1 }), 'unknown-property');
    await refused(() => O.create(wsG, operator, 'ghost', { name: 'X' }), 'unknown-type');
  });
  await ok('a value the type rejects is refused: the wrong choice, the missing required field', async () => {
    await refused(() => O.create(wsG, operator, 'customer', { name: 'Bad', tier: 'platinum' }), 'invalid-value', 'Not one of the choices for Tier');
    await refused(() => O.create(wsG, operator, 'job', { value: 10 }), 'invalid-value', 'Title is required');
  });
  await ok('a rule refusal blocks the write and changes nothing at all', async () => {
    const made = await O.create(wsG, operator, 'job', { title: 'Deck rebuild', value: 500, stage: 'open' });
    job1 = made.object.id;
    const before = await O.get(wsG, job1);
    const historyBefore = await O.history(wsG, job1, 50);

    await refused(() => O.update(wsG, operator, job1, { value: 50000 }), 'check-refused', 'Deal size must be at most 10000.');

    const after = await O.get(wsG, job1);
    assert.deepStrictEqual(after, before, 'the refused write left a mark');
    assert.strictEqual(after.props.value, 500);
    assert.strictEqual(after.rev, 1, 'a refusal must not burn a revision');
    assert.deepStrictEqual(await O.history(wsG, job1, 50), historyBefore, 'a refusal must not write history');
    // And the same refusal on create: no record appears.
    const count = (await O.listByType(wsG, 'job')).length;
    await refused(() => O.create(wsG, operator, 'job', { title: 'Too big', value: 99999, stage: 'open' }), 'check-refused');
    assert.strictEqual((await O.listByType(wsG, 'job')).length, count, 'a refused create still created something');
  });
  await ok('a rule that only warns does not block the save', async () => {
    const s = testSchema();
    s.types.job.rules[0].blocks = 'warn';
    const wsWarn = (await T.create({ name: 'Warn Fixture', by: operator.email })).id;
    await O.saveSchema(wsWarn, s, operator);
    const made = await O.create(wsWarn, operator, 'job', { title: 'Huge', value: 99999, stage: 'open' });
    assert.strictEqual(made.object.props.value, 99999, 'a warning is not a refusal');
  });
  await ok('a stale expectedRev is refused', async () => {
    const before = await O.get(wsG, cust1);
    await O.update(wsG, operator, cust1, { name: 'Acme Holdings' }, { expectedRev: before.rev });
    await refused(() => O.update(wsG, operator, cust1, { name: 'Someone else' }, { expectedRev: before.rev }),
      'stale', 'Someone else changed this record');
    assert.strictEqual((await O.get(wsG, cust1)).props.name, 'Acme Holdings', 'the first writer won and stayed won');
  });
  await ok('history records the actual before and after, per field', async () => {
    const made = await O.create(wsG, operator, 'customer', { name: 'Historic', tier: 'basic' });
    const id = made.object.id;
    await O.update(wsG, operator, id, { name: 'Historic Ltd' });
    await O.update(wsG, operator, id, { email: 'books@historic.test' });

    const h = await O.history(wsG, id, 50);
    assert.strictEqual(h.length, 3);
    assert.strictEqual(h[2].event, 'created');
    assert.deepStrictEqual(h[2].changes, []);
    assert.strictEqual(h[1].rev, 2);
    assert.deepStrictEqual(h[1].changes, [{ field: 'name', from: 'Historic', to: 'Historic Ltd' }]);
    assert.strictEqual(h[0].rev, 3);
    assert.deepStrictEqual(h[0].changes, [{ field: 'email', from: null, to: 'books@historic.test' }],
      'a field that was never set reads as null, not as missing');
    assert.strictEqual(h[0].by, operator.email);
    // A save that changes nothing is not history.
    const again = await O.update(wsG, operator, id, { name: 'Historic Ltd' });
    assert.strictEqual(again.unchanged, true);
    assert.strictEqual((await O.history(wsG, id, 50)).length, 3);
  });
  await ok('a typed link refuses a target of the wrong type', async () => {
    cust2 = (await O.create(wsG, operator, 'customer', { name: 'Second Customer' })).object.id;
    const otherJob = (await O.create(wsG, operator, 'job', { title: 'Other', value: 10, stage: 'open' })).object.id;
    await refused(() => O.link(wsG, operator, job1, 'customer', otherJob), 'wrong-target', 'must point at a customer, not a job');
    await refused(() => O.link(wsG, operator, job1, 'nonsense', cust1), 'unknown-link', 'There is no "nonsense" link');
    await refused(() => O.link(wsG, operator, job1, 'customer', 'obj_missing'), 'not-found');
    assert.deepStrictEqual(await O.linked(wsG, job1, 'customer'), [], 'nothing was linked by a refused link');
  });
  await ok('a one link replaces rather than accumulates, and the old backlink goes with it', async () => {
    await O.link(wsG, operator, job1, 'customer', cust1);
    assert.deepStrictEqual((await O.linked(wsG, job1, 'customer')).map((r) => r.id), [cust1]);
    assert.deepStrictEqual((await O.backlinks(wsG, cust1)).map((b) => b.object.id + '|' + b.via), [job1 + '|customer']);

    await O.link(wsG, operator, job1, 'customer', cust2);
    assert.deepStrictEqual((await O.linked(wsG, job1, 'customer')).map((r) => r.id), [cust2], 'one means one');
    assert.deepStrictEqual(await O.backlinks(wsG, cust1), [], 'the old backlink became a phantom');
    assert.deepStrictEqual((await O.backlinks(wsG, cust2)).map((b) => b.object.id), [job1]);
  });
  await ok('archive is refused while something links to the record, and says what', async () => {
    const jobTitle = (await O.get(wsG, job1)).props.title;
    const before = await O.get(wsG, cust2);
    const err = await refused(() => O.archive(wsG, operator, cust2), 'still-linked', 'Still linked from');
    assert.ok(err.message.includes(jobTitle), 'the refusal did not name the holder: ' + err.message);
    assert.ok(err.message.includes('(customer)'), 'the refusal did not name the link: ' + err.message);
    assert.deepStrictEqual(await O.get(wsG, cust2), before, 'a refused archive changed the record');

    await O.unlink(wsG, operator, job1, 'customer', cust2);
    const done = await O.archive(wsG, operator, cust2);
    assert.strictEqual(done.object.archived, true);
  });
  await ok('an archived record is hidden from listByType but still readable by id', async () => {
    const ids = (await O.listByType(wsG, 'customer')).map((r) => r.id);
    assert.ok(!ids.includes(cust2), 'an archived record is still listed');
    assert.ok(ids.includes(cust1), 'a live record went missing');
    const withArchived = (await O.listByType(wsG, 'customer', { includeArchived: true })).map((r) => r.id);
    assert.ok(withArchived.includes(cust2));
    const still = await O.get(wsG, cust2);
    assert.strictEqual(still.props.name, 'Second Customer', 'nothing here destroys a record');
    await refused(() => O.update(wsG, operator, cust2, { name: 'Changed' }), 'archived', 'Restore it before changing it');
    // counts() reads the type index, which keeps archived ids.
    const c = await O.counts(wsG, ['customer', 'job']);
    assert.ok(c.customer >= 3 && c.job >= 2);
  });

  console.log('\nlib/actions.js — governed write-back, stamped once');
  let job2;
  await ok('an action runs and stamps the moment it happened', async () => {
    const made = await O.create(wsG, operator, 'job', { title: 'Fence repair', value: 900, stage: 'open' });
    const id = made.object.id;
    const out = await at('2026-03-01T09:00:00.000Z', () => A.run(wsG, operator, id, 'mark-won', {}));
    assert.strictEqual(out.replayed, false);
    assert.strictEqual(out.result.action, 'mark-won');
    const stored = await O.get(wsG, id);
    assert.strictEqual(stored.props.stage, 'won', 'the action did not set what it declared');
    assert.strictEqual(stored.props.wonAt, '2026-03-01T09:00:00.000Z');
    assert.strictEqual(stored.rev, 2);
    const entries = await trail.list(wsG, { objectId: id, limit: 50 });
    assert.ok(entries.some((e) => e.event === 'action.run' && e.label === 'Mark won' && e.outcome === 'ok'));
  });
  await ok('a stamp already set is not moved by a second run', async () => {
    job2 = (await O.create(wsG, operator, 'job', { title: 'Gutter clean', value: 200, stage: 'open' })).object.id;
    await at('2026-03-02T10:00:00.000Z', () => A.run(wsG, operator, job2, 'touch', {}));
    const first = await O.get(wsG, job2);
    assert.strictEqual(first.props.wonAt, '2026-03-02T10:00:00.000Z');
    assert.strictEqual(first.rev, 2);

    await at('2026-06-30T23:59:00.000Z', () => A.run(wsG, operator, job2, 'touch', {}));
    const second = await O.get(wsG, job2);
    assert.strictEqual(second.props.wonAt, '2026-03-02T10:00:00.000Z', 'the funnel measures when it FIRST happened');
    assert.strictEqual(second.rev, 2, 'a run that changes nothing must not burn a revision');
  });
  await ok('a precondition that does not match refuses, in the wording the action chose', async () => {
    const wonJob = (await O.create(wsG, operator, 'job', { title: 'Already won', value: 10, stage: 'won' })).object.id;
    const snapshot = await O.get(wsG, wonJob);
    await refused(() => A.run(wsG, operator, wonJob, 'mark-won', {}), 'precondition', 'Only an open job can be won.');
    assert.deepStrictEqual(await O.get(wsG, wonJob), snapshot, 'a refused action half-applied');
    // preconditionFailure is the same answer the screen asks for before drawing.
    const s = await O.getSchema(wsG);
    const avail = A.availableFor(s.types.job, snapshot, 'operator');
    const markWon = avail.find((a) => a.key === 'mark-won');
    assert.strictEqual(markWon.state, 'unavailable');
    assert.strictEqual(markWon.reason, 'Only an open job can be won.');
  });
  await ok('requiresOwner refuses a client and records the refusal in the trail', async () => {
    const before = await O.get(wsG, job2);
    const err = await refused(() => A.run(wsG, staff, job2, 'approve', {}), authority.APPROVAL, 'Wolfe Intelligence completes this one');
    assert.strictEqual(err.code, 'approval-required');
    assert.deepStrictEqual(await O.get(wsG, job2), before, 'the refused action changed the record');

    const entries = await trail.list(wsG, { objectId: job2, limit: 50 });
    const last = entries[entries.length - 1];
    assert.strictEqual(last.event, 'action.refused');
    assert.strictEqual(last.outcome, 'refused');
    assert.strictEqual(last.detail, 'requires the operator');
    assert.strictEqual(last.by, staff.email);
    assert.strictEqual(last.role, 'member');
    assert.strictEqual(last.label, 'Approve');
    // Asking is a different state from being refused, and the client is told
    // which one they are in.
    const s = await O.getSchema(wsG);
    const forStaff = A.availableFor(s.types.job, before, 'member').find((a) => a.key === 'approve');
    assert.strictEqual(forStaff.state, 'needs-approval', 'a client may ask, which is not the same as being refused');
    assert.strictEqual(forStaff.reason, 'Wolfe Intelligence completes this one.');
    // And the operator, who is the one that completes it, actually can.
    const ownJob = (await O.create(wsG, operator, 'job', { title: 'Operator press', value: 1, stage: 'open' })).object.id;
    const done = await A.run(wsG, operator, ownJob, 'approve', {});
    assert.strictEqual(done.result.object.props.stage, 'won', 'the operator must be able to complete their own press');
  });
  await ok('a role with no authority to act is refused and audited, and sees no buttons', async () => {
    const before = await O.get(wsG, job2);
    await refused(() => A.run(wsG, onlooker, job2, 'touch', {}), authority.FORBIDDEN, 'may not do this');
    assert.deepStrictEqual(await O.get(wsG, job2), before);
    const entries = await trail.list(wsG, { objectId: job2, limit: 50 });
    const last = entries[entries.length - 1];
    assert.strictEqual(last.event, 'action.refused');
    assert.strictEqual(last.role, 'viewer');
    assert.ok(last.detail.startsWith('forbidden:'), last.detail);
    const s = await O.getSchema(wsG);
    assert.deepStrictEqual(A.availableFor(s.types.job, before, 'viewer'), [],
      'a button that would be refused must never be drawn');
  });
  await ok('an action nobody declared is refused', async () => {
    await refused(() => A.run(wsG, operator, job2, 'self-destruct', {}), 'unknown-action', 'There is no "self-destruct" on a job');
    await refused(() => A.run(wsG, operator, 'obj_nothing', 'touch', {}), 'not-found');
  });
  const runsOn = async (id) => (await trail.list(wsG, { objectId: id, limit: 200 })).filter((e) => e.event === 'action.run').length;
  await ok('the same idempotency key replayed returns the first answer without acting twice', async () => {
    const before = await runsOn(job2);
    const first = await at('2026-04-01T08:00:00.000Z', () => A.run(wsG, operator, job2, 'touch', {}, 'press-once'));
    assert.strictEqual(first.replayed, false);
    const between = await runsOn(job2);
    assert.strictEqual(between, before + 1, 'the first press should have acted exactly once');

    const again = await at('2026-04-01T08:00:03.000Z', () => A.run(wsG, operator, job2, 'touch', {}, 'press-once'));
    assert.strictEqual(again.replayed, true, 'the second press was not recognised as the same press');
    assert.deepStrictEqual(again.result, first.result, 'the replay answered differently');
    assert.strictEqual(await runsOn(job2), between, 'the replay acted a second time');
  });
  await ok('the same key with different details is a conflict, and nothing is changed', async () => {
    const before = await O.get(wsG, job2);
    const runs = await runsOn(job2);
    await refused(() => A.run(wsG, operator, job2, 'touch', { note: 'something else' }, 'press-once'),
      'receipt-conflict', 'already made with different details');
    assert.deepStrictEqual(await O.get(wsG, job2), before, 'a conflicted request changed the record');
    assert.strictEqual(await runsOn(job2), runs, 'a conflicted request acted anyway');
  });
  await ok('an action input reaches the record, and a required one that is missing refuses', async () => {
    const j = (await O.create(wsG, operator, 'job', { title: 'With a note', value: 5, stage: 'open' })).object.id;
    await A.run(wsG, operator, j, 'touch', { note: 'left the gate open' });
    assert.strictEqual((await O.get(wsG, j)).props.note, 'left the gate open');
    // A declared constant wins over an input naming the same key.
    await A.run(wsG, operator, j, 'mark-won', { stage: 'open' });
    assert.strictEqual((await O.get(wsG, j)).props.stage, 'won', 'a caller overrode what the action says it always does');

    // A required input that never arrived stops the whole action.
    const before = await O.get(wsG, j);
    await refused(() => A.run(wsG, operator, j, 'log-note', {}), 'input-required', 'Note is needed to do that.');
    await refused(() => A.run(wsG, operator, j, 'log-note', { note: '' }), 'input-required');
    assert.deepStrictEqual(await O.get(wsG, j), before, 'a missing input still half-ran the action');
    await A.run(wsG, operator, j, 'log-note', { note: 'now it has one' });
    assert.strictEqual((await O.get(wsG, j)).props.note, 'now it has one');
  });

  console.log('\nlib/files.js — documents, with the bytes somewhere the record is not');
  let docId;
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x0a, 0x7f, 0x80]);
  await ok('a disallowed content type is refused', async () => {
    await refused(() => docs.put(wsG, operator, { name: 'thing.exe', contentType: 'application/x-msdownload', dataBase64: bytes.toString('base64') }),
      'type-not-allowed', 'not accepted here');
    await refused(() => docs.put(wsG, operator, { name: 'nothing', contentType: 'application/pdf', dataBase64: '' }), 'empty');
    assert.deepStrictEqual(await O.listByType(wsG, 'document'), [], 'a refused upload left a record behind');
  });
  await ok('an oversized file is refused with a message naming the limit', async () => {
    const big = Buffer.alloc(docs.INLINE_MAX + 1024, 7).toString('base64');
    const err = await refused(() => docs.put(wsG, operator, { name: 'huge.pdf', contentType: 'application/pdf', dataBase64: big }), 'too-large');
    assert.ok(err.message.includes('the limit is ' + Math.round(docs.INLINE_MAX / 1024) + ' KB'), err.message);
    assert.ok(err.message.includes('401 KB'), 'the refusal should say how big the file actually was: ' + err.message);
    assert.deepStrictEqual(await O.listByType(wsG, 'document'), []);
    assert.strictEqual(docs.capability().inlineMaxBytes, docs.INLINE_MAX);
    assert.strictEqual(docs.capability().largeFiles, 'off');
  });
  await ok('upload then read round-trips the bytes exactly', async () => {
    const doc = await at('2026-05-05T12:00:00.000Z', () => docs.put(wsG, operator, {
      name: 'estimate: final/v2.pdf', contentType: 'application/pdf; charset=binary',
      dataBase64: bytes.toString('base64'), note: 'the one they signed',
    }));
    docId = doc.id;
    assert.strictEqual(doc.type, 'document');
    assert.strictEqual(doc.props.contentType, 'application/pdf', 'the parameters should be stripped');
    assert.strictEqual(doc.props.size, bytes.length);
    assert.strictEqual(doc.props.backend, 'inline');
    assert.strictEqual(doc.props.uploadedAt, '2026-05-05T12:00:00.000Z');
    assert.strictEqual(doc.props.name, 'estimate final v2.pdf', 'the stored name must be safe to show');

    const back = await docs.read(wsG, operator, docId);
    assert.ok(Buffer.from(back.dataBase64, 'base64').equals(bytes), 'the bytes came back changed');
    assert.strictEqual(back.contentType, 'application/pdf');
    assert.strictEqual(back.name, doc.props.name);
    await refused(() => docs.read(wsG, operator, cust1), 'not-found', 'No such document');
  });
  await ok('reading a document records a file.downloaded entry', async () => {
    const before = (await trail.list(wsG, { objectId: docId, limit: 50 })).filter((e) => e.event === 'file.downloaded').length;
    await docs.read(wsG, staff, docId);
    const entries = await trail.list(wsG, { objectId: docId, limit: 50 });
    const reads = entries.filter((e) => e.event === 'file.downloaded');
    assert.strictEqual(reads.length, before + 1);
    const last = reads[reads.length - 1];
    assert.strictEqual(last.by, staff.email);
    assert.strictEqual(last.actor, 'client');
    assert.strictEqual(last.label, 'estimate final v2.pdf');
    assert.ok(entries.some((e) => e.event === 'file.uploaded'), 'the upload should be in the trail too');
  });
  await ok('archiving a document keeps the record and drops the bytes', async () => {
    const bytesKey = 'ws:' + wsG + ':bytes:' + docId;
    assert.ok(await kv.cmd('GET', bytesKey), 'the bytes were not there to begin with');
    const archived = await docs.archive(wsG, operator, docId);
    assert.strictEqual(archived.archived, true);
    assert.strictEqual(await kv.cmd('GET', bytesKey), null, 'the storage is still paying for it');
    assert.strictEqual((await O.get(wsG, docId)).props.name, 'estimate final v2.pdf', 'the record must survive');
    await refused(() => docs.read(wsG, operator, docId), 'archived', 'That document was removed');
    assert.ok((await trail.list(wsG, { objectId: docId, limit: 50 })).some((e) => e.event === 'file.archived'));
  });
  await ok('a workspace whose schema cannot hold the document is refused before any bytes are stored', async () => {
    const thin = { types: { document: { label: 'File', titleProp: 'title', properties: [{ key: 'title', label: 'Name', type: 'text' }] } } };
    const wsThin = (await T.create({ name: 'Thin Fixture', by: operator.email })).id;
    await O.saveSchema(wsThin, thin, operator);
    await refused(() => docs.put(wsThin, operator, { name: 'a.pdf', contentType: 'application/pdf', dataBase64: bytes.toString('base64') }));
    assert.deepStrictEqual(await O.listByType(wsThin, 'document'), [], 'a refused upload created a record');
    const leftover = [...mock.strings.keys()].filter((k) => k.startsWith('ws:' + wsThin + ':bytes:'));
    assert.deepStrictEqual(leftover, [], 'a refused upload left orphan bytes behind');

    const wsNone = (await T.create({ name: 'No Documents', by: operator.email })).id;
    await refused(() => docs.put(wsNone, operator, { name: 'a.pdf', contentType: 'application/pdf', dataBase64: bytes.toString('base64') }),
      'no-document-type', 'not set up to hold documents');
  });

  console.log('\napi/graph.js — one route, one place identity is resolved');
  const wsApi = (await T.create({ name: 'API Fixture', by: operator.email })).id;
  await O.saveSchema(wsApi, testSchema(), operator);
  await T.addMember(wsApi, 'eyes@client.test', 'viewer', operator.email);
  const ownerTok = sign({ e: 'owner@wolfe.test', r: 'owner', x: RealDate.now() + 1e7 });
  const viewerTok = sign({ e: 'eyes@client.test', r: 'client', x: RealDate.now() + 1e7 });
  const strangerTok = sign({ e: 'stranger@client.test', r: 'client', x: RealDate.now() + 1e7 });

  await ok('a signed token for a workspace the session runs reaches the operation', async () => {
    const r = await call({ op: 'workspace.get', ws: wsApi }, ownerTok);
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.role, 'operator');
    assert.strictEqual(r.body.workspace.id, wsApi);
    assert.ok(r.body.schema.types.customer, 'the schema should come back with it');
  });
  await ok('an unsigned, forged or expired token is 401 and nothing else', async () => {
    for (const tok of [null, 'nonsense', 'a.b', sign({ e: 'x@y.test', r: 'owner', x: RealDate.now() + 1e7 }).slice(0, -2) + 'zz']) {
      const r = await call({ op: 'workspace.get', ws: wsApi }, tok);
      assert.strictEqual(r.code, 401, 'token ' + String(tok) + ' got ' + r.code);
      assert.strictEqual(r.body.error, 'unauthorized');
    }
    const expired = sign({ e: 'owner@wolfe.test', r: 'owner', x: RealDate.now() - 1000 });
    const r = await call({ op: 'workspace.get', ws: wsApi }, expired);
    assert.strictEqual(r.code, 401);
    assert.strictEqual(r.body.error, 'unauthorized');
    // A GET is not a way around it either.
    const g = res();
    await graphApi(Object.assign(apiReq({ op: 'describe' }, ownerTok), { method: 'GET' }), g);
    assert.strictEqual(g.code, 405);
  });
  await ok('a workspace the session is not a member of is 404, not 403 — existence is not disclosed', async () => {
    const outsider = await call({ op: 'workspace.get', ws: wsApi }, strangerTok);
    assert.strictEqual(outsider.code, 404, 'a non-member got ' + outsider.code);
    assert.notStrictEqual(outsider.code, 403, 'a 403 tells a stranger the workspace exists');
    const imaginary = await call({ op: 'workspace.get', ws: 'ws_does_not_exist_aaaaaa' }, strangerTok);
    assert.strictEqual(imaginary.code, 404);
    assert.deepStrictEqual(outsider.body, imaginary.body,
      'a real workspace and an imaginary one must be indistinguishable to a stranger');
    // The same is true of a write op, and of the operation body.
    const write = await call({ op: 'object.create', ws: wsApi, type: 'customer', props: { name: 'Sneaky' } }, strangerTok);
    assert.strictEqual(write.code, 404);
    assert.strictEqual(write.body.error, 'no-such-workspace');
  });
  await ok('a viewer is refused a write, and nothing is written', async () => {
    const before = (await O.listByType(wsApi, 'customer')).length;
    const r = await call({ op: 'object.create', ws: wsApi, type: 'customer', props: { name: 'By a viewer' } }, viewerTok);
    assert.strictEqual(r.code, 403, JSON.stringify(r.body));
    assert.strictEqual(r.body.error, authority.FORBIDDEN);
    assert.ok(r.body.text.includes('may not do this'), r.body.text);
    assert.strictEqual((await O.listByType(wsApi, 'customer')).length, before, 'the viewer wrote something');
    // A read is fine for the same session, and the operator may write.
    const read = await call({ op: 'objects.list', ws: wsApi, type: 'customer' }, viewerTok);
    assert.strictEqual(read.code, 200);
    const made = await call({ op: 'object.create', ws: wsApi, type: 'customer', props: { name: 'By the operator' } }, ownerTok);
    assert.strictEqual(made.code, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.object.props.name, 'By the operator');
    assert.strictEqual((await O.listByType(wsApi, 'customer')).length, before + 1);
  });
  await ok('an approval-required capability answers 202, not 200 and not 403', async () => {
    await T.addMember(wsApi, 'boss@client.test', 'admin', operator.email);
    const adminTok = sign({ e: 'boss@client.test', r: 'client', x: RealDate.now() + 1e7 });
    const r = await call({ op: 'schema.save', ws: wsApi, schema: { types: {} } }, adminTok);
    assert.strictEqual(r.code, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.error, authority.APPROVAL);
    assert.ok((await O.getSchema(wsApi)).types.customer, 'the schema was replaced by a request to replace it');
  });
  await ok('an operation nobody declared is refused rather than guessed at', async () => {
    for (const op of ['object.delete', '', 'DESCRIBE', 'toString', 'constructor', '__proto__']) {
      const r = await call({ op, ws: wsApi }, ownerTok);
      assert.strictEqual(r.code, 400, 'op "' + op + '" got ' + r.code);
      assert.strictEqual(r.body.error, 'unknown-op');
    }
    // Refused before any workspace is even resolved.
    const r = await call({ op: 'object.delete', ws: 'ws_does_not_exist_aaaaaa' }, ownerTok);
    assert.strictEqual(r.body.error, 'unknown-op');
  });
  await ok('every declared op has a case, and every case has a declaration', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'graph.js'), 'utf8');
    const cases = new Set();
    const re = /case '([^']+)':/g;
    let m;
    while ((m = re.exec(src))) cases.add(m[1]);
    const declared = Object.keys(graphApi.OPS);
    assert.ok(declared.length > 10 && cases.size > 10, 'the parity check found nothing to compare');

    const undeclared = [...cases].filter((c) => !Object.prototype.hasOwnProperty.call(graphApi.OPS, c));
    assert.deepStrictEqual(undeclared, [], 'dispatch handles ops that OPS does not declare (so nothing gates them)');
    const unimplemented = declared.filter((o) => !cases.has(o));
    assert.deepStrictEqual(unimplemented, [], 'OPS declares ops dispatch cannot serve');

    // Every declared op also names a capability or says plainly that it gates itself.
    for (const [op, spec] of Object.entries(graphApi.OPS)) {
      assert.strictEqual(typeof spec.ws, 'boolean', op + ' does not say whether it is workspace-scoped');
      assert.ok(spec.capability === null || authority.CAPABILITIES.includes(spec.capability),
        op + ' needs "' + spec.capability + '", which is not a capability the policy table knows');
    }
  });

  /* Four defects this layer had, each pinned so it cannot come back. They are
     written as requirements rather than as history: what must be true, not what
     once went wrong. */
  console.log('');
  console.log('regressions — four defects, pinned');

  const RWS = 'ws_regress';
  const rop = { email: 'owner@wolfe.test', role: 'owner', wsRole: 'operator' };
  const RSCHEMA = {
    types: {
      job: {
        label: 'Job', titleProp: 'what',
        properties: [
          { key: 'what', label: 'What', type: 'text' },
          { key: 'stage', label: 'Stage', type: 'select:|open=Open|done=Done' },
          { key: 'doneAt', label: 'Finished', type: 'datetime' },
          { key: 'invoiced', label: 'Invoiced', type: 'bool' },
        ],
        actions: [
          { key: 'finish', label: 'Mark finished', effect: 'mutate', risk: 'low',
            sets: { stage: 'done' }, stamps: ['doneAt'], when: { stage: 'open' },
            whenFails: 'This job is already finished.' },
          { key: 'invoice', label: 'Send the invoice', effect: 'mutate', risk: 'medium',
            requiresOwner: true, sets: { invoiced: true } },
        ],
      },
      document: templates.get('local-service').schema.types.document,
      customer: { label: 'Customer', titleProp: 'name', properties: [{ key: 'name', label: 'Name', type: 'text' }] },
    },
  };
  await O.saveSchema(RWS, RSCHEMA, rop);

  await ok('an upload completes, because the document type matches its only writer', async () => {
    // The template once described a file the way a person would and shared not
    // one key with the uploader, so every upload was refused on the first field.
    const writes = ['name', 'contentType', 'size', 'backend', 'checksum', 'uploadedAt', 'uploadedBy', 'note'];
    const declared = new Set(templates.get('local-service').schema.types.document.properties.map((p) => p.key));
    for (const k of writes) {
      assert.ok(declared.has(k), 'lib/files.js writes "' + k + '" and the document type has no such field');
    }
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const doc = await docs.put(RWS, rop, { name: 'before.png', contentType: 'image/png', dataBase64: png });
    const back = await docs.read(RWS, rop, doc.id);
    assert.strictEqual(back.dataBase64, png, 'the bytes did not survive the round trip');
  });

  await ok('the operator is the approver, so an owner-press action is available to them', async () => {
    const job = (await O.create(RWS, rop, 'job', { what: 'Aeration', stage: 'open' })).object;
    const forOp = A.availableFor(RSCHEMA.types.job, job, 'operator').find((a) => a.key === 'invoice');
    const forClient = A.availableFor(RSCHEMA.types.job, job, 'admin').find((a) => a.key === 'invoice');
    assert.strictEqual(forOp.state, 'available', 'the person who approves it was shown an approval prompt');
    assert.strictEqual(forOp.reason, '', 'an available action needs no excuse');
    assert.strictEqual(forClient.state, 'needs-approval');
    assert.ok(forClient.reason, 'a client must be told who completes it');
  });

  await ok('an honest retry replays the first answer instead of colliding', async () => {
    const job = (await O.create(RWS, rop, 'job', { what: 'Spring cleanup', stage: 'open' })).object;
    const key = 'press-' + job.id;
    const first = await A.run(RWS, rop, job.id, 'finish', {}, key);
    assert.strictEqual(first.replayed, false);
    // The first run is exactly what makes the precondition stop holding, so a
    // retry must be answered from the receipt rather than judged afresh.
    const again = await A.run(RWS, rop, job.id, 'finish', {}, key);
    assert.strictEqual(again.replayed, true, 'the retry was treated as a different request');
    assert.strictEqual(again.result.object.props.doneAt, first.result.object.props.doneAt, 'the retry moved the timestamp');
    assert.strictEqual((await O.get(RWS, job.id)).rev, 2, 'the retry wrote a second time');
  });

  await ok('an action that does not apply is refused and recorded', async () => {
    const job = (await O.create(RWS, rop, 'job', { what: 'Mulch', stage: 'done' })).object;
    await refused(() => A.run(RWS, rop, job.id, 'finish', {}, 'k-' + job.id), 'precondition', 'already finished');
    const entries = await trail.list(RWS, { objectId: job.id, limit: 20 });
    const refusals = entries.filter((t) => t.event === 'action.refused');
    assert.strictEqual(refusals.length, 1, 'a refused press left no trace');
    assert.strictEqual(refusals[0].outcome, 'refused');
  });

  console.log('\n' + pass + ' passing' + (process.exitCode ? ' — failures above' : ''));
})();
