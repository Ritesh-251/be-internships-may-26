/**
 * Sliding-window rate limiter (in-process, single-threaded safe).
 *
 * Per userId we keep a sorted array of accepted request timestamps (ms).
 * On every call we:
 *  1. Filter out timestamps older than WINDOW_MS (the "slide").
 *  2. If filtered.length >= RATE → reject WITHOUT pushing → ok: false.
 *  3. Otherwise → push nowMs, save back → ok: true.
 *
 * Concurrency (single Node.js process):
 *   JS's event loop is single-threaded; this function is fully synchronous,
 *   so no two calls can interleave — no mutex needed.
 *
 * Multi-instance safety:
 *   The in-memory Map breaks across multiple nodes.
 *   Replace with Redis: one sorted set per userId, key = "rl:{userId}".
 *   Use a Lua script for atomicity:
 *     ZREMRANGEBYSCORE key 0 (nowMs - WINDOW_MS)
 *     local cnt = ZCARD key
 *     if cnt < RATE then ZADD key nowMs <uuid> end
 *     EXPIRE key 60
 *   The Lua script runs atomically on the Redis server.
 */

const RATE      = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

/** @type {Map<string, number[]>} userId → sorted array of accepted timestamps */
const buckets = new Map();

/**
 * Check and optionally consume one token for userId.
 *
 * @param {string} userId
 * @param {number} [nowMs]
 * @returns {{ ok: boolean, remaining: number, resetMs: number }}
 */
export function checkAndConsume(userId, nowMs = Date.now()) {
  const cutoff = nowMs - WINDOW_MS;

  // 1. Get the existing timestamp array and drop expired entries.
  const timestamps = (buckets.get(userId) || []).filter((t) => t > cutoff);

  // 2. Check BEFORE consuming.
  if (timestamps.length >= RATE) {
    return { ok: false, remaining: 0, resetMs: timestamps[0] + WINDOW_MS };
  }

  // 3. Accept — record timestamp.
  timestamps.push(nowMs);
  buckets.set(userId, timestamps);

  // resetMs = when the oldest accepted timestamp exits the window.
  // If this was the first entry, timestamps[0] === nowMs → resetMs = nowMs + WINDOW_MS.
  const resetMs = timestamps[0] + WINDOW_MS;
  const remaining = RATE - timestamps.length;
  return { ok: true, remaining, resetMs };
}
