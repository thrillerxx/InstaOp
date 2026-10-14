// Ported from livingry-ops/src/lib/hvac-founding-five/rate-limit.ts — per-instance bucket
export function rateLimit(key, opts = {}) {
  const limit = opts.limit ?? 5;
  const windowMs = opts.windowMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return { allowed: true, retryAfterSec: 0 }; }
  if (b.count >= limit) return { allowed: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
  b.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}
const buckets = new Map();
export function _resetRateLimits() { buckets.clear(); }
