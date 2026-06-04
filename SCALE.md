# Scale Plan

- **Data model/indexes:** `idx_user_created (user_id, created_at)` already covers paginated queries. The `UNIQUE` index on `idempotency_key` covers dedup lookups. At Postgres scale, add a partial index on `idempotency_key WHERE idempotency_key IS NOT NULL` to avoid indexing NULLs.

- **Idempotency across instances:** The DB-level `UNIQUE` constraint on `idempotency_key` already makes this multi-instance safe — all nodes share the same DB and the constraint prevents duplicates atomically. For higher throughput, replace with Redis `SET NX PX 86400000` as the idempotency store to offload the DB.

- **Rate limiting across instances:** The current in-memory `Map` breaks across multiple nodes. Replace with Redis: use a sorted set per `userId` keyed as `rl:{userId}`, with `ZREMRANGEBYSCORE` + `ZCARD` + `ZADD` in a Lua script for atomicity. Alternatively use `INCR` + `EXPIRE` on a per-user-per-window key.

- **Observability (logs/metrics/alerts):** Fastify's built-in structured JSON logger covers request logs. Add Prometheus metrics via `fastify-metrics`: track request latency (p50/p99), 429 rate per userId, DB error rate, and retry counts. Alert on p99 > 200ms or error rate > 1% over 5 minutes.

- **Failure modes (DB down / partial outages / retries):** Transient failures handled by exponential backoff with jitter (3 attempts). For sustained DB outages, add a circuit breaker: after 5 consecutive failures, fast-fail for 10s before retrying. Rate limit store (Redis) failure: fail open (allow requests through) to avoid cascading denial of service.

- **10k RPS design sketch (infra & cost ballpark):** SQLite is single-writer and won't sustain 10k RPS. Migrate to Postgres (e.g. RDS `db.t4g.medium`) with PgBouncer for connection pooling. Run 3–5 Fastify instances behind an ALB (e.g. ECS Fargate `0.5 vCPU / 1GB`). Redis (ElastiCache `cache.t4g.small`) for rate limiting and idempotency. For write-heavy spikes, introduce a queue (SQS + worker) to buffer signal ingestion. Estimated AWS cost: ~$200–400/mo.
