/* Redis primitives.
 *
 * The rest of the site talks to Upstash by building a command into the URL
 * path — `kv('set/leads/' + encodeURIComponent(json))`. That works for a flag
 * or a counter and falls apart for anything bigger: URLs have length limits,
 * every value pays base64-ish escaping, and there is no way to send more than
 * one command per round trip. An object graph does neither one big write nor
 * one small read; it does twenty small ones. So this module speaks the POST
 * body form and pipelines.
 *
 * Lives in lib/ on purpose — anything under api/ becomes a public route.
 */

const URL_ = () => process.env.KV_REST_API_URL;
const TOK = () => process.env.KV_REST_API_TOKEN;

const ready = () => !!(URL_() && TOK());

/* Upstash returns { result } on success and { error } on failure. A failed
 * command is not an exception at the HTTP layer, so unwrap deliberately. */
function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
    throw new Error('kv: ' + payload.error);
  }
  return payload ? payload.result : null;
}

/* One command. Arguments go in the body, so a value can be a megabyte of JSON
 * without worrying about what a proxy will do to a long URL. */
async function cmd(...args) {
  if (!ready()) throw new Error('kv: not configured');
  const r = await fetch(URL_(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOK(), 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String)),
  });
  if (!r.ok) throw new Error('kv: HTTP ' + r.status);
  return unwrap(await r.json());
}

/* Many commands, one round trip. Serverless pays a network hop per call and
 * an object read touches the object, its links and its type index — three
 * hops become one. Falls back to sequential calls if the pipeline endpoint
 * ever refuses, so a deployment is never bricked by this optimisation. */
async function pipe(commands) {
  if (!commands.length) return [];
  if (!ready()) throw new Error('kv: not configured');
  try {
    const r = await fetch(URL_() + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOK(), 'Content-Type': 'application/json' },
      body: JSON.stringify(commands.map((c) => c.map(String))),
    });
    if (!r.ok) throw new Error('kv: pipeline HTTP ' + r.status);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error('kv: pipeline shape');
    return rows.map(unwrap);
  } catch (e) {
    const out = [];
    for (const c of commands) out.push(await cmd(...c));
    return out;
  }
}

/* JSON helpers. Storage is a string store; every caller here wants an object,
 * and a corrupt value should read as "absent" rather than throw halfway
 * through rendering a page. */
async function getJson(key, fallback) {
  let raw = null;
  try { raw = await cmd('GET', key); } catch (e) { return fallback === undefined ? null : fallback; }
  if (raw == null) return fallback === undefined ? null : fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback === undefined ? null : fallback; }
}
const setJson = (key, value) => cmd('SET', key, JSON.stringify(value));

/* Read many keys at once and parse each. Used everywhere a set of ids becomes
 * a list of records. */
async function mgetJson(keys) {
  if (!keys.length) return [];
  let raw = [];
  try { raw = await cmd('MGET', ...keys); } catch (e) { return keys.map(() => null); }
  return (raw || []).map((s) => { try { return s == null ? null : JSON.parse(s); } catch (e) { return null; } });
}

const smembers = async (key) => { try { return (await cmd('SMEMBERS', key)) || []; } catch (e) { return []; } };
const sadd = (key, ...m) => cmd('SADD', key, ...m);
const srem = (key, ...m) => cmd('SREM', key, ...m);
const scard = async (key) => { try { return parseInt(await cmd('SCARD', key), 10) || 0; } catch (e) { return 0; } };
const del = (...keys) => cmd('DEL', ...keys);
const exists = async (key) => { try { return (await cmd('EXISTS', key)) === 1; } catch (e) { return false; } };

/* Append-only lists — the audit trail and per-object history. LPUSH puts the
 * newest first, which is the order both are read in, and LTRIM caps growth so
 * one busy workspace cannot grow without bound. */
async function push(key, value, cap) {
  const c = [['LPUSH', key, JSON.stringify(value)]];
  if (cap) c.push(['LTRIM', key, '0', String(cap - 1)]);
  await pipe(c);
}
async function range(key, start, stop) {
  let raw = [];
  try { raw = (await cmd('LRANGE', key, String(start), String(stop))) || []; } catch (e) { return []; }
  return raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

module.exports = {
  ready, cmd, pipe, getJson, setJson, mgetJson,
  smembers, sadd, srem, scard, del, exists, push, range,
};
