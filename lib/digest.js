/* Stable digests.
 *
 * Two records that say the same thing must hash the same, whatever order the
 * keys happened to be written in. JSON.stringify does not promise that across
 * objects built by different code paths, so keys are sorted on the way down.
 * Used for idempotency (is this the same request I already answered?) and for
 * change detection (did this object actually change, or was it just re-saved?).
 */
const crypto = require('crypto');

function canonical(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonical);
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (v[k] === undefined) continue;
    out[k] = canonical(v[k]);
  }
  return out;
}

const stableJson = (v) => JSON.stringify(canonical(v));
const digest = (v) => 'sha256:' + crypto.createHash('sha256').update(stableJson(v)).digest('hex');
const shortDigest = (v) => digest(v).slice(7, 19);

module.exports = { canonical, stableJson, digest, shortDigest };
