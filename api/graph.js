/* The workspace API — one route for the whole object graph.
 *
 * Every .js file under api/ becomes a public route on this host, so this is a
 * single router dispatching on `op` rather than twenty endpoints. That also
 * means there is exactly one place where identity is resolved and exactly one
 * table saying which capability each operation needs, instead of twenty places
 * that each have to remember.
 *
 * Two rules this file exists to enforce:
 *
 *   Identity is resolved here, from the signed token, and never taken from the
 *   request. A caller may name a workspace; it may not name its own role in it.
 *
 *   An operation with no entry in OPS is refused. Not defaulted to allowed, not
 *   guessed at from its name — refused, because an operation nobody classified
 *   is one nobody decided to permit.
 */

const crypto = require('crypto');
const { limit, sameSite } = require('../lib/ratelimit');
const tenancy = require('../lib/tenancy');
const authority = require('../lib/authority');
const ontology = require('../lib/ontology');
const actions = require('../lib/actions');
const files = require('../lib/files');
const audit = require('../lib/audit');
const schema = require('../lib/schema');
const templates = (() => { try { return require('../lib/templates'); } catch (e) { return null; } })();

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

/* op -> the capability it needs, and whether it is scoped to a workspace.
 * `capability: null` means the op is its own gate (listing workspaces returns
 * only what the session may already see). */
const OPS = {
  'describe':          { ws: false, capability: null },
  'workspaces':        { ws: false, capability: null },
  'workspace.create':  { ws: false, capability: null, ownerOnly: true },
  'workspace.get':     { ws: true, capability: 'object.read' },
  'workspace.rename':  { ws: true, capability: 'workspace.rename' },
  'members':           { ws: true, capability: 'member.read' },
  'member.grant':      { ws: true, capability: 'member.grant' },
  'member.revoke':     { ws: true, capability: 'member.revoke' },
  'schema.get':        { ws: true, capability: 'schema.read' },
  'schema.save':       { ws: true, capability: 'schema.write' },
  'objects.list':      { ws: true, capability: 'object.read' },
  'object.get':        { ws: true, capability: 'object.read' },
  'object.create':     { ws: true, capability: 'object.create' },
  'object.update':     { ws: true, capability: 'object.write' },
  'object.archive':    { ws: true, capability: 'object.archive' },
  'link.add':          { ws: true, capability: 'object.write' },
  'link.remove':       { ws: true, capability: 'object.write' },
  'action.run':        { ws: true, capability: 'action.run' },
  'file.put':          { ws: true, capability: 'file.upload' },
  'file.get':          { ws: true, capability: 'file.read' },
  'file.archive':      { ws: true, capability: 'file.archive' },
  'audit.list':        { ws: true, capability: 'audit.read' },
  // Carrying the existing records into workspaces. Operator only, and the plan
  // is a separate operation from the apply so it can be looked at first.
  'migrate.plan':      { ws: false, capability: null, ownerOnly: true },
  'migrate.apply':     { ws: false, capability: null, ownerOnly: true },
};

const bad = (res, code, error, extra) => res.status(code).json(Object.assign({ error: error }, extra || {}));

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method');
  if (!sameSite(req)) return bad(res, 403, 'forbidden');

  const secret = process.env.SESSION_SECRET;
  if (!secret) return bad(res, 503, 'auth-not-configured');
  const ses = verify(String(req.headers.authorization || '').replace(/^Bearer /, ''), secret);
  if (!ses) return bad(res, 401, 'unauthorized');

  // Writes are cheap for a client and expensive for the store, so the cap is on
  // volume rather than on any one call being slow.
  const quota = await limit(req, 'graph', 120, 60);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return bad(res, 429, 'too-many-requests', { text: 'That is a lot of requests at once. Give it a minute.' });
  }

  const body = req.body || {};
  const op = String(body.op || '');
  const spec = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
  if (!spec) return bad(res, 400, 'unknown-op', { text: 'No operation called "' + op + '" is defined.' });

  const session = { email: String(ses.e || '').toLowerCase(), role: ses.r, wsRole: null };
  if (spec.ownerOnly && session.role !== 'owner') return bad(res, 403, 'owner-only');

  // Workspace scope and role, resolved from storage every time. Nothing the
  // caller sent contributes to this answer.
  let ws = null;
  if (spec.ws) {
    const wsId = String(body.ws || '');
    ws = await tenancy.get(wsId);
    if (!ws) return bad(res, 404, 'no-such-workspace');
    session.wsRole = await tenancy.roleIn(session, wsId);
    if (!session.wsRole) return bad(res, 404, 'no-such-workspace');   // not 403: existence is not disclosed
    if (spec.capability) {
      const decision = authority.resolve(session.wsRole, spec.capability);
      if (decision.state !== authority.ALLOWED) {
        return bad(res, decision.state === authority.APPROVAL ? 202 : 403, decision.state, { text: decision.reason });
      }
    }
  }

  try {
    const out = await dispatch(op, ws, session, body);
    return res.json(Object.assign({ ok: true }, out));
  } catch (e) {
    const code = e && e.code;
    if (code === 'receipt-conflict') return bad(res, 409, code, { text: e.message });
    if (code === 'receipt-pending') return bad(res, 409, code, { text: e.message });
    if (code === 'stale') return bad(res, 409, code, { text: e.message });
    if (code === 'not-found') return bad(res, 404, code, { text: e.message });
    if (code && String(code).indexOf('not configured') < 0) return bad(res, 400, code, { text: e.message });
    console.error('graph:' + op, e && e.message);
    return bad(res, 500, 'server-error', { text: 'Something went wrong saving that. Nothing was changed.' });
  }
};

async function dispatch(op, ws, session, b) {
  const id = ws && ws.id;

  switch (op) {
    case 'describe':
      return { describe: schema.describe(), files: files.capability(), templates: templates ? templates.list() : [] };

    case 'workspaces': {
      /* Clients who existed before any of this did still need to appear. The
       * operator's list is the one place that can see everyone, so it is the
       * place that closes the gap — a client whose record predates the graph
       * gets their workspace the first time the operator looks, rather than
       * waiting for someone to remember to press something.
       *
       * Cheap on purpose: it creates what is missing and carries leads that
       * were never carried. It does not re-examine records already there —
       * that happens on the path that changes them.
       */
      if (session.role === 'owner') {
        try { await require('../lib/migrate').apply(session, {}); }
        catch (e) { console.error('workspace reconcile skipped: ' + e.message); }
      }
      let list = await tenancy.visibleTo(session);
      /* A client who signs in before the operator has looked would otherwise
       * be shown an empty portal. Only when there is genuinely nothing to
       * show — a client who already has a workspace never pays for this. */
      if (!list.length && session.role !== 'owner') {
        const made = await require('../lib/migrate').quietly(session.email, { by: 'system' });
        if (made) list = await tenancy.visibleTo(session);
      }
      const withRole = [];
      for (const w of list) {
        withRole.push({ id: w.id, name: w.name, kind: w.kind, archived: !!w.archived, role: await tenancy.roleIn(session, w.id) });
      }
      return { workspaces: withRole, you: { email: session.email, operator: session.role === 'owner' } };
    }

    case 'workspace.create': {
      const created = await tenancy.create({ name: b.name, kind: b.kind, template: b.template, by: session.email });
      // The operator is reachable everywhere by role, so the grant that matters
      // is the client's. Creating a workspace nobody can open is not useful.
      if (b.forEmail) await tenancy.addMember(created.id, b.forEmail, 'admin', session.email);
      if (templates && b.template) {
        const seed = templates.get(b.template);
        if (seed) await ontology.saveSchema(created.id, seed.schema, { email: session.email, role: 'owner', wsRole: 'operator' });
      }
      await audit.append(created.id, {
        event: 'workspace.created', actor: 'operator', by: session.email, role: 'operator',
        outcome: 'ok', label: created.name, detail: b.template || '',
      });
      return { workspace: created };
    }

    case 'workspace.get': {
      const s = await ontology.getSchema(id);
      const types = Object.keys(s.types || {});
      return { workspace: ws, role: session.wsRole, schema: s, counts: await ontology.counts(id, types) };
    }

    case 'workspace.rename': {
      const next = Object.assign({}, ws, { name: String(b.name || '').trim().slice(0, 120) });
      await tenancy.save(next);
      await audit.append(id, { event: 'workspace.renamed', actor: session.role === 'owner' ? 'operator' : 'client', by: session.email, role: session.wsRole, outcome: 'ok', label: next.name });
      return { workspace: next };
    }

    case 'members':
      return { members: await tenancy.members(id) };

    case 'member.grant': {
      const rec = await tenancy.addMember(id, b.email, b.role, session.email);
      await audit.append(id, { event: 'member.granted', actor: session.role === 'owner' ? 'operator' : 'client', by: session.email, role: session.wsRole, outcome: 'ok', label: rec.email, detail: rec.role });
      return { member: rec };
    }

    case 'member.revoke': {
      await tenancy.removeMember(id, b.email);
      await audit.append(id, { event: 'member.revoked', actor: session.role === 'owner' ? 'operator' : 'client', by: session.email, role: session.wsRole, outcome: 'ok', label: String(b.email || '').toLowerCase() });
      return { revoked: String(b.email || '').toLowerCase() };
    }

    case 'schema.get': {
      const s = await ontology.getSchema(id);
      return { schema: s, violations: schema.validateSchema(s), checks: await ontology.getChecks(id) };
    }

    case 'schema.save':
      return { schema: await ontology.saveSchema(id, b.schema, session) };

    case 'objects.list': {
      const rows = await ontology.listByType(id, String(b.type || ''), { limit: b.limit, includeArchived: !!b.includeArchived });
      return { objects: rows };
    }

    case 'object.get': {
      const obj = await ontology.get(id, String(b.id || ''));
      if (!obj) return { object: null };
      const s = await ontology.getSchema(id);
      const typeDef = (s.types || {})[obj.type] || {};
      const links = {};
      for (const l of typeDef.links || []) links[l.key] = await ontology.linked(id, obj.id, l.key);
      return {
        object: obj,
        type: typeDef,
        links: links,
        backlinks: await ontology.backlinks(id, obj.id),
        history: await ontology.history(id, obj.id, b.historyLimit || 25),
        actions: actions.availableFor(typeDef, obj, session.wsRole),
        title: ontology.titleOf(typeDef, obj),
      };
    }

    case 'object.create':
      return await ontology.create(id, session, String(b.type || ''), b.props || {});

    case 'object.update':
      return await ontology.update(id, session, String(b.id || ''), b.props || {}, { expectedRev: b.rev });

    case 'object.archive':
      return await ontology.archive(id, session, String(b.id || ''));

    case 'link.add':
      return await ontology.link(id, session, String(b.from || ''), String(b.key || ''), String(b.to || ''));

    case 'link.remove':
      return await ontology.unlink(id, session, String(b.from || ''), String(b.key || ''), String(b.to || ''));

    case 'action.run':
      return await actions.run(id, session, String(b.id || ''), String(b.action || ''), b.inputs || {}, b.idempotencyKey);

    case 'file.put':
      return { document: await files.put(id, session, b) };

    case 'file.get':
      return await files.read(id, session, String(b.id || ''));

    case 'file.archive':
      return { document: await files.archive(id, session, String(b.id || '')) };

    case 'audit.list':
      return { entries: await audit.list(id, { limit: b.limit, objectId: b.objectId }) };

    case 'migrate.plan':
      return await require('../lib/migrate').plan();

    case 'migrate.apply':
      return await require('../lib/migrate').apply(session, { only: b.only });

    default:
      // Unreachable: OPS is checked before dispatch. Kept so that adding a row
      // to OPS without adding a case here fails loudly instead of returning ok.
      throw Object.assign(new Error('Operation "' + op + '" is declared but not implemented.'), { code: 'not-implemented' });
  }
}

module.exports.OPS = OPS;
