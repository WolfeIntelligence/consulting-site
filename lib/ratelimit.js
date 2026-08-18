// Shared rate limiter for the public API routes.
//
// Uses Upstash Redis when KV_REST_API_URL / KV_REST_API_TOKEN are set, which is
// the only way a limit holds across Vercel's serverless instances. Without it,
// each instance keeps its own in-memory counter — weaker, but it still stops a
// single client hammering one warm instance, and it never fails a request open
// on a storage error.

const memory = new Map(); // key -> { count, resetAt }

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function kv(path) {
  const url = process.env.KV_REST_API_URL;
  const tok = process.env.KV_REST_API_TOKEN;
  if (!url || !tok) return null;
  const r = await fetch(url + path, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) return null;
  const d = await r.json();
  return d && typeof d.result !== 'undefined' ? d.result : null;
}

function memoryHit(key, limit, windowSec) {
  const now = Date.now();
  const e = memory.get(key);
  if (!e || e.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    // Opportunistic sweep so a long-lived instance can't grow unbounded.
    if (memory.size > 5000) {
      for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    }
    return { allowed: true, remaining: limit - 1, retryAfter: windowSec };
  }
  e.count += 1;
  const retryAfter = Math.max(1, Math.ceil((e.resetAt - now) / 1000));
  return { allowed: e.count <= limit, remaining: Math.max(0, limit - e.count), retryAfter };
}

/**
 * Count one hit against `name` for this caller.
 * Returns { allowed, remaining, retryAfter, ip }.
 */
async function limit(req, name, max, windowSec) {
  const ip = clientIp(req);
  return { ...(await limitKey(`rl:${name}:${ip}`, max, windowSec)), ip };
}

/**
 * Count one hit against an arbitrary key (a site-wide cap, a per-route
 * ceiling). Same shape as limit() minus `ip`.
 */
async function limitKey(key, max, windowSec) {
  try {
    const n = await kv('/incr/' + encodeURIComponent(key));
    if (n !== null) {
      if (n === 1) await kv(`/expire/${encodeURIComponent(key)}/${windowSec}`);
      const ttl = await kv('/ttl/' + encodeURIComponent(key));
      const retryAfter = typeof ttl === 'number' && ttl > 0 ? ttl : windowSec;
      return { allowed: n <= max, remaining: Math.max(0, max - n), retryAfter };
    }
  } catch (e) {
    // Fall through to the in-memory limiter rather than failing the request open.
  }
  return memoryHit(key, max, windowSec);
}

/**
 * Reject browser requests that did not originate from this site. Requests with
 * no Origin header (curl, server-to-server) are left to the rate limiter.
 */
function sameSite(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).hostname; } catch (e) { return false; }
  const allowed = ['wolfeintelligence.com', 'www.wolfeintelligence.com'];
  if (process.env.VERCEL_URL) allowed.push(process.env.VERCEL_URL);
  return allowed.includes(host) || host.endsWith('.wolfeintelligence.com') || host.endsWith('.vercel.app');
}

module.exports = { limit, limitKey, sameSite, clientIp };
