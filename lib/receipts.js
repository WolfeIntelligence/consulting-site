/* Idempotency receipts.
 *
 * A client on a slow phone taps "Save" twice. A retry fires after a timeout
 * that had already succeeded. Without this, the second one creates a second
 * lead, or reverses a decision the first one made.
 *
 * Every mutation carries a key. The same key with the same payload replays the
 * stored answer. The same key with a DIFFERENT payload is a conflict and fails
 * closed rather than picking one — two different requests wearing one key is a
 * bug somewhere, and guessing which was meant is how the wrong one wins.
 */

const kv = require('./kv');
const { digest } = require('./digest');

const TTL = 86400;           // a day is long past any legitimate retry
const key = (wsId, k) => 'ws:' + wsId + ':receipt:' + k;

class Conflict extends Error {
  constructor() { super('That request was already made with different details. Nothing was changed.'); this.code = 'receipt-conflict'; }
}

/* Runs `work` at most once per (workspace, idempotency key). Returns
 * { result, replayed }. Passing no key runs the work unguarded — callers that
 * genuinely cannot produce one say so by omission rather than by inventing a
 * random key, which would guard nothing. */
async function once(wsId, idempotencyKey, payload, work) {
  if (!idempotencyKey) return { result: await work(), replayed: false };
  const k = key(wsId, String(idempotencyKey).slice(0, 120));
  const hash = digest(payload || {});
  const prior = await kv.getJson(k);
  if (prior) {
    if (prior.hash !== hash) throw new Conflict();
    // A receipt with no result is a run that died partway. Re-running could
    // repeat a half-finished effect, so it stops and says so.
    if (!('result' in prior)) {
      const e = new Error('That request is still finishing. Give it a moment, then check before trying again.');
      e.code = 'receipt-pending';
      throw e;
    }
    return { result: prior.result, replayed: true };
  }
  await kv.setJson(k, { hash, at: new Date().toISOString() });
  await kv.cmd('EXPIRE', k, String(TTL));
  let result;
  try {
    result = await work();
  } catch (e) {
    // Do not leave a pending receipt behind to block the honest retry.
    try { await kv.del(k); } catch (e2) {}
    throw e;
  }
  await kv.setJson(k, { hash, at: new Date().toISOString(), result });
  await kv.cmd('EXPIRE', k, String(TTL));
  return { result, replayed: false };
}

module.exports = { once, Conflict };
