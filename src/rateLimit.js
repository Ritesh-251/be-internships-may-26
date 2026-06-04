// Sliding-window rate limiter — in-process, single-threaded safe.
// For multi-instance deployments replace this Map with Redis:
//   ZREMRANGEBYSCORE + ZCARD + ZADD in a Lua script per userId.

const RATE      = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

/** @type {Map<string, number[]>} userId → sorted array of accepted timestamps (ms) */
const buckets = new Map();

/**
 * @param {string} userId
 * @param {number} [nowMs]
 * @returns {{ ok: boolean, remaining: number, resetMs: number }}
 */
export function checkAndConsume(userId, nowMs = Date.now()) {
  const cutoff = nowMs - WINDOW_MS;

  // Drop expired entries, then check BEFORE consuming.
  const timestamps = (buckets.get(userId) || []).filter((t) => t > cutoff);

  if (timestamps.length >= RATE) {
    return { ok: false, remaining: 0, resetMs: timestamps[0] + WINDOW_MS };
  }

  timestamps.push(nowMs);
  buckets.set(userId, timestamps);

  return {
    ok: true,
    remaining: RATE - timestamps.length,
    resetMs: timestamps[0] + WINDOW_MS,
  };
}
