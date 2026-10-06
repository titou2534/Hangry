// Best-effort protection for the public API routes. State lives in the memory
// of a warm serverless instance, so limits are per-instance rather than global:
// enough to stop casual hammering, not a substitute for a shared store (e.g.
// Upstash/Vercel KV) if this ever sees real abuse.

const buckets = new Map();
const MAX_TRACKED_KEYS = 5000;

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Returns true if the request may proceed; otherwise sends a 429 and returns false.
export function rateLimit(req, res, { name, limit, windowMs }) {
  const now = Date.now();
  const key = `${name}:${clientIp(req)}`;

  if (buckets.size > MAX_TRACKED_KEYS) {
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  if (bucket.count > limit) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
    return false;
  }
  return true;
}

// Small TTL cache with oldest-first eviction.
export function createCache({ ttlMs, maxEntries }) {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      if (store.size >= maxEntries) store.delete(store.keys().next().value);
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}
