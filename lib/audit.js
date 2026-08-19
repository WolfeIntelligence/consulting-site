/* The audit trail.
 *
 * Append-only, and not as a convention — this module exports no way to change
 * or remove an entry. There is no update method for a caller to be talked into
 * using. Reading is per workspace and oldest-first, because a trail read
 * backwards is not a trail.
 *
 * An entry is written when something HAS happened. There is no "about to"
 * event: intent is not an outcome, and a trail full of intentions cannot be
 * trusted to describe what the system did.
 */

const kv = require('./kv');
const { digest, shortDigest } = require('./digest');

/* Closed vocabularies. A free-text event name means the trail can never be
 * filtered or counted reliably, because the same thing gets three spellings. */
const EVENTS = [
  'workspace.created', 'workspace.renamed', 'workspace.archived',
  'member.granted', 'member.revoked',
  'object.created', 'object.updated', 'object.archived',
  'link.added', 'link.removed',
  'action.run', 'action.refused',
  'file.uploaded', 'file.archived', 'file.downloaded',
  'schema.updated',
];
const ACTORS = ['operator', 'client', 'system'];
const OUTCOMES = ['ok', 'refused', 'failed'];

const CAP = 5000;            // entries kept per workspace
const trailKey = (wsId) => 'ws:' + wsId + ':audit';
const objectTrailKey = (wsId, objId) => 'ws:' + wsId + ':audit:' + objId;

const trim = (v, n) => String(v == null ? '' : v).slice(0, n);

/* What changed, as field names only. The trail says which fields moved and
 * what they moved from and to; it does not become a second copy of the record.
 */
function changes(before, after) {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const b = (before || {})[k], a = (after || {})[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    out.push({ field: k, from: b === undefined ? null : b, to: a === undefined ? null : a });
  }
  return out;
}

/* Returns the receipt id, so a caller can hand the id back with its result and
 * the trail can be joined to the response without a search. */
async function append(wsId, entry) {
  const at = new Date().toISOString();
  const rec = {
    receipt: 'r_' + shortDigest({ wsId, entry, at, n: Math.random() }),
    at,
    event: EVENTS.includes(entry.event) ? entry.event : 'action.run',
    actor: ACTORS.includes(entry.actor) ? entry.actor : 'system',
    by: trim(entry.by, 200).toLowerCase(),
    role: trim(entry.role, 20),
    outcome: OUTCOMES.includes(entry.outcome) ? entry.outcome : 'ok',
    type: trim(entry.type, 60),
    objectId: trim(entry.objectId, 80),
    label: trim(entry.label, 160),
    detail: trim(entry.detail, 2000),
    changes: Array.isArray(entry.changes) ? entry.changes.slice(0, 40) : [],
  };
  const cmds = [['LPUSH', trailKey(wsId), JSON.stringify(rec)], ['LTRIM', trailKey(wsId), '0', String(CAP - 1)]];
  // A second, shorter trail per object, so "what happened to this lead" does
  // not mean scanning five thousand workspace entries.
  if (rec.objectId) {
    cmds.push(['LPUSH', objectTrailKey(wsId, rec.objectId), JSON.stringify(rec)]);
    cmds.push(['LTRIM', objectTrailKey(wsId, rec.objectId), '0', '199']);
  }
  try { await kv.pipe(cmds); } catch (e) { /* a trail that cannot be written must not fail the work it describes */ }
  return rec.receipt;
}

/* Oldest first. The stored list is newest-first because LPUSH is cheap; the
 * reversal happens here, once, rather than in every caller. */
async function list(wsId, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(500, o.limit || 100));
  const key = o.objectId ? objectTrailKey(wsId, o.objectId) : trailKey(wsId);
  const rows = await kv.range(key, 0, limit - 1);
  return rows.reverse();
}

module.exports = { EVENTS, ACTORS, OUTCOMES, append, list, changes };
