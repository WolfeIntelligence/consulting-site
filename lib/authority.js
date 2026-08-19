/* Authority resolution.
 *
 * Every action resolves to exactly one of four states, and the fourth is the
 * one that matters: an action nobody classified is not quietly allowed, it
 * escalates. A boolean `can()` has only two answers and so has to guess at the
 * third and fourth, which is how a permission check ends up granting something
 * nobody decided to grant.
 *
 * Adapted from the operating contract in Wolfe OS. The rule there was:
 * "Consequence, importance, risk, reversibility, cost, external effect, and
 * truth impact may inform owner policy. They do not replace policy." So this
 * file is a table, not a heuristic. Nothing here reads the shape of a request
 * and decides it feels risky.
 */

const ALLOWED = 'allowed';
const APPROVAL = 'approval-required';
const FORBIDDEN = 'forbidden';
const UNCLASSIFIED = 'unclassified';

/* Effects that no role reaches through this API, ever. They are listed rather
 * than merely absent so that adding a role cannot accidentally grant one. */
const FORBIDDEN_EFFECTS = [
  'workspace.delete',      // archive instead; nothing here destroys a client's record
  'audit.rewrite',         // the trail is append-only by construction and by policy
  'member.self-elevate',   // a role is granted by the operator, never claimed
  'schema.delete-type',    // a type with objects under it is retired, not removed
];

/* role -> capability -> state. Absent means unclassified, which escalates.
 *
 *   operator  Zach. The control plane.
 *   admin     the client's own principal — the owner of that business.
 *   member    staff at the client, doing the daily work.
 *   viewer    read-only: an accountant, a spouse, a partner.
 */
const POLICY = {
  operator: {
    'object.read': ALLOWED, 'object.write': ALLOWED, 'object.create': ALLOWED,
    'object.archive': ALLOWED, 'action.run': ALLOWED, 'file.read': ALLOWED,
    'file.upload': ALLOWED, 'file.archive': ALLOWED, 'audit.read': ALLOWED,
    'member.read': ALLOWED, 'member.grant': ALLOWED, 'member.revoke': ALLOWED,
    'schema.read': ALLOWED, 'schema.write': ALLOWED, 'workspace.create': ALLOWED,
    'workspace.archive': ALLOWED, 'workspace.rename': ALLOWED,
  },
  admin: {
    'object.read': ALLOWED, 'object.write': ALLOWED, 'object.create': ALLOWED,
    'object.archive': ALLOWED, 'action.run': ALLOWED, 'file.read': ALLOWED,
    'file.upload': ALLOWED, 'file.archive': ALLOWED, 'audit.read': ALLOWED,
    'member.read': ALLOWED, 'member.grant': APPROVAL, 'member.revoke': ALLOWED,
    'schema.read': ALLOWED, 'schema.write': APPROVAL,
    'workspace.rename': ALLOWED, 'workspace.archive': FORBIDDEN,
  },
  member: {
    'object.read': ALLOWED, 'object.write': ALLOWED, 'object.create': ALLOWED,
    'object.archive': APPROVAL, 'action.run': ALLOWED, 'file.read': ALLOWED,
    'file.upload': ALLOWED, 'file.archive': APPROVAL, 'audit.read': ALLOWED,
    'member.read': ALLOWED, 'member.grant': FORBIDDEN, 'member.revoke': FORBIDDEN,
    'schema.read': ALLOWED, 'schema.write': FORBIDDEN,
    'workspace.rename': FORBIDDEN, 'workspace.archive': FORBIDDEN,
  },
  viewer: {
    'object.read': ALLOWED, 'file.read': ALLOWED, 'schema.read': ALLOWED,
    'member.read': ALLOWED, 'audit.read': FORBIDDEN,
    'object.write': FORBIDDEN, 'object.create': FORBIDDEN, 'object.archive': FORBIDDEN,
    'action.run': FORBIDDEN, 'file.upload': FORBIDDEN, 'file.archive': FORBIDDEN,
    'member.grant': FORBIDDEN, 'member.revoke': FORBIDDEN, 'schema.write': FORBIDDEN,
    'workspace.rename': FORBIDDEN, 'workspace.archive': FORBIDDEN,
  },
};

const CAPABILITIES = [...new Set(Object.values(POLICY).flatMap((m) => Object.keys(m)))].sort();

/* The whole point of the module. Returns a state and a reason; callers act on
 * the state and show the reason. No caller compares role strings. */
function resolve(role, capability) {
  if (FORBIDDEN_EFFECTS.includes(capability)) {
    return { state: FORBIDDEN, reason: 'That effect is not reachable through this interface.' };
  }
  if (!role || !POLICY[role]) {
    return { state: FORBIDDEN, reason: 'No access to this workspace.' };
  }
  const state = POLICY[role][capability];
  if (!state) {
    return {
      state: UNCLASSIFIED,
      reason: 'No policy covers "' + capability + '" for a ' + role + '. It needs a decision before it can run.',
    };
  }
  const a = 'aeiou'.includes(role[0]) ? 'An ' : 'A ';
  const reason = state === ALLOWED ? ''
    : state === APPROVAL ? a + role + ' may request this; Wolfe Intelligence approves it.'
    : a + role + ' may not do this.';
  return { state, reason };
}

/* Convenience for the common read path. Deliberately NOT named `can`, because
 * it collapses four states into two and every use of it is a place that has
 * decided approval-required and unclassified both mean "no, not now". */
const isAllowed = (role, capability) => resolve(role, capability).state === ALLOWED;

module.exports = {
  ALLOWED, APPROVAL, FORBIDDEN, UNCLASSIFIED,
  FORBIDDEN_EFFECTS, POLICY, CAPABILITIES, resolve, isAllowed,
};
