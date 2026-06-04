import { insertSignal, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';

// ---------------------------------------------------------------------------
// Retry helper with exponential backoff + jitter
// ---------------------------------------------------------------------------

/**
 * Retry `fn` up to `maxAttempts` times on transient errors.
 * SQLITE_CONSTRAINT errors are re-thrown immediately (no point retrying).
 * Back-off formula: 2^attempt * 50ms + random jitter [0, 30)ms.
 *
 * @template T
 * @param {() => T} fn
 * @param {number}  maxAttempts
 * @returns {Promise<T>}
 */
async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return fn(); // better-sqlite3 is synchronous
    } catch (err) {
      // Unique-constraint violations are not transient — bail immediately.
      if (
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        err.code === 'SQLITE_CONSTRAINT'
      ) {
        throw err;
      }
      // Final attempt — rethrow so the caller sees the error.
      if (attempt === maxAttempts - 1) throw err;
      // Wait with exponential backoff + jitter before next attempt.
      const backoff = Math.pow(2, attempt) * 50 + Math.random() * 30;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function nowMs() {
  return Date.now();
}

/**
 * POST /v1/signals
 *
 * Idempotency approach — atomic, race-condition safe:
 *   Always attempt INSERT directly (no pre-flight SELECT).
 *   If two concurrent requests carry the same Idempotency-Key, exactly one
 *   INSERT wins; the other hits SQLITE_CONSTRAINT and falls back to SELECT.
 *   Both callers receive the same stored record.
 */
export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};

  // Validate body.
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  // Rate limit check.
  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) {
    return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
  }

  // Attempt atomic insert with retry on transient DB failures.
  const t = nowMs();
  try {
    const info = await withRetry(() =>
      insertSignal(userId, type, payload, idem, t)
    );
    return reply.code(200).send({
      id: info.lastInsertRowid,
      userId,
      type,
      payload: String(payload),
      idempotencyKey: idem,
      createdAt: t,
    });
  } catch (e) {
    // UNIQUE constraint → idempotency hit; fetch and return the existing record.
    if (
      (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT') &&
      idem
    ) {
      try {
        const existing = await withRetry(() => getByIdemKey(idem));
        return reply.code(200).send(existing);
      } catch (fetchErr) {
        req.log.error({ err: fetchErr, ctx: 'getByIdemKey' });
        return reply.code(503).send({ error: 'db_unavailable' });
      }
    }
    // Transient failure exhausted all retries.
    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

/**
 * GET /v1/signals?userId=...&limit=...
 */
export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
