/* The action framework: governed write-back.
 *
 * A client does not edit a record's fields directly in the parts of the portal
 * that matter. They press a named thing — "Mark this job won", "Book the
 * estimate" — and that named thing decides what changes, stamps when it
 * happened, records who did it, and is refused if their role does not reach it.
 *
 * Actions are declared as data on the type (see lib/schema.js), never as code
 * here. That is what lets one definition drive the button, the API call, the
 * audit entry and the permission check without any of them deciding separately
 * and disagreeing.
 *
 * Two ideas are carried over from Wolfe OS deliberately:
 *   - `requiresOwner`: a client may ASK for something without being able to
 *     complete it. That is a different state from "forbidden", and the person
 *     gets the right sentence.
 *   - the event is written when something HAS happened. There is no "about to
 *     run" entry, because intent is not an outcome.
 */

const ontology = require('./ontology');
const authority = require('./authority');
const audit = require('./audit');
const receipts = require('./receipts');
const T = require('./types');

class Refused extends Error {
  constructor(message, code) { super(message); this.code = code || 'refused'; }
}

/* Which actions this session may see on this record right now. The screen asks
 * for this rather than deciding for itself, so a button never appears that the
 * API would then refuse. */
function availableFor(typeDef, obj, wsRole) {
  const out = [];
  for (const a of (typeDef && typeDef.actions) || []) {
    const decision = authority.resolve(wsRole, a.effect === 'read' ? 'object.read' : 'action.run');
    if (decision.state === authority.FORBIDDEN) continue;
    const blocked = preconditionFailure(a, obj);
    out.push({
      key: a.key,
      label: a.label,
      hint: a.hint || '',
      effect: a.effect,
      risk: a.risk,
      confirm: !!a.confirm,
      inputs: a.inputs || [],
      // 'available' | 'needs-approval' | 'unavailable'
      state: blocked ? 'unavailable'
        : decision.state === authority.ALLOWED && (!a.requiresOwner || wsRole === 'operator') ? 'available'
        : 'needs-approval',
      reason: blocked || (a.requiresOwner && wsRole !== 'operator'
        ? 'Wolfe Intelligence completes this one.'
        : decision.state === authority.ALLOWED ? ''
        : decision.reason),
    });
  }
  return out;
}

/* An action that does not apply to the record as it stands says so, rather
 * than running and doing nothing. `when` compares against the record's current
 * property values only — an action never reaches outside the record it acts on. */
function preconditionFailure(action, obj) {
  const props = (obj && obj.props) || {};
  for (const k of Object.keys(action.when || {})) {
    const want = action.when[k];
    const have = props[k];
    const match = Array.isArray(want) ? want.indexOf(have) >= 0 : want === have;
    if (!match) return action.whenFails || 'That does not apply to this record right now.';
  }
  return '';
}

/* Run one action.
 *
 * The order matters and is the same order the record-write path uses: resolve
 * authority, check the precondition, build the patch, and only then write. A
 * refused action changes nothing at all — it does not half-apply and then stop.
 */
async function run(ws, session, objectId, actionKey, inputs, idempotencyKey) {
  const obj = await ontology.get(ws, objectId);
  if (!obj) throw new Refused('That record no longer exists.', 'not-found');
  if (obj.archived) throw new Refused('That record is archived.', 'archived');

  const s = await ontology.getSchema(ws);
  const typeDef = (s.types || {})[obj.type];
  const action = ((typeDef && typeDef.actions) || []).find((a) => a.key === actionKey);
  if (!action) throw new Refused('There is no "' + actionKey + '" on a ' + obj.type + '.', 'unknown-action');

  const decision = authority.resolve(session.wsRole, action.effect === 'read' ? 'object.read' : 'action.run');
  if (decision.state !== authority.ALLOWED) {
    await audit.append(ws, {
      event: 'action.refused', actor: session.role === 'owner' ? 'operator' : 'client',
      by: session.email, role: session.wsRole, outcome: 'refused',
      type: obj.type, objectId: objectId, label: action.label, detail: decision.state + ': ' + decision.reason,
    });
    throw new Refused(decision.reason, decision.state);
  }
  if (action.requiresOwner && session.wsRole !== 'operator') {
    await audit.append(ws, {
      event: 'action.refused', actor: 'client', by: session.email, role: session.wsRole,
      outcome: 'refused', type: obj.type, objectId: objectId, label: action.label,
      detail: 'requires the operator',
    });
    throw new Refused('Wolfe Intelligence completes this one. It has been noted.', authority.APPROVAL);
  }
  /* The same press twice — a double tap, a retry after a timeout — must not
   * stamp two different times or double a counter.
   *
   * Two ordering decisions here, both learned by getting them wrong:
   *
   * The payload deliberately does NOT include the record's revision. A
   * successful run bumps it, so hashing it would make every honest retry look
   * like a different request and come back as a conflict — defeating the one
   * case receipts exist for.
   *
   * And the precondition is checked INSIDE this, not before it. A successful
   * run is exactly what makes the precondition stop holding: press "mark
   * finished", the connection drops, the phone retries, and the job is now
   * finished — so the retry would be told the job is already finished instead
   * of being handed the answer the first press earned. Authority is still
   * resolved above, because who you are does not change on a retry.
   */
  const payload = { objectId: objectId, actionKey: actionKey, inputs: inputs || {} };
  const outcome = await receipts.once(ws, idempotencyKey, payload, async () => {
    const blocked = preconditionFailure(action, obj);
    if (blocked) {
      await audit.append(ws, {
        event: 'action.refused', actor: session.role === 'owner' ? 'operator' : 'client',
        by: session.email, role: session.wsRole, outcome: 'refused',
        type: obj.type, objectId: objectId, label: action.label, detail: 'does not apply: ' + blocked,
      });
      throw new Refused(blocked, 'precondition');
    }
    const patch = {};

    // Declared constants first, then the caller's inputs, so a client cannot
    // override what the action says it always does by naming the same key.
    const props = (typeDef.properties || []).map(T.property);
    const byKey = {};
    for (const p of props) byKey[p.key] = p;

    for (const inp of action.inputs || []) {
      const p = byKey[inp.key];
      if (!p) continue;
      const raw = (inputs || {})[inp.key];
      if (raw == null || raw === '') {
        if (inp.required) throw new Refused((inp.label || inp.key) + ' is needed to do that.', 'input-required');
        continue;
      }
      patch[inp.key] = raw;
    }
    for (const k of Object.keys(action.sets || {})) patch[k] = action.sets[k];

    // Stamps record WHEN something reached a state. Set once and never moved:
    // clearing an outcome and setting it again keeps the moment it first
    // happened, because that is the moment the funnel is measuring.
    const now = new Date().toISOString();
    for (const k of action.stamps || []) {
      if (!obj.props[k]) patch[k] = now;
    }

    const result = await ontology.update(ws, session, objectId, patch, { expectedRev: obj.rev });
    await audit.append(ws, {
      event: 'action.run', actor: session.role === 'owner' ? 'operator' : 'client',
      by: session.email, role: session.wsRole, outcome: 'ok',
      type: obj.type, objectId: objectId, label: action.label,
      detail: action.key, changes: audit.changes(obj.props, result.object.props),
    });
    return { object: result.object, action: action.key, label: action.label };
  });

  return { result: outcome.result, replayed: outcome.replayed };
}

module.exports = { Refused, run, availableFor, preconditionFailure };
