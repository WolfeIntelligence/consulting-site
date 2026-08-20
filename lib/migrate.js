/* Keeping the workspace graph in step with the records that already exist.
 *
 * This started life as a one-time migration with a plan step and a go button.
 * That was the wrong shape: a client's workspace should exist because the
 * client exists, not because someone remembered to press something. So the
 * work here is idempotent and gets called from the places where a client
 * actually comes into being:
 *
 *   - saving an engagement record in the console  -> api/apps.js
 *   - a lead arriving from a client's own site    -> api/lead.js
 *   - the operator listing workspaces             -> api/graph.js
 *
 * `ensureFor(email)` is the whole idea: after it returns, that client has a
 * workspace, is the admin of it, and every inquiry ever captured for them is
 * inside it. Calling it twice does nothing the second time.
 *
 * Three rules, because this touches real client records:
 *
 *   Nothing is destroyed. The existing `leads`, `onboarding` and `deployments`
 *   keys are read and never written. If this turns out to be wrong, the fix is
 *   to delete the workspaces and let them rebuild, not to restore a backup
 *   that may not exist.
 *
 *   It can be run twice. Every carried record keeps the id it came from, and a
 *   second pass skips anything already carried rather than duplicating it.
 *
 *   It can be looked at before it runs. `plan()` reports what `apply()` would
 *   do without doing any of it. Nothing calls it automatically — it is there
 *   so the state of the carry can be inspected, not so it can be approved.
 */

const kv = require('./kv');
const tenancy = require('./tenancy');
const ontology = require('./ontology');
const templates = require('./templates');
const audit = require('./audit');
const T = require('./types');

/* The engagement type on an onboarding record decides which template a new
 * workspace is seeded from. A client is always a local service business first —
 * the engagement is a thing being done FOR them, not what they are. */
const ENGAGEMENT_TEMPLATE = {
  google: 'engagement-google',
  ai: 'engagement-ai',
  automation: 'engagement-automation',
};

const norm = (e) => String(e || '').trim().toLowerCase();

/* Which old lead became which object in a workspace.
 *
 * A map rather than a set of ids, because there are two questions to answer
 * and only one of them is "have I seen this". When an outcome changes on a
 * lead — contacted, booked, won — the workspace copy has to change with it,
 * and that needs to know which record to go and change.
 *
 * Kept as its own small index rather than derived by reading every inquiry. A
 * lead arriving is on the critical path of someone's quote request: reading a
 * few hundred bytes of ids beats reading every record in the workspace.
 */
const legacyKey = (wsId) => 'ws:' + wsId + ':legacy';

async function carriedIds(wsId) {
  const map = await kv.hgetall(legacyKey(wsId));
  if (Object.keys(map).length) return map;
  /* Empty means either nothing has been carried, or this workspace predates
   * the index. Rebuild it from the records themselves once, so the cheap path
   * is right from then on. */
  const rows = await ontology.listByType(wsId, 'inquiry', { includeArchived: true });
  const found = {};
  for (const r of rows) {
    const lid = r.props && r.props.legacyId;
    if (lid) found[lid] = r.id;
  }
  for (const lid of Object.keys(found)) await kv.hset(legacyKey(wsId), lid, found[lid]);
  return found;
}

async function readLegacy() {
  const [leads, onboarding] = await Promise.all([
    kv.getJson('leads', []),
    kv.getJson('onboarding', []),
  ]);
  return {
    leads: Array.isArray(leads) ? leads : [],
    onboarding: Array.isArray(onboarding) ? onboarding : [],
  };
}

/* Which workspace already stands for a given client email. Matching on the
 * membership index rather than on the name, because a business can be renamed
 * and an email is what the login actually keys on. */
async function existingWorkspaceFor(email) {
  const ids = await kv.smembers('user:' + norm(email) + ':ws');
  if (!ids.length) return null;
  const rows = await kv.mgetJson(ids.map((i) => 'ws:' + i));
  return (rows.filter(Boolean)[0]) || null;
}

/* This client has a workspace, is the admin of it, and their history is in it.
 *
 * Everything downstream of a client existing goes through here, so there is
 * one answer to "what does a new client get" rather than one per call site.
 *
 * opts.record  the engagement record, when the caller already has it in hand
 * opts.leads   carry only these, instead of everything on file for the email
 * opts.by      who is causing this; 'system' when nobody pressed anything
 */
async function ensureFor(email, opts) {
  const o = opts || {};
  const e = norm(email);
  if (!e || e.indexOf('@') < 0) return null;

  const by = norm(o.by) || 'system';
  const session = { email: by, role: 'owner', wsRole: 'operator' };

  let rec = o.record || null;
  if (!rec) {
    const onb = await kv.getJson('onboarding', []);
    rec = (Array.isArray(onb) ? onb : []).find((r) => norm(r.email) === e) || null;
  }

  let ws = await existingWorkspaceFor(e);
  let created = false;
  if (!ws) {
    const named = rec && String(rec.businessName || '').trim();
    ws = await tenancy.create({
      name: named || e, kind: 'local-service', template: 'local-service', by: by,
    });
    created = true;
    await ontology.saveSchema(ws.id, templates.get('local-service').schema, session);
    await audit.append(ws.id, {
      event: 'workspace.created', actor: by === 'system' ? 'system' : 'operator',
      by: by, role: 'operator', outcome: 'ok', label: ws.name,
      detail: created && rec ? 'opened with the client record' : 'opened for an existing client',
    });
  }
  /* Membership is checked every time, not only on creation, so a workspace
   * whose client somehow lost their seat repairs itself rather than staying
   * broken. Only written when it is actually missing — re-granting on every
   * lead would keep resetting the date the client was given access, which is
   * a fact the trail is supposed to hold on to. */
  if (!(await tenancy.membership(ws.id, e))) {
    await tenancy.addMember(ws.id, e, 'admin', by);
    await audit.append(ws.id, {
      event: 'member.granted', actor: by === 'system' ? 'system' : 'operator',
      by: by, role: 'operator', outcome: 'ok', label: e,
      detail: created ? 'the client this workspace is for' : 'restored: the client was not a member of their own workspace',
    });
  }

  const carry = await backfill(ws.id, e, session, o.leads, { refresh: !!o.refresh });
  return {
    workspace: ws, created: created,
    carried: carry.carried, updated: carry.updated, skipped: carry.skipped,
    failed: carry.failed, partial: carry.partial,
  };
}

/* Move any of this client's leads that are not in the workspace yet.
 *
 * `refresh` also brings already-carried records back into step with the lead
 * they came from. It costs a read per record, so it is off by default and
 * turned on only at the one call site that knows something changed — the
 * console saving an outcome on a specific lead. A list of workspaces does not
 * need to re-examine every inquiry to draw itself.
 */
async function backfill(wsId, email, session, leadsIn, opts) {
  const refresh = !!(opts && opts.refresh);
  let leads = leadsIn;
  if (!Array.isArray(leads)) {
    const all = await kv.getJson('leads', []);
    leads = (Array.isArray(all) ? all : []).filter((l) => norm(l.to) === norm(email));
  }
  const out = { carried: 0, updated: 0, skipped: 0, failed: [], partial: [] };
  if (!leads.length) return out;

  const seen = await carriedIds(wsId);
  const fresh = leads.filter((l) => l && l.id && !seen[l.id]);
  const already = leads.filter((l) => l && l.id && seen[l.id]);
  out.skipped = already.length;
  if (!fresh.length && !(refresh && already.length)) return out;

  const schema = await ontology.getSchema(wsId);
  const inquiryType = (schema.types || {}).inquiry;
  if (!inquiryType) {
    out.failed.push({ id: '(all)', why: 'this workspace has no inquiry type' });
    return out;
  }

  for (const l of fresh) {
    const mapped = leadToInquiry(l, inquiryType);
    try {
      const made = await ontology.create(wsId, session, 'inquiry', mapped.props);
      await kv.hset(legacyKey(wsId), l.id, made.object.id);
      out.carried++;
      if (mapped.dropped.length) out.partial.push({ id: l.id, dropped: mapped.dropped });
    } catch (err) {
      /* One malformed old record must not stop the rest. Report it instead —
       * and the original is still in the old store, untouched, to go back to. */
      out.failed.push({ id: l.id || '(no id)', why: err.message });
    }
  }

  if (!refresh) return out;

  for (const l of already) {
    const mapped = leadToInquiry(l, inquiryType);
    try {
      const obj = await ontology.get(wsId, seen[l.id]);
      if (!obj || obj.archived) continue;
      /* Only what actually moved. Writing an identical record would bump the
       * revision and put a line in the trail saying nothing happened. */
      const patch = {};
      for (const k of Object.keys(mapped.props)) {
        if (k === 'legacyId') continue;
        if (obj.props[k] !== mapped.props[k]) patch[k] = mapped.props[k];
      }
      if (!Object.keys(patch).length) continue;
      await ontology.update(wsId, session, obj.id, patch, { expectedRev: obj.rev });
      out.updated++;
    } catch (err) {
      out.failed.push({ id: l.id, why: err.message });
    }
  }
  return out;
}

/* What would happen, without anything happening. Nothing calls this on its
 * own; it exists so the carry can be inspected. */
async function plan() {
  const legacy = await readLegacy();
  const byEmail = {};
  for (const o of legacy.onboarding) {
    const e = norm(o.email);
    if (e) byEmail[e] = o;
  }
  // A lead can exist for a client who has no onboarding record — the form is
  // live before the engagement is written down. Those still need a home.
  for (const l of legacy.leads) {
    const e = norm(l.to);
    if (e && !byEmail[e]) byEmail[e] = { email: e, businessName: '', engagement: 'google', orphan: true };
  }

  const rows = [];
  for (const email of Object.keys(byEmail)) {
    const rec = byEmail[email];
    const existing = await existingWorkspaceFor(email);
    const leads = legacy.leads.filter((l) => norm(l.to) === email);
    let alreadyCarried = 0;
    if (existing) {
      const seen = await carriedIds(existing.id);
      alreadyCarried = leads.filter((l) => seen[l.id]).length;
    }
    rows.push({
      email: email,
      businessName: rec.businessName || '(no business name on record)',
      engagement: rec.engagement || 'google',
      fromOnboarding: !rec.orphan,
      workspace: existing ? { id: existing.id, name: existing.name } : null,
      willCreateWorkspace: !existing,
      inquiries: leads.length,
      inquiriesAlreadyCarried: alreadyCarried,
      inquiriesToCarry: leads.length - alreadyCarried,
      hasIntake: !!(rec.intake && Object.keys(rec.intake).length),
      steps: (rec.steps || []).length,
      spendMonths: Object.keys(rec.spend || {}).length,
    });
  }
  rows.sort((a, b) => b.inquiries - a.inquiries);
  // Whether the target type can actually hold everything the old records carry.
  const inquiryType = ((templates.get('local-service') || {}).schema || {}).types.inquiry;
  return {
    clients: rows,
    totals: {
      clients: rows.length,
      workspacesToCreate: rows.filter((r) => r.willCreateWorkspace).length,
      inquiriesToCarry: rows.reduce((n, r) => n + r.inquiriesToCarry, 0),
      leadsInStore: legacy.leads.length,
      onboardingInStore: legacy.onboarding.length,
    },
    fieldsWithNoHome: unmapped(legacy.leads, inquiryType),
  };
}

/* Map one stored lead onto the inquiry type.
 *
 * Driven by the schema rather than a hand-written list of fields. A list here
 * would start out matching the template and quietly stop the first time either
 * side gained a column — and the failure would be silent data loss, which is
 * the worst kind. Anything the lead carries that the type declares comes
 * across; anything it does not is reported by `unmapped()` rather than dropped.
 *
 * A single value the type will not accept costs that value, not the whole
 * record. These are historical records with no second copy — carrying nineteen
 * fields and reporting the twentieth beats refusing all twenty because one old
 * row holds something unexpected.
 */
function leadToInquiry(lead, inquiryType) {
  const props = ((inquiryType && inquiryType.properties) || []).map(T.property);
  const byKey = {};
  for (const p of props) byKey[p.key] = p;
  const keys = new Set(Object.keys(byKey));
  const out = {};
  const dropped = [];
  const offer = (k, v) => {
    const p = byKey[k];
    if (!p || v == null || v === '') return;
    const err = T.validate(p, T.coerce(p, v));
    if (err) { dropped.push({ field: k, value: String(v).slice(0, 60), why: err }); return; }
    out[k] = v;
  };
  for (const k of Object.keys(lead || {})) {
    if (k === 'id' || k === 'to') continue;              // handled below
    if (keys.has(k)) offer(k, lead[k]);
  }
  // The utm block is stored nested and flattened on the type.
  const utm = lead.utm || {};
  offer('utmSource', utm.source);
  offer('utmMedium', utm.medium);
  offer('utmCampaign', utm.campaign);
  if (keys.has('legacyId')) out.legacyId = lead.id || '';
  offer('to', lead.to);
  return { props: out, dropped: dropped };
}

/* Anything in the old records that the type has nowhere to put. Reported by
 * plan() so the gap is seen before the move, not discovered afterwards. */
function unmapped(leads, inquiryType) {
  const keys = new Set(((inquiryType && inquiryType.properties) || []).map((p) => p.key));
  const nested = new Set(['utm', 'id']);
  const missing = new Set();
  for (const l of leads || []) {
    for (const k of Object.keys(l || {})) {
      if (nested.has(k) || keys.has(k)) continue;
      missing.add(k);
    }
  }
  return [...missing];
}

/* Every client on file, brought up to date. This is what the operator's
 * workspace list calls, so a client who existed before any of this did shows
 * up without anyone having to ask for them.
 *
 * `only` restricts the pass to one email.
 */
async function apply(session, opts) {
  const o = opts || {};
  const only = o.only ? norm(o.only) : null;
  const legacy = await readLegacy();
  const by = (session && session.email) || 'system';

  const emails = {};
  for (const r of legacy.onboarding) {
    const e = norm(r.email);
    if (e) emails[e] = r;
  }
  for (const l of legacy.leads) {
    const e = norm(l.to);
    if (e && !emails[e]) emails[e] = null;
  }

  const done = [];
  for (const email of Object.keys(emails)) {
    if (only && email !== only) continue;
    const leads = legacy.leads.filter((l) => norm(l.to) === email);
    const r = await ensureFor(email, { record: emails[email], leads: leads, by: by, refresh: !!o.refresh });
    if (!r) continue;
    done.push({
      email: email, workspace: r.workspace.id, createdWorkspace: r.created,
      inquiriesCarried: r.carried, inquiriesUpdated: r.updated,
      skippedAlreadyThere: r.skipped,
      failed: r.failed, carriedWithFieldsDropped: r.partial,
    });
  }

  return { migrated: done, note: 'The original records were read and left exactly as they were.' };
}

/* Fire-and-forget wrapper for the call sites where this must never be the
 * reason a request fails. A lead is captured whether or not the graph copy
 * succeeds; the same goes for saving an engagement record. The original store
 * is still the source of truth for anything not yet carried, so a failure here
 * costs a retry, not a record.
 */
async function quietly(email, opts) {
  try {
    return await ensureFor(email, opts);
  } catch (e) {
    console.error('workspace sync for ' + norm(email) + ' did not complete: ' + e.message);
    return null;
  }
}

module.exports = {
  ensureFor, quietly, backfill, plan, apply,
  leadToInquiry, unmapped, ENGAGEMENT_TEMPLATE, carriedIds,
};
