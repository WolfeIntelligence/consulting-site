/* An in-memory Redis that speaks Upstash's REST shapes.
 *
 * Two shapes, because the codebase uses two. The older modules build the
 * command into the URL path (`/set/key/value`); lib/kv.js posts the command as
 * a JSON array, and pipelines an array of those. Both land here so a test can
 * exercise old and new code against one store.
 *
 * Strings, sets, hashes and lists — the four types the ontology uses. Enough
 * to catch a wrong key or a lost member, which is what these tests are for.
 */

function makeKv(host) {
  const strings = new Map();
  const sets = new Map();
  const hashes = new Map();
  const lists = new Map();

  const S = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const H = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  const L = (k) => { if (!lists.has(k)) lists.set(k, []); return lists.get(k); };
  const has = (k) => strings.has(k) || sets.has(k) || hashes.has(k) || lists.has(k);

  function run(args) {
    const c = String(args[0]).toUpperCase();
    const a = args.slice(1).map(String);
    switch (c) {
      case 'GET': return strings.has(a[0]) ? strings.get(a[0]) : null;
      case 'SET': strings.set(a[0], a[1]); return 'OK';
      case 'MGET': return a.map((k) => (strings.has(k) ? strings.get(k) : null));
      case 'DEL': {
        let n = 0;
        for (const k of a) { if (has(k)) n++; strings.delete(k); sets.delete(k); hashes.delete(k); lists.delete(k); }
        return n;
      }
      case 'EXISTS': return has(a[0]) ? 1 : 0;
      case 'INCR': { const n = (parseInt(strings.get(a[0]) || '0', 10) || 0) + 1; strings.set(a[0], String(n)); return n; }
      case 'EXPIRE': return 1;
      case 'TTL': return 600;
      case 'SADD': { const s = S(a[0]); let n = 0; for (const m of a.slice(1)) if (!s.has(m)) { s.add(m); n++; } return n; }
      case 'SREM': { const s = S(a[0]); let n = 0; for (const m of a.slice(1)) if (s.delete(m)) n++; return n; }
      case 'SMEMBERS': return [...S(a[0])];
      case 'SCARD': return S(a[0]).size;
      case 'SISMEMBER': return S(a[0]).has(a[1]) ? 1 : 0;
      case 'HINCRBY': { const h = H(a[0]); const n = (parseInt(h.get(a[1]) || '0', 10) || 0) + parseInt(a[2], 10); h.set(a[1], String(n)); return n; }
      case 'HSET': { const h = H(a[0]); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], String(a[i + 1])); } return n; }
      case 'HGET': { const h = H(a[0]); return h.has(a[1]) ? h.get(a[1]) : null; }
      case 'HDEL': { const h = H(a[0]); let n = 0; for (const f of a.slice(1)) if (h.delete(f)) n++; return n; }
      case 'HGETALL': { const out = []; for (const [k, v] of H(a[0])) out.push(k, String(v)); return out; }
      case 'LPUSH': { const l = L(a[0]); for (const v of a.slice(1)) l.unshift(v); return l.length; }
      case 'LTRIM': { const l = L(a[0]); const stop = parseInt(a[2], 10); lists.set(a[0], l.slice(parseInt(a[1], 10), stop < 0 ? undefined : stop + 1)); return 'OK'; }
      case 'LRANGE': {
        const l = L(a[0]); const start = parseInt(a[1], 10); let stop = parseInt(a[2], 10);
        return l.slice(start, stop < 0 ? l.length + stop + 1 : stop + 1);
      }
      case 'LLEN': return L(a[0]).length;
      default: throw new Error('kvmock: unsupported command ' + c);
    }
  }

  const base = 'https://' + host;
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });

  async function handle(url, opt) {
    const u = String(url);
    if (!u.startsWith(base)) throw new Error('kvmock: unexpected fetch ' + u);
    const method = (opt && opt.method) || 'GET';
    // POST body form: one command, or an array of commands at /pipeline.
    if (method === 'POST') {
      const body = JSON.parse(opt.body);
      if (u === base + '/pipeline') {
        return { ok: true, status: 200, json: async () => body.map((c) => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } }) };
      }
      return reply(run(body));
    }
    // URL path form, used by the older modules.
    const parts = u.slice(base.length + 1).split('/').map(decodeURIComponent);
    return reply(run(parts));
  }

  return { handle, strings, sets, hashes, lists, run, dump: () => ({ strings, sets, hashes, lists }) };
}

module.exports = { makeKv };
