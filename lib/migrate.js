/* Moving what already exists into the workspace graph.
 *
 * Three rules, because this touches real client records:
 *
 *   Nothing is destroyed. The existing `leads`, `onboarding` and `deployments`
 *   keys are read and never written. If this migration turns out to be wrong,
 *   the fix is to delete the workspaces and run it again, not to restore a
 *   backup that may not exist.
 *
 *   It can be run twice. Every record carries the id it came from, and a second
 *   run skips anything already carried across rather than creating a duplicate.
 *
 *   It can be looked at before it runs. `plan()` reports exactly what `apply()`
 *   would do, so the first time this runs against real data is not also the
 *   first time anyone sees what it decided.
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

/* What would happen, without anything happening. */
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
      const carried = await ontology.listByType(existing.id, 'inquiry', { includeArchived: true });
      const seen = new Set(carried.map((c) => c.props && c.props.legacyId).filter(Boolean));
      alreadyCarried = leads.filter((l) => seen.has(l.id)).length;
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

/* Do it. `only` restricts the run to one client email, so the first real run
 * can be a single client rather than everyone at once. */
async function apply(session, opts) {
  const o = opts || {};
  const only = o.only ? norm(o.only) : null;
  const the = await plan();
  const legacy = await readLegacy();
  const done = [];

  for (const row of the.clients) {
    if (only && row.email !== only) continue;

    let wsId = row.workspace && row.workspace.id;
    let created = false;
    if (!wsId) {
      const name = row.businessName && row.businessName[0] !== '(' ? row.businessName : row.email;
      const made = await tenancy.create({ name: name, kind: 'local-service', template: 'local-service', by: session.email });
      wsId = made.id;
      created = true;
      await tenancy.addMember(wsId, row.email, 'admin', session.email);
      const seed = templates.get('local-service');
      await ontology.saveSchema(wsId, seed.schema, { email: session.email, role: 'owner', wsRole: 'operator' });
      await audit.append(wsId, {
        event: 'workspace.created', actor: 'operator', by: session.email, role: 'operator',
        outcome: 'ok', label: name, detail: 'carried over from the existing records',
      });
    }

    const wsSchema = await ontology.getSchema(wsId);
    const inquiryType = (wsSchema.types || {}).inquiry;

    // Skip anything already carried, so this is safe to run again.
    const carried = await ontology.listByType(wsId, 'inquiry', { includeArchived: true });
    const seen = new Set(carried.map((c) => c.props && c.props.legacyId).filter(Boolean));
    const mine = legacy.leads.filter((l) => norm(l.to) === row.email && !seen.has(l.id));

    let ok = 0;
    const failed = [];
    const partial = [];
    for (const l of mine) {
      const mapped = leadToInquiry(l, inquiryType);
      try {
        await ontology.create(wsId, { email: session.email, role: 'owner', wsRole: 'operator' }, 'inquiry', mapped.props);
        ok++;
        if (mapped.dropped.length) partial.push({ id: l.id || '(no id)', dropped: mapped.dropped });
      } catch (e) {
        // One malformed old record must not stop the rest. Report it instead —
        // and the original is still in the old store, untouched, to go back to.
        failed.push({ id: l.id || '(no id)', why: e.message });
      }
    }

    done.push({
      email: row.email, workspace: wsId, createdWorkspace: created,
      inquiriesCarried: ok, skippedAlreadyThere: row.inquiriesAlreadyCarried,
      failed: failed, carriedWithFieldsDropped: partial,
    });
  }

  return { migrated: done, note: 'The original records were read and left exactly as they were.' };
}

module.exports = { plan, apply, leadToInquiry, unmapped, ENGAGEMENT_TEMPLATE };
