/* The object graph: records, links, history and referential integrity.
 *
 * Every key is addressed under a workspace id, so a query cannot reach across
 * tenants — there is no "all objects" key to read from by mistake. Isolation is
 * a property of the key layout, not of a filter someone remembered to apply.
 *
 * Concurrency is optimistic. Each object carries a revision number; a write
 * that names the revision it read is refused if the record moved underneath it.
 * Upstash over REST has no multi-key transaction, so this is honest about what
 * it is: it catches two people editing the same record, which is the case that
 * actually happens, and it does not pretend to be a database transaction.
 */

const kv = require('./kv');
const audit = require('./audit');
const T = require('./types');
const schema = require('./schema');

const HISTORY_CAP = 100;

const objKey = (ws, id) => 'ws:' + ws + ':obj:' + id;
const typeKey = (ws, t) => 'ws:' + ws + ':type:' + t;
const linkKey = (ws, id, k) => 'ws:' + ws + ':link:' + id + ':' + k;
const backKey = (ws, id) => 'ws:' + ws + ':back:' + id;
const histKey = (ws, id) => 'ws:' + ws + ':hist:' + id;
const schemaKey = (ws) => 'ws:' + ws + ':schema';
const checksKey = (ws) => 'ws:' + ws + ':checks';

class Refused extends Error {
  constructor(message, code) { super(message); this.code = code || 'refused'; }
}

function newObjectId(type) {
  return String(type).slice(0, 12) + '_' + require('crypto').randomBytes(5).toString('hex');
}

/* ---------------------------------------------------------------- schema */

async function getSchema(ws) {
  return (await kv.getJson(schemaKey(ws))) || { types: {} };
}

/* Saving a schema compiles its checks in the same breath, so a compiled check
 * can never be from a different version of the shape than the one on screen. */
async function saveSchema(ws, next, session) {
  const violations = schema.validateSchema(next);
  const blocking = violations.filter((v) => v.code !== 'no-types');
  if (blocking.length) throw new Refused(blocking[0].message, 'schema-invalid');
  const stored = Object.assign({}, next, {
    version: schema.SCHEMA_VERSION,
    revision: schema.revisionOf(next),
    at: new Date().toISOString(),
  });
  await kv.pipe([
    ['SET', schemaKey(ws), JSON.stringify(stored)],
    ['SET', checksKey(ws), JSON.stringify(schema.compileChecks(next))],
  ]);
  await audit.append(ws, {
    event: 'schema.updated', actor: session.role === 'owner' ? 'operator' : 'client',
    by: session.email, role: session.wsRole, outcome: 'ok',
    detail: Object.keys(stored.types || {}).length + ' types',
  });
  return stored;
}

const getChecks = async (ws) => (await kv.getJson(checksKey(ws))) || {};

/* --------------------------------------------------------------- reading */

async function get(ws, id) {
  if (!id) return null;
  return kv.getJson(objKey(ws, id));
}

async function listByType(ws, type, opts) {
  const o = opts || {};
  const ids = await kv.smembers(typeKey(ws, type));
  if (!ids.length) return [];
  const rows = (await kv.mgetJson(ids.map((i) => objKey(ws, i)))).filter(Boolean);
  const live = o.includeArchived ? rows : rows.filter((r) => !r.archived);
  live.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return o.limit ? live.slice(0, o.limit) : live;
}

async function counts(ws, types) {
  const out = {};
  const keys = types.map((t) => typeKey(ws, t));
  const res = await kv.pipe(keys.map((k) => ['SCARD', k]));
  types.forEach((t, i) => { out[t] = parseInt(res[i], 10) || 0; });
  return out;
}

/* ------------------------------------------------------- writing records */

/* Shared by create and update: coerce every incoming value against its declared
 * type, reject a property the type does not have, and run the compiled checks
 * before anything is written. A refused save changes nothing. */
function prepare(typeDef, checks, current, patch) {
  const props = (typeDef.properties || []).map(T.property);
  const byKey = {};
  for (const p of props) byKey[p.key] = p;

  const next = Object.assign({}, current || {});
  for (const k of Object.keys(patch || {})) {
    const p = byKey[k];
    // An unknown property is a caller bug or a stale screen. Silently dropping
    // it would lose the client's typing without telling anyone.
    if (!p) throw new Refused('This record does not have a "' + k + '" field.', 'unknown-property');
    next[k] = T.coerce(p, patch[k]);
  }
  for (const p of props) {
    const err = T.validate(p, next[p.key]);
    if (err) throw new Refused(err, 'invalid-value');
  }
  const refusal = schema.firstRefusal(checks, next, byKey);
  if (refusal) throw new Refused(refusal.message, 'check-refused');
  return { next: next, props: props, byKey: byKey };
}

async function create(ws, session, type, patch) {
  const s = await getSchema(ws);
  const typeDef = (s.types || {})[type];
  if (!typeDef) throw new Refused('There is no "' + type + '" in this workspace.', 'unknown-type');
  const checks = (await getChecks(ws))[type] || [];
  const prepared = prepare(typeDef, checks, {}, patch);

  const now = new Date().toISOString();
  const obj = {
    id: newObjectId(type),
    type: type,
    props: prepared.next,
    rev: 1,
    at: now,
    by: session.email,
    updatedAt: now,
    updatedBy: session.email,
    archived: false,
  };
  await kv.pipe([
    ['SET', objKey(ws, obj.id), JSON.stringify(obj)],
    ['SADD', typeKey(ws, type), obj.id],
  ]);
  await kv.push(histKey(ws, obj.id), { rev: 1, at: now, by: session.email, event: 'created', changes: [] }, HISTORY_CAP);
  const receipt = await audit.append(ws, {
    event: 'object.created', actor: session.role === 'owner' ? 'operator' : 'client',
    by: session.email, role: session.wsRole, outcome: 'ok',
    type: type, objectId: obj.id, label: titleOf(typeDef, obj),
  });
  return { object: obj, receipt: receipt };
}

async function update(ws, session, id, patch, opts) {
  const o = opts || {};
  const current = await get(ws, id);
  if (!current) throw new Refused('That record no longer exists.', 'not-found');
  if (current.archived) throw new Refused('That record is archived. Restore it before changing it.', 'archived');
  // The revision the caller read. A mismatch means someone else saved first,
  // and overwriting them silently is the failure this prevents.
  if (o.expectedRev != null && Number(o.expectedRev) !== current.rev) {
    throw new Refused('Someone else changed this record while you were editing. Reload and try again.', 'stale');
  }
  const s = await getSchema(ws);
  const typeDef = (s.types || {})[current.type];
  if (!typeDef) throw new Refused('This record\'s type is no longer in the workspace.', 'unknown-type');
  const checks = (await getChecks(ws))[current.type] || [];
  const prepared = prepare(typeDef, checks, current.props, patch);

  const changes = audit.changes(current.props, prepared.next);
  if (!changes.length) return { object: current, receipt: '', unchanged: true };

  const now = new Date().toISOString();
  const next = Object.assign({}, current, {
    props: prepared.next, rev: current.rev + 1, updatedAt: now, updatedBy: session.email,
  });
  await kv.setJson(objKey(ws, id), next);
  await kv.push(histKey(ws, id), { rev: next.rev, at: now, by: session.email, event: 'updated', changes: changes }, HISTORY_CAP);
  const receipt = await audit.append(ws, {
    event: 'object.updated', actor: session.role === 'owner' ? 'operator' : 'client',
    by: session.email, role: session.wsRole, outcome: 'ok',
    type: current.type, objectId: id, label: titleOf(typeDef, next), changes: changes,
  });
  return { object: next, receipt: receipt };
}

/* Archive, never delete. Nothing here destroys a client's record — and a record
 * something still points at cannot even be archived without saying what points
 * at it, because a dangling link is a worse outcome than a stale record. */
async function archive(ws, session, id) {
  const current = await get(ws, id);
  if (!current) throw new Refused('That record no longer exists.', 'not-found');
  const refs = await kv.smembers(backKey(ws, id));
  if (refs.length) {
    const s = await getSchema(ws);
    const first = String(refs[0]).split('|');
    const holder = await get(ws, first[0]);
    const holderType = holder ? (s.types || {})[holder.type] : null;
    const name = holderType ? titleOf(holderType, holder) : first[0];
    throw new Refused(
      'Still linked from ' + name + (first[1] ? ' (' + first[1] + ')' : '') +
      (refs.length > 1 ? ' and ' + (refs.length - 1) + ' more' : '') + '. Remove the link first.',
      'still-linked'
    );
  }
  const now = new Date().toISOString();
  const next = Object.assign({}, current, { archived: true, updatedAt: now, updatedBy: session.email, rev: current.rev + 1 });
  await kv.setJson(objKey(ws, id), next);
  await kv.push(histKey(ws, id), { rev: next.rev, at: now, by: session.email, event: 'archived', changes: [] }, HISTORY_CAP);
  const receipt = await audit.append(ws, {
    event: 'object.archived', actor: session.role === 'owner' ? 'operator' : 'client',
    by: session.email, role: session.wsRole, outcome: 'ok', type: current.type, objectId: id,
  });
  return { object: next, receipt: receipt };
}

/* ----------------------------------------------------------------- links */

async function link(ws, session, fromId, key, toId) {
  const s = await getSchema(ws);
  const from = await get(ws, fromId);
  const to = await get(ws, toId);
  if (!from || !to) throw new Refused('One of those records no longer exists.', 'not-found');
  const typeDef = (s.types || {})[from.type];
  const def = ((typeDef && typeDef.links) || []).find((l) => l.key === key);
  if (!def) throw new Refused('There is no "' + key + '" link on a ' + from.type + '.', 'unknown-link');
  if (def.to !== to.type) {
    throw new Refused((typeDef.label || from.type) + ' ' + (def.label || key) + ' must point at a ' + def.to + ', not a ' + to.type + '.', 'wrong-target');
  }
  const cmds = [];
  // 'one' means exactly that: setting it replaces whatever was there, and the
  // old target's back-reference goes with it or it becomes a phantom.
  if (def.cardinality === 'one') {
    const existing = await kv.smembers(linkKey(ws, fromId, key));
    for (const old of existing) {
      cmds.push(['SREM', linkKey(ws, fromId, key), old]);
      cmds.push(['SREM', backKey(ws, old), fromId + '|' + key]);
    }
  }
  cmds.push(['SADD', linkKey(ws, fromId, key), toId]);
  cmds.push(['SADD', backKey(ws, toId), fromId + '|' + key]);
  await kv.pipe(cmds);
  const receipt = await audit.append(ws, {
    event: 'link.added', actor: session.role === 'owner' ? 'operator' : 'client',
    by: session.email, role: session.wsRole, outcome: 'ok',
    type: from.type, objectId: fromId, detail: key + ' -> ' + toId,
  });
  return { receipt: receipt };
}

async function unlink(ws, session, fromId, key, toId) {
  await kv.pipe([
    ['SREM', linkKey(ws, fromId, key), toId],
    ['SREM', backKey(ws, toId), fromId + '|' + key],
  ]);
  return { receipt: await audit.append(ws, {
    event: 'link.removed', actor: session.role === 'owner' ? 'operator' : 'client',
    by: session.email, role: session.wsRole, outcome: 'ok', objectId: fromId, detail: key + ' -> ' + toId,
  }) };
}

async function linked(ws, id, key) {
  const ids = await kv.smembers(linkKey(ws, id, key));
  if (!ids.length) return [];
  return (await kv.mgetJson(ids.map((i) => objKey(ws, i)))).filter(Boolean);
}

/* Everything pointing AT this record, resolved. This is the half a set of
 * forms with pointers cannot do, and the reason the inverse name is required. */
async function backlinks(ws, id) {
  const raw = await kv.smembers(backKey(ws, id));
  if (!raw.length) return [];
  const pairs = raw.map((r) => String(r).split('|'));
  const rows = await kv.mgetJson(pairs.map((p) => objKey(ws, p[0])));
  return rows.map((obj, i) => (obj ? { object: obj, via: pairs[i][1] } : null)).filter(Boolean);
}

async function history(ws, id, limit) {
  const rows = await kv.range(histKey(ws, id), 0, Math.max(1, Math.min(HISTORY_CAP, limit || 25)) - 1);
  return rows;
}

/* --------------------------------------------------------------- helpers */

function titleOf(typeDef, obj) {
  if (!obj) return '';
  const key = typeDef && typeDef.titleProp;
  const v = key ? (obj.props || {})[key] : null;
  if (v) return String(v).slice(0, 160);
  return (typeDef && typeDef.label ? typeDef.label : obj.type) + ' ' + String(obj.id).slice(-6);
}

module.exports = {
  Refused, getSchema, saveSchema, getChecks,
  get, listByType, counts, create, update, archive,
  link, unlink, linked, backlinks, history, titleOf, newObjectId,
};
