/* Workspaces, membership and capabilities.
 *
 * One workspace per client business. Everything else in the ontology is
 * addressed underneath a workspace id, so a query cannot accidentally reach
 * across tenants: there is no "all objects" key to read from. Isolation is a
 * property of the key layout, not of a filter someone remembered to apply.
 *
 * Two role systems meet here and they are deliberately separate:
 *   - the session role from api/login.js ('owner' | 'client') says who you are
 *     to Wolfe Intelligence;
 *   - the workspace role ('admin' | 'member' | 'viewer') says what you are
 *     inside one client's business.
 * Zach is the operator: 'owner' reaches every workspace. A client reaches only
 * workspaces they are a member of, at the role that membership grants.
 */

const kv = require('./kv');

const WS_INDEX = 'ws:index';
const wsKey = (id) => 'ws:' + id;
const membersKey = (id) => 'ws:' + id + ':members';
const memberKey = (id, email) => 'ws:' + id + ':member:' + email;
const userWsKey = (email) => 'user:' + email + ':ws';

const ROLES = ['admin', 'member', 'viewer'];
const norm = (e) => String(e || '').trim().toLowerCase();

/* Ids are readable on purpose. An operator reads these in an audit trail and
 * in a URL, and "ws_greenlawn_k3f9" beats a uuid every time. The random tail
 * keeps two clients with the same name apart. */
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'workspace';
}
function newId(name) {
  const tail = require('crypto').randomBytes(3).toString('hex');
  return 'ws_' + slugify(name).replace(/-/g, '_') + '_' + tail;
}

async function create({ name, kind, by, template }) {
  const id = newId(name);
  const ws = {
    id,
    name: String(name || '').trim().slice(0, 120),
    slug: slugify(name),
    kind: String(kind || 'business').slice(0, 40),
    template: String(template || '').slice(0, 40),
    at: new Date().toISOString(),
    by: norm(by),
    archived: false,
  };
  await kv.pipe([
    ['SET', wsKey(id), JSON.stringify(ws)],
    ['SADD', WS_INDEX, id],
  ]);
  return ws;
}

async function get(id) {
  if (!id || typeof id !== 'string' || !id.startsWith('ws_')) return null;
  return kv.getJson(wsKey(id));
}

async function save(ws) {
  if (!ws || !ws.id) throw new Error('tenancy: workspace has no id');
  await kv.setJson(wsKey(ws.id), ws);
  return ws;
}

async function list() {
  const ids = await kv.smembers(WS_INDEX);
  if (!ids.length) return [];
  const rows = await kv.mgetJson(ids.map(wsKey));
  return rows.filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/* Membership. Kept as a set plus a record per member rather than an array on
 * the workspace, so granting access is one write that cannot lose a concurrent
 * grant by overwriting the whole list. */
async function addMember(wsId, email, role, by) {
  const e = norm(email);
  const r = ROLES.includes(role) ? role : 'viewer';
  const rec = { email: e, role: r, at: new Date().toISOString(), by: norm(by) };
  await kv.pipe([
    ['SET', memberKey(wsId, e), JSON.stringify(rec)],
    ['SADD', membersKey(wsId), e],
    ['SADD', userWsKey(e), wsId],
  ]);
  return rec;
}

async function removeMember(wsId, email) {
  const e = norm(email);
  await kv.pipe([
    ['DEL', memberKey(wsId, e)],
    ['SREM', membersKey(wsId), e],
    ['SREM', userWsKey(e), wsId],
  ]);
}

async function members(wsId) {
  const emails = await kv.smembers(membersKey(wsId));
  if (!emails.length) return [];
  const rows = await kv.mgetJson(emails.map((e) => memberKey(wsId, e)));
  return rows.filter(Boolean);
}

async function membership(wsId, email) {
  return kv.getJson(memberKey(wsId, norm(email)));
}

/* Which workspaces a session may see at all. The operator sees every one; a
 * client sees only the ones they were added to. This is the only place that
 * answer is computed. */
async function visibleTo(session) {
  if (!session) return [];
  if (session.role === 'owner') return list();
  const ids = await kv.smembers(userWsKey(norm(session.email)));
  if (!ids.length) return [];
  const rows = await kv.mgetJson(ids.map(wsKey));
  return rows.filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/* The effective role of a session inside one workspace, or null for no access.
 * Every read and write in the ontology goes through this. */
async function roleIn(session, wsId) {
  if (!session || !wsId) return null;
  if (session.role === 'owner') return 'operator';
  const m = await membership(wsId, session.email);
  return m ? m.role : null;
}

/* Capability policy lives in lib/authority.js and only there. A second table
 * here would start out agreeing with it and quietly stop. */

module.exports = {
  ROLES, slugify, create, get, save, list,
  addMember, removeMember, members, membership,
  visibleTo, roleIn, norm,
};
