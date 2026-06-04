import { insertSignal, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';

/**
 * Retry fn up to maxAttempts times on transient errors.
 * Back-off: 2^attempt * 50ms + jitter [0, 30)ms.
 * Constraint errors are re-thrown immediately — they are permanent, not transient.
 */
async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      const isConstraint =
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        err.code === 'SQLITE_CONSTRAINT';
      if (isConstraint || attempt === maxAttempts - 1) throw err;
      const backoff = Math.pow(2, attempt) * 50 + Math.random() * 30;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

function nowMs() {
  return Date.now();
}

/**
 * POST /v1/signals
 *
 * Idempotency: always INSERT first, catch SQLITE_CONSTRAINT, then SELECT.
 * This eliminates the check-then-insert race — two concurrent requests with
 * the same key will both resolve to the same stored record.
 */
export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};

  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) {
    return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
  }

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
    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

/** GET /v1/signals?userId=...&limit=... */
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
